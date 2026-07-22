# Llama Pilot API (FastAPI application boundary)

The public application boundary for the **Self-Hosted Llama Pilot on Amazon EKS**.

```
SPA ──▶ API Gateway ──▶ internal ALB ──▶ [ FastAPI (this service) ] ──▶ vLLM (private)
```

FastAPI is the only component the browser talks to. It:

- validates **AWS Cognito access tokens** (RS256, JWKS-cached),
- enforces a narrow, safe request contract,
- injects the server-controlled system prompt and forces the served model name,
- proxies **streaming** chat completions to a private, OpenAI-compatible vLLM
  server (`http://vllm.llama-pilot.svc.cluster.local:8000`) reachable only
  inside the cluster,
- exposes structured JSON logs and Prometheus metrics,
- sheds load with `429` and maps upstream failures to a stable error contract.

## Layout

```
services/api/
  app/
    main.py            # FastAPI app, routes, lifespan, middleware wiring
    config.py          # pydantic-settings Settings (env-driven), cached get_settings()
    auth.py            # Cognito access-token validation + JWKS caching (require_auth)
    models.py          # request/response models + validation limits
    inference.py       # async httpx streaming proxy to vLLM
    middleware.py      # request-id, access log, body-size limit, concurrency -> 429
    logging_config.py  # structured JSON logging (no secrets/prompts)
    metrics.py         # Prometheus metrics + /metrics content
  tests/               # pytest + respx (vLLM) + in-process RSA-signed JWTs
  Dockerfile
  pyproject.toml
```

## Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `COGNITO_REGION` | `us-east-1` | Cognito region |
| `COGNITO_USER_POOL_ID` | — | User pool id (used to derive issuer/JWKS if unset) |
| `COGNITO_APP_CLIENT_ID` | — | Access tokens must carry this `client_id` |
| `COGNITO_ISSUER` | derived | Expected `iss`; derived from region+pool if empty |
| `COGNITO_JWKS_URL` | derived | JWKS URL; derived from issuer if empty |
| `VLLM_BASE_URL` | `http://vllm.llama-pilot.svc.cluster.local:8000` | Upstream vLLM base URL |
| `SERVED_MODEL_NAME` | `llama-pilot` | Public alias **and** the model name sent upstream |
| `MAX_MODEL_LENGTH` | `4096` | Advisory context length |
| `MAX_OUTPUT_TOKENS` | `512` | Server ceiling; requested output tokens are clamped to this |
| `SYSTEM_PROMPT` | a helpful-assistant prompt | Injected as the system message (ConfigMap mount in prod) |
| `MAX_CONCURRENT_INFERENCE` | `4` | In-process concurrency cap; overflow → `429` |
| `REQUEST_TIMEOUT_SECONDS` | `120` | httpx read timeout to vLLM |
| `GENERATION_TIMEOUT_SECONDS` | `300` | Overall wall-clock cap per generation |
| `LOG_LEVEL` | `INFO` | Log level |
| `LOG_PROMPTS` | `false` | **Must stay false**; prompts are never logged |
| `AUTH_DISABLED` | `false` | Dev/test escape hatch → synthetic principal |
| `CORS_ALLOW_ORIGINS` | — | Comma-separated allowed origins |

`get_settings()` is cached (`functools.lru_cache`). Never commit secrets or tokens.

## Routes

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/health/live` | none | `{"status":"live"}`. **Never calls vLLM.** |
| GET | `/health/ready` | none | `200` when vLLM `/health` or `/v1/models` is reachable, else `503`. |
| GET | `/metrics` | none | Prometheus exposition (in-cluster scrape). |
| GET | `/api/v1/me` | access token | Returns `sub`, `token_use`, `client_id`, `scope` only. |
| GET | `/api/v1/models` | access token | Returns only the public alias `SERVED_MODEL_NAME`. |
| POST | `/api/v1/chat/completions` | access token | Validates body; SSE stream by default; `stream:false` returns JSON. |

## Auth contract

Send `Authorization: Bearer <cognito-access-token>`. A token is accepted only if:

- it is present and well-formed;
- the RS256 signature verifies against the pool JWKS (cached; refetched on `kid` miss);
- `iss` == `COGNITO_ISSUER`;
- `exp` is in the future;
- `token_use == "access"` (**id tokens are rejected**);
- `client_id` == `COGNITO_APP_CLIENT_ID`.

Any failure → `401` with `WWW-Authenticate: Bearer error="invalid_token"` and a
stable body: `{"error":{"code":"UNAUTHORIZED","message":"..."}}`.

## Request contract (`POST /api/v1/chat/completions`)

```json
{
  "messages": [{"role": "user", "content": "..."}],
  "temperature": 0.2,
  "max_output_tokens": 256,
  "stream": true
}
```

Enforced limits (violations → `422`; a client `system` role → `400`):

- roles: `user` and `assistant` **only** (a client `system` message is rejected);
- ≤ 20 messages; ≤ 8000 chars/message; ≤ 24000 chars total;
- the final message must be `role: user`;
- `max_output_tokens` in `1..512` (further clamped to `MAX_OUTPUT_TOKENS`);
- `temperature` in `0.0..1.5`;
- request body ≤ 256 KiB (else `413`);
- unknown fields (e.g. `model`) are rejected — clients cannot choose the model.

The server injects `SYSTEM_PROMPT` and forces `model = SERVED_MODEL_NAME` upstream.

## SSE streaming contract (browser-facing)

`Content-Type: text/event-stream`. Frames:

```
event: token
data: {"text":"..."}

event: usage
data: {"prompt_tokens":10,"completion_tokens":2}

event: done
data: {}
```

On failure a single error frame is emitted instead of `done`:

```
event: error
data: {"code":"MODEL_UNAVAILABLE"|"MODEL_TIMEOUT"|"MODEL_ERROR","message":"..."}
```

Non-streaming (`stream:false`) returns JSON:

```json
{"id":"...","model":"llama-pilot","content":"...","finish_reason":"stop",
 "usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}
```

Error/status mapping (non-streaming): connect failure → `503` `MODEL_UNAVAILABLE`;
read timeout / generation timeout → `504` `MODEL_TIMEOUT`; other upstream error →
`502` `MODEL_ERROR`. Concurrency saturation → `429` with `Retry-After`.

## Observability

Structured JSON access logs (metadata only): `method`, `path`, `status`,
`duration_ms`, `request_id`, principal `sub` (never email), `bytes`. The service
**never** logs the `Authorization` header, tokens, prompts, responses, emails, or
cookies. Every response echoes `X-Request-ID` (accepted from the client or
generated).

Prometheus metrics at `/metrics`:
`api_requests_total`, `api_request_duration_seconds`,
`api_time_to_first_token_seconds`, `api_stream_duration_seconds`,
`api_active_inference_requests`, `api_rate_limited_total`,
`api_auth_failures_total`, `api_model_errors_total`,
`api_prompt_tokens_total`, `api_completion_tokens_total`.

## Local development

```bash
cd services/api
python -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]"

# Run against a local/dev vLLM with auth disabled:
AUTH_DISABLED=true VLLM_BASE_URL=http://localhost:8000 \
  uvicorn app.main:app --host 0.0.0.0 --port 8080 --reload

curl -s localhost:8080/health/live
curl -s -N -X POST localhost:8080/api/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"hello"}],"stream":true}'
```

## Tests

```bash
cd services/api
. .venv/bin/activate
python -m pytest -q
```

Tests generate an RSA keypair in-process, sign Cognito-shaped JWTs, stub the
JWKS resolver (PyJWKClient uses `urllib`, so only the key fetch is stubbed while
real RS256 verification runs), and mock vLLM's HTTP with `respx`. They run on
Python 3.11 and 3.12.

## Container

Multi-stage build on `python:3.12-slim`, non-root `uid 1000`, read-only-root-fs
compatible (`HOME=/tmp`), `uvicorn` on `0.0.0.0:8080`, `HEALTHCHECK` hitting
`/health/live`.

```bash
docker build -t llama-pilot-api:dev services/api
docker run --rm -p 8080:8080 \
  -e VLLM_BASE_URL=http://vllm.llama-pilot.svc.cluster.local:8000 \
  llama-pilot-api:dev
```
