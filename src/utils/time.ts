export function nowIso(): string {
  return new Date().toISOString();
}

export function relativeMs(startedAt: string, at = new Date()): number {
  return Math.max(0, at.getTime() - new Date(startedAt).getTime());
}
