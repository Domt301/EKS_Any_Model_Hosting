# ADR-009: Do not introduce a vector database

**Status:** Accepted

## Context
Retrieval-augmented generation (RAG), embeddings, and vector search are common
LLM add-ons, but the pilot's goal is a plain authenticated chat against a hosted
model.

## Decision
**No vector database and no RAG.** No OpenSearch, no pgvector, no external vector
store, no embeddings pipeline. The model answers from its own weights and the
in-conversation context only.

## Alternatives considered
- **Add a small vector store now:** Rejected — scope creep; unnecessary cost and
  operational burden for a pilot whose acceptance test is a single streamed
  completion.

## Consequences
- Minimal moving parts and cost.
- No grounding in private/organisational data; answers are limited to the model's
  training and the prompt.

## Revisit when
- A grounded/knowledge-base use case is prioritised — then design retrieval,
  embeddings, and a vector store as a separate, deliberate initiative.
