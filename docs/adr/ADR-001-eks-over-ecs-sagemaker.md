# ADR-001: Use EKS rather than ECS or SageMaker

**Status:** Accepted

## Context
The pilot must host an arbitrary open-weight LLM behind an inference API, on a
platform the organisation can standardise on for future "any model" hosting.
Candidate platforms: Amazon EKS, Amazon ECS, and Amazon SageMaker.

## Decision
Host the model on **Amazon EKS**. GPU inference runs as a Kubernetes workload
(vLLM) on a dedicated, tainted GPU managed node group; the application layer
(FastAPI) runs on a CPU node group in the same cluster.

## Alternatives considered
- **ECS (Fargate/EC2):** Simpler control plane, but weaker fit for GPU
  scheduling, device plugins, and the portable Kubernetes ecosystem the
  organisation wants for "any model" hosting.
- **SageMaker:** Excellent managed inference, but abstracts away the serving
  stack (vLLM, batching, GPU tuning) the pilot explicitly wants to own and
  learn, and is less portable.

## Consequences
- Full control over the serving runtime, autoscaling primitives, and networking.
- Higher operational surface: cluster upgrades, add-ons, device plugins.
- Kubernetes skills and tooling become part of the platform's baseline.

## Revisit when
- The organisation decides managed inference (SageMaker/Bedrock) meets all model
  and cost requirements, or
- Operating an EKS cluster proves disproportionate to the workload.
