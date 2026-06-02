import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { EndBehaviorType } from "@discordjs/voice";
import { env } from "../config/env.js";
import type { AppDatabase } from "../db/database.js";
import { createId } from "../utils/ids.js";
import { log } from "../utils/log.js";
import { relativeMs } from "../utils/time.js";
import { errorMessage } from "./errors.js";
import type { SegmentFinalizer } from "./segment-finalizer.js";
import { createOggStream } from "./stream-utils.js";
import type { ActiveRecordingSession, ActiveSegment } from "./types.js";

export class SpeakerCapture {
  constructor(
    private readonly dependencies: {
      db: AppDatabase;
      segmentFinalizer: SegmentFinalizer;
      onSpeakerStart: (session: ActiveRecordingSession) => void;
      onSpeakerSettled: (session: ActiveRecordingSession) => void;
    },
  ) {}

  listenForSpeakers(session: ActiveRecordingSession): void {
    session.connection.receiver.speaking.on("start", (discordUserId) => {
      void this.handleSpeakerStart(session, discordUserId);
    });
  }

  cancelActiveSegments(session: ActiveRecordingSession, reason: string): void {
    for (const [
      discordUserId,
      segment,
    ] of session.activeUserStreams.entries()) {
      session.cancelledSegmentIds.add(segment.segmentId);

      try {
        this.dependencies.db.markAudioSegmentFailed(segment.segmentId, reason);
      } catch (error) {
        log.error("segment.cancel_db_failed", {
          sessionId: session.sessionId,
          segmentId: segment.segmentId,
          error,
        });
      }

      segment.receiveStream?.destroy();
      segment.outputStream?.destroy();
      session.activeUserStreams.delete(discordUserId);

      log.warn("segment.cancelled", {
        sessionId: session.sessionId,
        guildId: session.guildId,
        channelId: session.channelId,
        discordUserId,
        participantId: segment.participantId,
        segmentId: segment.segmentId,
        reason,
      });
    }
  }

  private async handleSpeakerStart(
    session: ActiveRecordingSession,
    discordUserId: string,
  ): Promise<void> {
    if (session.stopping) return;

    if (
      session.activeUserStreams.has(discordUserId) ||
      session.startingUserIds.has(discordUserId)
    ) {
      log.info("segment.duplicate_start_ignored", {
        sessionId: session.sessionId,
        guildId: session.guildId,
        channelId: session.channelId,
        discordUserId,
      });
      return;
    }

    session.startingUserIds.add(discordUserId);
    this.dependencies.onSpeakerStart(session);

    let segmentId: string | null = null;

    try {
      const speaker = await this.resolveSpeaker(session, discordUserId);
      const participant = this.dependencies.db.upsertParticipant({
        sessionId: session.sessionId,
        discordUserId,
        displayName: speaker.displayName,
        username: speaker.username,
      });

      const startedAtDate = new Date();
      const startedAt = startedAtDate.toISOString();
      const relativeStartMs = relativeMs(session.startedAt, startedAtDate);
      segmentId = createId();
      const relativePath = posix.join(
        session.sessionId,
        discordUserId,
        `${segmentId}.ogg`,
      );
      const absolutePath = join(
        env.RECORDINGS_DIR,
        session.sessionId,
        discordUserId,
        `${segmentId}.ogg`,
      );

      await mkdir(dirname(absolutePath), { recursive: true });

      this.dependencies.db.createAudioSegment({
        id: segmentId,
        sessionId: session.sessionId,
        participantId: participant.id,
        discordUserId,
        startedAt,
        relativeStartMs,
        localFilePath: relativePath,
      });

      const receiveStream = session.connection.receiver.subscribe(
        discordUserId,
        {
          end: {
            behavior: EndBehaviorType.AfterSilence,
            duration: 1_000,
          },
        },
      );
      const oggStream = createOggStream();
      const outputStream = createWriteStream(absolutePath);
      const activeSegment: ActiveSegment = {
        segmentId,
        participantId: participant.id,
        discordUserId,
        startedAt,
        relativeStartMs,
        relativePath,
        absolutePath,
        receiveStream,
        outputStream,
      };

      session.activeUserStreams.set(discordUserId, activeSegment);

      log.info("segment.started", {
        sessionId: session.sessionId,
        guildId: session.guildId,
        channelId: session.channelId,
        discordUserId,
        participantId: participant.id,
        speakerLabel: participant.speaker_label,
        segmentId,
        relativeStartMs,
      });

      log.info("segment.file_opened", {
        sessionId: session.sessionId,
        segmentId,
        discordUserId,
        localFilePath: relativePath,
      });

      const task = this.dependencies.segmentFinalizer.finalize(
        session,
        activeSegment,
        receiveStream,
        oggStream,
        outputStream,
      );
      session.segmentTasks.add(task);
      void task.finally(() => session.segmentTasks.delete(task));

      // Discord voice receive streams can close in ways that Node's pipeline()
      // treats as premature. A finalized non-empty Ogg file is the success condition.
      receiveStream.pipe(oggStream).pipe(outputStream);
    } catch (error) {
      if (segmentId) {
        this.dependencies.db.markAudioSegmentFailed(
          segmentId,
          errorMessage(error),
        );
      }

      log.error("segment.start_failed", {
        sessionId: session.sessionId,
        guildId: session.guildId,
        channelId: session.channelId,
        discordUserId,
        segmentId,
        error,
      });
    } finally {
      session.startingUserIds.delete(discordUserId);
      this.dependencies.onSpeakerSettled(session);
    }
  }

  private async resolveSpeaker(
    session: ActiveRecordingSession,
    discordUserId: string,
  ): Promise<{ displayName: string | null; username: string | null }> {
    const member = await session.guild.members
      .fetch(discordUserId)
      .catch(() => null);
    if (member) {
      return {
        displayName: member.displayName,
        username: member.user.username,
      };
    }

    const user = await session.guild.client.users
      .fetch(discordUserId)
      .catch(() => null);
    return {
      displayName: user?.globalName ?? user?.username ?? null,
      username: user?.username ?? null,
    };
  }
}
