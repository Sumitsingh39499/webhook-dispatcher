import { Router } from "express";
import { checkPostgres } from "../db/pool";
import { checkRedis } from "../redis/connection";

const router = Router();

/**
 * GET /health
 *
 * Verifies PostgreSQL and Redis connectivity and reports basic process info.
 * Returns 200 when all checks pass, 503 when any dependency is unreachable.
 */
router.get("/health", async (_req, res) => {
  const startedAt = Date.now();
  const checks: Record<string, { ok: boolean; error?: string }> = {};

  await Promise.all([
    (async () => {
      try {
        await checkPostgres();
        checks.postgres = { ok: true };
      } catch (err) {
        checks.postgres = { ok: false, error: (err as Error).message };
      }
    })(),
    (async () => {
      try {
        await checkRedis();
        checks.redis = { ok: true };
      } catch (err) {
        checks.redis = { ok: false, error: (err as Error).message };
      }
    })(),
  ]);

  const allOk = Object.values(checks).every((c) => c.ok);

  res.status(allOk ? 200 : 503).json({
    status: allOk ? "ok" : "degraded",
    uptimeSeconds: Math.floor(process.uptime()),
    checks,
    checkedInMs: Date.now() - startedAt,
  });
});

export default router;
