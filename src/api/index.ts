import { serve } from "@hono/node-server";
import { env } from "../config/env.js";
import { AppDatabase } from "../db/database.js";
import { log } from "../utils/log.js";
import { createApiApp } from "./app.js";

type CloseableServer = {
  close(callback: (error?: Error) => void): void;
};

function closeHttpServer(server: CloseableServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function main(): Promise<void> {
  log.info("api.startup", { nodeVersion: process.version });

  const db = new AppDatabase(env.DATABASE_PATH, { readonly: true });
  const app = createApiApp(db);
  const server = serve(
    {
      fetch: app.fetch,
      hostname: env.API_HOST,
      port: env.API_PORT,
    },
    () => {
      log.info("api.started", {
        host: env.API_HOST,
        port: env.API_PORT,
        databasePath: env.DATABASE_PATH,
      });
    },
  ) as CloseableServer;

  let shuttingDown = false;

  async function shutdown(signal: NodeJS.Signals): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    log.info("api.shutdown_started", { signal });

    const forceExit = setTimeout(() => {
      log.error("api.shutdown_timeout", { signal });
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    try {
      await closeHttpServer(server);
    } catch (error) {
      log.error("api.http_close_failed", { error });
    } finally {
      db.close();
    }

    clearTimeout(forceExit);
    log.info("api.shutdown_completed", { signal });
    process.exit(0);
  }

  process.on("SIGINT", (signal) => {
    void shutdown(signal);
  });

  process.on("SIGTERM", (signal) => {
    void shutdown(signal);
  });

  process.on("unhandledRejection", (reason) => {
    log.error("api.unhandled_rejection", { error: reason });
  });

  process.on("uncaughtException", (error) => {
    log.error("api.uncaught_exception", { error });
    void shutdown("SIGTERM");
  });
}

try {
  await main();
} catch (error) {
  log.error("api.start_failed", { error });
  process.exitCode = 1;
}
