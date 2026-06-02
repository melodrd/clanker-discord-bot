import { stat } from "node:fs/promises";
import type { Readable, Transform } from "node:stream";
import type { AppDatabase } from "../db/database.js";
import { log } from "../utils/log.js";
import { relativeMs } from "../utils/time.js";
import { errorMessage } from "./errors.js";
import { waitForWritableClose } from "./stream-utils.js";
import type { TranscriptionWorker } from "./transcription-worker.js";
import type { ActiveRecordingSession, ActiveSegment } from "./types.js";

export class SegmentFinalizer {
  constructor(
    private readonly dependencies: {
      db: AppDatabase;
      transcriptionWorker: TranscriptionWorker;
      onSegmentSettled: (session: ActiveRecordingSession) => void;
    },
  ) {}

  async finalize(
    session: ActiveRecordingSession,
    segment: ActiveSegment,
    receiveStream: Readable,
    oggStream: Transform,
    outputStream: NodeJS.WritableStream,
  ): Promise<void> {
    try {
      await waitForWritableClose(receiveStream, oggStream, outputStream);

      if (session.cancelledSegmentIds.has(segment.segmentId)) return;

      const fileStats = await stat(segment.absolutePath).catch(() => null);
      const sizeBytes = fileStats?.size ?? 0;
      const endedAtDate = new Date();
      const endedAt = endedAtDate.toISOString();
      const relativeEndMs = relativeMs(session.startedAt, endedAtDate);

      if (sizeBytes <= 0) {
        this.dependencies.db.markAudioSegmentFailed(
          segment.segmentId,
          "Empty audio segment",
        );
        log.warn("segment.empty", {
          sessionId: session.sessionId,
          guildId: session.guildId,
          channelId: session.channelId,
          discordUserId: segment.discordUserId,
          participantId: segment.participantId,
          segmentId: segment.segmentId,
          localFilePath: segment.relativePath,
          relativeStartMs: segment.relativeStartMs,
          relativeEndMs,
          sizeBytes,
        });
        return;
      }

      this.dependencies.db.markAudioSegmentSaved({
        segmentId: segment.segmentId,
        endedAt,
        relativeEndMs,
        sizeBytes,
      });

      log.info("segment.saved", {
        sessionId: session.sessionId,
        guildId: session.guildId,
        channelId: session.channelId,
        discordUserId: segment.discordUserId,
        participantId: segment.participantId,
        segmentId: segment.segmentId,
        localFilePath: segment.relativePath,
        relativeStartMs: segment.relativeStartMs,
        relativeEndMs,
        sizeBytes,
      });

      this.dependencies.transcriptionWorker.schedule(session, {
        segmentId: segment.segmentId,
        participantId: segment.participantId,
        discordUserId: segment.discordUserId,
        relativeStartMs: segment.relativeStartMs,
        relativeEndMs,
        relativePath: segment.relativePath,
        absolutePath: segment.absolutePath,
        sizeBytes,
      });
    } catch (error) {
      if (!session.cancelledSegmentIds.has(segment.segmentId)) {
        this.dependencies.db.markAudioSegmentFailed(
          segment.segmentId,
          errorMessage(error),
        );
        log.error("segment.failed", {
          sessionId: session.sessionId,
          guildId: session.guildId,
          channelId: session.channelId,
          discordUserId: segment.discordUserId,
          participantId: segment.participantId,
          segmentId: segment.segmentId,
          localFilePath: segment.relativePath,
          error,
        });
      }
    } finally {
      session.activeUserStreams.delete(segment.discordUserId);
      this.dependencies.onSegmentSettled(session);
    }
  }
}
