# Self-Hosted Llama Pilot on Amazon EKS

An AWS CDK (TypeScript) application that provisions a complete pilot for an
authenticated web app that streams chat completions from a small Llama-family
model self-hosted on Amazon EKS with **vLLM**.

> **Pilot, not production.** One GPU node, one model replica, one NAT gateway,
> short log retention, no HA. See [Known limitations](#17-known-pilot-limitations)
> and [Cost](#14-cost-considerations).

---

## 1. Architecture

```text
Amplify Hosting (React SPA)  ──OAuth2 Auth-Code + PKCE──►  Amazon Cognito
        │                                                   (User Pool + public
        │ HTTPS, Authorization: Bearer <access token>        SPA client, no secret)
        ▼
   API Gateway (HTTP API)   ── managed HTTPS, CORS, throttling, JWT authorizer,
        │                       access logs
        ▼
     VPC Link  ─────────────►  Internal ALB (private subnets)
                                    │  (TargetGroupBinding, AWS LB Controller)
                                    ▼
                              FastAPI  (CPU node group)
                                    │  - validates Cognito access token
                                    │  - input/output limits, system prompt
                                    │  - concurrency limit (429), metadata-only logs
                                    │  - streaming proxy (SSE)
                                    ▼  cluster-private HTTP
                              vLLM  (GPU node group, ClusterIP only)
                                    └─ small Llama instruct model
```

- The SPA never calls vLLM. **FastAPI is the only public application API.**
- vLLM is `ClusterIP` only — no ingress, no LB, no public IP — and is reachable
  only from FastAPI (enforced by NetworkPolicy). See
  [ADR-004](docs/adr/ADR-004-vllm-private.md).
- **Conversation context is kept in memory** (no database): FastAPI holds each
  conversation's windowed context in a lightweight, TTL/LRU-bounded in-process
  store keyed by an opaque `session_id` (`services/api/app/sessions.py`), and the
  SPA sends a `session_id` per chat. Introspect/clear via
  `GET`/`DELETE /api/v1/sessions/{id}`. A stateless path (no `session_id`) also works.

### Repository layout
```
bin/app.ts                 CDK entry point
lib/config/                typed config + synth-time validation
lib/constructs/            Cognito, GPU node group, EKS add-ons, vLLM, FastAPI, observability
lib/stacks/                network, auth, container(ECR), eks(+workloads+edge), amplify
lib/application-stage.ts   composes all stacks
services/api/              FastAPI application (Python) + tests + Dockerfile
spa/                       React + TypeScript + Vite SPA (PKCE, SSE streaming)
kubernetes/                reference manifests (CDK is the source of truth) + network policies
scripts/                   build / deploy / smoke / integration / test-user / destroy
test/                      CDK assertion tests
docs/adr/                  Architecture Decision Records (ADR-001..010)
.github/workflows/         build-api, deploy-infrastructure, deploy-spa
```

## 2. Prerequisites
- AWS account with permission to create VPC, EKS, ECR, Cognito, API Gateway,
  ELBv2, Amplify, CloudWatch, IAM.
- Tools: **Node.js 20 LTS**, **npm**, **AWS CLI v2**, **Docker**, **kubectl**,
  **Python 3.12** (for the API), `jq`, `git`.
- CDK bootstrapped in the target account/region (see §6).

## 3. Required AWS quotas (check before deploying)
- **On-Demand G/VT vCPUs** ≥ the GPU instance size (e.g. `g5.xlarge` = 4 vCPU).
  This is the quota most often at 0 in a new account — request an increase early.
- Regional availability of the chosen GPU instance type (`g5`/`g6`).
- EIP and NAT gateway quotas (1 each for the pilot default).
- Elastic Network Interfaces for the VPC CNI at your pod density.

Preflight helper: `scripts/deploy.sh` prints a checklist; verify GPU availability with
`aws ec2 describe-instance-type-offerings --location-type availability-zone --filters Name=instance-type,Values=g5.xlarge --region <region>`.

## 4. Model license & access
- The default (`unsloth/Llama-3.2-1B-Instruct`, pinned by commit `modelRevision`)
  is an **ungated** Llama mirror: no Hugging Face token, no license click-through.
  This is what makes the pilot deploy into **any AWS account** out of the box.
- To use a **gated** model instead (e.g. `meta-llama/Llama-3.2-3B-Instruct`):
  1. Accept the license on Hugging Face and create a token.
  2. Store the token in **AWS Secrets Manager** (never in git/CDK/outputs/images/logs);
     the deploy materialises it as the `huggingface-token` Kubernetes Secret
     (see `kubernetes/reference/hf-secret.example.yaml`).
  3. Set `modelId` + a **pinned** `modelRevision`, `enableHuggingFaceTokenSecret: true`,
     and `huggingFaceSecretName` in `cdk.json`. vLLM only wires the HF token env
     when that flag is on. See §19 for substitution.

## 5. Configuration
All environment-specific values live in **one typed object** read from CDK
context (`cdk.json` → `context.llamaPilot`), validated at synth
(`lib/config/validation.ts`). No secrets belong here. Key fields:

| Field | Meaning |
| --- | --- |
| `environmentName` | e.g. `dev`; used in resource names/tags |
| `vpcCidr`, `natGatewayCount` | network sizing (1 NAT = pilot default) |
| `kubernetesVersion` | EKS minor, e.g. `1.33`. The kubectl Lambda layer must be within ±1 minor (this repo ships the `v32` layer, which covers 1.32/1.33) |
| `cpuNodeInstanceTypes`, `gpuNodeInstanceTypes` | node sizing |
| `modelId`, `modelRevision`, `servedModelName` | model + public alias |
| `maxModelLength`, `maxOutputTokens`, `gpuMemoryUtilization` | inference limits |
| `vllmImage` | pinned vLLM image (never `:latest`) |
| `enableHuggingFaceTokenSecret`, `huggingFaceSecretName` | HF secret wiring |
| `cognitoCallbackUrls`, `cognitoLogoutUrls` | OAuth redirect allow-list |
| `deletionProtection`, `logRetentionDays` | lifecycle |

## 6. CDK bootstrap
```bash
npm ci
npm run build
npx cdk bootstrap aws://<account-id>/<region>
```

## 7. Deploy
One command runs the full two-phase deploy (build+push API image, deploy all,
resolve the Amplify URL, rewire Cognito/CORS):
```bash
scripts/deploy.sh dev
```
Or manually:
```bash
TAG=$(scripts/build-api-image.sh dev | sed -n 's/^IMAGE_TAG=//p')
npx cdk deploy --all --require-approval never -c apiImageTag=$TAG
```
Deployment order is dependency-driven: Network → Auth → Container → EKS
(cluster, node groups, add-ons, workloads, internal ALB, API Gateway,
observability) → Amplify.

## 8. Amplify callback-URL workflow (two-phase)
A CfnApp cannot reference its own generated domain, so the SPA origin is resolved
after the first deploy:
1. `cdk deploy --all` creates the Amplify app (Cognito callbacks = placeholder).
2. Read `AmplifyBranchUrl` from the `LlamaPilot-<env>-Amplify` outputs.
3. Redeploy Auth + Eks + Amplify with `-c spaRedirectUrl=<amplify-url>/` — this
   sets the Amplify origin as the sole Cognito callback/logout URL and the API
   Gateway + FastAPI CORS origin.
`scripts/deploy.sh` performs steps 2–3 automatically and idempotently.

## 9. Create a test user
Self-sign-up is disabled (admin-created users only):
```bash
scripts/create-test-user.sh you@example.com dev
```
It sets a permanent password and prints the hosted-UI login URL.

## 10. Authentication flow
SPA → Cognito hosted UI (Authorization Code + PKCE, no secret) → SPA exchanges
the code for tokens → SPA sends the **access** token as `Authorization: Bearer`
→ API Gateway JWT authorizer validates → FastAPI validates again (signature via
JWKS, issuer, expiry, `token_use==access`, `client_id`).

## 11. Model startup expectations
First start downloads and loads weights; the vLLM pod has a long **startup
probe** (~20 min ceiling). Time-to-first-token target after warm-up is < 5 s.
Cold start (image pull + model download + load) is measured separately and can
take several minutes depending on model size and network.

## 12. Smoke test
```bash
scripts/smoke-test.sh dev                                   # health + 401 rejection
COGNITO_ACCESS_TOKEN=<token> scripts/smoke-test.sh dev      # + models + streamed chat
scripts/integration-test.sh dev                             # security-boundary checks
```
**Primary acceptance test:** one authenticated, streamed chat completion returns
`event: token …` frames followed by `event: done`.

## 13. Troubleshooting
| Symptom | Likely cause / fix |
| --- | --- |
| GPU pod `Pending` | GPU quota/availability; `kubectl describe node`; check taint/toleration |
| `nvidia.com/gpu` not allocatable | NVIDIA device plugin not ready; check `kube-system` daemonset |
| vLLM `CrashLoopBackOff` on load | model gated (missing HF secret), CUDA OOM (lower `gpuMemoryUtilization`/`maxModelLength`) |
| API 401 with a valid login | token is the **id** token not **access**; check issuer/client id |
| API 5xx / `MODEL_UNAVAILABLE` | vLLM not ready; `GET /health/ready`; check vLLM logs |
| Long answers cut at ~29 s | API Gateway integration timeout — see [ADR-005](docs/adr/ADR-005-api-gateway-https.md) |
| CORS errors in browser | run phase 2 so CORS origin = Amplify domain |

## 14. Cost considerations
Dominant cost is the **GPU node** (one `g5.xlarge`, on-demand — check current
regional hourly price). Also: 1 NAT gateway, 1 internal ALB, API Gateway
requests, CloudWatch logs (14-day retention). Controls: single GPU, single model
replica, no EFS/DB/OpenSearch, cost-allocation tags (`Application`, `Environment`,
`CostCenter`, …), optional AWS Budget. **Stop GPU cost between sessions** with §15.

## 15. GPU scale-to-zero
```bash
# Stop GPU cost (model must redownload/reload on restore):
aws eks update-nodegroup-config --cluster-name llama-pilot-dev-cluster \
  --nodegroup-name llama-pilot-dev-gpu --scaling-config minSize=0,maxSize=1,desiredSize=0
# Restore:
aws eks update-nodegroup-config --cluster-name llama-pilot-dev-cluster \
  --nodegroup-name llama-pilot-dev-gpu --scaling-config minSize=1,maxSize=1,desiredSize=1
```

## 16. Teardown
```bash
scripts/destroy.sh dev
```
Scales the GPU group to zero, then `cdk destroy --all`. If `deletionProtection`
is true, the Cognito pool and ECR repos are retained (remove manually — the
script prints the commands). Confirm no LB-Controller-created load balancers are
orphaned.

## 17. Known pilot limitations
- **Streaming through API Gateway HTTP API is capped at 29 s and buffered** — fine
  for the pilot's short outputs; not incremental for long generations
  ([ADR-005](docs/adr/ADR-005-api-gateway-https.md)).
- One GPU node / one model replica — **no HA**, no GPU autoscaling.
- One NAT gateway — not resilient to an AZ failure.
- No persistent chat history (browser-memory only), no RAG, no custom domain/WAF.
- The EKS public API endpoint is enabled; restrict it via `clusterPublicAccessCidrs`.

## 18. Security considerations
- vLLM private (ClusterIP + NetworkPolicy); GPU nodes in private subnets.
- Public SPA client has **no secret**; access-token validated at the gateway and
  again in FastAPI.
- FastAPI: non-root, read-only root fs, all caps dropped, no AWS permissions.
- **Prompts and responses are not logged** by default (`LOG_PROMPTS=false`);
  logs contain metadata only.
- Secrets only in Secrets Manager — never in git, CDK context, outputs, images,
  logs, or SPA env vars.
- SPA→API is HTTPS end to end; CORS restricted to the Amplify origin.

## 19. Model substitution
1. Set `modelId` + pinned `modelRevision` (and `servedModelName`) in `cdk.json`.
2. Adjust `maxModelLength`, `gpuMemoryUtilization`, and the GPU instance type for
   the model's memory footprint. Larger models (3B–8B) only after GPU sizing is
   verified.
3. Handle licensing/HF token (§4). Redeploy Eks; the vLLM pod reloads.
The public alias (`servedModelName`) stays stable, so the SPA/API contract is
unchanged.

## 20. vLLM upgrade procedure
1. Pick a new pinned tag (and ideally a digest); update `vllmImage`.
2. Validate flags/CUDA/driver compatibility against the new release notes and the
   GPU AMI.
3. Redeploy Eks; the vLLM Deployment uses `Recreate`, so there is a brief
   inference outage while the new pod loads.
4. Re-run the smoke test.

---

## Development
```bash
npm run build     # tsc
npm test          # CDK assertion tests
npm run synth     # cdk synth
npm run lint

# FastAPI
cd services/api && python -m pytest

# SPA
cd spa && npm ci && npm run build
```

See [`docs/adr/`](docs/adr/) for decisions,
[`docs/VERIFICATION.md`](docs/VERIFICATION.md) for the verification report and
unresolved risks, and [`services/api/README.md`](services/api/README.md) /
[`kubernetes/README.md`](kubernetes/README.md) for component docs.
