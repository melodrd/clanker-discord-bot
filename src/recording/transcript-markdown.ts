import type { SessionTranscriptRow } from "../db/database.js";

export function createTranscriptMarkdown(input: {
  sessionId: string;
  startedAt: string;
  completedAt: string;
  rows: SessionTranscriptRow[];
}): string {
  const lines = [
    "# Meeting Transcript",
    "",
    `Session ID: ${input.sessionId}`,
    `Started at: ${input.startedAt}`,
    `Completed at: ${input.completedAt}`,
    "",
    "---",
    "",
    "## Transcript",
  ];

  for (const row of input.rows) {
    const text = formatTranscriptText(row.text);
    if (text.length === 0) continue;

    lines.push(
      "",
      `### [${formatTimestamp(row.relative_start_ms)}] ${formatSpeakerName(row)}`,
      "",
      text,
    );
  }

  lines.push("");
  return lines.join("\n");
}

function formatSpeakerName(row: SessionTranscriptRow): string {
  return row.display_name ?? row.username ?? row.speaker_label;
}

function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return [hours, minutes, seconds]
    .map((value) => value.toString().padStart(2, "0"))
    .join(":");
}

function formatTranscriptText(text: string): string {
  return text.trim();
}
