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
  type GuildBasedChannel,
  PermissionsBitField,
  type StageChannel,
  type StageInstance,
  type VoiceState,
} from "discord.js";
import { env } from "../config/env.js";
import type { AppDatabase, SessionStats } from "../db/database.js";
import { createMeetingSummary } from "../summarization/meeting-summary.js";
import { createSessionId } from "../utils/ids.js";
import { log } from "../utils/log.js";
import { nowIso } from "../utils/time.js";
import {
  createCompletedEmbed,
  createProcessingRecordingEmbed,
  createRecordingReminderEmbed,
} from "./embeds.js";
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
const maxRecordingReminderUserMentions = 5;
const unknownStageInstanceCode = 10067;

type CompletionAttachmentOptions = {
  onSummaryFailed?: () => void;
};

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

function getStageSpeakerUserIds(channel: StageChannel): string[] {
  return [...channel.members.values()]
    .filter((member) => !member.user.bot)
    .filter((member) => member.voice.channelId === channel.id)
    .filter((member) => member.voice.suppress === false)
    .map((member) => member.id);
}

function getStageParticipantUserIds(channel: StageChannel): string[] {
  return [...channel.members.values()]
    .filter((member) => !member.user.bot)
    .filter((member) => member.voice.channelId === channel.id)
    .map((member) => member.id);
}

function formatUserMentions(userIds: string[]): string {
  return userIds.map((id) => `<@${id}>`).join(" ");
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

      const initialSpeakerUserIds = getStageSpeakerUserIds(channel);
      if (initialSpeakerUserIds.length === 0) {
        log.warn("recording.no_active_stage_speakers", {
          sessionId,
          guildId: guild.id,
          channelId: channel.id,
          startedBy: interaction.user.id,
        });
      } else {
        log.info("recording.initial_stage_speakers", {
          sessionId,
          guildId: guild.id,
          channelId: channel.id,
          speakerCount: initialSpeakerUserIds.length,
          speakerUserIds: initialSpeakerUserIds,
        });
      }
      this.speakerCapture.listenForSpeakers(session, initialSpeakerUserIds);

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

  async stopStageSession(
    guildId: string,
    channelId: string,
  ): Promise<{ session: ActiveRecordingSession; summary: StopSummary } | null> {
    const session = this.getActiveSessionForChannel(guildId, channelId);
    if (!session) return null;

    const summary = await this.stopSession(
      session,
      "stage_ended",
      "The active Stage was ended",
    );
    return { session, summary };
  }

  handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): void {
    if (newState.member?.user.bot) return;
    if (newState.channelId === null) return;
    if (newState.suppress !== false) return;

    const session = this.getActiveSessionForChannel(
      newState.guild.id,
      newState.channelId,
    );
    if (!session) return;

    const becameStageSpeaker =
      oldState.channelId !== newState.channelId || oldState.suppress !== false;
    if (!becameStageSpeaker) return;

    log.info("recording.stage_speaker_detected", {
      sessionId: session.sessionId,
      guildId: session.guildId,
      channelId: session.channelId,
      discordUserId: newState.id,
    });

    this.speakerCapture.captureSpeaker(
      session,
      newState.id,
      "voice_state_update",
    );
  }

  async sendRecordingReminder(stageInstance: StageInstance): Promise<void> {
    const guild = stageInstance.guild;
    if (!guild) {
      log.warn("recording.reminder_guild_unavailable", {
        guildId: stageInstance.guildId,
        channelId: stageInstance.channelId,
        stageInstanceId: stageInstance.id,
      });
      return;
    }

    let channel: GuildBasedChannel | null;

    try {
      channel = await guild.channels.fetch(stageInstance.channelId);
    } catch (error) {
      log.warn("recording.reminder_channel_fetch_failed", {
        guildId: stageInstance.guildId,
        channelId: stageInstance.channelId,
        stageInstanceId: stageInstance.id,
        error,
      });
      return;
    }

    if (!channel || channel.type !== ChannelType.GuildStageVoice) {
      log.warn("recording.reminder_channel_unavailable", {
        guildId: stageInstance.guildId,
        channelId: stageInstance.channelId,
        stageInstanceId: stageInstance.id,
      });
      return;
    }

    if (!channel.isSendable()) {
      log.warn("recording.reminder_channel_not_sendable", {
        guildId: stageInstance.guildId,
        channelId: stageInstance.channelId,
        stageInstanceId: stageInstance.id,
      });
      return;
    }

    const existingSession = this.getActiveSessionForChannel(
      stageInstance.guildId,
      stageInstance.channelId,
    );

    if (existingSession) {
      log.info("recording.reminder_skipped_active_session", {
        sessionId: existingSession.sessionId,
        guildId: stageInstance.guildId,
        channelId: stageInstance.channelId,
      });
      return;
    }

    const mentionedUserIds = getStageParticipantUserIds(channel).slice(
      0,
      maxRecordingReminderUserMentions,
    );
    const reminderContent =
      mentionedUserIds.length > 0
        ? `${formatUserMentions(mentionedUserIds)} Do you want to record this meeting?`
        : "Do you want to record this meeting?";

    try {
      await channel.send({
        content: reminderContent,
        embeds: [createRecordingReminderEmbed(channel.id)],
        allowedMentions:
          mentionedUserIds.length > 0
            ? { users: mentionedUserIds }
            : { parse: [] },
      });
      log.info("recording.reminder_sent", {
        guildId: stageInstance.guildId,
        channelId: stageInstance.channelId,
        stageInstanceId: stageInstance.id,
        mentionedUserCount: mentionedUserIds.length,
      });
    } catch (error) {
      log.warn("recording.reminder_send_failed", {
        guildId: stageInstance.guildId,
        channelId: stageInstance.channelId,
        stageInstanceId: stageInstance.id,
        error,
      });
    }
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
    let summaryFailed = false;
    const attachments = await this.tryCreateCompletionAttachments(
      session,
      completedAt,
      {
        onSummaryFailed: () => {
          summaryFailed = true;
        },
      },
    );

    if (summaryFailed) {
      embed.addFields({
        name: "Summary",
        value: "Summary generation failed; raw transcript attached.",
        inline: false,
      });
    }

    await this.sendSessionEmbed(session, embed, {
      files: attachments.length > 0 ? attachments : undefined,
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

  private async tryCreateCompletionAttachments(
    session: ActiveRecordingSession,
    completedAt: string,
    options: CompletionAttachmentOptions = {},
  ): Promise<AttachmentBuilder[]> {
    try {
      return await this.createCompletionAttachments(
        session,
        completedAt,
        options,
      );
    } catch (error) {
      log.warn("recording.transcript_attachment_failed", {
        sessionId: session.sessionId,
        error,
      });
      return [];
    }
  }

  private async createCompletionAttachments(
    session: ActiveRecordingSession,
    completedAt: string,
    options: CompletionAttachmentOptions = {},
  ): Promise<AttachmentBuilder[]> {
    const rows = this.db.getSessionTranscriptRows(session.sessionId);
    if (rows.length === 0) return [];

    const transcriptMarkdown = createTranscriptMarkdown({
      sessionId: session.sessionId,
      startedAt: session.startedAt,
      completedAt,
      rows,
    });

    const attachments = [
      new AttachmentBuilder(Buffer.from(transcriptMarkdown, "utf8"), {
        name: `clanker-transcript-${session.sessionId}.md`,
      }),
    ];

    const summary = await createMeetingSummary({
      sessionId: session.sessionId,
      transcriptMarkdown,
    });

    if (summary.status === "created") {
      attachments.push(
        new AttachmentBuilder(Buffer.from(summary.markdown, "utf8"), {
          name: `clanker-summary-${session.sessionId}.md`,
        }),
      );
    } else if (summary.status === "failed") {
      options.onSummaryFailed?.();
    }

    return attachments;
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
      await this.sendProcessingSessionMessage(session, source);

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

  private async sendProcessingSessionMessage(
    session: ActiveRecordingSession,
    source: StopSource,
  ): Promise<void> {
    try {
      const channel = await session.guild.channels.fetch(session.channelId);
      if (!channel?.isSendable()) {
        log.warn("recording.processing_notice_channel_unavailable", {
          sessionId: session.sessionId,
          guildId: session.guildId,
          channelId: session.channelId,
        });
        return;
      }

      await channel.send({
        embeds: [createProcessingRecordingEmbed(source)],
      });
      log.info("recording.processing_notice_sent", {
        sessionId: session.sessionId,
        guildId: session.guildId,
        channelId: session.channelId,
        source,
      });
    } catch (error) {
      log.warn("recording.processing_notice_failed", {
        sessionId: session.sessionId,
        guildId: session.guildId,
        channelId: session.channelId,
        source,
        error,
      });
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
