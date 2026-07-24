#!/usr/bin/env bash
#
# Deterministic, idempotent deploy of the llama pilot. Safe to re-run: every
# phase is a no-op when already up to date.
#
#   Phase 0: deploy the Container stack first so the ECR repository exists
#            before we push the API image (breaks the chicken-and-egg on a
#            brand-new account).
#   Phase 1: build + push the API image (skipped if the tag already exists).
#   Phase 2: `cdk deploy --all` (Cognito callbacks still at the placeholder).
#   Phase 3: resolve the Amplify branch URL, then redeploy Auth + Eks + Amplify
#            with `-c spaRedirectUrl=<amplify-url>` so CORS + Cognito
#            callback/logout allow-lists use the real SPA origin.
#   Phase 4: build + publish the SPA to Amplify Hosting (manual zip deploy).
#
# Usage: scripts/deploy.sh [environment]   (default: dev)
#
# Requires: aws CLI (authenticated), docker, node/npm, npx cdk, jq, zip.
set -euo pipefail
cd "$(dirname "$0")/.."

ENVIRONMENT="${1:-dev}"
REGION="${AWS_REGION:-$(aws configure get region 2>/dev/null || echo us-east-1)}"
export AWS_REGION="${REGION}"
# CloudFormation stack names use dashes (LlamaPilot-dev-Amplify); `cdk deploy`
# targets the hierarchical construct path with a slash (LlamaPilot-dev/Amplify).
STACK_PREFIX="LlamaPilot-${ENVIRONMENT}"
STACK_PATH="LlamaPilot-${ENVIRONMENT}"
CTX=(-c "environmentName=${ENVIRONMENT}")

echo "== llama-pilot deploy (env=${ENVIRONMENT}, region=${REGION}) =="

# --- Preflight ------------------------------------------------------------
cat >&2 <<'EOF'
[preflight] Confirm before deploying:
  - EC2 On-Demand G/VT vCPU quota covers the GPU instance (e.g. g5.xlarge = 4 vCPU).
  - The chosen GPU instance type is available in this region/AZ.
  - The model is ungated (pilot default) OR its HF token secret exists.
EOF

# --- Phase 0: ECR first ---------------------------------------------------
echo ">> Phase 0: deploy Container stack (ECR) so the image has a home"
npx cdk deploy "${STACK_PATH}/Container" --require-approval never "${CTX[@]}"

# --- Phase 1: build + push the API image ---------------------------------
IMAGE_TAG="$(scripts/build-api-image.sh "${ENVIRONMENT}" | sed -n 's/^IMAGE_TAG=//p')"
echo ">> API image tag: ${IMAGE_TAG}"

# --- Phase 2: deploy everything ------------------------------------------
# Stacks live inside a Stage sub-assembly. `--all` sees only the main assembly
# (nothing), and a `/*` glob was observed to return after the dependency-free
# stacks without deploying Eks/Amplify. List every stack explicitly, in
# dependency order, and deploy sequentially so nothing is skipped.
echo ">> Phase 2: cdk deploy all stage stacks (explicit, sequential)"
npx cdk deploy \
  "${STACK_PATH}/Network" "${STACK_PATH}/Auth" "${STACK_PATH}/Container" \
  "${STACK_PATH}/Eks" "${STACK_PATH}/Amplify" \
  --require-approval never --concurrency 1 "${CTX[@]}" -c "apiImageTag=${IMAGE_TAG}"

# --- Resolve the Amplify branch URL --------------------------------------
AMPLIFY_URL="$(aws cloudformation describe-stacks \
  --stack-name "${STACK_PREFIX}-Amplify" --region "${REGION}" \
  --query "Stacks[0].Outputs[?OutputKey=='AmplifyBranchUrl'].OutputValue" \
  --output text)"
echo ">> Amplify branch URL: ${AMPLIFY_URL}"

# --- Phase 3: rewire Cognito callbacks + CORS to the Amplify origin -------
echo ">> Phase 3: redeploy Auth + Eks + Amplify with the resolved SPA origin"
npx cdk deploy \
  "${STACK_PATH}/Auth" "${STACK_PATH}/Eks" "${STACK_PATH}/Amplify" \
  --require-approval never "${CTX[@]}" \
  -c "apiImageTag=${IMAGE_TAG}" \
  -c "spaRedirectUrl=${AMPLIFY_URL}/"

# --- Phase 4: publish the SPA --------------------------------------------
echo ">> Phase 4: build + publish the SPA to Amplify"
scripts/deploy-spa.sh "${ENVIRONMENT}"

echo ""
echo "== Deploy complete =="
echo ">> App URL:  ${AMPLIFY_URL}"
printf ">> API URL:  "
aws cloudformation describe-stacks --stack-name "${STACK_PREFIX}-Eks" --region "${REGION}" \
  --query "Stacks[0].Outputs[?OutputKey=='ApiBaseUrl'].OutputValue" --output text
echo ">> Next: scripts/create-test-user.sh you@example.com ${ENVIRONMENT}, then sign in."
