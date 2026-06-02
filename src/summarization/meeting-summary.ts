import { env } from "../config/env.js";
import { log } from "../utils/log.js";
import { MEETING_SUMMARY_SYSTEM_PROMPT } from "./meeting-summary-prompt.js";
import { createOpenRouterChatCompletion } from "./openrouter.js";

export type MeetingSummaryInput = {
  sessionId: string;
  transcriptMarkdown: string;
};

export type MeetingSummaryResult =
  | {
      status: "created";
      markdown: string;
    }
  | {
      status: "skipped";
      reason: "missing_api_key" | "empty_transcript";
    }
  | {
      status: "failed";
      error: string;
    };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function createMeetingSummary(
  input: MeetingSummaryInput,
): Promise<MeetingSummaryResult> {
  const transcriptLength = input.transcriptMarkdown.length;

  log.info("summary.requested", {
    sessionId: input.sessionId,
    transcriptLength,
  });

  if (!env.OPENROUTER_API_KEY) {
    log.warn("summary.skipped", {
      sessionId: input.sessionId,
      transcriptLength,
      reason: "missing_api_key",
    });
    return { status: "skipped", reason: "missing_api_key" };
  }

  if (input.transcriptMarkdown.trim().length === 0) {
    log.warn("summary.skipped", {
      sessionId: input.sessionId,
      transcriptLength,
      reason: "empty_transcript",
    });
    return { status: "skipped", reason: "empty_transcript" };
  }

  try {
    const markdown = await createOpenRouterChatCompletion({
      sessionId: input.sessionId,
      messages: [
        { role: "system", content: MEETING_SUMMARY_SYSTEM_PROMPT },
        { role: "user", content: input.transcriptMarkdown },
      ],
    });

    log.info("summary.created", {
      sessionId: input.sessionId,
      transcriptLength,
      summaryLength: markdown.length,
    });

    return { status: "created", markdown };
  } catch (error) {
    const message = errorMessage(error);

    log.warn("summary.failed", {
      sessionId: input.sessionId,
      transcriptLength,
      error: message,
    });

    return { status: "failed", error: message };
  }
}
