import { config } from "dotenv";
import { log } from "../utils/log.js";

config();

const maxTimerDelayMs = 2_147_483_647;

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

function optionalNonNegativeInteger(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  if (!value) return fallback;

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }

  if (parsed > maxTimerDelayMs) {
    throw new Error(`${name} must be less than or equal to ${maxTimerDelayMs}`);
  }

  return parsed;
}

for (const name of requiredEnvVars) {
  requireEnv(name);
}

const allowedDiscordUserIds = parseAllowedUserIds(
  process.env.ALLOWED_DISCORD_USER_IDS ?? "",
);

if (allowedDiscordUserIds.size === 0) {
  log.warn("auth.allowlist.empty", {
    message: "No Discord users are authorized to control recording",
  });
}

export const env = {
  DISCORD_TOKEN: requireEnv("DISCORD_TOKEN"),
  DISCORD_CLIENT_ID: requireEnv("DISCORD_CLIENT_ID"),
  DISCORD_GUILD_ID: requireEnv("DISCORD_GUILD_ID"),
  DEEPGRAM_API: requireEnv("DEEPGRAM_API"),
  ALLOWED_DISCORD_USER_IDS: allowedDiscordUserIds,
  DATABASE_PATH: "./data/lituus.sqlite",
  RECORDINGS_DIR: "./recordings",
  RECORDING_MAX_DURATION_MS: optionalNonNegativeInteger(
    "RECORDING_MAX_DURATION_MS",
    4 * 60 * 60 * 1000,
  ),
  RECORDING_IDLE_STOP_MS: optionalNonNegativeInteger(
    "RECORDING_IDLE_STOP_MS",
    15 * 60 * 1000,
  ),
  DEEPGRAM_LANGUAGE: "en",
  DEEPGRAM_MODEL: "nova-3",
  DEEPGRAM_TIMEOUT_MS: 60_000,
} as const;

log.info("env.validated", {
  allowedDiscordUserCount: allowedDiscordUserIds.size,
});
