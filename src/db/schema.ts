import type Database from "better-sqlite3";

export function migrate(db: Database.Database): void {
  db.exec(`
    create table if not exists recording_sessions (
      id text primary key,

      discord_guild_id text not null,
      discord_channel_id text not null,

      status text not null check (
        status in (
          'recording',
          'stopping',
          'transcribing',
          'completed',
          'failed',
          'cancelled'
        )
      ),

      started_by_discord_user_id text,

      started_at text not null,
      stopped_at text,
      completed_at text,

      error text,

      created_at text not null,
      updated_at text not null
    );

    create table if not exists recording_participants (
      id text primary key,

      session_id text not null references recording_sessions(id) on delete cascade,

      discord_user_id text not null,

      speaker_label text not null,
      display_name text,
      username text,

      created_at text not null,
      updated_at text not null,

      unique (session_id, discord_user_id),
      unique (session_id, speaker_label)
    );

    create table if not exists audio_segments (
      id text primary key,

      session_id text not null references recording_sessions(id) on delete cascade,
      participant_id text not null references recording_participants(id) on delete cascade,

      discord_user_id text not null,

      status text not null check (
        status in (
          'recording',
          'saved',
          'transcribing',
          'transcribed',
          'failed'
        )
      ),

      started_at text not null,
      ended_at text,

      relative_start_ms integer not null,
      relative_end_ms integer,

      local_file_path text not null,

      mime_type text not null default 'audio/ogg',
      codec text not null default 'opus',

      size_bytes integer,

      error text,

      created_at text not null,
      updated_at text not null
    );

    create table if not exists transcript_segments (
      id text primary key,

      session_id text not null references recording_sessions(id) on delete cascade,
      participant_id text not null references recording_participants(id) on delete cascade,
      audio_segment_id text not null unique references audio_segments(id) on delete cascade,

      text text not null,

      confidence real,
      language text,
      model text,

      deepgram_request_id text,
      deepgram_response_json text not null,

      relative_start_ms integer not null,
      relative_end_ms integer,

      created_at text not null,
      updated_at text not null
    );

    create index if not exists recording_sessions_status_idx
      on recording_sessions (status);

    create index if not exists recording_sessions_started_at_idx
      on recording_sessions (started_at desc);

    create index if not exists recording_participants_session_idx
      on recording_participants (session_id);

    create index if not exists audio_segments_session_time_idx
      on audio_segments (session_id, relative_start_ms);

    create index if not exists audio_segments_status_idx
      on audio_segments (status);

    create index if not exists transcript_segments_session_time_idx
      on transcript_segments (session_id, relative_start_ms);

    create index if not exists transcript_segments_text_idx
      on transcript_segments (text);
  `);
}
