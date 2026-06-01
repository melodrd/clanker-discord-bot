import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, posix } from "node:path";
import type { Readable, Transform } from "node:stream";
import {
  EndBehaviorType,
  entersState,
  joinVoiceChannel,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import {
  ChannelType,
  type ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  PermissionsBitField,
} from "discord.js";
import { env } from "../config/env.js";
import type { AppDatabase, SessionStats } from "../db/database.js";
import { transcribeOggFile } from "../transcription/deepgram.js";
import { createId, createSessionId } from "../utils/ids.js";
import { log } from "../utils/log.js";
import { nowIso, relativeMs } from "../utils/time.js";
import type {
  ActiveRecordingSession,
  ActiveSegment,
  SavedSegment,
} from "./types.js";

const require = createRequire(import.meta.url);
const prism = require("prism-media") as {
  opus: {
    OggLogicalBitstream: new (options: unknown) => Transform;
    OpusHead: new (options: unknown) => unknown;
  };
};

const unauthorizedMessage = "You are not allowed to use recording commands.";
const segmentFinalizeTimeoutMs = 5_000;
const defaultEmbedColor = 0x2ae7a8;

type StopSource = "manual" | "max_duration" | "idle_timeout";

type StopSummary = {
  completedAt: string;
  stats: SessionStats;
};

class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserFacingError";
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function errorMessage(error: unknown): string {
  return toError(error).message;
}

function createOggStream(): Transform {
  return new prism.opus.OggLogicalBitstream({
    opusHead: new prism.opus.OpusHead({
      channelCount: 2,
      sampleRate: 48_000,
    }),
    pageSizeControl: {
      maxPackets: 10,
    },
  });
}

function waitForWritableClose(
  receiveStream: Readable,
  oggStream: Transform,
  outputStream: NodeJS.WritableStream,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      outputStream.off("finish", done);
      outputStream.off("close", done);
      outputStream.off("error", fail);
      oggStream.off("error", fail);
      receiveStream.off("error", fail);
    };

    const done = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(toError(error));
    };

    outputStream.once("finish", done);
    outputStream.once("close", done);
    outputStream.once("error", fail);
    oggStream.once("error", fail);
    receiveStream.once("error", fail);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTaskSetToDrain(
  tasks: Set<Promise<void>>,
  timeoutMs?: number,
): Promise<boolean> {
  const startedAt = Date.now();

  while (tasks.size > 0) {
    const snapshot = Promise.allSettled([...tasks]).then(() => true);

    if (timeoutMs === undefined) {
      await snapshot;
      continue;
    }

    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) return false;

    const drained = await Promise.race([
      snapshot,
      sleep(remainingMs).then(() => false),
    ]);
    if (!drained) return false;
  }

  return true;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}

function formatUtcDisplay(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return `${iso} UTC`;
  return parsed.toISOString().replace("T", " ").replace(".000Z", " UTC");
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export class Recorder {
  private readonly activeSessions = new Map<string, ActiveRecordingSession>();

  constructor(private readonly db: AppDatabase) {}

  private createEmbed(title: string, description?: string): EmbedBuilder {
    const embed = new EmbedBuilder()
      .setTitle(title)
      .setColor(defaultEmbedColor);
    if (description) embed.setDescription(description);
    return embed;
  }

  async handleInteraction(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    if (interaction.commandName === "ping") {
      await interaction.reply({ embeds: [this.createEmbed("Pong")] });
      return;
    }

    if (interaction.commandName !== "record") return;

    const subcommand = interaction.options.getSubcommand();
    if (
      !(await this.authorizeRecordingInteraction(
        interaction,
        `/record ${subcommand}`,
      ))
    )
      return;

    if (subcommand === "start") {
      await this.startRecording(interaction);
    } else if (subcommand === "stop") {
      await this.stopRecording(interaction);
    } else if (subcommand === "status") {
      await this.showStatus(interaction);
    }
  }

  async shutdown(reason: string): Promise<void> {
    const timestamp = nowIso();

    for (const session of this.activeSessions.values()) {
      session.stopping = true;
      this.clearSessionTimers(session);
      this.cancelActiveSegments(session, reason);

      try {
        this.db.updateRecordingSessionStatus(session.sessionId, "failed", {
          stoppedAt: timestamp,
          completedAt: timestamp,
          error: reason,
        });
      } catch (error) {
        log.error("recording.shutdown_db_failed", {
          sessionId: session.sessionId,
          error,
        });
      }

      try {
        session.connection.destroy();
      } catch (error) {
        log.error("voice.connection_destroy_failed", {
          sessionId: session.sessionId,
          error,
        });
      }
    }

    this.activeSessions.clear();
  }

  private async authorizeRecordingInteraction(
    interaction: ChatInputCommandInteraction,
    commandName: string,
  ): Promise<boolean> {
    if (env.ALLOWED_DISCORD_USER_IDS.has(interaction.user.id)) {
      return true;
    }

    log.warn("recording.unauthorized", {
      discordUserId: interaction.user.id,
      commandName,
    });

    await interaction.reply({
      embeds: [this.createEmbed("Unauthorized", unauthorizedMessage)],
      flags: MessageFlags.Ephemeral,
    });
    return false;
  }

  private getActiveSession(): ActiveRecordingSession | null {
    for (const session of this.activeSessions.values()) {
      return session;
    }

    return null;
  }

  private clearSessionTimers(session: ActiveRecordingSession): void {
    if (session.maxDurationTimer) clearTimeout(session.maxDurationTimer);
    if (session.idleStopTimer) clearTimeout(session.idleStopTimer);

    session.maxDurationTimer = undefined;
    session.idleStopTimer = undefined;
    session.maxDurationStopAt = null;
    session.idleStopAt = null;
  }

  private clearIdleStop(session: ActiveRecordingSession): void {
    if (session.idleStopTimer) clearTimeout(session.idleStopTimer);
    session.idleStopTimer = undefined;
    session.idleStopAt = null;
  }

  private scheduleMaxDurationStop(session: ActiveRecordingSession): void {
    if (env.RECORDING_MAX_DURATION_MS <= 0) return;

    session.maxDurationStopAt = Date.now() + env.RECORDING_MAX_DURATION_MS;
    session.maxDurationTimer = setTimeout(() => {
      void this.autoStopRecording(
        session.sessionId,
        "max_duration",
        `Maximum recording duration reached (${formatDuration(env.RECORDING_MAX_DURATION_MS)})`,
      );
    }, env.RECORDING_MAX_DURATION_MS);
    session.maxDurationTimer.unref();
  }

  private scheduleIdleStop(session: ActiveRecordingSession): void {
    this.clearIdleStop(session);

    if (
      env.RECORDING_IDLE_STOP_MS <= 0 ||
      session.stopping ||
      session.activeUserStreams.size > 0 ||
      session.startingUserIds.size > 0
    ) {
      return;
    }

    session.idleStopAt = Date.now() + env.RECORDING_IDLE_STOP_MS;
    session.idleStopTimer = setTimeout(() => {
      void this.autoStopRecording(
        session.sessionId,
        "idle_timeout",
        `No active speakers for ${formatDuration(env.RECORDING_IDLE_STOP_MS)}`,
      );
    }, env.RECORDING_IDLE_STOP_MS);
    session.idleStopTimer.unref();
  }

  private async autoStopRecording(
    sessionId: string,
    source: Exclude<StopSource, "manual">,
    reason: string,
  ): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    log.warn("recording.auto_stop_requested", {
      sessionId: session.sessionId,
      guildId: session.guildId,
      channelId: session.channelId,
      source,
      reason,
    });

    try {
      const summary = await this.stopSession(session, source, reason);
      await this.notifyAutoStop(session, source, reason, summary);
    } catch (error) {
      log.error("recording.auto_stop_failed", {
        sessionId: session.sessionId,
        guildId: session.guildId,
        channelId: session.channelId,
        source,
        reason,
        error,
      });
    }
  }

  private async startRecording(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    log.info("recording.start_requested", {
      discordUserId: interaction.user.id,
      guildId: interaction.guildId,
    });

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    let connection: ReturnType<typeof joinVoiceChannel> | null = null;

    try {
      if (!interaction.inGuild() || interaction.guildId === null) {
        throw new UserFacingError(
          "Recording commands can only be used inside a server.",
        );
      }

      const existingSession = this.getActiveSession();
      if (existingSession) {
        throw new UserFacingError(
          `A recording is already active. Session ID: ${existingSession.sessionId}`,
        );
      }

      const guild =
        interaction.guild ??
        (await interaction.client.guilds.fetch(interaction.guildId));
      const member = await guild.members.fetch(interaction.user.id);
      const channel = member.voice.channel;

      if (!channel || channel.type !== ChannelType.GuildStageVoice) {
        throw new UserFacingError(
          "You must be in a Discord Stage channel to start recording.",
        );
      }

      const botMember = guild.members.me ?? (await guild.members.fetchMe());
      const permissions = channel.permissionsFor(botMember);

      if (!permissions?.has(PermissionsBitField.Flags.ViewChannel)) {
        throw new UserFacingError(
          "I need View Channel permission for that Stage channel.",
        );
      }

      if (!permissions.has(PermissionsBitField.Flags.Connect)) {
        throw new UserFacingError(
          "I need Connect permission for that Stage channel.",
        );
      }

      const startedAtDate = new Date();
      const startedAt = startedAtDate.toISOString();
      const sessionId = createSessionId(startedAtDate);

      connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfMute: true,
        selfDeaf: false,
      });

      connection.on("error", (error) => {
        log.error("voice.connection_error", {
          sessionId,
          guildId: guild.id,
          channelId: channel.id,
          error,
        });
      });

      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);

      this.db.createRecordingSession({
        id: sessionId,
        guildId: guild.id,
        channelId: channel.id,
        startedByDiscordUserId: interaction.user.id,
        startedAt,
      });

      const session: ActiveRecordingSession = {
        sessionId,
        guildId: guild.id,
        channelId: channel.id,
        startedByDiscordUserId: interaction.user.id,
        startedAt,
        guild,
        connection,
        activeUserStreams: new Map(),
        startingUserIds: new Set(),
        segmentTasks: new Set(),
        transcriptionTasks: new Set(),
        cancelledSegmentIds: new Set(),
        maxDurationStopAt: null,
        idleStopAt: null,
        stopping: false,
      };

      this.activeSessions.set(sessionId, session);
      this.scheduleMaxDurationStop(session);
      this.scheduleIdleStop(session);
      this.listenForSpeakers(session);

      log.info("recording.started", {
        sessionId,
        guildId: guild.id,
        channelId: channel.id,
        startedBy: interaction.user.id,
      });

      await interaction.editReply({
        embeds: [
          this.createEmbed("Recording Started").addFields(
            { name: "Session ID", value: sessionId, inline: true },
            { name: "Channel", value: `<#${channel.id}>`, inline: true },
          ),
        ],
      });
    } catch (error) {
      if (connection) {
        try {
          connection.destroy();
        } catch (destroyError) {
          log.error("voice.connection_destroy_failed", { error: destroyError });
        }
      }

      log.error("recording.start_failed", {
        discordUserId: interaction.user.id,
        guildId: interaction.guildId,
        error,
      });

      const message =
        error instanceof UserFacingError
          ? error.message
          : "Failed to start recording.";
      await interaction.editReply({
        embeds: [this.createEmbed("Error", message)],
      });
    }
  }

  private listenForSpeakers(session: ActiveRecordingSession): void {
    session.connection.receiver.speaking.on("start", (discordUserId) => {
      void this.handleSpeakerStart(session, discordUserId);
    });
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
    this.clearIdleStop(session);

    let segmentId: string | null = null;

    try {
      const speaker = await this.resolveSpeaker(session, discordUserId);
      const participant = this.db.upsertParticipant({
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

      this.db.createAudioSegment({
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

      const task = this.finalizeSegment(
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
        this.db.markAudioSegmentFailed(segmentId, errorMessage(error));
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
      this.scheduleIdleStop(session);
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

  private async finalizeSegment(
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
        this.db.markAudioSegmentFailed(
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

      this.db.markAudioSegmentSaved({
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

      this.scheduleTranscription(session, {
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
        this.db.markAudioSegmentFailed(segment.segmentId, errorMessage(error));
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
      this.scheduleIdleStop(session);
    }
  }

  private scheduleTranscription(
    session: ActiveRecordingSession,
    segment: SavedSegment,
  ): void {
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

  private async showStatus(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    const session = this.getActiveSession();
    if (!session) {
      const idleEmbed = new EmbedBuilder()
        .setTitle("Recording Status")
        .setDescription("Recording is currently idle.")
        .setColor(defaultEmbedColor);

      await interaction.reply({
        embeds: [idleEmbed],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const stats = this.db.getSessionStats(session.sessionId);
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

    const statusEmbed = new EmbedBuilder()
      .setTitle("Recording Status")
      .setDescription("Recording is active.")
      .setColor(defaultEmbedColor)
      .addFields(
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

    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      embeds: [statusEmbed],
    });
  }

  private async stopRecording(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    const session = this.getActiveSession();
    if (!session) {
      await interaction.reply({
        embeds: [this.createEmbed("Recording", "No active recording session.")],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    log.info("recording.stop_requested", {
      sessionId: session.sessionId,
      guildId: session.guildId,
      channelId: session.channelId,
      discordUserId: interaction.user.id,
    });

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const summary = await this.stopSession(
        session,
        "manual",
        `Stopped by ${interaction.user.id}`,
      );
      await interaction.editReply({
        embeds: [this.createCompletedEmbed(session, summary)],
      });
    } catch (_error) {
      await interaction.editReply({
        embeds: [
          this.createEmbed("Error", "Failed to stop recording cleanly."),
        ],
      });
    }
  }

  private createCompletedEmbed(
    session: ActiveRecordingSession,
    summary: StopSummary,
    title = "Recording Completed",
    description?: string,
  ): EmbedBuilder {
    const embed = new EmbedBuilder()
      .setTitle(title)
      .setColor(defaultEmbedColor)
      .addFields(
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

  private async stopSession(
    session: ActiveRecordingSession,
    source: StopSource,
    reason: string,
  ): Promise<StopSummary> {
    try {
      const stoppedAt = nowIso();
      session.stopping = true;
      this.clearSessionTimers(session);
      this.db.updateRecordingSessionStatus(session.sessionId, "stopping", {
        stoppedAt,
      });

      try {
        session.connection.destroy();
      } catch (error) {
        log.error("voice.connection_destroy_failed", {
          sessionId: session.sessionId,
          error,
        });
      }

      this.activeSessions.delete(session.sessionId);

      log.info("recording.stopped", {
        sessionId: session.sessionId,
        guildId: session.guildId,
        channelId: session.channelId,
        source,
        reason,
      });

      const segmentsFinalized = await waitForTaskSetToDrain(
        session.segmentTasks,
        segmentFinalizeTimeoutMs,
      );
      if (!segmentsFinalized) {
        this.cancelActiveSegments(
          session,
          "Recording stopped before segment finalized",
        );
      }

      this.db.updateRecordingSessionStatus(session.sessionId, "transcribing");
      await waitForTaskSetToDrain(session.transcriptionTasks);

      const completedAt = nowIso();
      this.db.updateRecordingSessionStatus(session.sessionId, "completed", {
        completedAt,
      });
      const stats = this.db.getSessionStats(session.sessionId);

      log.info("session.completed", {
        sessionId: session.sessionId,
        guildId: session.guildId,
        channelId: session.channelId,
        source,
        participantsCount: stats.participantsCount,
        audioSegmentsCount: stats.audioSegmentsCount,
        transcribedSegmentsCount: stats.transcribedSegmentsCount,
        failedSegmentsCount: stats.failedSegmentsCount,
      });

      return { completedAt, stats };
    } catch (error) {
      this.clearSessionTimers(session);
      this.activeSessions.delete(session.sessionId);
      this.db.updateRecordingSessionStatus(session.sessionId, "failed", {
        completedAt: nowIso(),
        error: errorMessage(error),
      });

      log.error("recording.stop_failed", {
        sessionId: session.sessionId,
        guildId: session.guildId,
        channelId: session.channelId,
        source,
        reason,
        error,
      });

      throw error;
    }
  }

  private async notifyAutoStop(
    session: ActiveRecordingSession,
    source: Exclude<StopSource, "manual">,
    reason: string,
    summary: StopSummary,
  ): Promise<void> {
    const title =
      source === "max_duration"
        ? "Recording Auto-Stopped: Max Duration"
        : "Recording Auto-Stopped: Idle Timeout";
    const embed = this.createCompletedEmbed(session, summary, title, reason);

    try {
      const user = await session.guild.client.users.fetch(
        session.startedByDiscordUserId,
      );
      await user.send({ embeds: [embed] });
    } catch (error) {
      log.warn("recording.auto_stop_notify_failed", {
        sessionId: session.sessionId,
        guildId: session.guildId,
        channelId: session.channelId,
        startedByDiscordUserId: session.startedByDiscordUserId,
        error,
      });
    }
  }

  private cancelActiveSegments(
    session: ActiveRecordingSession,
    reason: string,
  ): void {
    for (const [
      discordUserId,
      segment,
    ] of session.activeUserStreams.entries()) {
      session.cancelledSegmentIds.add(segment.segmentId);

      try {
        this.db.markAudioSegmentFailed(segment.segmentId, reason);
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
}
