# ADR-002: Use vLLM as the inference server

**Status:** Accepted

## Context
The pilot needs an OpenAI-compatible, high-throughput inference server for a
small Llama-family instruct model, with streaming token output and efficient GPU
memory use.

## Decision
Use **vLLM** (`vllm/vllm-openai`, pinned tag) serving an OpenAI-compatible
`/v1/chat/completions` endpoint. FastAPI proxies to it over cluster-private HTTP.

## Alternatives considered
- **Text Generation Inference (TGI):** Comparable; vLLM chosen for its
  PagedAttention memory efficiency, continuous batching, and prefix caching.
- **Triton / TensorRT-LLM:** More performant at scale but heavier to operate and
  model-compile; overkill for a pilot.
- **Ollama:** Explicitly out of scope — not designed for server-grade GPU
  serving or the OpenAI streaming contract the SPA relies on.

## Consequences
- OpenAI-compatible API simplifies the FastAPI proxy and the SSE contract.
- vLLM/CUDA/driver compatibility must be validated against the GPU AMI.
- vLLM typically runs as root in-container; mitigated by a dedicated GPU node,
  dropped capabilities, and NetworkPolicy isolation.

## Revisit when
- A different engine measurably improves tokens/sec or memory for the chosen
  model, or the model family requires a runtime vLLM does not support.
