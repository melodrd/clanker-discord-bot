import {
  type ChatInputCommandInteraction,
  MessageFlags,
  type StageInstance,
} from "discord.js";
import { env } from "../config/env.js";
import type { AppDatabase } from "../db/database.js";
import { log } from "../utils/log.js";
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
import { UserFacingError } from "./errors.js";
import { RecordingSessionManager } from "./session-manager.js";

export class Recorder {
  private readonly sessions: RecordingSessionManager;

  constructor(db: AppDatabase) {
    this.sessions = new RecordingSessionManager(db);
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
    ) {
      return;
    }

    if (subcommand === "start") {
      await this.startRecording(interaction);
      return;
    }

    if (subcommand === "stop") {
      await this.stopRecording(interaction);
      return;
    }

    if (subcommand === "status") {
      await this.showStatus(interaction);
    }
  }

  async shutdown(reason: string): Promise<void> {
    await this.sessions.shutdown(reason);
  }

  async handleStageInstanceDelete(stageInstance: StageInstance): Promise<void> {
    log.info("recording.stage_ended", {
      guildId: stageInstance.guildId,
      channelId: stageInstance.channelId,
      stageInstanceId: stageInstance.id,
    });

    await this.sessions.stopStageSession(
      stageInstance.guildId,
      stageInstance.channelId,
    );
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

  private async startRecording(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    log.info("recording.start_requested", {
      discordUserId: interaction.user.id,
      guildId: interaction.guildId,
    });

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const session = await this.sessions.startRecording(interaction);
      await this.sessions.sendSessionEmbed(
        session,
        createRecordingStartedEmbed(session.sessionId, session.channelId),
      );
      await interaction.deleteReply();
    } catch (error) {
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
    const status = this.sessions.getActiveSessionStatus();
    if (!status) {
      await interaction.reply({
        embeds: [createIdleStatusEmbed()],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      embeds: [createActiveStatusEmbed(status.session, status.stats)],
    });
  }

  private async stopRecording(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    const session = this.sessions.getActiveSession();
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
      const summary = await this.sessions.stopActiveSession(
        session,
        interaction.user.id,
      );
      await this.sessions.sendCompletedSessionMessage(
        session,
        createCompletedEmbed(session, summary),
        summary.completedAt,
      );
      await interaction.deleteReply();
    } catch (_error) {
      await interaction.editReply({
        embeds: [createErrorEmbed("Failed to stop recording cleanly.")],
      });
    }
  }
}
