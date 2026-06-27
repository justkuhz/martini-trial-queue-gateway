import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
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

async function fetchJson(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; body: any }> {
  const response = await fetch(url, init);
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
  const response = await fetch(url);
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

test("readyz responds with dependency health", async () => {
  const { status, body } = await fetchJson(`${BASE_URL}/readyz`);
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.dependencies.db, "up");
  assert.equal(body.dependencies.queue, "up");
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
