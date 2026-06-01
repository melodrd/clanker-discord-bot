import { readFile } from "node:fs/promises";
import { env } from "../config/env.js";
import type { DeepgramTranscription } from "./types.js";

type DeepgramResponse = {
  metadata?: {
    request_id?: unknown;
  };
  results?: {
    detected_language?: unknown;
    channels?: Array<{
      detected_language?: unknown;
      alternatives?: Array<{
        transcript?: unknown;
        confidence?: unknown;
      }>;
    }>;
  };
};

function buildDeepgramUrl(): URL {
  const url = new URL("https://api.deepgram.com/v1/listen");
  url.searchParams.set("model", env.DEEPGRAM_MODEL);
  url.searchParams.set("language", env.DEEPGRAM_LANGUAGE);
  url.searchParams.set("smart_format", "true");
  url.searchParams.set("utterances", "true");
  url.searchParams.set("paragraphs", "true");
  return url;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export async function transcribeOggFile(
  filePath: string,
): Promise<DeepgramTranscription> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.DEEPGRAM_TIMEOUT_MS);

  try {
    const body = await readFile(filePath);
    const response = await fetch(buildDeepgramUrl(), {
      method: "POST",
      headers: {
        Authorization: `Token ${env.DEEPGRAM_API}`,
        "Content-Type": "audio/ogg",
      },
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      const responseBody = await response.text().catch(() => "");
      throw new Error(
        `Deepgram request failed (${response.status}): ${responseBody.slice(0, 500)}`,
      );
    }

    const rawResponse = (await response.json()) as DeepgramResponse;
    const firstChannel = rawResponse.results?.channels?.[0];
    const firstAlternative = firstChannel?.alternatives?.[0];

    return {
      text: stringOrNull(firstAlternative?.transcript) ?? "",
      confidence: numberOrNull(firstAlternative?.confidence),
      requestId:
        response.headers.get("dg-request-id") ??
        response.headers.get("request-id") ??
        stringOrNull(rawResponse.metadata?.request_id),
      detectedLanguage:
        stringOrNull(firstChannel?.detected_language) ??
        stringOrNull(rawResponse.results?.detected_language),
      rawResponse,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(
        `Deepgram request timed out after ${env.DEEPGRAM_TIMEOUT_MS} ms`,
      );
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
