#!/usr/bin/env bash
#
# Build the React SPA with configuration resolved from the deployed stacks and
# publish it to Amplify Hosting via a manual (zip) deployment. Idempotent: each
# run produces a fresh, complete deployment of the current dist.
#
# The Amplify app is created without a connected git repo (no provider token),
# so we ship pre-built assets rather than triggering an Amplify build. Because
# Amplify does not run the build, we must inline the VITE_* values at build time
# here — pulled from the CloudFormation outputs.
#
# Usage: scripts/deploy-spa.sh [environment]   (default: dev)
#
# Requires: aws CLI, node/npm, jq, zip, curl.
set -euo pipefail
cd "$(dirname "$0")/.."

ENVIRONMENT="${1:-dev}"
REGION="${AWS_REGION:-$(aws configure get region 2>/dev/null || echo us-east-1)}"
STACK_PREFIX="LlamaPilot-${ENVIRONMENT}"

echo "== publish SPA (env=${ENVIRONMENT}, region=${REGION}) =="

# --- Helper: read a single stack output -----------------------------------
# Match by substring: outputs created inside a nested construct (e.g. Workloads)
# are emitted with a prefixed logical id + hash (WorkloadsApiBaseUrlB23D3DDF),
# so an exact OutputKey match misses them.
out() {  # out <stack-suffix> <OutputKey-substring>
  aws cloudformation describe-stacks --stack-name "${STACK_PREFIX}-$1" --region "${REGION}" \
    --query "Stacks[0].Outputs[?contains(OutputKey,'$2')].OutputValue | [0]" --output text
}

APP_ID="$(out Amplify AmplifyAppId)"
BRANCH="$(out Amplify AmplifyBranchName)"
AMPLIFY_URL="$(out Amplify AmplifyBranchUrl)"
API_BASE_URL="$(out Eks ApiBaseUrl)"
MODEL_NAME="$(out Eks ServedModelName)"
USER_POOL_ID="$(out Auth CognitoUserPoolId)"
APP_CLIENT_ID="$(out Auth CognitoAppClientId)"
COGNITO_DOMAIN="$(out Auth CognitoDomain)"

for pair in "APP_ID=$APP_ID" "API_BASE_URL=$API_BASE_URL" "USER_POOL_ID=$USER_POOL_ID" \
            "APP_CLIENT_ID=$APP_CLIENT_ID" "COGNITO_DOMAIN=$COGNITO_DOMAIN"; do
  if [ -z "${pair#*=}" ] || [ "${pair#*=}" = "None" ]; then
    echo "ERROR: missing required stack output: ${pair%%=*}. Deploy the stacks first." >&2
    exit 1
  fi
done

# --- Build the SPA with resolved config ----------------------------------
echo ">> Building SPA (VITE_* from stack outputs)"
pushd spa >/dev/null
npm ci
VITE_AWS_REGION="${REGION}" \
VITE_COGNITO_USER_POOL_ID="${USER_POOL_ID}" \
VITE_COGNITO_APP_CLIENT_ID="${APP_CLIENT_ID}" \
VITE_COGNITO_DOMAIN="${COGNITO_DOMAIN}" \
VITE_COGNITO_REDIRECT_SIGN_IN="${AMPLIFY_URL}/" \
VITE_COGNITO_REDIRECT_SIGN_OUT="${AMPLIFY_URL}/" \
VITE_API_BASE_URL="${API_BASE_URL}" \
VITE_MODEL_NAME="${MODEL_NAME}" \
  npm run build
popd >/dev/null

# --- Package dist --------------------------------------------------------
ZIP="$(mktemp -t llama-spa-XXXXXX).zip"
trap 'rm -f "${ZIP}"' EXIT
( cd spa/dist && zip -qr "${ZIP}" . )
echo ">> Packaged $(du -h "${ZIP}" | cut -f1) → ${ZIP}"

# --- Create + upload + start the Amplify deployment ----------------------
echo ">> Creating Amplify deployment (app=${APP_ID}, branch=${BRANCH})"
CREATE_JSON="$(aws amplify create-deployment \
  --app-id "${APP_ID}" --branch-name "${BRANCH}" --region "${REGION}")"
JOB_ID="$(echo "${CREATE_JSON}" | jq -r '.jobId')"
UPLOAD_URL="$(echo "${CREATE_JSON}" | jq -r '.zipUploadUrl')"

echo ">> Uploading bundle (job ${JOB_ID})"
curl -sSf -H 'Content-Type: application/zip' --upload-file "${ZIP}" "${UPLOAD_URL}"

aws amplify start-deployment \
  --app-id "${APP_ID}" --branch-name "${BRANCH}" --job-id "${JOB_ID}" \
  --region "${REGION}" >/dev/null

# --- Wait for completion -------------------------------------------------
echo -n ">> Waiting for deployment to finish"
for _ in $(seq 1 60); do
  STATUS="$(aws amplify get-job --app-id "${APP_ID}" --branch-name "${BRANCH}" \
    --job-id "${JOB_ID}" --region "${REGION}" --query 'job.summary.status' --output text)"
  case "${STATUS}" in
    SUCCEED) echo " ✓"; echo ">> SPA live at ${AMPLIFY_URL}"; exit 0 ;;
    FAILED|CANCELLED) echo " ✗ (${STATUS})"; exit 1 ;;
    *) echo -n "."; sleep 5 ;;
  esac
done
echo " timed out waiting for Amplify job ${JOB_ID}" >&2
exit 1
