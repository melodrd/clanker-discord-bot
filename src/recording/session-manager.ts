import {
  entersState,
  joinVoiceChannel,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import {
  AttachmentBuilder,
  ChannelType,
  type ChatInputCommandInteraction,
  type EmbedBuilder,
  PermissionsBitField,
} from "discord.js";
import { env } from "../config/env.js";
import type { AppDatabase, SessionStats } from "../db/database.js";
import { createSessionId } from "../utils/ids.js";
import { log } from "../utils/log.js";
import { nowIso } from "../utils/time.js";
import { createCompletedEmbed } from "./embeds.js";
import { errorMessage, UserFacingError } from "./errors.js";
import { formatDuration } from "./format.js";
import { SegmentFinalizer } from "./segment-finalizer.js";
import { SpeakerCapture } from "./speaker-capture.js";
import { createTranscriptMarkdown } from "./transcript-markdown.js";
import { TranscriptionWorker } from "./transcription-worker.js";
import type {
  ActiveRecordingSession,
  StopSource,
  StopSummary,
} from "./types.js";

const segmentFinalizeTimeoutMs = 5_000;
const unknownStageInstanceCode = 10067;

export type ActiveSessionStatus = {
  session: ActiveRecordingSession;
  stats: SessionStats;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isUnknownStageInstanceError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === unknownStageInstanceCode
  );
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

export class RecordingSessionManager {
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

  getActiveSession(): ActiveRecordingSession | null {
    for (const session of this.activeSessions.values()) {
      return session;
    }

    return null;
  }

  getActiveSessionStatus(): ActiveSessionStatus | null {
    const session = this.getActiveSession();
    if (!session) return null;

    return {
      session,
      stats: this.db.getSessionStats(session.sessionId),
    };
  }

  async startRecording(
    interaction: ChatInputCommandInteraction,
  ): Promise<ActiveRecordingSession> {
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

      try {
        await guild.stageInstances.fetch(channel, { force: true });
      } catch (error) {
        if (isUnknownStageInstanceError(error)) {
          throw new UserFacingError(
            "The Stage must be started before I can start recording.",
          );
        }

        throw error;
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

      return session;
    } catch (error) {
      if (connection) {
        try {
          connection.destroy();
        } catch (destroyError) {
          log.error("voice.connection_destroy_failed", { error: destroyError });
        }
      }

      throw error;
    }
  }

  async stopActiveSession(
    session: ActiveRecordingSession,
    stoppedByDiscordUserId: string,
  ): Promise<StopSummary> {
    return this.stopSession(
      session,
      "manual",
      `Stopped by ${stoppedByDiscordUserId}`,
    );
  }

  async stopStageSession(guildId: string, channelId: string): Promise<boolean> {
    const session = this.getActiveSessionForChannel(guildId, channelId);
    if (!session) return false;

    await this.autoStopRecording(
      session.sessionId,
      "stage_ended",
      "The active Stage was ended",
    );
    return true;
  }

  async sendSessionEmbed(
    session: ActiveRecordingSession,
    embed: EmbedBuilder,
    options: {
      files?: AttachmentBuilder[];
    } = {},
  ): Promise<void> {
    const channel = await session.guild.channels.fetch(session.channelId);
    if (!channel?.isSendable()) {
      throw new Error("Stage channel is not sendable");
    }

    await channel.send({
      embeds: [embed],
      files: options.files,
    });
  }

  async sendCompletedSessionMessage(
    session: ActiveRecordingSession,
    embed: EmbedBuilder,
    completedAt: string,
  ): Promise<void> {
    const transcriptAttachment = this.tryCreateTranscriptAttachment(
      session,
      completedAt,
    );

    await this.sendSessionEmbed(session, embed, {
      files: transcriptAttachment ? [transcriptAttachment] : undefined,
    });
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

  private clearSessionTimers(session: ActiveRecordingSession): void {
    if (session.maxDurationTimer) clearTimeout(session.maxDurationTimer);
    if (session.idleStopTimer) clearTimeout(session.idleStopTimer);

    session.maxDurationTimer = undefined;
    session.idleStopTimer = undefined;
    session.maxDurationStopAt = null;
    session.idleStopAt = null;
  }

  private getActiveSessionForChannel(
    guildId: string,
    channelId: string,
  ): ActiveRecordingSession | null {
    for (const session of this.activeSessions.values()) {
      if (session.guildId === guildId && session.channelId === channelId) {
        return session;
      }
    }

    return null;
  }

  private tryCreateTranscriptAttachment(
    session: ActiveRecordingSession,
    completedAt: string,
  ): AttachmentBuilder | null {
    try {
      return this.createTranscriptAttachment(session, completedAt);
    } catch (error) {
      log.warn("recording.transcript_attachment_failed", {
        sessionId: session.sessionId,
        error,
      });
      return null;
    }
  }

  private createTranscriptAttachment(
    session: ActiveRecordingSession,
    completedAt: string,
  ): AttachmentBuilder | null {
    const rows = this.db.getSessionTranscriptRows(session.sessionId);
    if (rows.length === 0) return null;

    const markdown = createTranscriptMarkdown({
      sessionId: session.sessionId,
      startedAt: session.startedAt,
      completedAt,
      rows,
    });

    return new AttachmentBuilder(Buffer.from(markdown, "utf8"), {
      name: `lituus-transcript-${session.sessionId}.md`,
    });
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
    notify = true,
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
      if (notify) {
        await this.notifyAutoStop(session, source, reason, summary);
      }
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
        : source === "stage_ended"
          ? "Recording Auto-Stopped: Stage Ended"
          : "Recording Auto-Stopped: Idle Timeout";
    const embed = createCompletedEmbed(session, summary, title, reason);

    try {
      await this.sendCompletedSessionMessage(
        session,
        embed,
        summary.completedAt,
      );
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
