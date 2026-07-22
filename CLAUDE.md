# CLAUDE.md

Guidance for AI assistants (Claude Code and others) working in this repository.

> **⚠️ Status: repository is currently empty (scaffold).**
> As of the last update to this file, this repo contained **no source code, build
> tooling, or configuration** — only git metadata. This document is therefore a
> **template**, structured around the project's evident intent, not a description of
> existing code. Sections marked _TODO_ must be filled in (and inaccurate assumptions
> corrected) once real code lands. **Do not treat the specifics below as ground truth
> until they are verified against actual files in the repo.**

## Project intent

Based on the repository name (`EKS_Any_Model_Hosting`), the goal is to provide
infrastructure and tooling to **host arbitrary ML / LLM models on Amazon EKS**
(Elastic Kubernetes Service) — i.e. a reusable platform for deploying "any model"
behind an inference API on Kubernetes.

Typical components such a project ends up containing (confirm/adjust as they appear):

- **Infrastructure as Code** — the EKS cluster, node groups (often GPU-enabled),
  networking, IAM/IRSA, and add-ons. Commonly Terraform, `eksctl`, CDK, or
  CloudFormation.
- **Kubernetes manifests / Helm charts** — Deployments, Services, HPA/KEDA
  autoscaling, Ingress/Gateway, and possibly a serving framework
  (KServe, Ray Serve, vLLM, Triton Inference Server, TGI, etc.).
- **Model serving code** — an inference server or adapter that loads a model and
  exposes it over HTTP/gRPC.
- **Container build** — Dockerfile(s) for the serving image(s).
- **CI/CD** — GitHub Actions or similar for build/test/deploy.
- **Docs** — setup, architecture, and operational runbooks.

## Repository structure

_TODO: document the real layout once files exist._ A likely shape:

```
.
├── infra/ or terraform/     # EKS cluster + AWS resources (IaC)
├── charts/ or helm/         # Helm charts for model deployments
├── manifests/ or k8s/       # Raw Kubernetes YAML
├── serving/ or src/         # Inference server / model adapters
├── docker/ or images/       # Dockerfile(s)
├── scripts/                 # Helper scripts (deploy, teardown, load-test)
├── .github/workflows/       # CI/CD pipelines
└── docs/                    # Architecture & runbooks
```

When you add or discover the real structure, replace this block with an accurate
tree and note the purpose of each top-level directory.

## Development workflows

_TODO: replace every command below with the project's real commands once tooling
exists. Do not invent commands — verify them against `Makefile`, `package.json`,
`*.tf`, `Chart.yaml`, workflow files, or scripts before documenting them here._

Common workflows to capture when they exist:

- **Provision infrastructure** — e.g. `terraform init && terraform plan && terraform apply`, or `eksctl create cluster -f cluster.yaml`.
- **Configure cluster access** — e.g. `aws eks update-kubeconfig --name <cluster> --region <region>`.
- **Build & push image** — e.g. `docker build ...` then push to ECR.
- **Deploy a model** — e.g. `helm upgrade --install <release> ./charts/...` or `kubectl apply -k manifests/`.
- **Test** — unit tests for serving code; smoke/integration tests against a running endpoint.
- **Lint / format** — language- and IaC-specific (e.g. `terraform fmt`, `tflint`, `ruff`, `black`, `golangci-lint`, `helm lint`, `kubeval`/`kubeconform`).
- **Load / inference test** — e.g. curl against the endpoint, or a load-test script.
- **Teardown** — e.g. `terraform destroy` or `eksctl delete cluster` (guard against accidental prod deletion).

## Key conventions

_TODO: document conventions as they emerge. Placeholders to confirm:_

- **Cloud/region defaults** — the target AWS account, region(s), and cluster naming scheme.
- **Secrets & credentials** — how AWS creds, model registry tokens, and HF tokens are
  supplied (IRSA, Kubernetes Secrets, external-secrets, SSM). **Never commit secrets.**
- **Model onboarding** — the contract a new model must satisfy to be hosted
  (interface, resource requests, GPU type, container conventions).
- **Naming** — conventions for namespaces, Helm releases, image tags, and resource names.
- **Versioning & releases** — how images and charts are versioned.
- **IaC state** — where Terraform state lives (S3 backend + DynamoDB lock?), and
  workspace/environment separation (dev/staging/prod).

## Guidance for AI assistants

- **Verify before you document.** This file is a scaffold. Before relying on any
  command, path, or convention above, confirm it against actual repository files.
  Correct this document when reality differs.
- **Infrastructure changes are high-impact.** Treat `terraform apply`, `helm upgrade`,
  `kubectl apply/delete`, and cluster teardown as consequential. Prefer `plan`/`--dry-run`
  and surface the diff before applying anything that touches live infrastructure.
- **Never commit secrets** — AWS keys, kubeconfigs with embedded tokens, HF/model tokens.
- **Mind cost.** GPU node groups and always-on clusters are expensive; call out anything
  that provisions or scales up costly resources.
- **Keep this file current.** When you add tooling or structure, update the relevant
  section here so future assistants have accurate guidance.

---

_This CLAUDE.md was generated against an empty repository. Replace the TODO/placeholder
sections with verified details as the project takes shape._
