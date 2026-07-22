#!/usr/bin/env bash
#
# Tear down the pilot. Scales the GPU node group to zero first (fast cost stop),
# then destroys all stacks. Retained resources (when deletionProtection=true)
# are reported.
#
# Usage: scripts/destroy.sh [environment]   (default: dev)
#
# Requires: aws CLI, npx cdk.
set -euo pipefail
cd "$(dirname "$0")/.."

ENVIRONMENT="${1:-dev}"
REGION="${AWS_REGION:-$(aws configure get region 2>/dev/null || echo us-east-1)}"
CLUSTER="llama-pilot-${ENVIRONMENT}-cluster"
GPU_NG="llama-pilot-${ENVIRONMENT}-gpu"

read -r -p "This will DESTROY the '${ENVIRONMENT}' pilot in ${REGION}. Type the env name to confirm: " confirm
[ "${confirm}" = "${ENVIRONMENT}" ] || { echo "Aborted."; exit 1; }

# Best-effort: stop GPU cost immediately.
echo ">> Scaling GPU node group to zero (best effort)"
aws eks update-nodegroup-config --cluster-name "${CLUSTER}" --nodegroup-name "${GPU_NG}" \
  --scaling-config minSize=0,maxSize=1,desiredSize=0 --region "${REGION}" 2>/dev/null || \
  echo "   (skipped — cluster/nodegroup may already be gone)"

echo ">> cdk destroy --all"
npx cdk destroy --all --force -c "environmentName=${ENVIRONMENT}"

cat <<EOF
== Teardown complete ==
If deletionProtection was true, the Cognito user pool and ECR repositories are
RETAINED and must be removed manually:
  aws cognito-idp delete-user-pool --user-pool-id <id> --region ${REGION}
  aws ecr delete-repository --repository-name llama-pilot-${ENVIRONMENT}-api --force --region ${REGION}
Also confirm no orphaned load balancers remain (created by the LB Controller):
  aws elbv2 describe-load-balancers --region ${REGION} --query "LoadBalancers[?contains(LoadBalancerName,'llama-pilot')].LoadBalancerArn"
EOF
