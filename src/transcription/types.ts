export type DeepgramTranscription = {
  text: string;
  confidence: number | null;
  requestId: string | null;
  detectedLanguage: string | null;
  rawResponse: unknown;
};
