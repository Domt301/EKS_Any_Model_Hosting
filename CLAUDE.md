# CLAUDE.md

Guidance for AI assistants (Claude Code and others) working in this repository.

## Project intent

An **AWS CDK (TypeScript)** application that provisions a complete, self-contained
pilot for an authenticated web app that streams chat completions from a small
**Llama-family model self-hosted on Amazon EKS with vLLM**. It is a *pilot*, not
production: one GPU node, one model replica, one NAT gateway, no HA.

The whole pilot is designed to be **idempotent and deployable into any AWS
account** with a single command, using an **ungated** model by default (no
Hugging Face token or license click-through required).

## Architecture (request path)

```
React SPA (Amplify)  ──OAuth2 code + PKCE──►  Amazon Cognito
     │  HTTPS, Bearer <access token>
     ▼
API Gateway (HTTP API)  ── JWT authorizer, CORS, throttling, access logs
     │  VPC Link
     ▼
Internal ALB (private)  ── TargetGroupBinding (AWS LB Controller)
     ▼
FastAPI (CPU nodes)  ── validates token again, limits, in-memory session memory,
     │                   streaming SSE proxy
     ▼  cluster-private HTTP
vLLM (GPU node, ClusterIP only)  ── small Llama instruct model
```

- FastAPI is the **only** public application API. vLLM is `ClusterIP` only
  (no ingress/LB/public IP), reachable solely from FastAPI (NetworkPolicy).
- The internal ALB and API Gateway edge live in the **same** stack as the EKS
  cluster on purpose: `cluster.addManifest` resources must live in the cluster's
  stack, so splitting them out creates a cyclic dependency (see `docs/adr/README.md`).

## Repository layout

```
bin/app.ts                 CDK entry point (single ApplicationStage)
lib/config/                typed config + synth-time validation
lib/constructs/            Cognito, GPU node group, EKS add-ons, vLLM, FastAPI, observability
lib/stacks/                network, auth, container(ECR), eks(+workloads+edge), amplify
lib/application-stage.ts   composes all stacks in dependency order
services/api/              FastAPI app (Python) + tests + Dockerfile
  app/sessions.py          lightweight in-memory conversation memory (see below)
spa/                       React + TS + Vite SPA (PKCE, SSE streaming, futuristic UI)
kubernetes/                reference manifests (CDK is source of truth) + network policies
scripts/                   deploy / deploy-spa / build-api-image / smoke / integration / destroy
test/                      CDK assertion tests (jest)
docs/adr/                  Architecture Decision Records (ADR-001..010)
```

## Key conventions

- **Config is one typed object** (`lib/config/environment-config.ts`), read from
  CDK context (`cdk.json` → `context.llamaPilot`, or `-c` overrides) and validated
  at synth (`lib/config/validation.ts`). **No secrets** live here — only the
  *name* of a Secrets Manager secret when a gated model is used.
- **Model default is ungated**: `unsloth/Llama-3.2-1B-Instruct`, pinned by commit
  revision, `enableHuggingFaceTokenSecret: false`. To use a gated model, set
  `modelId` + pinned `modelRevision`, `enableHuggingFaceTokenSecret: true`, and a
  `huggingFaceSecretName` (Secrets Manager). vLLM only wires the HF token env when
  the flag is on.
- **Naming**: resources are `llama-pilot-<env>-<resource>`; stacks are
  `LlamaPilot-<Env>-*`.
- **Pinned versions**: vLLM image, ALB controller, NVIDIA device plugin, and the
  kubectl layer (must match `kubernetesVersion`). Never `:latest` (validation rejects it).

## In-memory conversation memory

`services/api/app/sessions.py` is a lightweight, process-local `ConversationStore`
(no database — see ADR-008/009). Behaviour:
- Keyed by an opaque client-supplied `session_id`; holds each conversation's
  windowed context in memory across turns and applies a server-side sliding
  window (last N user+assistant pairs).
- Bounded: LRU eviction past `SESSION_MAX_SESSIONS`, lazy TTL drop past
  `SESSION_TTL_SECONDS` (env-driven via the FastAPI ConfigMap).
- The SPA sends its transcript + a `session_id`; the server keeps the
  authoritative windowed copy. Because the client still transports the
  transcript, a turn stays correct even on a cold replica or after a restart.
- Endpoints: `GET/DELETE /api/v1/sessions/{id}` for introspection / clearing.
  A stateless path (no `session_id`) is still supported.

## Development workflows

```bash
# CDK
npm ci && npm run build      # tsc
npm test                     # jest assertion tests
npx cdk synth                # synth all stacks

# FastAPI
cd services/api && python -m venv .venv && . .venv/bin/activate \
  && pip install -e '.[dev]' && python -m pytest

# SPA
cd spa && npm ci && npm run build
```

Deploy / teardown (idempotent, any account):
```bash
scripts/deploy.sh dev                       # ECR → image → all stacks → 2-phase → SPA
scripts/create-test-user.sh you@x.com dev
scripts/smoke-test.sh dev                   # health + 401; add COGNITO_ACCESS_TOKEN for chat
scripts/destroy.sh dev                      # destroys all + sweeps dangling log groups / LBs
```

## Guidance for AI assistants

- **Infrastructure changes are high-impact and cost money.** A running pilot is
  ~$1.20/hr (g5.xlarge GPU + EKS control plane + NAT + ALB). Prefer `plan`/synth,
  surface diffs, and call out anything that provisions or scales costly resources.
  Use `scripts/destroy.sh` (not a bare `cdk destroy`) so AWS-managed log groups
  and any orphan LBs are swept — a bare destroy leaves the EKS control-plane and
  Container Insights log groups behind.
- **GPU quota** ("Running On-Demand G and VT instances", `L-DB2E81BA`) is 0 in
  new accounts and must be raised to ≥ the instance vCPUs before deploying.
- **Never commit secrets** — AWS keys, kubeconfigs, HF/model tokens. Secrets only
  in Secrets Manager.
- **Keep this file and the README current** when tooling or structure changes.

## Deploy gotchas (learned on the first real deployment)

The stack synthesizes and unit-tests cleanly but these only fail at deploy/runtime.
All are fixed in the code now — do not regress them:

- **Stage stack targeting.** Stacks live in a CDK `Stage`, so `cdk deploy --all`
  and CloudFormation dash-names (`LlamaPilot-dev-Eks`) match nothing. Target the
  path form `LlamaPilot-<env>/Eks` (the scripts list stacks explicitly).
- **GPU AMI.** AL2 GPU AMIs are end-of-support; use `AL2023_x86_64_NVIDIA`, set via
  an L1 escape hatch on the `CfnNodegroup` (CDK 2.170's `NodegroupAmiType` enum
  lacks it).
- **No duplicate cluster-admin policy.** The cluster's `mastersRole` already grants
  `AmazonEKSClusterAdminPolicy`; do NOT also `grantAccess(...ClusterAdminPolicy)`
  for that role — CFN early validation rejects the duplicate AccessEntry policy.
- **Security-group descriptions** can't contain `>` (EC2 charset). No `->` arrows.
- **CloudWatch alarm math:** `MAX([metric, scalar])` is unsupported; use `IF(x>0, …)`.
- **Pod Security:** vLLM runs as root (CUDA), so the app namespace enforces
  `baseline`, not `restricted` (which would reject the vLLM pod).
- **TargetGroupBinding ordering:** its manifest must `DependsOn` the ALB controller
  at the **CfnResource** level (a node-level dependency does not translate to a CFN
  `DependsOn` through the shared kubectl provider) or the CRD won't exist when applied.
- **NVIDIA device plugin:** its chart's default `nodeAffinity` needs Node Feature
  Discovery labels we don't produce. We set `nvidia.com/gpu.present=true` as a GPU
  **node-group label** instead (the `nvidia.com/` prefix is allowed; `feature.node.
  kubernetes.io/` and `kubernetes.io/` are reserved on managed node groups).
- **`enableServiceLinks: false`** on the vLLM pod: the Service named `vllm` injects
  `VLLM_PORT=tcp://<ip>:8000`, which collides with vLLM's own integer `VLLM_PORT`
  config var and crashes the engine on startup. Pods use DNS, not link env vars.
- **kubectl layer must match the cluster version** within ±1 minor. This repo runs a
  1.33 cluster with the **v32** layer (`@aws-cdk/lambda-layer-kubectl-v32`); the v33
  layer requires `aws-cdk-lib ^2.224`.
- **Teardown is not a plain `cdk destroy`.** The Eks stack can land in `DELETE_FAILED`
  if the kubectl provider loses cluster access mid-teardown, and the EKS-managed
  `eks-cluster-sg-<cluster>` SG + `/aws/vendedlogs/states/waiter-state-machine-*`
  log groups linger. `scripts/destroy.sh` auto-recovers (force-delete cluster →
  `delete-stack --retain-resources` the phantom EKS custom resources → clear the SG
  → sweep those log groups) and prints a zeroed final verification. Always tear down
  with it, not a bare `cdk destroy`. Also: long teardowns can outlive a temporary AWS
  session token — refresh creds if you see `ExpiredToken`.

See `README.md` for the full runbook, `AGENTS.md` for the quick agent guide,
`docs/adr/` for decisions, and `docs/VERIFICATION.md` for the verification report.
