import assert from "node:assert/strict";
import test from "node:test";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
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
