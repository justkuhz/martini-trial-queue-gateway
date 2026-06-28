# Project Notes

Selected implementation stack (short decision note):

```txt
Language: TypeScript
HTTP: Fastify
Queue: BullMQ (Redis)
DB: Postgres
ORM: Drizzle (leaner/faster than Prisma for this scope)
Infra: Docker Compose
```

Local base URL configuration for the trial:

```txt
BASE_URL=http://localhost:3000
PORT=3000
```

Bootstrap run commands:

```bash
cp .env.example .env
docker compose up -d
npm run db:generate
npm run db:migrate
npm run dev:api
npm run dev:worker
```

What each command does:

- `cp .env.example .env`: creates your local env file from the template.
- `docker compose up -d`: MAKE SURE DOCKER DAEMON IS RUNNING. starts Postgres and Redis in the background.
- `npm run db:generate`: generates Drizzle migration files from current schema definitions.
- `npm run db:migrate`: applies generated migrations to Postgres.
- `npm run dev:api`: starts the Fastify API server in watch mode.
- `npm run dev:worker`: starts the BullMQ worker in watch mode.

Data models:

- `requests`: one row per `request_id`; stores model id, input/output payloads, public status (`IN_QUEUE | IN_PROGRESS | COMPLETED`), internal status (`queued | running | succeeded | failed | timeout | cancelled`), cancellation flag, metrics, and lifecycle timestamps.
- `request_logs`: append-only logs per request used by the status endpoint when `?logs=1` is provided.
- `request_attempts`: one row per execution attempt; stores `gateway_request_id`, attempt number, attempt status, and error details for retry/debug visibility.
- `error_type` and status enums are normalized in schema to keep worker transitions and API behavior consistent.
- `expires_at` is stored on completed requests for future retention cleanup jobs.

Model mocks and response behavior:

- `martini/image-fast` mock provider returns image-shaped output:

```json
{
  "images": [
    {
      "url": "https://example.com/fake-image.png",
      "width": 1024,
      "height": 1024,
      "content_type": "image/png"
    }
  ],
  "prompt": "a cinematic cat walking through New York at night",
  "seed": 42
}
```

- `martini/video-fast` mock providers return video-shaped output:

```json
{
  "video": {
    "url": "https://example.com/fake-video.mp4",
    "content_type": "video/mp4",
    "file_name": "fake-video.mp4"
  },
  "prompt": "a cinematic cat walking through New York at night",
  "seed": 42
}
```

- `GET /v1/queue/:model_id/requests/:request_id/response` behavior:
  - Returns `200` with model-specific payload when request is completed successfully.
  - Returns `409` with a clear `"Response not ready yet."` error when request is still `IN_QUEUE` or `IN_PROGRESS`.
  - Returns `422` with `error` and `error_type` when request completed with an execution error.

Completion webhooks:

- Submit supports optional webhook query parameter:

```txt
POST /v1/queue/:model_id?fal_webhook=https://example.com/webhook
```

- On completion, service sends:
  - success payload: `{ request_id, gateway_request_id, status: "OK", payload: <model response> }`
  - error payload: `{ request_id, gateway_request_id, status: "ERROR", error, payload: { detail: error_type } }`
- Delivery includes `Idempotency-Key: <request_id>` and is idempotent by `request_id`.

Auth:

- Queue endpoints use fal-like auth with a hardcoded local key:

```txt
Authorization: Key test_key
```

- On auth failure, API returns:
  - `401 Unauthorized`
  - `{ "error": "Unauthorized", "error_type": "authentication_error", ... }`

Request headers:

- Disable retry:

```txt
X-Fal-No-Retry: 1
```

When set, retryable failures are not retried (`attempts=1` for that request).

- Queue priority:

```txt
X-Fal-Queue-Priority: normal
X-Fal-Queue-Priority: low
```

Low-priority requests are enqueued behind normal priority requests.

- Start timeout:

```txt
X-Fal-Request-Timeout: 30
```

Applied as queue wait timeout only. If a request waits too long before worker start, it completes with `timeout`. Once processing starts, this header does not limit inference runtime.

Retention and expiry strategy:

- Completed requests are retained with `expires_at` and cleaned in batches by a periodic retention cycle.
- Deleting an expired `requests` row automatically removes related `request_logs` and `request_attempts` via FK cascade.
- Stuck `running` requests are reconciled to `timeout` if they exceed a safety threshold.
- BullMQ history is kept short-lived (age + count caps) and periodically cleaned for completed/failed jobs.
- Requests that are already expired/deleted are treated as `404 NOT_FOUND` by API endpoints.

Infrastructure and runflow:

- Start infra and apply DB schema:

```bash
docker compose up -d
npm run db:migrate
```

- Start runtime processes in separate terminals:

```bash
npm run dev:api
npm run dev:worker
```

- API startup includes fail-fast dependency checks for DB + queue connectivity.
- Readiness endpoint is available at:

```txt
GET /readyz
```

Expected response:

```json
{
  "ok": true,
  "dependencies": {
    "db": "up",
    "queue": "up"
  }
}
```

Smoke and integration testing:

- Quick smoke test against local stack:

```bash
npm run smoke
```

- Minimal integration test suite for core endpoints:

```bash
npm run test:integration
```

Coverage includes:
- readiness check (`/readyz`)
- image submit -> status polling -> response retrieval lifecycle
- cancel request acceptance behavior
- auth failure behavior (`401` + `authentication_error`)
- `X-Fal-No-Retry` behavior (retryable failure does not retry)
- `X-Fal-Request-Timeout` behavior (fails before start when queue wait exceeds threshold)
- `X-Fal-Queue-Priority` behavior (normal request starts before queued low-priority request)

Verification coverage:

- Public status lifecycle (`IN_QUEUE` -> `IN_PROGRESS` -> `COMPLETED`) via integration polling tests.
- Logs gating behavior (`?logs=1`) validated by status endpoint integration tests.
- Not-ready response behavior validated (`GET .../response` returns clear error before completion).
- SSE status streaming (`GET .../status/stream?logs=1`) validated to emit status objects through completion.
- Retry semantics validated with deterministic mock trigger:
  - same `request_id` is preserved
  - new `gateway_request_id` is created per attempt
- Provider fallback behavior validated in unit tests for `executeModelWithProviders`.
- Completion webhook success/error payloads validated via integration tests using a local webhook receiver.
