import {
  entersState,
  joinVoiceChannel,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import {
  ChannelType,
  type ChatInputCommandInteraction,
  MessageFlags,
  PermissionsBitField,
} from "discord.js";
import { env } from "../config/env.js";
import type { AppDatabase } from "../db/database.js";
import { createSessionId } from "../utils/ids.js";
import { log } from "../utils/log.js";
import { nowIso } from "../utils/time.js";
import {
  createActiveStatusEmbed,
  createCompletedEmbed,
  createErrorEmbed,
  createIdleStatusEmbed,
  createNoActiveRecordingEmbed,
  createPingEmbed,
  createRecordingStartedEmbed,
  createUnauthorizedEmbed,
} from "./embeds.js";
import { errorMessage, UserFacingError } from "./errors.js";
import { formatDuration } from "./format.js";
import { SegmentFinalizer } from "./segment-finalizer.js";
import { SpeakerCapture } from "./speaker-capture.js";
import { TranscriptionWorker } from "./transcription-worker.js";
import type {
  ActiveRecordingSession,
  StopSource,
  StopSummary,
} from "./types.js";

const segmentFinalizeTimeoutMs = 5_000;

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

export class Recorder {
  private readonly activeSessions = new Map<string, ActiveRecordingSession>();

  private readonly transcriptionWorker: TranscriptionWorker;
  private readonly segmentFinalizer: SegmentFinalizer;
  private readonly speakerCapture: SpeakerCapture;

  constructor(private readonly db: AppDatabase) {
    this.transcriptionWorker = new TranscriptionWorker(db);
    this.segmentFinalizer = new SegmentFinalizer({
      db,
      transcriptionWorker: this.transcriptionWorker,
      onSegmentSettled: (session) => this.scheduleIdleStop(session),
    });
    this.speakerCapture = new SpeakerCapture({
      db,
      segmentFinalizer: this.segmentFinalizer,
      onSpeakerStart: (session) => this.clearIdleStop(session),
      onSpeakerSettled: (session) => this.scheduleIdleStop(session),
    });
  }

  async handleInteraction(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    if (interaction.commandName === "ping") {
      await interaction.reply({ embeds: [createPingEmbed()] });
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
      embeds: [createUnauthorizedEmbed()],
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
      this.speakerCapture.listenForSpeakers(session);

      log.info("recording.started", {
        sessionId,
        guildId: guild.id,
        channelId: channel.id,
        startedBy: interaction.user.id,
      });

      await interaction.editReply({
        embeds: [createRecordingStartedEmbed(sessionId, channel.id)],
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
        embeds: [createErrorEmbed(message)],
      });
    }
  }

  private async showStatus(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    const session = this.getActiveSession();
    if (!session) {
      await interaction.reply({
        embeds: [createIdleStatusEmbed()],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const stats = this.db.getSessionStats(session.sessionId);

    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      embeds: [createActiveStatusEmbed(session, stats)],
    });
  }

  private async stopRecording(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    const session = this.getActiveSession();
    if (!session) {
      await interaction.reply({
        embeds: [createNoActiveRecordingEmbed()],
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
        embeds: [createCompletedEmbed(session, summary)],
      });
    } catch (_error) {
      await interaction.editReply({
        embeds: [createErrorEmbed("Failed to stop recording cleanly.")],
      });
    }
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
    const embed = createCompletedEmbed(session, summary, title, reason);

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
    this.speakerCapture.cancelActiveSegments(session, reason);
  }
}
