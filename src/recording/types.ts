import type { WriteStream } from "node:fs";
import type { Readable } from "node:stream";
import type { VoiceConnection } from "@discordjs/voice";
import type { Guild } from "discord.js";
import type { SessionStats } from "../db/database.js";

export type StopSource = "manual" | "max_duration" | "idle_timeout";

export type StopSummary = {
  completedAt: string;
  stats: SessionStats;
};

export type ActiveSegment = {
  segmentId: string;
  participantId: string;
  discordUserId: string;
  startedAt: string;
  relativeStartMs: number;
  relativePath: string;
  absolutePath: string;
  receiveStream?: Readable;
  outputStream?: WriteStream;
};

export type ActiveRecordingSession = {
  sessionId: string;
  guildId: string;
  channelId: string;
  startedByDiscordUserId: string;
  startedAt: string;
  guild: Guild;
  connection: VoiceConnection;
  activeUserStreams: Map<string, ActiveSegment>;
  startingUserIds: Set<string>;
  segmentTasks: Set<Promise<void>>;
  transcriptionTasks: Set<Promise<void>>;
  cancelledSegmentIds: Set<string>;
  maxDurationStopAt: number | null;
  maxDurationTimer?: NodeJS.Timeout;
  idleStopAt: number | null;
  idleStopTimer?: NodeJS.Timeout;
  stopping: boolean;
};

export type SavedSegment = {
  segmentId: string;
  participantId: string;
  discordUserId: string;
  relativeStartMs: number;
  relativeEndMs: number;
  relativePath: string;
  absolutePath: string;
  sizeBytes: number;
};
