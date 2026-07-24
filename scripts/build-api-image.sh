#!/usr/bin/env bash
#
# Build and push the FastAPI application image to ECR using an immutable,
# git-SHA-based tag (never :latest). Prints the resulting tag on stdout as
#   IMAGE_TAG=<sha>
# so callers can capture it for `cdk deploy -c apiImageTag=<sha>`.
#
# Usage: scripts/build-api-image.sh [environment]
#   environment  logical env name (default: dev)
#
# Requires: aws CLI (authenticated), docker.
set -euo pipefail

ENVIRONMENT="${1:-dev}"
REGION="${AWS_REGION:-$(aws configure get region 2>/dev/null || echo us-east-1)}"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
REPO_NAME="llama-pilot-${ENVIRONMENT}-api"
REGISTRY="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"
REPO_URI="${REGISTRY}/${REPO_NAME}"

# Immutable tag = short git SHA (+ "-dirty" when the tree has changes).
GIT_SHA="$(git rev-parse --short HEAD)"
if ! git diff --quiet || ! git diff --cached --quiet; then
  GIT_SHA="${GIT_SHA}-dirty"
fi
TAG="${GIT_SHA}"

# Idempotency: the ECR repo has IMMUTABLE tags, so re-pushing an existing tag
# fails. If this exact image already exists, skip build+push and just report it.
if aws ecr describe-images \
  --repository-name "${REPO_NAME}" --image-ids imageTag="${TAG}" \
  --region "${REGION}" >/dev/null 2>&1; then
  echo ">> Image ${REPO_URI}:${TAG} already present — skipping build/push" >&2
  echo "IMAGE_TAG=${TAG}"
  exit 0
fi

echo ">> Building FastAPI image ${REPO_URI}:${TAG}" >&2

aws ecr get-login-password --region "${REGION}" \
  | docker login --username AWS --password-stdin "${REGISTRY}" >&2

docker build \
  --platform linux/amd64 \
  -t "${REPO_URI}:${TAG}" \
  "$(dirname "$0")/../services/api" >&2

docker push "${REPO_URI}:${TAG}" >&2

echo ">> Pushed ${REPO_URI}:${TAG}" >&2
# Machine-readable output for callers.
echo "IMAGE_TAG=${TAG}"
