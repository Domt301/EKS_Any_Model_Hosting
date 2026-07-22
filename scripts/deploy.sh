#!/usr/bin/env bash
#
# Deterministic, idempotent two-phase deploy of the llama pilot.
#
#   Phase 1: build+push the API image, then `cdk deploy --all` (Cognito
#            callback URLs still point at the placeholder origin).
#   Phase 2: resolve the Amplify branch URL, then redeploy Auth + Eks + Amplify
#            with `-c spaRedirectUrl=<amplify-url>` so CORS + Cognito
#            callback/logout allow-lists use the real SPA origin.
#
# Usage: scripts/deploy.sh [environment]   (default: dev)
#
# Requires: aws CLI (authenticated), docker, node/npm, npx cdk.
set -euo pipefail
cd "$(dirname "$0")/.."

ENVIRONMENT="${1:-dev}"
REGION="${AWS_REGION:-$(aws configure get region 2>/dev/null || echo us-east-1)}"
STACK_PREFIX="LlamaPilot-${ENVIRONMENT}"

echo "== llama-pilot deploy (env=${ENVIRONMENT}, region=${REGION}) =="

# --- Preflight: GPU quota reminder ---------------------------------------
cat >&2 <<'EOF'
[preflight] Confirm before deploying:
  - EC2 On-Demand G/VT vCPU quota covers the GPU instance (e.g. g5.xlarge = 4 vCPU).
  - The chosen GPU instance type is available in this region/AZ.
  - The Hugging Face model license is accepted and (if gated) a token secret exists.
EOF

# --- Phase 0: build + push the API image ---------------------------------
IMAGE_TAG="$(scripts/build-api-image.sh "${ENVIRONMENT}" | sed -n 's/^IMAGE_TAG=//p')"
echo ">> API image tag: ${IMAGE_TAG}"

# --- Phase 1: deploy everything ------------------------------------------
echo ">> Phase 1: cdk deploy --all"
npx cdk deploy --all --require-approval never \
  -c "environmentName=${ENVIRONMENT}" \
  -c "apiImageTag=${IMAGE_TAG}"

# --- Resolve the Amplify branch URL --------------------------------------
AMPLIFY_URL="$(aws cloudformation describe-stacks \
  --stack-name "${STACK_PREFIX}-Amplify" --region "${REGION}" \
  --query "Stacks[0].Outputs[?OutputKey=='AmplifyBranchUrl'].OutputValue" \
  --output text)"
echo ">> Amplify branch URL: ${AMPLIFY_URL}"

# --- Phase 2: rewire Cognito callbacks + CORS to the Amplify origin -------
echo ">> Phase 2: redeploy Auth + Eks + Amplify with the resolved SPA origin"
npx cdk deploy \
  "${STACK_PREFIX}-Auth" "${STACK_PREFIX}-Eks" "${STACK_PREFIX}-Amplify" \
  --require-approval never \
  -c "environmentName=${ENVIRONMENT}" \
  -c "apiImageTag=${IMAGE_TAG}" \
  -c "spaRedirectUrl=${AMPLIFY_URL}/"

echo "== Deploy complete. Next: scripts/deploy-spa.sh (or trigger the Amplify build), then scripts/smoke-test.sh =="
echo ">> API base URL:"
aws cloudformation describe-stacks --stack-name "${STACK_PREFIX}-Eks" --region "${REGION}" \
  --query "Stacks[0].Outputs[?OutputKey=='ApiBaseUrl'].OutputValue" --output text
