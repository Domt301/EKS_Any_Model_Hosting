# ADR-005: Use API Gateway for managed HTTPS without a custom domain

**Status:** Accepted (with a documented streaming constraint)

## Context
Amplify serves the SPA over HTTPS, so the API must also be HTTPS (mixed content
is blocked). Custom domains, Route 53, and user-provided ACM certs are out of
scope, so the API needs an AWS-managed TLS endpoint. The backend is an internal
ALB in private subnets.

## Decision
Front the internal ALB with an **API Gateway HTTP API** over a **VPC Link**. API
Gateway provides the managed `https://<id>.execute-api.<region>.amazonaws.com`
endpoint, CORS restricted to the Amplify origin, request throttling (5 rps /
burst 10), access logging, and a Cognito **JWT authorizer** (FastAPI validates
the token again — defence in depth).

## Alternatives considered
- **Public ALB + ACM:** Needs a domain/cert (out of scope) for a trusted HTTPS
  name; API Gateway gives a managed HTTPS name with no domain.
- **CloudFront + ALB:** More moving parts; also effectively needs a cert for a
  custom name and does not add value for the pilot.

## Consequences / known constraint
- **HTTP API caps the integration timeout at 29 seconds and buffers responses**,
  so it is not a true incremental-streaming transport. For the pilot's small
  model and short outputs (≤512 tokens, TTFT < 5 s) a generation completes within
  the window and the SSE body is delivered, but very long generations will be cut
  at 29 s and streaming may be buffered rather than incremental.
  - The FastAPI ↔ browser contract is genuine SSE; the constraint is purely the
    API Gateway hop. If incremental streaming for long generations becomes a
    requirement, revisit with a public ALB + ACM/custom domain or a
    streaming-capable edge (e.g. a Lambda Function URL / CloudFront), which the
    current out-of-scope list excludes.

## Revisit when
- Long-form streaming is required, a custom domain becomes available, or WAF/edge
  requirements are introduced.
