#!/usr/bin/env bash
#
# Tear down the pilot completely and leave no dangling resources.
#
# A plain `cdk destroy` is not always enough for an EKS stack. This script:
#   1. Scales the GPU node group to zero first (fast cost stop).
#   2. Runs `cdk destroy` for every stage stack (explicit, dependency order).
#   3. AUTO-RECOVERS any stack left in DELETE_FAILED:
#        - Eks: the kubectl-provider custom resources can hang if the provider
#          loses cluster access mid-teardown. We force-delete the cluster (node
#          groups first) so those resources become phantom, then re-issue
#          `delete-stack --retain-resources` for the EKS custom resources
#          (safe — the cluster is already gone, so nothing real is orphaned).
#        - Network: the EKS-managed `eks-cluster-sg-<cluster>` security group and
#          leftover ENIs can block VPC deletion; we clear them and retry.
#   4. Sweeps AWS-managed resources CDK does NOT own and would otherwise linger:
#        - EKS control-plane, Container Insights, custom-resource Lambda, and the
#          CDK provider Step Functions waiter log groups (/aws/vendedlogs/states).
#        - orphaned load balancers / target groups.
#   5. Prints a final "nothing dangling" verification.
#
# Idempotent: safe to re-run; every step tolerates already-deleted resources.
#
# Usage: scripts/destroy.sh [environment]   (default: dev)
# Requires: aws CLI, npx cdk.
set -uo pipefail
cd "$(dirname "$0")/.."

ENVIRONMENT="${1:-dev}"
REGION="${AWS_REGION:-$(aws configure get region 2>/dev/null || echo us-east-1)}"
export AWS_REGION="${REGION}"
CLUSTER="llama-pilot-${ENVIRONMENT}-cluster"
STACK_PREFIX="LlamaPilot-${ENVIRONMENT}"   # CloudFormation name form (dashes)
STACK_PATH="LlamaPilot-${ENVIRONMENT}"     # cdk path form

read -r -p "This will DESTROY the '${ENVIRONMENT}' pilot in ${REGION}. Type the env name to confirm: " confirm
[ "${confirm}" = "${ENVIRONMENT}" ] || { echo "Aborted."; exit 1; }

stack_status() {  # $1 = stack name
  aws cloudformation describe-stacks --stack-name "$1" --region "${REGION}" \
    --query "Stacks[0].StackStatus" --output text 2>/dev/null || echo "GONE"
}

# --- Best-effort: stop GPU cost immediately ------------------------------
echo ">> Scaling GPU node group to zero (best effort)"
aws eks update-nodegroup-config --cluster-name "${CLUSTER}" --nodegroup-name "llama-pilot-${ENVIRONMENT}-gpu" \
  --scaling-config minSize=0,maxSize=1,desiredSize=0 --region "${REGION}" 2>/dev/null || \
  echo "   (skipped — cluster/nodegroup may already be gone)"

# --- Destroy all CloudFormation stacks -----------------------------------
# Stacks live inside a Stage sub-assembly; list them explicitly in reverse
# dependency order (a bare `--all` sees only the main assembly; a `/*` glob can
# skip stacks). Don't abort the script if cdk destroy fails — recover below.
echo ">> cdk destroy all stage stacks (explicit)"
npx cdk destroy \
  "${STACK_PATH}/Amplify" "${STACK_PATH}/Eks" "${STACK_PATH}/Container" \
  "${STACK_PATH}/Auth" "${STACK_PATH}/Network" \
  --force -c "environmentName=${ENVIRONMENT}" || echo ">> cdk destroy reported errors — entering recovery"

# --- Recovery helpers ----------------------------------------------------
ensure_cluster_deleted() {
  aws eks describe-cluster --name "${CLUSTER}" --region "${REGION}" >/dev/null 2>&1 || return 0
  echo "   [recover] force-deleting cluster ${CLUSTER} (node groups first)"
  for ng in $(aws eks list-nodegroups --cluster-name "${CLUSTER}" --region "${REGION}" \
      --query "nodegroups" --output text 2>/dev/null); do
    aws eks delete-nodegroup --cluster-name "${CLUSTER}" --nodegroup-name "${ng}" --region "${REGION}" >/dev/null 2>&1 || true
    aws eks wait nodegroup-deleted --cluster-name "${CLUSTER}" --nodegroup-name "${ng}" --region "${REGION}" 2>/dev/null || true
  done
  aws eks delete-cluster --name "${CLUSTER}" --region "${REGION}" >/dev/null 2>&1 || true
  aws eks wait cluster-deleted --name "${CLUSTER}" --region "${REGION}" 2>/dev/null || true
}

recover_eks_stack() {
  echo "   [recover] Eks stack in DELETE_FAILED — clearing phantom EKS custom resources"
  ensure_cluster_deleted
  # Retain every EKS custom resource that has not yet deleted (cluster is gone,
  # so these back nothing real — retaining orphans nothing).
  local retain=()
  while read -r lid; do [ -n "${lid}" ] && retain+=("${lid}"); done < <(
    aws cloudformation describe-stack-resources --stack-name "${STACK_PREFIX}-Eks" --region "${REGION}" \
      --query "StackResources[?contains(ResourceType,'Custom::AWSCDK-EKS') && ResourceStatus!='DELETE_COMPLETE'].LogicalResourceId" \
      --output text 2>/dev/null | tr '\t' '\n')
  if [ "${#retain[@]}" -gt 0 ]; then
    echo "   [recover] delete-stack --retain-resources ${retain[*]}"
    aws cloudformation delete-stack --stack-name "${STACK_PREFIX}-Eks" --region "${REGION}" \
      --retain-resources "${retain[@]}" 2>/dev/null || true
  else
    aws cloudformation delete-stack --stack-name "${STACK_PREFIX}-Eks" --region "${REGION}" 2>/dev/null || true
  fi
  aws cloudformation wait stack-delete-complete --stack-name "${STACK_PREFIX}-Eks" --region "${REGION}" 2>/dev/null || true
}

clear_cluster_sg_and_enis() {  # clear things that block VPC deletion
  local vpc
  vpc="$(aws ec2 describe-vpcs --region "${REGION}" \
    --filters "Name=tag:Application,Values=llama-pilot" "Name=tag:Environment,Values=${ENVIRONMENT}" \
    --query "Vpcs[0].VpcId" --output text 2>/dev/null)"
  [ -z "${vpc}" ] || [ "${vpc}" = "None" ] && return 0
  echo "   [recover] clearing leftover ENIs + EKS cluster SG in ${vpc}"
  for eni in $(aws ec2 describe-network-interfaces --region "${REGION}" \
      --filters "Name=vpc-id,Values=${vpc}" "Name=status,Values=available" \
      --query "NetworkInterfaces[].NetworkInterfaceId" --output text 2>/dev/null); do
    aws ec2 delete-network-interface --network-interface-id "${eni}" --region "${REGION}" 2>/dev/null || true
  done
  for sg in $(aws ec2 describe-security-groups --region "${REGION}" \
      --filters "Name=vpc-id,Values=${vpc}" \
      --query "SecurityGroups[?GroupName!='default'].GroupId" --output text 2>/dev/null); do
    aws ec2 delete-security-group --group-id "${sg}" --region "${REGION}" 2>/dev/null || true
  done
}

recover_network_stack() {
  echo "   [recover] Network stack in DELETE_FAILED — clearing VPC dependencies"
  clear_cluster_sg_and_enis
  aws cloudformation delete-stack --stack-name "${STACK_PREFIX}-Network" --region "${REGION}" 2>/dev/null || true
  aws cloudformation wait stack-delete-complete --stack-name "${STACK_PREFIX}-Network" --region "${REGION}" 2>/dev/null || true
}

# --- Recovery pass: resolve any DELETE_FAILED stack ----------------------
for attempt in 1 2 3; do
  failed=0
  for s in Eks Container Auth Network; do
    st="$(stack_status "${STACK_PREFIX}-${s}")"
    [ "${st}" = "DELETE_FAILED" ] || continue
    failed=1
    echo ">> Recovering ${STACK_PREFIX}-${s} (attempt ${attempt}, status ${st})"
    case "${s}" in
      Eks)     recover_eks_stack ;;
      Network) recover_network_stack ;;
      *)       aws cloudformation delete-stack --stack-name "${STACK_PREFIX}-${s}" --region "${REGION}" 2>/dev/null || true
               aws cloudformation wait stack-delete-complete --stack-name "${STACK_PREFIX}-${s}" --region "${REGION}" 2>/dev/null || true ;;
    esac
  done
  [ "${failed}" -eq 0 ] && break
done

# --- Sweep dangling CloudWatch log groups --------------------------------
echo ">> Sweeping orphaned CloudWatch log groups"
delete_log_groups_by_prefix() {  # $1 = log-group name prefix
  for lg in $(aws logs describe-log-groups --log-group-name-prefix "$1" \
      --region "${REGION}" --query 'logGroups[].logGroupName' --output text 2>/dev/null); do
    echo "   - deleting ${lg}"
    aws logs delete-log-group --log-group-name "${lg}" --region "${REGION}" 2>/dev/null || true
  done
}
delete_log_groups_by_prefix "/aws/eks/${CLUSTER}/cluster"
delete_log_groups_by_prefix "/aws/containerinsights/${CLUSTER}/"
delete_log_groups_by_prefix "/aws/lambda/${STACK_PREFIX}"
delete_log_groups_by_prefix "/llama-pilot/${ENVIRONMENT}/"
# CDK custom-resource provider Step Functions waiters (easy to miss).
delete_log_groups_by_prefix "/aws/vendedlogs/states/waiter-state-machine-${STACK_PREFIX}"

# --- Defensive: orphaned load balancers / target groups ------------------
echo ">> Checking for orphaned load balancers / target groups"
for lb_arn in $(aws elbv2 describe-load-balancers --region "${REGION}" \
  --query "LoadBalancers[?contains(LoadBalancerName,'llama-pilot-${ENVIRONMENT}')].LoadBalancerArn" \
  --output text 2>/dev/null); do
  echo "   - deleting load balancer ${lb_arn}"
  aws elbv2 delete-load-balancer --load-balancer-arn "${lb_arn}" --region "${REGION}" 2>/dev/null || true
done
for tg_arn in $(aws elbv2 describe-target-groups --region "${REGION}" \
  --query "TargetGroups[?contains(TargetGroupName,'llama-pilot-${ENVIRONMENT}')].TargetGroupArn" \
  --output text 2>/dev/null); do
  echo "   - deleting target group ${tg_arn}"
  aws elbv2 delete-target-group --target-group-arn "${tg_arn}" --region "${REGION}" 2>/dev/null || true
done

# --- Retained resources note + final verification ------------------------
cat <<EOF

== Teardown complete ==
If deletionProtection was true, the Cognito user pool and ECR repositories are
RETAINED and must be removed manually:
  aws cognito-idp delete-user-pool --user-pool-id <id> --region ${REGION}
  aws ecr delete-repository --repository-name llama-pilot-${ENVIRONMENT}-api --force --region ${REGION}
  aws ecr delete-repository --repository-name llama-pilot-${ENVIRONMENT}-vllm-mirror --force --region ${REGION}
EOF

echo ">> Final verification — counts should all be 0 (unless deletionProtection retained resources):"
count() { local n; n="$(eval "$1" 2>/dev/null)"; [ -z "${n}" ] && n=0; printf "   %-24s %s\n" "$2" "${n}"; }
count "aws cloudformation list-stacks --region ${REGION} --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE ROLLBACK_COMPLETE DELETE_FAILED DELETE_IN_PROGRESS --query \"length(StackSummaries[?contains(StackName,'${STACK_PREFIX}')])\" --output text" "CFN stacks:"
count "aws eks list-clusters --region ${REGION} --query \"length(clusters[?contains(@,'llama-pilot-${ENVIRONMENT}')])\" --output text" "EKS clusters:"
count "aws ec2 describe-vpcs --region ${REGION} --filters Name=tag:Application,Values=llama-pilot Name=tag:Environment,Values=${ENVIRONMENT} --query 'length(Vpcs)' --output text" "VPCs:"
count "aws ecr describe-repositories --region ${REGION} --query \"length(repositories[?contains(repositoryName,'llama-pilot-${ENVIRONMENT}')])\" --output text" "ECR repos:"
count "aws cognito-idp list-user-pools --max-results 60 --region ${REGION} --query \"length(UserPools[?contains(Name,'llama-pilot-${ENVIRONMENT}')])\" --output text" "Cognito pools:"
count "aws elbv2 describe-load-balancers --region ${REGION} --query \"length(LoadBalancers[?contains(LoadBalancerName,'llama-pilot-${ENVIRONMENT}')])\" --output text" "Load balancers:"
count "aws amplify list-apps --region ${REGION} --query \"length(apps[?contains(name,'llama-pilot-${ENVIRONMENT}')])\" --output text" "Amplify apps:"
count "aws logs describe-log-groups --region ${REGION} --query \"length(logGroups[?contains(logGroupName,'${CLUSTER}') || contains(logGroupName,'llama-pilot/${ENVIRONMENT}') || contains(logGroupName,'${STACK_PREFIX}')])\" --output text" "Log groups:"
echo ">> If any count is non-zero (and deletionProtection was false), re-run this script."
