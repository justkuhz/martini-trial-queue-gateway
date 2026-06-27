#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
MODEL_PATH="${MODEL_PATH:-martini/image-fast}"
PROMPT="${PROMPT:-a cinematic cat walking through New York at night}"

echo "Running smoke test against ${BASE_URL}"

READY_JSON="$(curl -sS "${BASE_URL}/readyz")"
echo "readyz: ${READY_JSON}"

SUBMIT_JSON="$(curl -sS -X POST "${BASE_URL}/v1/queue/${MODEL_PATH}" \
  -H "Content-Type: application/json" \
  -d "{\"prompt\":\"${PROMPT}\"}")"
echo "submit: ${SUBMIT_JSON}"

REQUEST_ID="$(node -e "const j=JSON.parse(process.argv[1]); if(!j.request_id) process.exit(1); process.stdout.write(j.request_id);" "${SUBMIT_JSON}")"
STATUS_URL="$(node -e "const j=JSON.parse(process.argv[1]); process.stdout.write(j.status_url);" "${SUBMIT_JSON}")"
RESPONSE_URL="$(node -e "const j=JSON.parse(process.argv[1]); process.stdout.write(j.response_url);" "${SUBMIT_JSON}")"
CANCEL_URL="$(node -e "const j=JSON.parse(process.argv[1]); process.stdout.write(j.cancel_url);" "${SUBMIT_JSON}")"

echo "request_id: ${REQUEST_ID}"
echo "status_url: ${STATUS_URL}"
echo "response_url: ${RESPONSE_URL}"
echo "cancel_url: ${CANCEL_URL}"

for _ in $(seq 1 30); do
  STATUS_JSON="$(curl -sS "${STATUS_URL}?logs=1")"
  STATUS="$(node -e "const j=JSON.parse(process.argv[1]); process.stdout.write(j.status || 'UNKNOWN');" "${STATUS_JSON}")"
  echo "status: ${STATUS_JSON}"
  if [[ "${STATUS}" == "COMPLETED" ]]; then
    break
  fi
  sleep 1
done

echo "response:"
curl -sS "${RESPONSE_URL}"
echo

echo "smoke test completed"
