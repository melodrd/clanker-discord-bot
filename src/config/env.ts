import { config } from "dotenv";
import { log } from "../utils/log.js";

config();

const maxTimerDelayMs = 2_147_483_647;
const defaultOpenRouterModels = [
  "openai/gpt-oss-120b:free",
  "z-ai/glm-4.5-air:free",
] as const;

const botRequiredEnvVars = [
  "DISCORD_TOKEN",
  "DISCORD_CLIENT_ID",
  "DISCORD_GUILD_ID",
  "DEEPGRAM_API",
  "ALLOWED_DISCORD_USER_IDS",
] as const;

function requireBotEnv(name: (typeof botRequiredEnvVars)[number]): string {
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

function optionalCommaSeparatedList(
  name: string,
  fallback: readonly string[],
): string[] {
  const value = process.env[name]?.trim();
  if (!value) return [...fallback];

  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  if (items.length === 0) {
    throw new Error(`${name} must include at least one value`);
  }

  return [...new Set(items)];
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

function optionalPositiveInteger(
  name: string,
  fallback: number,
  options: { max?: number } = {},
): number {
  const value = process.env[name]?.trim();
  if (!value) return fallback;

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a safe positive integer`);
  }

  if (options.max !== undefined && parsed > options.max) {
    throw new Error(`${name} must be less than or equal to ${options.max}`);
  }

  return parsed;
}

function optionalBoundedNumber(
  name: string,
  fallback: number,
  options: { min: number; max: number },
): number {
  const value = process.env[name]?.trim();
  if (!value) return fallback;

  const parsed = Number(value);
  if (
    !Number.isFinite(parsed) ||
    parsed < options.min ||
    parsed > options.max
  ) {
    throw new Error(
      `${name} must be a finite number between ${options.min} and ${options.max}`,
    );
  }

  return parsed;
}

function optionalString(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

const allowedDiscordUserIds = parseAllowedUserIds(
  process.env.ALLOWED_DISCORD_USER_IDS ?? "",
);

export function validateBotEnv(): void {
  for (const name of botRequiredEnvVars) {
    requireBotEnv(name);
  }

  if (allowedDiscordUserIds.size === 0) {
    log.warn("auth.allowlist.empty", {
      message: "No Discord users are authorized to control recording",
    });
  }

  log.info("env.validated", {
    allowedDiscordUserCount: allowedDiscordUserIds.size,
  });
}

export const env = {
  DISCORD_TOKEN: process.env.DISCORD_TOKEN ?? "",
  DISCORD_CLIENT_ID: process.env.DISCORD_CLIENT_ID ?? "",
  DISCORD_GUILD_ID: process.env.DISCORD_GUILD_ID ?? "",
  DEEPGRAM_API: process.env.DEEPGRAM_API ?? "",
  ALLOWED_DISCORD_USER_IDS: allowedDiscordUserIds,
  DATABASE_PATH: process.env.DATABASE_PATH ?? "./data/clanker.sqlite",
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
  OPENROUTER_API_KEY: optionalString("OPENROUTER_API_KEY"),
  OPENROUTER_MODEL: optionalCommaSeparatedList(
    "OPENROUTER_MODEL",
    defaultOpenRouterModels,
  ),
  OPENROUTER_TIMEOUT_MS: optionalPositiveInteger(
    "OPENROUTER_TIMEOUT_MS",
    120_000,
    { max: maxTimerDelayMs },
  ),
  OPENROUTER_MAX_TOKENS: optionalPositiveInteger(
    "OPENROUTER_MAX_TOKENS",
    100_000,
  ),
  OPENROUTER_TEMPERATURE: optionalBoundedNumber("OPENROUTER_TEMPERATURE", 0.2, {
    min: 0,
    max: 2,
  }),
} as const;
