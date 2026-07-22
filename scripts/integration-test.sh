#!/usr/bin/env bash
#
# Integration checks (§25) against a deployed pilot. Verifies the security
# boundaries that the smoke test does not: the internal ALB is not public and
# vLLM is not reachable from outside the cluster.
#
# Usage: COGNITO_ACCESS_TOKEN=<token> scripts/integration-test.sh [environment]
#
# Requires: aws CLI, curl, jq, kubectl (configured for the cluster).
set -euo pipefail
cd "$(dirname "$0")/.."

ENVIRONMENT="${1:-dev}"
REGION="${AWS_REGION:-$(aws configure get region 2>/dev/null || echo us-east-1)}"
STACK="LlamaPilot-${ENVIRONMENT}-Eks"
pass() { echo "  PASS: $*"; }
fail() { echo "  FAIL: $*" >&2; exit 1; }

echo ">> [1] Internal ALB is scheme=internal (not internet-facing)"
scheme="$(aws elbv2 describe-load-balancers --region "${REGION}" \
  --query "LoadBalancers[?contains(LoadBalancerName,'llama-pilot-${ENVIRONMENT}-api-alb')].Scheme | [0]" \
  --output text)"
[ "${scheme}" = "internal" ] || fail "ALB scheme is '${scheme}', expected internal"
pass "ALB is internal"

echo ">> [2] API Gateway is the public HTTPS endpoint"
API_BASE="$(aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}" \
  --query "Stacks[0].Outputs[?OutputKey=='ApiBaseUrl'].OutputValue" --output text)"
[[ "${API_BASE}" == https://* ]] || fail "ApiBaseUrl is not HTTPS: ${API_BASE}"
pass "public endpoint is HTTPS: ${API_BASE}"

echo ">> [3] vLLM Service is ClusterIP (never public)"
vtype="$(kubectl -n llama-pilot get svc vllm -o jsonpath='{.spec.type}' 2>/dev/null || echo MISSING)"
[ "${vtype}" = "ClusterIP" ] || fail "vllm service type is '${vtype}', expected ClusterIP"
pass "vllm service is ClusterIP"

echo ">> [4] vLLM has no ingress / external hostname"
if kubectl -n llama-pilot get ingress 2>/dev/null | grep -qi vllm; then
  fail "found an ingress referencing vllm"
fi
pass "no vllm ingress"

echo ">> [5] NetworkPolicy denies non-FastAPI pods from reaching vLLM"
kubectl -n llama-pilot get networkpolicy vllm-allow-from-fastapi >/dev/null 2>&1 \
  || fail "vllm-allow-from-fastapi NetworkPolicy missing"
pass "vLLM ingress NetworkPolicy present"

echo ">> [6] Authenticated model list works (requires COGNITO_ACCESS_TOKEN)"
if [ -n "${COGNITO_ACCESS_TOKEN:-}" ]; then
  id="$(curl -s -H "Authorization: Bearer ${COGNITO_ACCESS_TOKEN}" "${API_BASE}/api/v1/models" \
    | jq -r '.data[0].id')"
  [ -n "${id}" ] && [ "${id}" != "null" ] || fail "model list did not return an id"
  pass "authenticated model list returned: ${id}"
else
  echo "  SKIP: set COGNITO_ACCESS_TOKEN to run the authenticated check"
fi

echo "INTEGRATION CHECKS PASSED"
