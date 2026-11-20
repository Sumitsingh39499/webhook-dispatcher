import { Router } from "express";

/**
 * Mock receiver routes - DEVELOPMENT ONLY.
 *
 * These routes must never be mounted in production (see src/index.ts). They
 * simulate downstream webhook targets for local testing:
 *   POST /mock/200     -> instant success
 *   POST /mock/429     -> too many requests (retryable)
 *   POST /mock/500     -> internal server error (retryable)
 *   POST /mock/delayed -> responds after ~12 seconds (exceeds the 5s timeout)
 */
const router = Router();

router.post("/200", (req, res) => {
  res.status(200).json({ received: true, body: req.body });
});

router.post("/429", (req, res) => {
  res.status(429).set("Retry-After", "2").json({ error: "too many requests" });
});

router.post("/500", (req, res) => {
  res.status(500).json({ error: "internal server error" });
});

router.post("/delayed", (req, res) => {
  setTimeout(() => {
    res.status(200).json({ received: true, delayed: true, body: req.body });
  }, 12_000);
});

export default router;
