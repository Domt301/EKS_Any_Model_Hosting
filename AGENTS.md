# AGENTS.md

Guide for AI coding agents working in this repository. (Claude-specific notes and
the full gotcha list live in [`CLAUDE.md`](CLAUDE.md); the human runbook is
[`README.md`](README.md).)

## What this is

An **AWS CDK (TypeScript)** app that deploys a complete, self-contained pilot:
an authenticated React SPA that streams chat completions from a small **Llama
model self-hosted on Amazon EKS with vLLM** on a GPU node. Designed to be
**idempotent** and deployable into **any AWS account** with an **ungated** model
(no Hugging Face token required).

Request path:
`SPA (Amplify) → Cognito (PKCE) → API Gateway (JWT) → VPC Link → internal ALB →
FastAPI (CPU nodes) → vLLM (GPU node, ClusterIP-only) → Llama`.

## Layout

```
bin/app.ts            CDK entry (single ApplicationStage)
lib/config/           typed config + synth-time validation
lib/constructs/       Cognito, GPU node group, EKS add-ons, vLLM, FastAPI, observability
lib/stacks/           network, auth, container(ECR), eks(+workloads+edge), amplify
services/api/         FastAPI app (Python) — app/sessions.py = in-memory conversation memory
spa/                  React + TS + Vite SPA (PKCE, SSE streaming)
scripts/              deploy / deploy-spa / build-api-image / smoke / integration / destroy
test/                 CDK jest assertion tests
docs/adr/             Architecture Decision Records
```

## Commands

```bash
# CDK (infra)
npm ci && npm run build     # tsc — run after any lib/ change
npm test                    # jest assertion tests (must stay green)
npx cdk synth               # synth all stacks

# FastAPI (services/api)
python -m venv .venv && . .venv/bin/activate && pip install -e '.[dev]'
python -m pytest            # unit + integration tests

# SPA (spa)
npm ci && npm run build     # tsc -b && vite build

# Deploy / teardown (idempotent; any account)
scripts/deploy.sh dev       # ECR → image → all stacks → 2-phase → SPA
scripts/destroy.sh dev      # destroys all + sweeps AWS-managed log groups / orphan LBs
```

Always run `npm run build && npm test` (CDK) and `pytest` (API) before committing.

## Conventions

- **One typed config object** (`lib/config/environment-config.ts`) from
  `cdk.json → context.llamaPilot`, validated at synth. **No secrets here** — only
  the *name* of a Secrets Manager secret (for gated models).
- Resources are `llama-pilot-<env>-<resource>`; stacks are `LlamaPilot-<Env>-*`.
- Default model is **ungated** (`unsloth/Llama-3.2-1B-Instruct`, pinned revision,
  `enableHuggingFaceTokenSecret: false`).
- Kubernetes **1.33** with the **v32** kubectl layer; GPU node is `g5.xlarge` +
  `AL2023_x86_64_NVIDIA`.
- **In-memory conversation context** only (no DB): `services/api/app/sessions.py`,
  keyed by `session_id`, windowed + TTL/LRU bounded.

## Rules of engagement

- **Infra changes cost money.** A running pilot is ~$1.20/hr (GPU + EKS + NAT +
  ALB). Prefer synth/plan; call out anything that scales costly resources. GPU
  quota (`L-DB2E81BA`) is 0 in new accounts and must be raised before deploying.
- **Keep IaC and the live cluster in sync** — apply changes via `cdk deploy`, not
  ad-hoc `kubectl` patches.
- **Tear down with `scripts/destroy.sh`**, never a bare `cdk destroy` — the script
  also sweeps the EKS/Container-Insights/Lambda log groups CDK doesn't own.
- **Never commit secrets** (AWS keys, kubeconfigs, HF/model tokens).
- **The stack synthesizes clean but has real deploy/runtime footguns** — read the
  "Deploy gotchas" section in [`CLAUDE.md`](CLAUDE.md) before touching the EKS
  stack, GPU node group, workloads, or deploy scripts.
