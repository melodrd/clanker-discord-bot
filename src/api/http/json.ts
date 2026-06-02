import type {
  MeetingDetailView,
  MeetingListItem,
  TranscriptSegmentView,
} from "../../db/database.js";

export type HealthResponse = {
  ok: true;
};

export type MeetingsResponse = {
  meetings: MeetingListItem[];
};

export type MeetingResponse = {
  meeting: MeetingDetailView;
};

export type TranscriptResponse = {
  meeting_id: string;
  segments: TranscriptSegmentView[];
};

export function healthResponse(): HealthResponse {
  return { ok: true };
}
