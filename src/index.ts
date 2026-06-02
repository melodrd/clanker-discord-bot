import { EmbedBuilder, Events, MessageFlags } from "discord.js";
import { env } from "./config/env.js";
import { AppDatabase } from "./db/database.js";
import { client } from "./discord/client.js";
import { Recorder } from "./recording/recorder.js";
import { log } from "./utils/log.js";

log.info("app.startup", { nodeVersion: process.version });

const db = new AppDatabase(env.DATABASE_PATH);
db.markInterruptedSessionsFailed();

const recorder = new Recorder(db);
let shuttingDown = false;

client.once(Events.ClientReady, (readyClient) => {
  log.info("discord.client_ready", {
    clientId: readyClient.user.id,
    username: readyClient.user.username,
  });
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    await recorder.handleInteraction(interaction);
  } catch (error) {
    log.error("discord.interaction_failed", {
      commandName: interaction.commandName,
      discordUserId: interaction.user.id,
      error,
    });

    if (!interaction.isRepliable()) return;

    const content = "Command failed.";
    const errorEmbed = new EmbedBuilder()
      .setTitle("Error")
      .setDescription(content)
      .setColor(0xecabcd);
    if (interaction.deferred || interaction.replied) {
      await interaction
        .editReply({ embeds: [errorEmbed] })
        .catch(() => undefined);
    } else {
      await interaction
        .reply({ embeds: [errorEmbed], flags: MessageFlags.Ephemeral })
        .catch(() => undefined);
    }
  }
});

client.on(Events.StageInstanceDelete, async (stageInstance) => {
  try {
    await recorder.handleStageInstanceDelete(stageInstance);
  } catch (error) {
    log.error("discord.stage_instance_delete_failed", {
      guildId: stageInstance.guildId,
      channelId: stageInstance.channelId,
      stageInstanceId: stageInstance.id,
      error,
    });
  }
});

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  log.info("shutdown.started", { signal });

  const forceExit = setTimeout(() => {
    log.error("shutdown.timeout", { signal });
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  await recorder.shutdown(`Process received ${signal}`);
  client.destroy();
  db.close();

  clearTimeout(forceExit);
  log.info("shutdown.completed", { signal });
  process.exit(0);
}

process.on("SIGINT", (signal) => {
  void shutdown(signal);
});

process.on("SIGTERM", (signal) => {
  void shutdown(signal);
});

process.on("unhandledRejection", (reason) => {
  log.error("process.unhandled_rejection", { error: reason });
});

process.on("uncaughtException", (error) => {
  log.error("process.uncaught_exception", { error });
  void shutdown("SIGTERM");
});

try {
  log.info("discord.login_requested", {
    clientId: env.DISCORD_CLIENT_ID,
    guildId: env.DISCORD_GUILD_ID,
  });
  await client.login(env.DISCORD_TOKEN);
} catch (error) {
  log.error("app.start_failed", { error });
  db.close();
  process.exitCode = 1;
}
