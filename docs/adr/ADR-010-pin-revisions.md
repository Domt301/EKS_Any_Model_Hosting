# ADR-010: Pin model and container revisions

**Status:** Accepted

## Context
Unpinned model weights and container tags make deployments non-reproducible and
can silently change behaviour, GPU-memory footprint, or API compatibility.

## Decision
Pin everything that can drift:
- **Model:** a specific Hugging Face `modelRevision` (commit hash), not `main`.
- **vLLM image:** an explicit tag (e.g. `vllm/vllm-openai:v0.6.6`), never
  `latest`; config validation rejects `:latest` / untagged images.
- **FastAPI image:** deployed by **digest or immutable git-SHA tag**; the ECR
  repo enforces tag immutability and the deploy passes `-c apiImageTag=<sha>`.
- **EKS add-ons / kubectl layer / ALB controller / device plugin:** pinned or
  explicitly resolved to a validated version.

## Alternatives considered
- **Track `latest`/`main`:** Rejected — irreproducible and unsafe for a platform
  meant to host "any model" predictably.

## Consequences
- Reproducible deploys and rollbacks; changes are deliberate.
- Upgrades are explicit, reviewed steps (documented vLLM upgrade procedure).
- Requires periodic, intentional bumping to pick up fixes.

## Revisit when
- A CVE or required fix mandates an upgrade — bump the pin deliberately and
  re-validate compatibility.
