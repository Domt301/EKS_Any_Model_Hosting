#!/usr/bin/env bash
#
# Create (or reset) a Cognito test user with a permanent password and print the
# hosted-UI login URL. Self-sign-up is disabled, so users must be admin-created.
#
# Usage: scripts/create-test-user.sh <email> [environment]
#
# After running, open the printed hosted-UI URL, log in, and copy the
# `access_token` from the redirect (or browser devtools) for smoke-test.sh.
#
# Requires: aws CLI (authenticated).
set -euo pipefail
cd "$(dirname "$0")/.."

EMAIL="${1:?usage: create-test-user.sh <email> [environment]}"
ENVIRONMENT="${2:-dev}"
REGION="${AWS_REGION:-$(aws configure get region 2>/dev/null || echo us-east-1)}"
STACK_PREFIX="LlamaPilot-${ENVIRONMENT}"

out() {
  aws cloudformation describe-stacks --stack-name "${STACK_PREFIX}-Auth" --region "${REGION}" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

POOL_ID="$(out CognitoUserPoolId)"
CLIENT_ID="$(out CognitoAppClientId)"
DOMAIN="$(out CognitoDomain)"
REDIRECT="$(out CognitoCallbackUrls | cut -d, -f1)"

# A strong temporary/permanent password meeting the pool policy.
PASSWORD="${TEST_USER_PASSWORD:-Pilot!$(date +%s)Aa}"

echo ">> Creating user ${EMAIL} in pool ${POOL_ID}"
aws cognito-idp admin-create-user \
  --user-pool-id "${POOL_ID}" --username "${EMAIL}" \
  --user-attributes Name=email,Value="${EMAIL}" Name=email_verified,Value=true \
  --message-action SUPPRESS --region "${REGION}" >/dev/null 2>&1 || \
  echo "   (user may already exist — continuing to set password)"

aws cognito-idp admin-set-user-password \
  --user-pool-id "${POOL_ID}" --username "${EMAIL}" \
  --password "${PASSWORD}" --permanent --region "${REGION}"

cat <<EOF

== Test user ready ==
  email:    ${EMAIL}
  password: ${PASSWORD}

Log in via the hosted UI (Authorization Code + PKCE), then copy the access token:
  ${DOMAIN}/login?client_id=${CLIENT_ID}&response_type=code&scope=openid+email+profile&redirect_uri=${REDIRECT}

Then run the full smoke test:
  COGNITO_ACCESS_TOKEN=<access_token> scripts/smoke-test.sh ${ENVIRONMENT}
EOF
