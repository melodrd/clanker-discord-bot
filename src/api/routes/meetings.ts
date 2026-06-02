import { Hono } from "hono";
import type { AppDatabase } from "../../db/database.js";
import { meetingNotFound } from "../http/errors.js";
import type {
  MeetingResponse,
  MeetingsResponse,
  TranscriptResponse,
} from "../http/json.js";

function readMeetingId(value: string): string | null {
  const meetingId = value.trim();
  return meetingId ? meetingId : null;
}

export function createMeetingsRoutes(db: AppDatabase): Hono {
  const routes = new Hono();

  routes.get("/", (c) => {
    const body: MeetingsResponse = {
      meetings: db.listMeetings(),
    };

    return c.json(body);
  });

  routes.get("/:meetingId", (c) => {
    const meetingId = readMeetingId(c.req.param("meetingId"));
    if (!meetingId) return c.json(meetingNotFound(), 404);

    const meeting = db.getMeeting(meetingId);
    if (!meeting) return c.json(meetingNotFound(), 404);

    const body: MeetingResponse = { meeting };
    return c.json(body);
  });

  routes.get("/:meetingId/transcript", (c) => {
    const meetingId = readMeetingId(c.req.param("meetingId"));
    if (!meetingId) return c.json(meetingNotFound(), 404);

    const meeting = db.getMeeting(meetingId);
    if (!meeting) return c.json(meetingNotFound(), 404);

    const body: TranscriptResponse = {
      meeting_id: meetingId,
      segments: db.getTranscriptSegments(meetingId),
    };

    return c.json(body);
  });

  return routes;
}
