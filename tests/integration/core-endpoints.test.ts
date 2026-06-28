import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { Client } from "pg";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const AUTH_KEY = process.env.AUTH_KEY ?? "test_key";
const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5433/martini_queue";
const IMAGE_MODEL = "martini/image-fast";
const VIDEO_MODEL = "martini/video-fast";

type SubmitResponse = {
  request_id: string;
  status_url: string;
  response_url: string;
  cancel_url: string;
};

type CapturedWebhook = {
  path: string;
  body: any;
  headers: http.IncomingHttpHeaders;
};

async function fetchJson(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; body: any }> {
  const headers = new Headers(init?.headers);
  if (!headers.has("authorization")) {
    headers.set("Authorization", `Key ${AUTH_KEY}`);
  }
  const response = await fetch(url, {
    ...init,
    headers,
  });
  const body = await response.json();
  return { status: response.status, body };
}

async function waitForCompletedStatus(
  statusUrl: string,
  timeoutMs = 60_000,
): Promise<any> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const { body } = await fetchJson(`${statusUrl}?logs=1`);
    if (body.status === "COMPLETED") {
      return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error("Timed out waiting for COMPLETED status");
}

async function getAttemptRows(requestId: string): Promise<
  Array<{ gateway_request_id: string; attempt_number: number }>
> {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const result = await client.query(
      `select gateway_request_id, attempt_number
       from request_attempts
       where request_id = $1
       order by attempt_number asc`,
      [requestId],
    );
    return result.rows;
  } finally {
    await client.end();
  }
}

async function readSseUntilCompleted(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Key ${AUTH_KEY}`,
    },
  });
  assert.equal(response.status, 200);
  assert.ok(response.body);

  const decoder = new TextDecoder();
  let combined = "";
  const reader = response.body.getReader();
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    combined += decoder.decode(value, { stream: true });
    if (combined.includes('"status":"COMPLETED"')) {
      return combined;
    }
  }

  throw new Error("Timed out waiting for COMPLETED stream event");
}

async function createWebhookReceiver() {
  const captured: CapturedWebhook[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      captured.push({
        path: req.url ?? "",
        body: rawBody ? JSON.parse(rawBody) : {},
        headers: req.headers,
      });
      res.statusCode = 200;
      res.end("ok");
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to determine webhook receiver address");
  }

  const baseUrl = `http://127.0.0.1:${address.port}/webhook`;
  const close = async () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });

  const waitForRequest = async (
    predicate: (item: CapturedWebhook) => boolean,
    timeoutMs = 60_000,
  ) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const match = captured.find(predicate);
      if (match) {
        return match;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("Timed out waiting for webhook request");
  };

  const getCaptured = () => captured.slice();
  return { baseUrl, close, waitForRequest, getCaptured };
}

test("readyz responds with dependency health", async () => {
  const { status, body } = await fetchJson(`${BASE_URL}/readyz`);
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.dependencies.db, "up");
  assert.equal(body.dependencies.queue, "up");
});

test("auth failure returns 401 with authentication error details", async () => {
  const { status, body } = await fetchJson(`${BASE_URL}/v1/queue/${IMAGE_MODEL}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Key wrong_key",
    },
    body: JSON.stringify({ prompt: "auth failure test prompt" }),
  });

  assert.equal(status, 401);
  assert.equal(body.error, "Unauthorized");
  assert.equal(body.error_type, "authentication_error");
});

test("image submit -> status -> response lifecycle", async () => {
  const submit = await fetchJson(`${BASE_URL}/v1/queue/${IMAGE_MODEL}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "integration test image prompt" }),
  });

  assert.equal(submit.status, 202);
  const submitBody = submit.body as SubmitResponse;
  assert.ok(submitBody.request_id);
  assert.ok(submitBody.status_url);
  assert.ok(submitBody.response_url);
  assert.ok(submitBody.cancel_url);

  const completedStatus = await waitForCompletedStatus(submitBody.status_url);
  assert.equal(completedStatus.status, "COMPLETED");

  const response = await fetchJson(submitBody.response_url);
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.body.images));
  assert.equal(response.body.images[0].content_type, "image/png");
});

test("status endpoint only includes logs when logs=1", async () => {
  const submit = await fetchJson(`${BASE_URL}/v1/queue/${IMAGE_MODEL}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "integration test logs gating prompt" }),
  });

  assert.equal(submit.status, 202);
  const submitBody = submit.body as SubmitResponse;

  const noLogs = await fetchJson(submitBody.status_url);
  assert.equal(noLogs.status, 200);
  assert.equal("logs" in noLogs.body, false);

  const withLogs = await fetchJson(`${submitBody.status_url}?logs=1`);
  assert.equal(withLogs.status, 200);
  assert.ok(Array.isArray(withLogs.body.logs));
});

test("response endpoint returns clear not-ready error before completion", async () => {
  const submit = await fetchJson(`${BASE_URL}/v1/queue/${IMAGE_MODEL}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "integration test not ready response prompt" }),
  });

  assert.equal(submit.status, 202);
  const submitBody = submit.body as SubmitResponse;

  const earlyResponse = await fetchJson(submitBody.response_url);
  assert.ok(earlyResponse.status === 409 || earlyResponse.status === 200);
  if (earlyResponse.status === 409) {
    assert.equal(earlyResponse.body.error, "Response not ready yet.");
  }
});

test("status stream emits status objects and reaches COMPLETED", async () => {
  const submit = await fetchJson(`${BASE_URL}/v1/queue/${IMAGE_MODEL}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "integration test stream prompt" }),
  });

  assert.equal(submit.status, 202);
  const submitBody = submit.body as SubmitResponse;
  const streamUrl = `${submitBody.status_url}/stream?logs=1`;

  const streamOutput = await readSseUntilCompleted(streamUrl);
  assert.ok(streamOutput.includes('"status":"IN_PROGRESS"'));
  assert.ok(streamOutput.includes('"status":"COMPLETED"'));
});

test("retry keeps same request_id and generates new gateway_request_id", async () => {
  const submit = await fetchJson(`${BASE_URL}/v1/queue/${IMAGE_MODEL}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "__force_retry_once integration test image prompt" }),
  });

  assert.equal(submit.status, 202);
  const submitBody = submit.body as SubmitResponse;

  const completedStatus = await waitForCompletedStatus(submitBody.status_url);
  assert.equal(completedStatus.status, "COMPLETED");

  const attempts = await getAttemptRows(submitBody.request_id);
  assert.ok(attempts.length >= 2);
  assert.ok(new Set(attempts.map((a) => a.gateway_request_id)).size >= 2);
  assert.deepEqual(
    attempts.map((a) => a.attempt_number),
    [1, 2],
  );
});

test("cancel request returns accepted status", async () => {
  const submit = await fetchJson(`${BASE_URL}/v1/queue/${VIDEO_MODEL}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "integration test video cancel prompt" }),
  });

  assert.equal(submit.status, 202);
  const submitBody = submit.body as SubmitResponse;
  const cancel = await fetchJson(submitBody.cancel_url, { method: "PUT" });
  assert.equal(cancel.status, 200);
  assert.ok(
    cancel.body.status === "CANCELLATION_REQUESTED" ||
      cancel.body.status === "ALREADY_COMPLETED",
  );
});

test("completion webhook delivers success payload", async () => {
  const webhookReceiver = await createWebhookReceiver();
  try {
    const submit = await fetchJson(
      `${BASE_URL}/v1/queue/${IMAGE_MODEL}?fal_webhook=${encodeURIComponent(webhookReceiver.baseUrl)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "integration test webhook success prompt" }),
      },
    );

    assert.equal(submit.status, 202);
    const submitBody = submit.body as SubmitResponse;
    await waitForCompletedStatus(submitBody.status_url);

    const webhookRequest = await webhookReceiver.waitForRequest(
      (item) => item.body.request_id === submitBody.request_id,
    );
    assert.equal(webhookRequest.body.status, "OK");
    assert.equal(webhookRequest.body.request_id, submitBody.request_id);
    assert.ok(typeof webhookRequest.body.gateway_request_id === "string");
    assert.ok(Array.isArray(webhookRequest.body.payload.images));
    assert.ok(
      webhookRequest.headers["idempotency-key"] === submitBody.request_id,
    );
    // Delivery is idempotent by request_id: we expect a single webhook event per request.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const deliveriesForRequest = webhookReceiver
      .getCaptured()
      .filter((item) => item.body.request_id === submitBody.request_id);
    assert.equal(deliveriesForRequest.length, 1);
  } finally {
    await webhookReceiver.close();
  }
});

test("completion webhook delivers error payload", async () => {
  const webhookReceiver = await createWebhookReceiver();
  try {
    const submit = await fetchJson(
      `${BASE_URL}/v1/queue/${IMAGE_MODEL}?fal_webhook=${encodeURIComponent(webhookReceiver.baseUrl)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "__force_bad_request integration test webhook error prompt",
        }),
      },
    );

    assert.equal(submit.status, 202);
    const submitBody = submit.body as SubmitResponse;
    const status = await waitForCompletedStatus(submitBody.status_url);
    assert.equal(status.status, "COMPLETED");
    assert.equal(status.error_type, "bad_request");

    const webhookRequest = await webhookReceiver.waitForRequest(
      (item) => item.body.request_id === submitBody.request_id,
    );
    assert.equal(webhookRequest.body.status, "ERROR");
    assert.equal(webhookRequest.body.request_id, submitBody.request_id);
    assert.equal(webhookRequest.body.payload.detail, "bad_request");
    assert.ok(typeof webhookRequest.body.gateway_request_id === "string");
    assert.ok(typeof webhookRequest.body.error === "string");
  } finally {
    await webhookReceiver.close();
  }
});
