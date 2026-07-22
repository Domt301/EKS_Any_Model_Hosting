# ADR-003: Use FastAPI as the public application boundary

**Status:** Accepted

## Context
Something must authenticate users, validate and constrain requests, apply the
system prompt, enforce usage limits, and translate internal inference errors
into a stable public contract. The browser must never talk to vLLM directly.

## Decision
A **FastAPI** service is the sole public application API. It validates Cognito
access tokens, enforces input/output limits, injects the system prompt, forces
the served-model alias, applies an in-process concurrency limit, streams vLLM
output back as SSE, and logs metadata only (never prompts/responses/tokens).

## Alternatives considered
- **Expose vLLM directly (behind auth):** Rejected — leaks model identity and
  generation controls, no request policy, no stable error contract.
- **Lambda proxy:** Poor fit for long-lived streaming connections and in-process
  concurrency control.

## Consequences
- One clear, testable trust boundary; vLLM stays an internal implementation
  detail.
- FastAPI is on the hot path for every token; it must stream without buffering.
- Public API contract is decoupled from vLLM's version and semantics.

## Revisit when
- The application layer needs to scale independently in ways a single service
  cannot express, or a gateway/mesh subsumes these responsibilities.
