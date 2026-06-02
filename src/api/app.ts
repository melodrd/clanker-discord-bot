import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppDatabase } from "../db/database.js";
import { log } from "../utils/log.js";
import { internalError, routeNotFound } from "./http/errors.js";
import { type HealthResponse, healthResponse } from "./http/json.js";
import { createMeetingsRoutes } from "./routes/meetings.js";

const corsOrigins = ["http://localhost:3000", "http://localhost:5173"];

export function createApiApp(db: AppDatabase): Hono {
  const app = new Hono();

  app.use(
    "/api/*",
    cors({
      origin: corsOrigins,
      allowMethods: ["GET", "OPTIONS"],
    }),
  );

  app.get("/api/health", (c) => {
    const body: HealthResponse = healthResponse();
    return c.json(body);
  });

  app.route("/api/meetings", createMeetingsRoutes(db));

  app.onError((error, c) => {
    log.error("api.unexpected_error", { error });
    return c.json(internalError(), 500);
  });

  app.notFound((c) => c.json(routeNotFound(), 404));

  return app;
}
