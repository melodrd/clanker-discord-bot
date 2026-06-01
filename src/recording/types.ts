import type { VoiceConnection } from "@discordjs/voice";
import type { Guild } from "discord.js";
import type { WriteStream } from "node:fs";
import type { Readable } from "node:stream";

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
  startedAt: string;
  guild: Guild;
  connection: VoiceConnection;
  activeUserStreams: Map<string, ActiveSegment>;
  startingUserIds: Set<string>;
  segmentTasks: Set<Promise<void>>;
  transcriptionTasks: Set<Promise<void>>;
  cancelledSegmentIds: Set<string>;
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
