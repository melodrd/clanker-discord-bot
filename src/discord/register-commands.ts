import { REST, Routes } from "discord.js";
import { env } from "../config/env.js";
import { log } from "../utils/log.js";
import { commandJson } from "./commands.js";

const rest = new REST({ version: "10" }).setToken(env.DISCORD_TOKEN);

try {
  await rest.put(Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, env.DISCORD_GUILD_ID), {
    body: commandJson,
  });

  log.info("discord.commands_registered", {
    clientId: env.DISCORD_CLIENT_ID,
    guildId: env.DISCORD_GUILD_ID,
    commandCount: commandJson.length,
  });
} catch (error) {
  log.error("discord.commands_register_failed", { error });
  process.exitCode = 1;
}
