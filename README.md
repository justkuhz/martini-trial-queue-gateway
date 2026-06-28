# Martini Queue Gateway

A minimal **fal-like async queue gateway** for model inference. Clients submit a
request, immediately get a `request_id` plus status/response/cancel URLs, poll
for status, and retrieve a model-specific response once it completes — exactly
the fal queue pattern:

```txt
submit request -> get request_id -> poll status -> retrieve response
```

Model execution never runs inside the HTTP handler. Requests are persisted to
Postgres and executed by a background BullMQ worker.

---

## Stack

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript | Type-safe domain modeling |
| HTTP | Fastify | Fast, schema-friendly, async hooks |
| Queue | BullMQ (Redis) | Mature retry/backoff/priority primitives |
| DB | Postgres | Durable request state |
| ORM | Drizzle | Lean, typed SQL with explicit migrations |
| Infra | Docker Compose | One command for Postgres + Redis |

---

## Architecture

```txt
              HTTP (Fastify)                         Worker (BullMQ)
  ┌───────────────────────────────┐        ┌──────────────────────────────┐
  │ POST /v1/queue/:model          │        │ pick job                     │
  │   1. validate input (Zod)      │        │  ├ guard: cancelled? timeout?│
  │   2. persist request row  ─────┼──DB────┤  ├ mark IN_PROGRESS (guarded)│
  │   3. enqueue job (jobId=req_id)┼─Redis──┤  ├ start attempt (new gw id) │
  │   4. return 202 + URLs         │        │  ├ run model adapter(s)      │
  └───────────────────────────────┘        │  ├ persist output / error    │
  GET .../status  (reads DB)               │  ├ mark COMPLETED (guarded)  │
  GET .../response (reads DB)              │  └ deliver webhook (claimed) │
  PUT .../cancel  (DB + Redis)             └──────────────────────────────┘
```

- **`request_id`** is the durable identity: it is the Postgres primary key *and*
  the BullMQ `jobId`. It is stable for the life of the request, including across
  all retries.
- **`gateway_request_id`** identifies a single execution **attempt**. A new one
  is minted per attempt and stored in `request_attempts`.
- **Public vs internal status** are separate types. The DB tracks a rich internal
  status (`queued | running | succeeded | failed | timeout | cancelled`); the API
  only ever emits `IN_QUEUE | IN_PROGRESS | COMPLETED` via `toPublicStatus()`.

### Layout

```txt
src/
  api/            Fastify server + queue routes (HTTP only, model-agnostic)
  worker/         BullMQ worker (execution, retries, completion, webhooks)
  db/             Drizzle schema + client
  queue/          enqueue + queue-position lookup
  models/         registry, provider adapters, executeModel (fallback), Zod schemas
  services/       request / attempt / log / webhook / retention / status services
  domain/         status, error, model, url, queue types (single source of truth)
  utils/          id + time helpers
```

---

## Setup & Run

### Prerequisites
- Node 20+
- Docker (for Postgres + Redis) — **make sure the Docker daemon is running**

### 1. Environment

```bash
cp .env.example .env
```

`.env` defaults (Postgres is published on host port **5433** by Compose):

```txt
PORT=3000
BASE_URL=http://localhost:3000
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/martini_queue
REDIS_URL=redis://localhost:6379
QUEUE_NAME=model-requests
```

### 2. Start infrastructure

```bash
docker compose up -d
```

### 3. Run migrations

Migration SQL is generated from the Drizzle schema (the `drizzle/` output dir is
gitignored, so generate first on a fresh clone), then applied:

```bash
npm run db:generate   # generate SQL migrations from src/db/schema.ts
npm run db:migrate    # apply them to Postgres
```

### 4. Run the API

```bash
npm run dev:api       # Fastify on http://localhost:3000 (watch mode)
```

Readiness check (verifies DB + queue connectivity):

```bash
curl http://localhost:3000/readyz
# {"ok":true,"dependencies":{"db":"up","queue":"up"}}
```

### 5. Run the worker

In a separate terminal:

```bash
npm run dev:worker
```

For production, build once and run the compiled output:

```bash
npm run build
npm run start          # API
npm run start:worker   # worker
```

### Tests

```bash
npm run test:unit          # provider fallback logic (no infra needed)
npm run test:integration   # full lifecycle against a running stack
npm run smoke              # quick end-to-end curl script
```

> Auth is required on all `/v1/queue/*` routes. The local key is `test_key`, sent
> as `Authorization: Key test_key`.

---

## Using the API

### Submit a request

```bash
curl -X POST http://localhost:3000/v1/queue/martini/image-fast \
  -H "Authorization: Key test_key" \
  -H "Content-Type: application/json" \
  -d '{ "prompt": "a cinematic cat walking through New York at night" }'
```

The body is the model arguments directly (not wrapped). Returns `202 Accepted`:

```json
{
  "request_id": "req_…",
  "queue_position": 0,
  "response_url": "http://localhost:3000/v1/queue/martini/image-fast/requests/req_…/response",
  "status_url":   "http://localhost:3000/v1/queue/martini/image-fast/requests/req_…/status",
  "cancel_url":   "http://localhost:3000/v1/queue/martini/image-fast/requests/req_…/cancel"
}
```

Available models: `martini/image-fast`, `martini/video-fast`.

### Poll status

```bash
curl -H "Authorization: Key test_key" \
  "http://localhost:3000/v1/queue/martini/image-fast/requests/req_…/status?logs=1"
```

`status` is always one of `IN_QUEUE`, `IN_PROGRESS`, `COMPLETED`. Logs are only
included when `?logs=1` is passed. On completion, `metrics.inference_time` (mock
adapter execution time, not queue wait) is included; a failed request still
returns `COMPLETED` but with `error` and `error_type`.

### Retrieve the response

```bash
curl -H "Authorization: Key test_key" \
  http://localhost:3000/v1/queue/martini/image-fast/requests/req_…/response
```

| Situation | HTTP | Body |
|---|---|---|
| Completed successfully | `200` | model-specific payload (`images` / `video`) |
| Still `IN_QUEUE` / `IN_PROGRESS` | `409` | `{ "error": "Response not ready yet.", "status": … }` |
| Completed with an execution error | `422` | `{ "error", "error_type" }` |

`409` was chosen for "not ready" because the request is valid but the resource is
in a conflicting (incomplete) state — a retryable, non-error condition for the
client, distinct from a real failure (`422`).

### Cancel a request

```bash
curl -X PUT -H "Authorization: Key test_key" \
  http://localhost:3000/v1/queue/martini/image-fast/requests/req_…/cancel
```

| State | HTTP | Body |
|---|---|---|
| Queued or in progress | `202` | `{ "status": "CANCELLATION_REQUESTED" }` |
| Already completed | `400` | `{ "status": "ALREADY_COMPLETED" }` |
| Unknown | `404` | `{ "status": "NOT_FOUND" }` |

If queued, the job is removed from Redis and never runs. If in progress, a
cancellation flag is set; the worker honors it cooperatively at its next
checkpoint.

### Webhook on completion

```bash
curl -X POST "http://localhost:3000/v1/queue/martini/image-fast?fal_webhook=https://example.com/webhook" \
  -H "Authorization: Key test_key" -H "Content-Type: application/json" \
  -d '{ "prompt": "…" }'
```

On completion the gateway POSTs a success (`status: "OK"`) or error
(`status: "ERROR"`) payload with an `Idempotency-Key: <request_id>` header.

### fal-like request headers

| Header | Effect |
|---|---|
| `X-Fal-No-Retry: 1` | Do not retry retryable failures (`attempts=1`). |
| `X-Fal-Queue-Priority: normal\|low` | `low` is processed after `normal`. |
| `X-Fal-Request-Timeout: <seconds>` | Server-side **start** timeout: fail before processing if it waited too long in the queue. Does not bound inference once started. |
| `x-app-fal-disable-fallback: true` | Skip fallback providers; surface the primary failure. |

---

## What is implemented

- All four required endpoints (`submit`, `status`, `response`, `cancel`) with
  fal-like URLs, shapes, and status codes.
- Async execution via BullMQ; the HTTP handler only persists + enqueues.
- Correct public status lifecycle (`IN_QUEUE → IN_PROGRESS → COMPLETED`), with
  internal statuses never leaking.
- Durable persistence in Postgres: `requests`, `request_logs`, `request_attempts`.
- Provider adapter abstraction + registry; two models, with a primary/fallback
  pair behind `martini/video-fast`.
- Automatic retries (up to 10) for retryable errors, preserving `request_id` and
  minting a fresh `gateway_request_id` per attempt; non-retryable errors
  (`bad_request`, `client_cancelled`) are not retried.
- Logs (gated by `?logs=1`) and `metrics.inference_time`.
- Cooperative cancellation (queued removal + in-progress flag).
- **Scalable queue position**: a single indexed Postgres `COUNT` ordered by
  `(priority, queue_seq)` — no full scan of Redis.
- **Bonus**: webhooks (idempotent, with at-least-once retry), SSE status
  streaming (`/status/stream`), `Authorization: Key` auth, priority / no-retry /
  start-timeout / disable-fallback headers, model fallback routing.
- Retention loop: expiring completed rows (FK-cascade to logs/attempts),
  reconciling stuck `running` rows to `timeout`, trimming BullMQ history, and
  retrying undelivered webhooks.
- `/readyz` dependency health check; API fails fast at startup if DB/Redis are down.
- Graceful shutdown: both the API and worker handle `SIGTERM`/`SIGINT` by draining
  in-flight HTTP requests / jobs before closing the queue and DB connections, so a
  deploy or restart never abandons work mid-flight.

---

## What is intentionally simplified

- **Mock adapters**: no real model calls. `martini/video-fast`'s primary fails
  ~25% of the time (and on `__force_*` prompt markers) to exercise retry/fallback.
- **Auth**: a single hardcoded local key, not real key management.
- **Single fixed model registry** in code; no admin API to add models at runtime.
- **Worker concurrency** is a fixed constant (2). Horizontal scaling is by running
  more worker processes; concurrency would be env-driven in production.
- **Start-timeout** is interpreted purely as queue-wait time, checked when the
  worker picks the job up (matches the spec's "before processing" semantics).
- **Cooperative cancellation** only takes effect at worker checkpoints; an
  in-flight mock provider may still finish (as the spec allows).
- **Webhook delivery** retries on a coarse interval (the retention loop), not an
  exponential per-delivery schedule.
- Migrations are regenerated from the schema (`drizzle/` is gitignored) rather
  than committed.

---

## What I would improve for production

- **Webhook delivery as first-class jobs**: move delivery onto its own BullMQ
  queue with per-attempt exponential backoff and a dead-letter queue, instead of
  the retention-loop sweep used here.
- **Configurable concurrency + autoscaling**: env-driven worker concurrency,
  multiple worker deployments, and queue-depth-based scaling.
- **Observability**: structured logs, Prometheus metrics (queue depth, attempt
  counts, p95 inference time, failure rates), and tracing across HTTP → queue →
  worker.
- **Real auth**: API keys per tenant, rate limiting, and per-key quotas.
- **Idempotent submit**: accept a client idempotency key so retried submits don't
  create duplicate requests.
- **Object storage** for real outputs (signed URLs) instead of inline JSON.
- **Partitioning / archival** of `requests` and `request_logs` for high volume,
  plus pushing expiry to a DB TTL/cron rather than app-side batches.
- **Cooperative cancellation** propagated into real providers via the abort signal.

---

## Answers to the evaluation questions

**How would we add a new model endpoint?**
Add a Zod input/output schema in `models/schemas.ts`, write an adapter
implementing `ModelProviderAdapter` (`providerId` + `run(input, ctx)`), and
register one entry in `models/registry.ts` with its `requestTimeoutSeconds`,
`providers`, and schemas. No HTTP or worker changes are needed — the routes and
worker are model-agnostic.

**How would we add a new provider behind an existing model?**
Append another adapter to that model's `providers: []` array in the registry.
`executeModelWithProviders` already iterates primary → fallbacks in order.

**What happens if a provider fails?**
`executeModelWithProviders` falls through to the next provider when the error is
retryable and fallback isn't disabled. If every provider fails, the error
propagates and BullMQ retries the whole job (a new attempt / `gateway_request_id`)
until attempts are exhausted, after which the request completes with the error.

**What happens if the worker crashes?**
All state is in Postgres, not memory. BullMQ redelivers the in-flight job. The
status transitions use guarded writes (`markInProgressIfNotCompleted`,
`markCompletedIfNotCompleted` with `WHERE status != 'COMPLETED'`) so redelivery
can never reopen a terminal request, and completion writes are idempotent. A
retention reconciler also flips abandoned `running` rows to `timeout`.

**How do retries preserve the same request_id?**
`request_id` is both the DB primary key and the BullMQ `jobId`, so retrying the
same job keeps the same id. On a retryable failure the worker rethrows to let
BullMQ retry that same job.

**How do we distinguish request_id from gateway_request_id?**
`request_id` is the durable, client-facing identity for the whole request.
`gateway_request_id` identifies one execution attempt; `startAttempt()` mints a
new one per attempt into `request_attempts` and updates
`requests.latest_gateway_request_id`. Retries share a `request_id` but each get a
distinct `gateway_request_id`.

**How do we avoid exposing internal statuses in the public API?**
The public and internal status sets are distinct types. Persistence keeps the
rich internal status; every API response maps through `toPublicStatus()`, which
only returns `IN_QUEUE | IN_PROGRESS | COMPLETED`. No code path serializes the
internal status.

**How would this scale to 100k requests/day?**
~1.2 req/s average is comfortable. The design scales horizontally by running more
worker processes against the shared Redis queue. Queue position is an indexed
Postgres `COUNT` (`requests_queue_position_idx` on
`internal_status, priority, queue_seq`), not a Redis scan, so it stays cheap under
deep backlogs. Status/response reads are single indexed lookups. The remaining
production work for sustained high volume is listed above (webhook queue,
autoscaling, partitioning/archival, observability).
```
