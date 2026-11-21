# Distributed Webhook Dispatcher Engine

## 1. Overview
Node.js and TypeScript webhook ingestion and delivery engine using Express, BullMQ, Redis, and PostgreSQL.

## Live Deployment
- **Base URL:** https://webhook-dispatcher-ip95.onrender.com
- **Health Check:** `GET` https://webhook-dispatcher-ip95.onrender.com/health

> **Note:** Hosted on Render's free tier; the first request after inactivity may take ~50 seconds to wake up. Mock receiver routes (`/mock/*`) are intentionally disabled in production (`NODE_ENV=production`)—use external endpoints such as `https://httpbin.org/status/200` (or `/500`, `/404`) when testing against the live URL.

**Quick Live Test:**
```bash
curl -X POST [https://webhook-dispatcher-ip95.onrender.com/api/webhooks/dispatch](https://webhook-dispatcher-ip95.onrender.com/api/webhooks/dispatch) \
  -H "Content-Type: application/json" \
  -d '{"destinationUrl":"[https://httpbin.org/status/200](https://httpbin.org/status/200)","eventId":"live-test-1","payload":{"msg":"hello"}}'
```

## 2. Architecture & Design Choices
- **Non-Blocking Ingestion & Background Execution (Express + BullMQ/Redis):** `POST /api/webhooks/dispatch` only validates the payload and enqueues a job into Redis via BullMQ, returning `202 Accepted` immediately regardless of downstream latency. On Render's free tier, the API and BullMQ worker run in a single Node.js process to fit the single-service constraint while preserving async decoupling.
- **State Persistence (Redis + PostgreSQL):** Redis handles fast, atomic queue state and rate-limiting counters, while PostgreSQL (`delivery_attempts`) stores durable, queryable delivery audit logs (`retrying`, `success`, `failed`, HTTP status codes, attempt counts, and timestamps).
- **Rate Limiting (Atomic Redis Lua Token Bucket):** Chosen over a sliding window because it supports controlled bursts (5-token capacity, 1 token/sec refill per destination hostname) in $O(1)$ memory and prevents race conditions via atomic Lua execution. Deferred jobs do not consume HTTP retry attempts.
- **Error Handling & DLQ:** Retryable failures (`5xx`, `429`, and 5s timeouts) retry up to 3 times with exponential backoff (2s, 4s, 8s). Non-retryable `4xx` errors (such as `404`) fail fast on attempt 1. All terminal failures are copied to `webhook-dlq` for inspection.

## 3. Prerequisites
- Node.js 20+
- Docker and Docker Compose
- PostgreSQL 15/16
- Redis 7+

## 4. Local Setup
```powershell
npm install
npm run migrate
docker compose up -d
npm run dev
```

Copy `.env.example` to `.env` for local defaults.

## 5. Local Services
- API: `http://127.0.0.1:3000`
- PostgreSQL: `127.0.0.1:5433`
- Redis: `127.0.0.1:6379`

## 6. Environment Variables
| Variable | Purpose |
|---|---|
| `PORT` | HTTP port |
| `NODE_ENV` | `development` or `production` |
| `PG_CONNECTION_STRING` | Preferred PostgreSQL connection |
| `PG_HOST`, `PG_PORT`, `PG_DATABASE`, `PG_USER`, `PG_PASSWORD` | Discrete PostgreSQL settings |
| `REDIS_URL` | Preferred Redis connection |
| `REDIS_HOST`, `REDIS_PORT` | Discrete Redis settings |
| `DEV_ALLOWED_LOCAL_HOSTS` | Development-only local destination allowlist |

## 7. API Endpoints
| Method | Path | Behavior |
|---|---|---|
| GET | `/health` | Dependency health and process uptime |
| POST | `/api/webhooks/dispatch` | Validate and enqueue a webhook; returns 202 |
| GET | `/api/webhooks/:jobId` | Return BullMQ, PostgreSQL, and DLQ status |
| POST | `/mock/200` | Development success receiver |
| POST | `/mock/429` | Development retryable 429 receiver |
| POST | `/mock/500` | Development retryable 500 receiver |
| POST | `/mock/delayed` | Development 12-second receiver |

## 8. Dispatch Request
```json
{
  "destinationUrl": "[http://127.0.0.1:3000/mock/200](http://127.0.0.1:3000/mock/200)",
  "eventId": "event-123",
  "payload": { "customerId": "c-1" }
}
```

Responses include `202 { status, jobId }`, `400` validation errors, or `503` queue unavailable.

## 9. Delivery Semantics
Delivery is asynchronous. A duplicate `eventId` is allowed and receives a unique `jobId`. HTTP 2xx is successful; 429 and 5xx are retryable; 3xx and 4xx other than 429 are non-retryable.

## 10. Retry and Timeout Policy
- Maximum HTTP attempts: 4
- Backoff: exponential 2 seconds, 4 seconds, 8 seconds
- HTTP timeout: 5 seconds
- 404 and other non-retryable failures go immediately to the DLQ with one attempt

## 11. Rate Limiting
Each destination hostname has an atomic Redis token bucket: 5 tokens capacity, 1 token per second refill. A deferred rate-limit job does not consume an HTTP attempt.

## 12. PostgreSQL Delivery Logging
Only `retrying`, `success`, and `failed` statuses are stored. Records include job, event, destination, HTTP code, error details, attempt count, and timestamp.

## 13. DLQ Behavior
Terminal failed jobs are copied to `webhook-dlq` using the original jobId, providing duplicate-transfer protection. Status queries report `dlq` until the original or DLQ data is unavailable.

## 14. Health Check
`GET /health` returns 200 when PostgreSQL and Redis are reachable, otherwise 503 with per-dependency details.

## 15. Basic SSRF Protection and Known Limitations
Production mode blocks localhost, loopback, private/link-local/reserved IPv4 and IPv6 targets and rejects unresolved destinations. DNS results are checked; redirects are disabled.

Known limitations: DNS rebinding/TOCTOU is not prevented, DNS names are not rechecked immediately before every outbound socket connection, and there is no redirect-chain validation or destination port allow-list. This is basic SSRF protection, not a complete security boundary.

## 16. Render Free-Tier Preparation
`render.yaml` prepares one free web service with npm build/start commands and the `/health` check. The Express API and BullMQ worker intentionally run in the same process because the free plan is a single web service.

Set `NODE_ENV=production`, `PG_CONNECTION_STRING`, and `REDIS_URL` in Render. Do not use the local `.env` file.

## 17. Render Free-Tier Limitations
Free web services may sleep after inactivity and may lose ephemeral process state. Redis and PostgreSQL persistence and availability depend on the external managed services provisioned by the operator. BullMQ jobs remain only as durable as the Redis provider and PostgreSQL backing data. No guaranteed uptime, zero-downtime deploy, dedicated worker scaling, or horizontal delivery-worker isolation is provided.

## 18. Testing
```powershell
npm test
npm run build
```

The Vitest suite covers dispatch validation and 202/503 behavior, unique IDs and duplicate eventIds, token bucket configuration, retry/timeout classification, DLQ transfer, basic SSRF ranges, and delivery logging.

## 19. Postman
Import `postman.collection.json`, set `baseUrl`, then run the health, dispatch, status, and mock scenarios. Copy the returned `jobId` into the collection's `jobId` variable.