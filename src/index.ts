import express from "express";
import path from "path";
import type { NextFunction, Request, Response } from "express";
import { env } from "./config/env";
import { runMigrations } from "./db/migrate";
import { closePostgres } from "./db/pool";
import { closeQueues } from "./queue/queues";
import { DlqRouter } from "./queue/dlq-router";
import { closeRedis } from "./redis/connection";
import { DeliveryWorker } from "./worker/delivery";
import healthRouter from "./routes/health";
import mockRouter from "./routes/mock";
import dispatchRouter from "./routes/dispatch";
import statusRouter from "./routes/status";

async function main(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.use("/", healthRouter); // GET /health
  app.use("/", dispatchRouter); // POST /api/webhooks/dispatch
  app.use("/", statusRouter); // GET /api/webhooks/:jobId

  // Mock receivers exist only in development (spec 4.11).
  if (!env.isProduction) {
    app.use("/mock", mockRouter);
  }
  app.use(express.static(path.resolve(process.cwd(), "public")));

  app.use((_req, res) => {
    res.status(404).json({ error: "not found" });
  });

  // Malformed JSON body -> 400 JSON, not an HTML stack trace.
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[api] error:", err.message);
    res.status(400).json({ error: "bad_request", message: err.message });
  });

  const server = app.listen(env.port, () => {
    console.log(`[api] listening on port ${env.port} (${env.nodeEnv})`);
  });

  // Startup checks + auto-migration. On Render free tier the single service must
  // migrate itself; locally the same code path runs via `npm run migrate`.
  try {
    await runMigrations();
    console.log("[db] migrations up to date");
  } catch (err) {
    console.error("[db] migration failed:", (err as Error).message);
    process.exitCode = 1;
    server.close(() => process.exit(1));
    return;
  }

  // Background delivery worker (same process - Render free tier has no
  // dedicated worker service).
  const deliveryWorker = new DeliveryWorker();
  const dlqRouter = new DlqRouter();
  try {
    await deliveryWorker.start();
    await dlqRouter.start();
  } catch (err) {
    console.error("[worker] failed to start:", err);
    process.exitCode = 1;
    server.close(() => process.exit(1));
    return;
  }

  // Graceful shutdown: stop accepting connections, then release resources.
  const shutdown = async (signal: string) => {
    console.log(`[shutdown] received ${signal}`);
    server.close(async () => {
      try {
        await deliveryWorker.close();
        await dlqRouter.close();
        await closeQueues();
        await closeRedis();
        await closePostgres();
        console.log("[shutdown] complete");
        process.exit(0);
      } catch (err) {
        console.error("[shutdown] error during cleanup:", (err as Error).message);
        process.exit(1);
      }
    });
    // Safety valve: if connections refuse to drain in 10s, exit anyway.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[startup] fatal:", err);
  process.exit(1);
});
