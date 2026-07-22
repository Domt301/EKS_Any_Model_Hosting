#!/usr/bin/env bash
#
# End-to-end smoke test against a deployed pilot. Verifies:
#   1. Public health endpoint responds.
#   2. Unauthenticated app call is rejected (401).
#   3. (Optional, with a token) authenticated model list + a streamed chat.
#
# Usage:
#   scripts/smoke-test.sh [environment]
#   COGNITO_ACCESS_TOKEN=<token> scripts/smoke-test.sh [environment]   # full test
#
# Get a token for a test user with:
#   scripts/get-test-token.sh   (documented in README) — or the AWS hosted UI.
#
# Requires: aws CLI, curl, jq.
set -euo pipefail
cd "$(dirname "$0")/.."

ENVIRONMENT="${1:-dev}"
REGION="${AWS_REGION:-$(aws configure get region 2>/dev/null || echo us-east-1)}"
STACK="LlamaPilot-${ENVIRONMENT}-Eks"

API_BASE="$(aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}" \
  --query "Stacks[0].Outputs[?OutputKey=='ApiBaseUrl'].OutputValue" --output text)"
echo ">> API base URL: ${API_BASE}"

fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }

# 1. Health (public, no auth) ------------------------------------------------
echo ">> [1] GET /health/live"
code="$(curl -s -o /dev/null -w '%{http_code}' "${API_BASE}/health/live")"
[ "${code}" = "200" ] || fail "/health/live returned ${code}, expected 200"
echo "   OK (200)"

# 2. Unauthenticated app call must be rejected -------------------------------
echo ">> [2] GET /api/v1/models without a token (expect 401)"
code="$(curl -s -o /dev/null -w '%{http_code}' "${API_BASE}/api/v1/models")"
[ "${code}" = "401" ] || fail "unauthenticated /api/v1/models returned ${code}, expected 401"
echo "   OK (401)"

# 3. Authenticated path (only if a token is provided) ------------------------
if [ -z "${COGNITO_ACCESS_TOKEN:-}" ]; then
  echo ">> [3] Skipped (set COGNITO_ACCESS_TOKEN to run the authenticated + streaming test)"
  echo "SMOKE PASS (health + auth-rejection)"
  exit 0
fi

AUTH=(-H "Authorization: Bearer ${COGNITO_ACCESS_TOKEN}")

echo ">> [3a] GET /api/v1/models with a token (expect 200 + served model name)"
models="$(curl -s "${AUTH[@]}" "${API_BASE}/api/v1/models")"
echo "${models}" | jq -e '.data[0].id' >/dev/null || fail "models response missing data[].id: ${models}"
echo "   OK: $(echo "${models}" | jq -r '.data[0].id')"

echo ">> [3b] POST /api/v1/chat/completions (streaming SSE)"
body='{"messages":[{"role":"user","content":"Say hello in one short sentence."}],"temperature":0.2,"max_output_tokens":32,"stream":true}'
out="$(curl -sN "${AUTH[@]}" -H 'Content-Type: application/json' \
  -d "${body}" "${API_BASE}/api/v1/chat/completions")"
echo "${out}" | grep -q 'event: token' || fail "no token events in stream: ${out}"
echo "${out}" | grep -q 'event: done'  || fail "stream did not complete (no done event)"
echo "   OK: received token stream and done event"

echo "SMOKE PASS (health + auth + streamed inference)"
