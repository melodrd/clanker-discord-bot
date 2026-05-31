type LogLevel = "info" | "warn" | "error";
type LogMeta = Record<string, unknown>;

const secretKeyPattern = /(token|api.?key|secret|authorization|password)/i;

function formatError(error: Error): LogMeta {
  return {
    errorName: error.name,
    errorMessage: error.message,
    ...(error.stack ? { errorStack: error.stack } : {}),
  };
}

function redactValue(key: string, value: unknown): unknown {
  if (secretKeyPattern.test(key)) {
    return "[redacted]";
  }

  if (value instanceof Error) {
    return formatError(value);
  }

  return value;
}

function stringifyValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return /\s/.test(value) ? JSON.stringify(value) : value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }

  return JSON.stringify(value, (key, nestedValue) => redactValue(key, nestedValue));
}

function flattenMeta(meta: LogMeta): LogMeta {
  const flat: LogMeta = {};

  for (const [key, value] of Object.entries(meta)) {
    const redacted = redactValue(key, value);
    if (redacted && typeof redacted === "object" && !Array.isArray(redacted) && value instanceof Error) {
      Object.assign(flat, redacted);
    } else {
      flat[key] = redacted;
    }
  }

  return flat;
}

function write(level: LogLevel, event: string, meta: LogMeta = {}): void {
  const timestamp = new Date().toISOString();
  const parts = Object.entries(flattenMeta(meta)).map(([key, value]) => `${key}=${stringifyValue(value)}`);
  const line = [timestamp, level.toUpperCase(), event, ...parts].join(" ");

  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const log = {
  info: (event: string, meta?: LogMeta) => write("info", event, meta),
  warn: (event: string, meta?: LogMeta) => write("warn", event, meta),
  error: (event: string, meta?: LogMeta) => write("error", event, meta),
};
