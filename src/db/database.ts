import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { migrate } from "./schema.js";
import { createId } from "../utils/ids.js";
import { log } from "../utils/log.js";
import { nowIso } from "../utils/time.js";

export type RecordingSessionStatus =
  | "recording"
  | "stopping"
  | "transcribing"
  | "completed"
  | "failed"
  | "cancelled";

export type AudioSegmentStatus = "recording" | "saved" | "transcribing" | "transcribed" | "failed";

export type RecordingParticipant = {
  id: string;
  session_id: string;
  discord_user_id: string;
  speaker_label: string;
  display_name: string | null;
  username: string | null;
};

export type SessionStats = {
  participantsCount: number;
  audioSegmentsCount: number;
  transcribedSegmentsCount: number;
  failedSegmentsCount: number;
  transcribingSegmentsCount: number;
};

type CountRow = { count: number };
type StatusCountRow = { status: AudioSegmentStatus; count: number };

export class AppDatabase {
  private readonly db: Database.Database;
  private closed = false;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);

    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");

    log.info("database.opened", { databasePath });
    migrate(this.db);
    log.info("database.migrations_completed");
  }

  createRecordingSession(input: {
    id: string;
    guildId: string;
    channelId: string;
    startedByDiscordUserId: string;
    startedAt: string;
  }): void {
    const timestamp = nowIso();

    this.db
      .prepare(
        `insert into recording_sessions (
          id,
          discord_guild_id,
          discord_channel_id,
          status,
          started_by_discord_user_id,
          started_at,
          created_at,
          updated_at
        ) values (?, ?, ?, 'recording', ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.guildId,
        input.channelId,
        input.startedByDiscordUserId,
        input.startedAt,
        timestamp,
        timestamp,
      );
  }

  updateRecordingSessionStatus(
    sessionId: string,
    status: RecordingSessionStatus,
    options: { stoppedAt?: string; completedAt?: string; error?: string | null } = {},
  ): void {
    this.db
      .prepare(
        `update recording_sessions
         set status = @status,
             stopped_at = coalesce(@stoppedAt, stopped_at),
             completed_at = coalesce(@completedAt, completed_at),
             error = @error,
             updated_at = @updatedAt
         where id = @sessionId`,
      )
      .run({
        sessionId,
        status,
        stoppedAt: options.stoppedAt ?? null,
        completedAt: options.completedAt ?? null,
        error: options.error ?? null,
        updatedAt: nowIso(),
      });
  }

  upsertParticipant(input: {
    sessionId: string;
    discordUserId: string;
    displayName: string | null;
    username: string | null;
  }): RecordingParticipant {
    return this.db.transaction(() => {
      const existing = this.db
        .prepare(
          `select id, session_id, discord_user_id, speaker_label, display_name, username
           from recording_participants
           where session_id = ? and discord_user_id = ?`,
        )
        .get(input.sessionId, input.discordUserId) as RecordingParticipant | undefined;

      if (existing) {
        this.db
          .prepare(
            `update recording_participants
             set display_name = ?, username = ?, updated_at = ?
             where id = ?`,
          )
          .run(input.displayName, input.username, nowIso(), existing.id);

        return {
          ...existing,
          display_name: input.displayName,
          username: input.username,
        };
      }

      const participantCount = this.db
        .prepare(`select count(*) as count from recording_participants where session_id = ?`)
        .get(input.sessionId) as CountRow;

      const timestamp = nowIso();
      const participant: RecordingParticipant = {
        id: createId(),
        session_id: input.sessionId,
        discord_user_id: input.discordUserId,
        speaker_label: `Speaker ${participantCount.count + 1}`,
        display_name: input.displayName,
        username: input.username,
      };

      this.db
        .prepare(
          `insert into recording_participants (
            id,
            session_id,
            discord_user_id,
            speaker_label,
            display_name,
            username,
            created_at,
            updated_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          participant.id,
          participant.session_id,
          participant.discord_user_id,
          participant.speaker_label,
          participant.display_name,
          participant.username,
          timestamp,
          timestamp,
        );

      return participant;
    })();
  }

  createAudioSegment(input: {
    id: string;
    sessionId: string;
    participantId: string;
    discordUserId: string;
    startedAt: string;
    relativeStartMs: number;
    localFilePath: string;
  }): void {
    const timestamp = nowIso();

    this.db
      .prepare(
        `insert into audio_segments (
          id,
          session_id,
          participant_id,
          discord_user_id,
          status,
          started_at,
          relative_start_ms,
          local_file_path,
          created_at,
          updated_at
        ) values (?, ?, ?, ?, 'recording', ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.sessionId,
        input.participantId,
        input.discordUserId,
        input.startedAt,
        input.relativeStartMs,
        input.localFilePath,
        timestamp,
        timestamp,
      );
  }

  markAudioSegmentSaved(input: {
    segmentId: string;
    endedAt: string;
    relativeEndMs: number;
    sizeBytes: number;
  }): void {
    this.db
      .prepare(
        `update audio_segments
         set status = 'saved',
             ended_at = ?,
             relative_end_ms = ?,
             size_bytes = ?,
             error = null,
             updated_at = ?
         where id = ?`,
      )
      .run(input.endedAt, input.relativeEndMs, input.sizeBytes, nowIso(), input.segmentId);
  }

  markAudioSegmentTranscribing(segmentId: string): void {
    this.db
      .prepare(
        `update audio_segments
         set status = 'transcribing', updated_at = ?
         where id = ?`,
      )
      .run(nowIso(), segmentId);
  }

  markAudioSegmentFailed(segmentId: string, error: string): void {
    this.db
      .prepare(
        `update audio_segments
         set status = 'failed', error = ?, updated_at = ?
         where id = ?`,
      )
      .run(error, nowIso(), segmentId);
  }

  insertTranscriptAndMarkAudioTranscribed(input: {
    id: string;
    sessionId: string;
    participantId: string;
    audioSegmentId: string;
    text: string;
    confidence: number | null;
    language: string | null;
    model: string;
    deepgramRequestId: string | null;
    deepgramResponseJson: string;
    relativeStartMs: number;
    relativeEndMs: number | null;
  }): void {
    this.db.transaction(() => {
      const timestamp = nowIso();

      this.db
        .prepare(
          `insert into transcript_segments (
            id,
            session_id,
            participant_id,
            audio_segment_id,
            text,
            confidence,
            language,
            model,
            deepgram_request_id,
            deepgram_response_json,
            relative_start_ms,
            relative_end_ms,
            created_at,
            updated_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.sessionId,
          input.participantId,
          input.audioSegmentId,
          input.text,
          input.confidence,
          input.language,
          input.model,
          input.deepgramRequestId,
          input.deepgramResponseJson,
          input.relativeStartMs,
          input.relativeEndMs,
          timestamp,
          timestamp,
        );

      this.db
        .prepare(
          `update audio_segments
           set status = 'transcribed', error = null, updated_at = ?
           where id = ?`,
        )
        .run(timestamp, input.audioSegmentId);
    })();
  }

  getSessionStats(sessionId: string): SessionStats {
    const participants = this.db
      .prepare(`select count(*) as count from recording_participants where session_id = ?`)
      .get(sessionId) as CountRow;

    const rows = this.db
      .prepare(
        `select status, count(*) as count
         from audio_segments
         where session_id = ?
         group by status`,
      )
      .all(sessionId) as StatusCountRow[];

    const counts: Partial<Record<AudioSegmentStatus, number>> = {};
    for (const row of rows) {
      counts[row.status] = row.count;
    }

    return {
      participantsCount: participants.count,
      audioSegmentsCount: rows.reduce((sum, row) => sum + row.count, 0),
      transcribedSegmentsCount: counts.transcribed ?? 0,
      failedSegmentsCount: counts.failed ?? 0,
      transcribingSegmentsCount: counts.transcribing ?? 0,
    };
  }

  markInterruptedSessionsFailed(): { sessions: number; segments: number } {
    const timestamp = nowIso();
    const sessionResult = this.db
      .prepare(
        `update recording_sessions
         set status = 'failed',
             error = 'Bot restarted while session was active',
             stopped_at = coalesce(stopped_at, ?),
             completed_at = coalesce(completed_at, ?),
             updated_at = ?
         where status in ('recording', 'stopping', 'transcribing')`,
      )
      .run(timestamp, timestamp, timestamp);

    const segmentResult = this.db
      .prepare(
        `update audio_segments
         set status = 'failed',
             error = 'Bot restarted while segment was active',
             updated_at = ?
         where status in ('recording', 'transcribing')`,
      )
      .run(timestamp);

    log.info("database.interrupted_marked_failed", {
      sessions: sessionResult.changes,
      segments: segmentResult.changes,
    });

    return { sessions: sessionResult.changes, segments: segmentResult.changes };
  }

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
    log.info("database.closed");
  }
}
