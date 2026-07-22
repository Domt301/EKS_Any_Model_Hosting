# ADR-004: Keep vLLM private

**Status:** Accepted

## Context
The inference server exposes an unauthenticated OpenAI-compatible API and reveals
the true model identity and generation controls. Exposing it publicly would
bypass every policy enforced by FastAPI.

## Decision
vLLM is reachable **only inside the cluster**. Its Service is `type: ClusterIP`
with no ingress, no load balancer, no public DNS, and no public IP. A Kubernetes
NetworkPolicy (`vllm-allow-from-fastapi`) permits ingress on TCP 8000 **only**
from FastAPI pods; a default-deny-ingress policy covers the namespace.

## Alternatives considered
- **Internal ALB in front of vLLM:** Unnecessary indirection; still widens the
  surface. FastAPI already fronts it.
- **Rely on auth alone:** Rejected — defence in depth requires network isolation,
  not just application auth.

## Consequences
- vLLM cannot be called except through FastAPI; testing it requires
  `kubectl port-forward`.
- Requires a CNI that enforces NetworkPolicy (VPC CNI with
  `enableNetworkPolicy=true`, set in the add-on config).

## Revisit when
- A second internal consumer of vLLM appears (then extend the NetworkPolicy
  explicitly, never open it broadly).
