# ADR-007: Use one fixed GPU node for the pilot

**Status:** Accepted

## Context
GPU capacity is the dominant cost and the scarcest quota. The pilot must
demonstrate one authenticated streamed inference, not production scale.

## Decision
Provision a **single** GPU managed node group with min=desired=max=1
(ON_DEMAND), dedicated to vLLM via a `dedicated=inference:NoSchedule` taint and
`workload-type=inference` labels. vLLM runs a single replica (Recreate). No GPU
autoscaling, no Karpenter, no multi-AZ GPU redundancy.

## Alternatives considered
- **GPU autoscaling / Karpenter:** Out of scope for the pilot; adds cost and
  complexity. (Karpenter may be an optional, disabled-by-default follow-on.)
- **Multiple replicas:** A single GPU cannot host two model copies here;
  horizontal scaling is explicitly out of scope.

## Consequences
- Lowest viable GPU cost; simple capacity model.
- No HA: node/AZ failure or a CUDA OOM takes inference down until recovery.
- A documented scale-to-zero procedure stops GPU cost between sessions (with a
  model-redownload/startup penalty on restore).

## Revisit when
- The pilot graduates toward availability or throughput targets that need more
  than one GPU or autoscaling.
