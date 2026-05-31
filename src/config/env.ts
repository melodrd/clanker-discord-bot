import { config } from "dotenv";
import { log } from "../utils/log.js";

config();

const requiredEnvVars = [
  "DISCORD_TOKEN",
  "DISCORD_CLIENT_ID",
  "DISCORD_GUILD_ID",
  "DEEPGRAM_API",
  "ALLOWED_DISCORD_USER_IDS",
] as const;

function requireEnv(name: (typeof requiredEnvVars)[number]): string {
  const value = process.env[name];
  const canBeEmpty = name === "ALLOWED_DISCORD_USER_IDS";

  if (value === undefined || (!canBeEmpty && value.trim() === "")) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function parseAllowedUserIds(value: string): Set<string> {
  return new Set(
    value
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

for (const name of requiredEnvVars) {
  requireEnv(name);
}

const allowedDiscordUserIds = parseAllowedUserIds(process.env.ALLOWED_DISCORD_USER_IDS ?? "");

if (allowedDiscordUserIds.size === 0) {
  log.warn("auth.allowlist.empty", { message: "No Discord users are authorized to control recording" });
}

export const env = {
  DISCORD_TOKEN: requireEnv("DISCORD_TOKEN"),
  DISCORD_CLIENT_ID: requireEnv("DISCORD_CLIENT_ID"),
  DISCORD_GUILD_ID: requireEnv("DISCORD_GUILD_ID"),
  DEEPGRAM_API: requireEnv("DEEPGRAM_API"),
  ALLOWED_DISCORD_USER_IDS: allowedDiscordUserIds,
  DATABASE_PATH: "./data/lituus.sqlite",
  RECORDINGS_DIR: "./recordings",
  DEEPGRAM_LANGUAGE: "en",
  DEEPGRAM_MODEL: "nova-3",
  DEEPGRAM_TIMEOUT_MS: 60_000,
} as const;

log.info("env.validated", { allowedDiscordUserCount: allowedDiscordUserIds.size });
