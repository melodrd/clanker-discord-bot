import { randomUUID } from "node:crypto";

export function createId(): string {
  return randomUUID();
}

export function createSessionId(date = new Date()): string {
  return date.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}
