# Trial Project: Martini Queue Gateway (fal-like)

## Background

At Martini, we route image and video generation requests through model endpoints and execute them asynchronously. For this trial, build a minimal **fal-like queue gateway**.

This project should focus on the async queue pattern:

```txt
submit request -> get request_id -> poll status -> retrieve response
```

You do **not** need to integrate real AI models. Mock model endpoints are expected.

Please spend **no more than 12 hours**.

---

# Goal

Build a backend service that exposes a fal-like queue API for asynchronous model inference.

A client should be able to:

```txt
1. Submit a model request to a queue
2. Receive request_id, response_url, status_url, cancel_url
3. Poll request status
4. Optionally include logs while polling
5. Retrieve the final model response after completion
6. Cancel queued or in-progress requests
```

---

# Recommended Stack

Recommended:

```txt
TypeScript
Fastify or Express
Postgres
Redis + BullMQ
Drizzle or Prisma
Docker Compose
```

You may use a different stack if you explain the tradeoffs clearly.

---

# Required API

Use this local base URL in examples:

```txt
http://localhost:3000
```

Your API should mimic fal's queue structure, replacing fal's real domain with localhost.

---

## 1. Submit Request

Implement:

```txt
POST /v1/queue/:model_id
```

Example model IDs:

```txt
martini/image-fast
martini/video-fast
```

So the actual local routes can be:

```txt
POST /v1/queue/martini/image-fast
POST /v1/queue/martini/video-fast
```

Request body should be the model arguments directly, not wrapped in `{ model, input }`.

Example:

```json
{
  "prompt": "a cinematic cat walking through New York at night"
}
```

Response:

```json
{
  "request_id": "req_123",
  "response_url": "http://localhost:3000/v1/queue/martini/image-fast/requests/req_123/response",
  "status_url": "http://localhost:3000/v1/queue/martini/image-fast/requests/req_123/status",
  "cancel_url": "http://localhost:3000/v1/queue/martini/image-fast/requests/req_123/cancel",
  "queue_position": 0
}
```

The HTTP request should return immediately. The model should not run inside the HTTP request handler.

---

## 2. Check Status

Implement:

```txt
GET /v1/queue/:model_id/requests/:request_id/status
```

Support logs via query param:

```txt
GET /v1/queue/:model_id/requests/:request_id/status?logs=1
```

Public queue status must be one of:

```txt
IN_QUEUE
IN_PROGRESS
COMPLETED
```

Do not expose `succeeded`, `failed`, `running`, or `timeout` as public queue statuses.

### IN_QUEUE response

```json
{
  "status": "IN_QUEUE",
  "request_id": "req_123",
  "queue_position": 2,
  "response_url": "http://localhost:3000/v1/queue/martini/image-fast/requests/req_123/response"
}
```

### IN_PROGRESS response

```json
{
  "status": "IN_PROGRESS",
  "request_id": "req_123",
  "response_url": "http://localhost:3000/v1/queue/martini/image-fast/requests/req_123/response",
  "logs": [
    {
      "message": "Loading model weights...",
      "timestamp": "2026-01-01T00:00:02.000Z"
    },
    {
      "message": "Generating image...",
      "timestamp": "2026-01-01T00:00:03.000Z"
    }
  ]
}
```

Only include `logs` when `logs=1`.

### COMPLETED success response

```json
{
  "status": "COMPLETED",
  "request_id": "req_123",
  "response_url": "http://localhost:3000/v1/queue/martini/image-fast/requests/req_123/response",
  "logs": [
    {
      "message": "Done.",
      "timestamp": "2026-01-01T00:00:06.000Z"
    }
  ],
  "metrics": {
    "inference_time": 3.42
  }
}
```

### COMPLETED failure response

A failed request should still return queue status `COMPLETED`, with error fields:

```json
{
  "status": "COMPLETED",
  "request_id": "req_456",
  "response_url": "http://localhost:3000/v1/queue/martini/video-fast/requests/req_456/response",
  "error": "Mock provider failed",
  "error_type": "runner_server_error",
  "metrics": {
    "inference_time": 1.17
  }
}
```

Use simple `error_type` values such as:

```txt
runner_server_error
runner_connection_error
timeout
bad_request
internal_error
client_cancelled
```

---

## 3. Retrieve Response

Implement:

```txt
GET /v1/queue/:model_id/requests/:request_id/response
```

The response shape should be model-specific.

### Image model response

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

### Video model response

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

If the request has not completed yet, return a clear error response. You may choose the exact HTTP status code, but document your choice in the README.

---

## 4. Cancel Request

Implement:

```txt
PUT /v1/queue/:model_id/requests/:request_id/cancel
```

Response cases:

### Cancellation accepted

```http
202 Accepted
```

```json
{
  "status": "CANCELLATION_REQUESTED"
}
```

### Already completed

```http
400 Bad Request
```

```json
{
  "status": "ALREADY_COMPLETED"
}
```

### Not found

```http
404 Not Found
```

```json
{
  "status": "NOT_FOUND"
}
```

Expected behavior:

```txt
If IN_QUEUE:
  Remove the request from the queue and never process it.
If IN_PROGRESS:
  Mark cancellation_requested internally.
  The mock provider may still complete unless you implement cooperative cancellation.
If COMPLETED:
  Return ALREADY_COMPLETED.
```

---

# Required Internals

## 1. Async Worker

The request must be executed by a background worker, not by the HTTP request handler.

Flow:

```txt
POST /v1/queue/:model_id
  -> persist request
  -> enqueue request
  -> return request_id immediately

worker
  -> pick queued request
  -> mark IN_PROGRESS internally
  -> run model endpoint adapter
  -> save response or error
  -> mark externally COMPLETED
```

---

## 2. Persistent Request State

Persist enough data to recover request state after process restart.

At minimum:

```ts
type QueueRequest = {
  request_id: string;
  model_id: string;
  status: "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED";
  arguments: unknown;
  response?: unknown;
  error?: string;
  error_type?: string;
  queue_position?: number;
  metrics?: {
    inference_time?: number;
  };
  created_at: Date;
  started_at?: Date;
  completed_at?: Date;
  cancellation_requested?: boolean;
};
```

You may keep richer internal states if you want, such as:

```txt
queued
running
succeeded
failed
timeout
cancelled
```

But the public API should still expose only:

```txt
IN_QUEUE
IN_PROGRESS
COMPLETED
```

---

## 3. Model Endpoint Adapter Abstraction

Implement at least two model endpoint adapters.

Example:

```txt
martini/image-fast
martini/video-fast
```

Suggested interface:

```ts
type ModelRunContext = {
  request_id: string;
  gateway_request_id: string;
  signal?: AbortSignal;
  log: (message: string) => void;
};

interface ModelEndpointAdapter {
  model_id: string;
  run(
    args: unknown,
    context: ModelRunContext
  ): Promise<{
    response: unknown;
    metrics?: {
      inference_time?: number;
    };
  }>;
}
```

The HTTP layer should not hardcode model execution logic.

---

## 4. Model Registry

Implement a simple model registry.

Example:

```ts
const modelRegistry = {
  "martini/image-fast": {
    adapter: "mock-image-fast",
    request_timeout: 30
  },
  "martini/video-fast": {
    adapter: "mock-video-fast",
    request_timeout: 120
  }
};
```

One mock adapter should be stable. Another should occasionally fail, so error handling and retry behavior can be tested.

---

## 5. Logs

Store request logs.

Each log should look like:

```ts
type RequestLog = {
  request_id: string;
  message: string;
  timestamp: string;
};
```

Only return logs from the status endpoint when the caller passes:

```txt
?logs=1
```

---

## 6. Metrics

At minimum, record:

```txt
metrics.inference_time
```

This should represent time spent executing the mock model adapter, not queue wait time.

Do not put `cost` in the public response as a required field. If you want to track cost, keep it internal or add it as a bonus feature.

---

## 7. Retry Behavior

Implement basic automatic retries for retryable failures.

Default behavior:

```txt
Retry up to 10 total attempts for retryable provider failures.
Keep the same request_id across retries.
Create a new gateway_request_id for each attempt.
```

You can simplify retryable errors to:

```txt
runner_server_error
runner_connection_error
timeout
```

Do not retry:

```txt
bad_request
client_cancelled
```

Store attempts if possible:

```ts
type RequestAttempt = {
  gateway_request_id: string;
  request_id: string;
  model_id: string;
  attempt_number: number;
  status: "started" | "succeeded" | "failed" | "timeout";
  error?: string;
  error_type?: string;
  started_at: Date;
  completed_at?: Date;
};
```

---

# Bonus Features

These are not required, but they are strong signals.

## 1. Webhook

Support webhook delivery on completion.

For REST, support a submit query param:

```txt
POST /v1/queue/martini/image-fast?fal_webhook=https://example.com/webhook
```

When the request completes, send:

### Success webhook

```json
{
  "request_id": "req_123",
  "gateway_request_id": "gwreq_789",
  "status": "OK",
  "payload": {
    "images": [
      {
        "url": "https://example.com/fake-image.png",
        "width": 1024,
        "height": 1024,
        "content_type": "image/png"
      }
    ],
    "seed": 42
  }
}
```

### Error webhook

```json
{
  "request_id": "req_456",
  "gateway_request_id": "gwreq_999",
  "status": "ERROR",
  "error": "Mock provider failed",
  "payload": {
    "detail": "runner_server_error"
  }
}
```

Webhook delivery should be idempotent by `request_id`.

---

## 2. Status Streaming

Implement:

```txt
GET /v1/queue/:model_id/requests/:request_id/status/stream?logs=1
```

Return Server-Sent Events where each event is a status object.

---

## 3. Auth

Support fal-like auth:

```txt
Authorization: Key test_key
```

A hardcoded local test key is fine.

---

## 4. Request Headers

Support one or more fal-like headers.

### Disable retry

```txt
X-Fal-No-Retry: 1
```

When set, do not retry retryable failures.

### Queue priority

```txt
X-Fal-Queue-Priority: normal
X-Fal-Queue-Priority: low
```

Low priority requests should be processed after normal priority requests.

### Start timeout

```txt
X-Fal-Request-Timeout: 30
```

Interpret this as a server-side start timeout: the request should fail before processing if it waits too long to start. It should not limit inference after the worker has already started processing.

---

## 5. Request Storage Toggle

Support:

```txt
X-Fal-Store-IO: 0
```

When set, avoid storing full input/output JSON payloads if possible. It is fine to store enough metadata to debug status.

---

## 6. Model Fallback

Support fallback routing internally.

Example:

```ts
const modelRegistry = {
  "martini/image-fast": {
    primary: "mock-image-fast-a",
    fallbacks: ["mock-image-fast-b"]
  }
};
```

Optional header:

```txt
x-app-fal-disable-fallback: true
```

When set, do not use fallback providers.

---

# Suggested Directory Structure

```txt
src/
  api/
    server.ts
    routes/
      queue.ts
  worker/
    worker.ts
  db/
    schema.ts
    client.ts
  queue/
    enqueue.ts
    position.ts
  models/
    registry.ts
    adapters/
      base.ts
      mockImageFast.ts
      mockVideoFast.ts
  services/
    requestService.ts
    attemptService.ts
    logService.ts
    webhookService.ts
  utils/
    ids.ts
    time.ts
    errors.ts
```

---

# Example curl Commands

## Submit image request

```bash
curl -X POST http://localhost:3000/v1/queue/martini/image-fast \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "a cinematic cat walking through New York at night"
  }'
```

Expected response:

```json
{
  "request_id": "req_123",
  "response_url": "http://localhost:3000/v1/queue/martini/image-fast/requests/req_123/response",
  "status_url": "http://localhost:3000/v1/queue/martini/image-fast/requests/req_123/status",
  "cancel_url": "http://localhost:3000/v1/queue/martini/image-fast/requests/req_123/cancel",
  "queue_position": 0
}
```

## Check status

```bash
curl "http://localhost:3000/v1/queue/martini/image-fast/requests/req_123/status?logs=1"
```

## Retrieve response

```bash
curl http://localhost:3000/v1/queue/martini/image-fast/requests/req_123/response
```

## Cancel request

```bash
curl -X PUT http://localhost:3000/v1/queue/martini/image-fast/requests/req_123/cancel
```

## Submit with webhook

```bash
curl -X POST "http://localhost:3000/v1/queue/martini/image-fast?fal_webhook=https://example.com/webhook" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "a cinematic cat walking through New York at night"
  }'
```

---

# Evaluation Criteria

We will evaluate based on:

```txt
1. fal-like API conventions
2. Async queue execution
3. Correct public status lifecycle
4. Clean model endpoint adapter abstraction
5. Durable request persistence
6. Retry and error handling
7. Logs and metrics
8. Cancel behavior
9. Code quality and modularity
10. README clarity
```

Strong solutions should make it easy to answer:

```txt
How would we add a new model endpoint?
How would we add a new provider behind an existing model?
What happens if a provider fails?
What happens if the worker crashes?
How do retries preserve the same request_id?
How do we distinguish request_id from gateway_request_id?
How do we avoid exposing internal statuses in the public API?
How would this scale to 100k requests per day?
```

---

# What to Submit

Please submit:

```txt
1. GitHub repo
2. README with setup instructions
3. Short architecture explanation
4. Example curl commands
5. Notes on tradeoffs and simplifications
```

The README should include:

```txt
How to run the API
How to run the worker
How to run migrations
How to submit a request
How to poll status
How to retrieve response
How to cancel a request
What is implemented
What is intentionally simplified
What you would improve for production
```

---

# Time Limit

Please spend **no more than 12 hours**.

We are not looking for a complete production clone of fal. We are looking for a thoughtful, well-structured minimal queue gateway that follows fal-like conventions closely.

---

## References

- [Asynchronous Inference — fal](https://fal.ai/docs/documentation/model-apis/inference/queue)
- [Webhooks — fal](https://fal.ai/docs/documentation/model-apis/inference/webhooks)
