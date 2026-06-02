import { EmbedBuilder } from "discord.js";
import { env } from "../config/env.js";
import type { SessionStats } from "../db/database.js";
import { relativeMs } from "../utils/time.js";
import { formatDuration, formatUtcDisplay } from "./format.js";
import type { ActiveRecordingSession, StopSummary } from "./types.js";

const defaultEmbedColor = 0xecabcd;
const unauthorizedMessage = "You are not allowed to use recording commands.";

export function createRecordingEmbed(
  title: string,
  description?: string,
): EmbedBuilder {
  const embed = new EmbedBuilder().setTitle(title).setColor(defaultEmbedColor);
  if (description) embed.setDescription(description);
  return embed;
}

export function createPingEmbed(): EmbedBuilder {
  return createRecordingEmbed("Pong");
}

export function createUnauthorizedEmbed(): EmbedBuilder {
  return createRecordingEmbed("Unauthorized", unauthorizedMessage);
}

export function createErrorEmbed(message: string): EmbedBuilder {
  return createRecordingEmbed("Error", message);
}

export function createRecordingStartedEmbed(
  sessionId: string,
  channelId: string,
): EmbedBuilder {
  return createRecordingEmbed("Recording Started").addFields(
    { name: "Session ID", value: sessionId, inline: true },
    { name: "Channel", value: `<#${channelId}>`, inline: true },
  );
}

export function createIdleStatusEmbed(): EmbedBuilder {
  return createRecordingEmbed(
    "Recording Status",
    "Recording is currently idle.",
  );
}

export function createActiveStatusEmbed(
  session: ActiveRecordingSession,
  stats: SessionStats,
): EmbedBuilder {
  const now = Date.now();
  const maxDurationStatus = session.maxDurationStopAt
    ? `in ${formatDuration(session.maxDurationStopAt - now)}`
    : "Disabled";
  const idleStatus =
    env.RECORDING_IDLE_STOP_MS <= 0
      ? "Disabled"
      : session.idleStopAt
        ? `in ${formatDuration(session.idleStopAt - now)}`
        : "Waiting for silence";

  return createRecordingEmbed(
    "Recording Status",
    "Recording is active.",
  ).addFields(
    { name: "Channel", value: `<#${session.channelId}>`, inline: true },
    { name: "Session ID", value: session.sessionId, inline: true },
    {
      name: "Voice Status",
      value: String(session.connection.state.status),
      inline: true,
    },
    {
      name: "Elapsed",
      value: formatDuration(relativeMs(session.startedAt)),
      inline: true,
    },
    { name: "Max Auto-Stop", value: maxDurationStatus, inline: true },
    { name: "Idle Auto-Stop", value: idleStatus, inline: true },
    {
      name: "Participants",
      value: String(stats.participantsCount),
      inline: true,
    },
    {
      name: "Audio Segments",
      value: String(stats.audioSegmentsCount),
      inline: true,
    },
    {
      name: "Transcribed",
      value: String(stats.transcribedSegmentsCount),
      inline: true,
    },
    {
      name: "Failed",
      value: String(stats.failedSegmentsCount),
      inline: true,
    },
    {
      name: "Transcribing",
      value: String(stats.transcribingSegmentsCount),
      inline: true,
    },
    {
      name: "Active Speaker Streams",
      value: String(session.activeUserStreams.size),
      inline: true,
    },
  );
}

export function createNoActiveRecordingEmbed(): EmbedBuilder {
  return createRecordingEmbed("Recording", "No active recording session.");
}

export function createCompletedEmbed(
  session: ActiveRecordingSession,
  summary: StopSummary,
  title = "Recording Completed",
  description?: string,
): EmbedBuilder {
  const embed = createRecordingEmbed(title).addFields(
    {
      name: "Start Date",
      value: formatUtcDisplay(session.startedAt),
      inline: true,
    },
    {
      name: "End Date",
      value: formatUtcDisplay(summary.completedAt),
      inline: true,
    },
    {
      name: "Participants",
      value: String(summary.stats.participantsCount),
      inline: true,
    },
  );

  if (description) embed.setDescription(description);
  return embed;
}
