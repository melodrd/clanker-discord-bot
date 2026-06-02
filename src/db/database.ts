import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { createId } from "../utils/ids.js";
import { log } from "../utils/log.js";
import { nowIso } from "../utils/time.js";
import { migrate } from "./schema.js";

export type RecordingSessionStatus =
  | "recording"
  | "stopping"
  | "transcribing"
  | "completed"
  | "failed"
  | "cancelled";

export type AudioSegmentStatus =
  | "recording"
  | "saved"
  | "transcribing"
  | "transcribed"
  | "failed";

export type RecordingParticipant = {
  id: string;
  session_id: string;
  discord_user_id: string;
  speaker_label: string;
  display_name: string | null;
  username: string | null;
};

export type MeetingListItem = {
  id: string;
  title: string | null;
  started_at: string;
  stopped_at: string | null;
  completed_at: string | null;
  status: RecordingSessionStatus;
  duration_seconds: number | null;
  participant_count: number;
  transcript_segment_count: number;
};

export type MeetingParticipantView = {
  id: string;
  speaker_label: string;
  display_name: string | null;
  username: string | null;
  name: string;
};

export type MeetingDetailView = MeetingListItem & {
  participants: MeetingParticipantView[];
};

export type TranscriptSegmentView = {
  id: string;
  meeting_id: string;
  start_seconds: number;
  end_seconds: number | null;
  timestamp: string;
  speaker: {
    id: string;
    name: string;
    speaker_label: string;
    display_name: string | null;
    username: string | null;
  };
  text: string;
  confidence: number | null;
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
type AppDatabaseOptions = { readonly?: boolean };
type MeetingRow = MeetingListItem;
type TranscriptSegmentRow = {
  id: string;
  meeting_id: string;
  relative_start_ms: number;
  relative_end_ms: number | null;
  text: string;
  confidence: number | null;
  speaker_id: string;
  speaker_label: string;
  display_name: string | null;
  username: string | null;
  speaker_name: string;
};

const meetingSelectSql = `
  with participant_stats as (
    select session_id, count(*) as participant_count
    from recording_participants
    group by session_id
  ),
  transcript_stats as (
    select
      session_id,
      count(*) as transcript_segment_count,
      max(coalesce(relative_end_ms, relative_start_ms)) as duration_ms
    from transcript_segments
    group by session_id
  ),
  audio_stats as (
    select
      session_id,
      max(coalesce(relative_end_ms, relative_start_ms)) as duration_ms
    from audio_segments
    group by session_id
  )
  select
    s.id,
    null as title,
    s.started_at,
    s.stopped_at,
    s.completed_at,
    s.status,
    case
      when coalesce(transcript_stats.duration_ms, audio_stats.duration_ms) is null
      then null
      else cast(
        coalesce(transcript_stats.duration_ms, audio_stats.duration_ms) / 1000
        as integer
      )
    end as duration_seconds,
    coalesce(participant_stats.participant_count, 0) as participant_count,
    coalesce(transcript_stats.transcript_segment_count, 0) as transcript_segment_count
  from recording_sessions s
  left join participant_stats
    on participant_stats.session_id = s.id
  left join transcript_stats
    on transcript_stats.session_id = s.id
  left join audio_stats
    on audio_stats.session_id = s.id
`;

function millisecondsToSeconds(milliseconds: number): number {
  return milliseconds / 1000;
}

function formatTimestamp(seconds: number): string {
  const totalSeconds = Math.floor(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;

  return [hours, minutes, secs]
    .map((value) => value.toString().padStart(2, "0"))
    .join(":");
}

export class AppDatabase {
  private readonly db: Database.Database;
  private closed = false;

  constructor(databasePath: string, options: AppDatabaseOptions = {}) {
    const isReadonly = options.readonly ?? false;

    if (!isReadonly) {
      mkdirSync(dirname(databasePath), { recursive: true });
    }

    this.db = new Database(
      databasePath,
      isReadonly ? { readonly: true, fileMustExist: true } : undefined,
    );

    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");

    if (isReadonly) {
      this.db.pragma("query_only = ON");
    } else {
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = NORMAL");
    }

    log.info("database.opened", { databasePath, readonly: isReadonly });

    if (!isReadonly) {
      migrate(this.db);
      log.info("database.migrations_completed");
    }
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
    options: {
      stoppedAt?: string;
      completedAt?: string;
      error?: string | null;
    } = {},
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
        .get(input.sessionId, input.discordUserId) as
        | RecordingParticipant
        | undefined;

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
        .prepare(
          `select count(*) as count from recording_participants where session_id = ?`,
        )
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
      .run(
        input.endedAt,
        input.relativeEndMs,
        input.sizeBytes,
        nowIso(),
        input.segmentId,
      );
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
      .prepare(
        `select count(*) as count from recording_participants where session_id = ?`,
      )
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

  listMeetings(): MeetingListItem[] {
    return this.db
      .prepare<[], MeetingRow>(
        `${meetingSelectSql}
         order by s.started_at desc`,
      )
      .all();
  }

  getMeeting(sessionId: string): MeetingDetailView | null {
    const meeting = this.db
      .prepare<[string], MeetingRow>(
        `${meetingSelectSql}
         where s.id = ?`,
      )
      .get(sessionId);

    if (!meeting) return null;

    return {
      ...meeting,
      participants: this.getMeetingParticipants(sessionId),
    };
  }

  getMeetingParticipants(sessionId: string): MeetingParticipantView[] {
    return this.db
      .prepare<[string], MeetingParticipantView>(
        `select
           id,
           speaker_label,
           display_name,
           username,
           coalesce(display_name, username, speaker_label) as name
         from recording_participants
         where session_id = ?
         order by speaker_label asc`,
      )
      .all(sessionId);
  }

  getTranscriptSegments(sessionId: string): TranscriptSegmentView[] {
    const rows = this.db
      .prepare<[string], TranscriptSegmentRow>(
        `select
           ts.id,
           ts.session_id as meeting_id,
           ts.relative_start_ms,
           ts.relative_end_ms,
           ts.text,
           ts.confidence,
           rp.id as speaker_id,
           rp.speaker_label,
           rp.display_name,
           rp.username,
           coalesce(rp.display_name, rp.username, rp.speaker_label) as speaker_name
         from transcript_segments ts
         join recording_participants rp
           on rp.id = ts.participant_id
         where ts.session_id = ?
         order by ts.relative_start_ms asc`,
      )
      .all(sessionId);

    return rows.map((row) => {
      const startSeconds = millisecondsToSeconds(row.relative_start_ms);

      return {
        id: row.id,
        meeting_id: row.meeting_id,
        start_seconds: startSeconds,
        end_seconds:
          row.relative_end_ms === null
            ? null
            : millisecondsToSeconds(row.relative_end_ms),
        timestamp: formatTimestamp(startSeconds),
        speaker: {
          id: row.speaker_id,
          name: row.speaker_name,
          speaker_label: row.speaker_label,
          display_name: row.display_name,
          username: row.username,
        },
        text: row.text,
        confidence: row.confidence,
      };
    });
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
