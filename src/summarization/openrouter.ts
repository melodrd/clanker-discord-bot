import { env } from "../config/env.js";

export type OpenRouterChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type OpenRouterCompletionInput = {
  messages: OpenRouterChatMessage[];
  sessionId: string;
};

type OpenRouterResponse = {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
};

const openRouterChatCompletionsUrl =
  "https://openrouter.ai/api/v1/chat/completions";

function stringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function firstChoiceContent(response: unknown): string {
  const responseObject = objectOrNull(response);
  if (!responseObject) {
    throw new Error("OpenRouter response body was malformed: expected object");
  }

  const choices = (response as OpenRouterResponse).choices;
  if (!Array.isArray(choices)) {
    throw new Error(
      "OpenRouter response body was malformed: missing choices array",
    );
  }

  const firstChoice = objectOrNull(choices[0]);
  const message = objectOrNull(firstChoice?.message);
  if (!message) {
    throw new Error(
      "OpenRouter response body was malformed: missing first choice message",
    );
  }

  const content = stringOrNull(message.content);
  if (!content) {
    throw new Error("OpenRouter response content was empty");
  }

  return content;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redactErrorBody(body: string): string {
  const apiKey = env.OPENROUTER_API_KEY;
  const redacted = apiKey ? body.replaceAll(apiKey, "[redacted]") : body;
  return redacted.slice(0, 500);
}

async function readErrorBody(response: Response): Promise<string> {
  const body = await response.text().catch(() => "");
  return redactErrorBody(body);
}

async function readJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new Error(
      `OpenRouter response body was malformed JSON: ${errorMessage(error)}`,
    );
  }
}

export async function createOpenRouterChatCompletion(
  input: OpenRouterCompletionInput,
): Promise<string> {
  if (!env.OPENROUTER_API_KEY) {
    throw new Error("OpenRouter API key is not configured");
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    env.OPENROUTER_TIMEOUT_MS,
  );

  try {
    const response = await fetch(openRouterChatCompletionsUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: env.OPENROUTER_MODEL,
        messages: input.messages,
        temperature: env.OPENROUTER_TEMPERATURE,
        max_tokens: env.OPENROUTER_MAX_TOKENS,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const responseBody = await readErrorBody(response);
      throw new Error(
        `OpenRouter request failed (${response.status}): ${responseBody}`,
      );
    }

    const rawResponse = await readJsonResponse(response);
    return firstChoiceContent(rawResponse);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(
        `OpenRouter request timed out after ${env.OPENROUTER_TIMEOUT_MS} ms`,
      );
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
