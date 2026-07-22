# ADR-008: Keep conversation state in the browser

**Status:** Accepted

## Context
The pilot needs multi-turn chat but explicitly excludes persistent history,
DynamoDB, RDS, and any database.

## Decision
Conversation history lives **only in browser memory** for the session. Each
request sends the message array; the server is stateless per request and injects
the system prompt. Clearing the conversation or reloading discards history.

## Alternatives considered
- **Server-side session store (DynamoDB/RDS):** Out of scope; adds cost, PII
  handling, and infrastructure.
- **localStorage persistence:** Would persist potentially sensitive prompts on
  the device; avoided for the pilot.

## Consequences
- No server-side PII or chat storage; simplest possible data posture.
- History is lost on reload/logout; requests grow with turn count (bounded by the
  20-message / 24k-character limits).

## Revisit when
- Persistent history, sharing, or auditing becomes a requirement (then design a
  storage layer with an explicit data-retention/privacy policy).
