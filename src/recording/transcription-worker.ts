import { env } from "../config/env.js";
import type { AppDatabase } from "../db/database.js";
import { transcribeOggFile } from "../transcription/deepgram.js";
import { createId } from "../utils/ids.js";
import { log } from "../utils/log.js";
import { errorMessage } from "./errors.js";
import type { ActiveRecordingSession, SavedSegment } from "./types.js";

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}

export class TranscriptionWorker {
  constructor(private readonly db: AppDatabase) {}

  schedule(session: ActiveRecordingSession, segment: SavedSegment): void {
    const task = this.transcribeSegment(session, segment);
    session.transcriptionTasks.add(task);
    void task.finally(() => session.transcriptionTasks.delete(task));
  }

  private async transcribeSegment(
    session: ActiveRecordingSession,
    segment: SavedSegment,
  ): Promise<void> {
    log.info("transcription.requested", {
      sessionId: session.sessionId,
      guildId: session.guildId,
      channelId: session.channelId,
      discordUserId: segment.discordUserId,
      participantId: segment.participantId,
      segmentId: segment.segmentId,
      localFilePath: segment.relativePath,
      sizeBytes: segment.sizeBytes,
    });

    try {
      this.db.markAudioSegmentTranscribing(segment.segmentId);
      const transcription = await transcribeOggFile(segment.absolutePath);

      this.db.insertTranscriptAndMarkAudioTranscribed({
        id: createId(),
        sessionId: session.sessionId,
        participantId: segment.participantId,
        audioSegmentId: segment.segmentId,
        text: transcription.text,
        confidence: transcription.confidence,
        language: transcription.detectedLanguage,
        model: env.DEEPGRAM_MODEL,
        deepgramRequestId: transcription.requestId,
        deepgramResponseJson: safeJsonStringify(transcription.rawResponse),
        relativeStartMs: segment.relativeStartMs,
        relativeEndMs: segment.relativeEndMs,
      });

      log.info("transcription.completed", {
        sessionId: session.sessionId,
        guildId: session.guildId,
        channelId: session.channelId,
        discordUserId: segment.discordUserId,
        participantId: segment.participantId,
        segmentId: segment.segmentId,
        deepgramRequestId: transcription.requestId,
        confidence: transcription.confidence,
        language: transcription.detectedLanguage,
      });
    } catch (error) {
      this.db.markAudioSegmentFailed(segment.segmentId, errorMessage(error));
      log.error("transcription.failed", {
        sessionId: session.sessionId,
        guildId: session.guildId,
        channelId: session.channelId,
        discordUserId: segment.discordUserId,
        participantId: segment.participantId,
        segmentId: segment.segmentId,
        error,
      });
    }
  }
}
