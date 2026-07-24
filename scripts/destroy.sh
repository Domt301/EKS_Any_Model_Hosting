#!/usr/bin/env bash
#
# Tear down the pilot completely and leave no dangling resources. Scales the GPU
# node group to zero first (fast cost stop), destroys all stacks, then sweeps
# the AWS-managed resources that CDK does NOT own and would otherwise linger:
#   - the EKS control-plane log group  (/aws/eks/<cluster>/cluster)
#   - Container Insights log groups    (/aws/containerinsights/<cluster>/*)
#   - custom-resource Lambda log groups (/aws/lambda/<StackPrefix>*)
#   - any orphaned llama-pilot load balancers / target groups (defensive)
#
# Idempotent: safe to re-run; every sweep tolerates already-deleted resources.
#
# Usage: scripts/destroy.sh [environment]   (default: dev)
#
# Requires: aws CLI, npx cdk.
set -euo pipefail
cd "$(dirname "$0")/.."

ENVIRONMENT="${1:-dev}"
REGION="${AWS_REGION:-$(aws configure get region 2>/dev/null || echo us-east-1)}"
export AWS_REGION="${REGION}"
CLUSTER="llama-pilot-${ENVIRONMENT}-cluster"
GPU_NG="llama-pilot-${ENVIRONMENT}-gpu"
STACK_PREFIX="LlamaPilot-${ENVIRONMENT}"   # CloudFormation name form (dashes)
STACK_PATH="LlamaPilot-${ENVIRONMENT}"     # cdk path form (used with /*)

read -r -p "This will DESTROY the '${ENVIRONMENT}' pilot in ${REGION}. Type the env name to confirm: " confirm
[ "${confirm}" = "${ENVIRONMENT}" ] || { echo "Aborted."; exit 1; }

# --- Best-effort: stop GPU cost immediately ------------------------------
echo ">> Scaling GPU node group to zero (best effort)"
aws eks update-nodegroup-config --cluster-name "${CLUSTER}" --nodegroup-name "${GPU_NG}" \
  --scaling-config minSize=0,maxSize=1,desiredSize=0 --region "${REGION}" 2>/dev/null || \
  echo "   (skipped — cluster/nodegroup may already be gone)"

# --- Destroy all CloudFormation stacks -----------------------------------
# Stacks live inside a Stage sub-assembly; list them explicitly in reverse
# dependency order (a bare `--all` sees only the main assembly, and a `/*` glob
# can skip stacks). cdk still resolves dependencies, but being explicit is safe.
echo ">> cdk destroy all stage stacks (explicit)"
npx cdk destroy \
  "${STACK_PATH}/Amplify" "${STACK_PATH}/Eks" "${STACK_PATH}/Container" \
  "${STACK_PATH}/Auth" "${STACK_PATH}/Network" \
  --force -c "environmentName=${ENVIRONMENT}"

# --- Sweep dangling CloudWatch log groups --------------------------------
echo ">> Sweeping orphaned CloudWatch log groups"
delete_log_groups_by_prefix() {  # $1 = log-group name prefix
  local prefix="$1" names
  names="$(aws logs describe-log-groups --log-group-name-prefix "${prefix}" \
    --region "${REGION}" --query 'logGroups[].logGroupName' --output text 2>/dev/null || true)"
  for lg in ${names}; do
    echo "   - deleting ${lg}"
    aws logs delete-log-group --log-group-name "${lg}" --region "${REGION}" 2>/dev/null || true
  done
}
delete_log_groups_by_prefix "/aws/eks/${CLUSTER}/cluster"
delete_log_groups_by_prefix "/aws/containerinsights/${CLUSTER}/"
delete_log_groups_by_prefix "/aws/lambda/${STACK_PREFIX}"
delete_log_groups_by_prefix "/llama-pilot/${ENVIRONMENT}/"

# --- Defensive: orphaned load balancers / target groups ------------------
echo ">> Checking for orphaned load balancers / target groups"
for lb_arn in $(aws elbv2 describe-load-balancers --region "${REGION}" \
  --query "LoadBalancers[?contains(LoadBalancerName,'llama-pilot-${ENVIRONMENT}')].LoadBalancerArn" \
  --output text 2>/dev/null || true); do
  echo "   - deleting load balancer ${lb_arn}"
  aws elbv2 delete-load-balancer --load-balancer-arn "${lb_arn}" --region "${REGION}" 2>/dev/null || true
done
for tg_arn in $(aws elbv2 describe-target-groups --region "${REGION}" \
  --query "TargetGroups[?contains(TargetGroupName,'llama-pilot-${ENVIRONMENT}')].TargetGroupArn" \
  --output text 2>/dev/null || true); do
  echo "   - deleting target group ${tg_arn}"
  aws elbv2 delete-target-group --target-group-arn "${tg_arn}" --region "${REGION}" 2>/dev/null || true
done

# --- Report any retained resources + final verification ------------------
cat <<EOF

== Teardown complete ==
If deletionProtection was true, the Cognito user pool and ECR repositories are
RETAINED and must be removed manually:
  aws cognito-idp delete-user-pool --user-pool-id <id> --region ${REGION}
  aws ecr delete-repository --repository-name llama-pilot-${ENVIRONMENT}-api --force --region ${REGION}
  aws ecr delete-repository --repository-name llama-pilot-${ENVIRONMENT}-vllm-mirror --force --region ${REGION}
EOF

echo ">> Final check — remaining llama-pilot resources (should be empty unless retained):"
echo "   CloudFormation stacks:"
aws cloudformation list-stacks --region "${REGION}" \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE ROLLBACK_COMPLETE DELETE_FAILED \
  --query "StackSummaries[?contains(StackName,'${STACK_PREFIX}')].StackName" --output text || true
echo "   ECR repositories:"
aws ecr describe-repositories --region "${REGION}" \
  --query "repositories[?contains(repositoryName,'llama-pilot-${ENVIRONMENT}')].repositoryName" \
  --output text 2>/dev/null || true
echo "   Log groups:"
aws logs describe-log-groups --region "${REGION}" \
  --query "logGroups[?contains(logGroupName,'${CLUSTER}') || contains(logGroupName,'llama-pilot/${ENVIRONMENT}')].logGroupName" \
  --output text 2>/dev/null || true
echo ">> If any names print above (and deletionProtection was false), re-run this script."
