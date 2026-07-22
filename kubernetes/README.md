# Kubernetes reference manifests

**These YAML files are reference copies, not the deployment mechanism.**

The AWS CDK application in this repository is the **source of truth**. At
`cdk deploy` time, CDK renders and applies every Kubernetes object here via
`cluster.addManifest(...)` (see `lib/stacks/eks-stack.ts`,
`lib/stacks/workload-stack.ts`, and the constructs under `lib/constructs/`).
The files in this directory are hand-maintained mirrors kept for readability,
code review, and local experimentation.

> Do **not** `kubectl apply` these against the live EKS cluster. CDK owns those
> objects; applying by hand will drift or conflict with the next `cdk deploy`.
> `kubectl apply` them **only** for local/kind experimentation or inspection —
> in AWS they are applied by CDK.

## Layout

| File | Mirrors | Applied in AWS by |
| --- | --- | --- |
| `namespace.yaml` | `llama-pilot` (restricted) + `observability` (baseline) namespaces | `lib/stacks/eks-stack.ts` |
| `network-policies.yaml` | The five NetworkPolicies (default-deny + allow rules) | `lib/stacks/workload-stack.ts` |
| `reference/vllm.yaml` | vLLM ServiceAccount + Service + Deployment | `lib/constructs/vllm-workload.ts` |
| `reference/fastapi.yaml` | FastAPI ConfigMap + ServiceAccount + Service + Deployment | `lib/constructs/fastapi-workload.ts` |
| `reference/target-group-binding.yaml` | ALB `TargetGroupBinding` for the FastAPI Service | `lib/stacks/workload-stack.ts` |
| `reference/hf-secret.example.yaml` | **Example only** — how the `huggingface-token` Secret is created | Created out-of-band from Secrets Manager (never CDK, never committed) |

## Architecture at a glance

```
API Gateway (JWT authorizer)
      │  VPC Link
      ▼
Internal ALB ──TargetGroupBinding──▶ fastapi Service (ClusterIP :80 → :8080)
                                          │  2 replicas, CPU nodes, restricted
                                          ▼
                                     vllm Service (ClusterIP :8000)
                                          │  1 replica, GPU nodes, Recreate
                                          ▼
                                     Hugging Face weights (HTTPS via NAT)
```

NetworkPolicies (enforced by the Amazon VPC CNI) lock this down: default-deny
ingress, vLLM reachable only from FastAPI on 8000, FastAPI reachable only on
8080, and tightly scoped egress (DNS + vLLM + HTTPS).

## Secrets

The `huggingface-token` Secret is **never committed**. It is created imperatively
from AWS Secrets Manager at deploy time. See
`reference/hf-secret.example.yaml` for the exact command. The vLLM pod consumes
it with `optional: true`, so public models work even when the Secret is absent.

## Local / kind experimentation

For inspection or a local kind cluster (no GPUs, no ALB, no VPC CNI enforcement):

```sh
# 1. Namespaces
kubectl apply -f namespace.yaml

# 2. (Optional) NetworkPolicies — enforced only if your CNI supports them
kubectl apply -f network-policies.yaml

# 3. Workloads — edit the image and placeholder values first
#    (vLLM will not schedule without GPU nodes; scale it to 0 or use a stub)
kubectl apply -f reference/vllm.yaml
kubectl apply -f reference/fastapi.yaml

# target-group-binding.yaml requires the AWS Load Balancer Controller + a real
# ALB target group, so it is a no-op locally — skip it on kind.
```

Substitute the placeholders before applying:

- `reference/fastapi.yaml`: `<ECR_REPO_URI>:<tag>`, the `COGNITO_*` values, and
  `<SPA_ORIGIN>`.
- `reference/vllm.yaml`: the `MODEL_ID` env value (defaults to
  `meta-llama/Llama-3.2-3B-Instruct`).
- `reference/target-group-binding.yaml`: `<TARGET_GROUP_ARN>`.

To just inspect what CDK would apply without a cluster, use
`kubectl apply --dry-run=client -f <file>` or `kubeconform` / `kubeval`.
