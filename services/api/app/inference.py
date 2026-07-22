"""Async streaming proxy to the private vLLM OpenAI-compatible server.

Responsibilities:
  * Build an OpenAI-compatible /v1/chat/completions payload, injecting the
    server-controlled system prompt and forcing the served model name.
  * Stream vLLM SSE `data: {json}` lines and re-emit them on our own SSE
    contract (`event: token|usage|done|error`).
  * Never buffer the full response for streaming; honor an overall generation
    timeout; detect client disconnect and close the upstream response.
  * Map upstream failures to a stable public error contract that leaks nothing.
"""
from __future__ import annotations

import asyncio
import json
import time
from typing import Any, AsyncIterator, Dict, List, Optional, Tuple

import httpx

from .config import Settings
from .logging_config import get_logger
from .metrics import (
    api_completion_tokens_total,
    api_model_errors_total,
    api_prompt_tokens_total,
    api_stream_duration_seconds,
    api_time_to_first_token_seconds,
)
from .models import ChatCompletionRequest

logger = get_logger("app.inference")

# Public, stable error codes.
CODE_MODEL_UNAVAILABLE = "MODEL_UNAVAILABLE"
CODE_MODEL_TIMEOUT = "MODEL_TIMEOUT"
CODE_MODEL_ERROR = "MODEL_ERROR"

# HTTP status mapping for non-streaming responses / readiness.
STATUS_FOR_CODE = {
    CODE_MODEL_UNAVAILABLE: 503,
    CODE_MODEL_TIMEOUT: 504,
    CODE_MODEL_ERROR: 502,
}


class UpstreamError(Exception):
    """Raised when the upstream model call fails; carries a public error code."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _sse(event: str, data: Dict[str, Any]) -> bytes:
    """Encode a Server-Sent Event frame."""
    return f"event: {event}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n".encode()


def build_payload(
    req: ChatCompletionRequest, settings: Settings, *, stream: bool
) -> Dict[str, Any]:
    """Build the OpenAI-compatible upstream payload.

    The server injects the system prompt and forces the served model name.
    Clients cannot set the model or a system message.
    """
    messages: List[Dict[str, str]] = [
        {"role": "system", "content": settings.SYSTEM_PROMPT}
    ]
    messages.extend({"role": m.role, "content": m.content} for m in req.messages)

    return {
        "model": settings.SERVED_MODEL_NAME,
        "messages": messages,
        "temperature": req.temperature,
        "max_tokens": req.clamped_max_tokens(settings.MAX_OUTPUT_TOKENS),
        "stream": stream,
    }


def _parse_sse_data(raw_line: str) -> Optional[str]:
    """Return the JSON payload of a `data:` SSE line, or None to skip."""
    if not raw_line.startswith("data:"):
        return None
    return raw_line[len("data:"):].strip()


def _extract_delta(chunk: Dict[str, Any]) -> Tuple[Optional[str], Optional[str]]:
    """Return (content_delta, finish_reason) from a streaming chunk."""
    choices = chunk.get("choices") or []
    if not choices:
        return None, None
    choice = choices[0]
    delta = choice.get("delta") or {}
    return delta.get("content"), choice.get("finish_reason")


class InferenceClient:
    """Thin wrapper over a shared httpx.AsyncClient targeting vLLM."""

    def __init__(self, settings: Settings, client: httpx.AsyncClient) -> None:
        self._settings = settings
        self._client = client

    async def check_ready(self) -> bool:
        """Return True if vLLM appears reachable (via /health then /v1/models)."""
        for path in ("/health", "/v1/models"):
            try:
                resp = await self._client.get(path, timeout=5.0)
                if resp.status_code < 500:
                    return True
            except httpx.HTTPError:
                continue
        return False

    async def stream_chat(
        self,
        req: ChatCompletionRequest,
        *,
        is_disconnected=None,
    ) -> AsyncIterator[bytes]:
        """Yield SSE frames for a streaming chat completion.

        `is_disconnected` is an optional awaitable-returning callable (typically
        `request.is_disconnected`) used to stop early when the client goes away.
        """
        payload = build_payload(req, self._settings, stream=True)
        start = time.monotonic()
        first_token_seen = False
        prompt_tokens = 0
        completion_tokens = 0

        try:
            async with asyncio.timeout(self._settings.GENERATION_TIMEOUT_SECONDS):
                async with self._client.stream(
                    "POST", "/v1/chat/completions", json=payload
                ) as resp:
                    if resp.status_code >= 400:
                        await resp.aread()
                        api_model_errors_total.labels(code=CODE_MODEL_ERROR).inc()
                        yield _sse(
                            "error",
                            {
                                "code": CODE_MODEL_ERROR,
                                "message": "The model returned an error.",
                            },
                        )
                        return

                    async for line in resp.aiter_lines():
                        if is_disconnected is not None and await is_disconnected():
                            # Client left; exiting the context closes upstream.
                            logger.info("client disconnected mid-stream", extra={"event": "disconnect"})
                            return

                        data = _parse_sse_data(line)
                        if data is None or data == "":
                            continue
                        if data == "[DONE]":
                            break
                        try:
                            chunk = json.loads(data)
                        except json.JSONDecodeError:
                            continue

                        usage = chunk.get("usage")
                        if usage:
                            prompt_tokens = usage.get("prompt_tokens", prompt_tokens)
                            completion_tokens = usage.get(
                                "completion_tokens", completion_tokens
                            )

                        content, _finish = _extract_delta(chunk)
                        if content:
                            if not first_token_seen:
                                first_token_seen = True
                                api_time_to_first_token_seconds.observe(
                                    time.monotonic() - start
                                )
                            yield _sse("token", {"text": content})

            if prompt_tokens:
                api_prompt_tokens_total.inc(prompt_tokens)
            if completion_tokens:
                api_completion_tokens_total.inc(completion_tokens)
            if prompt_tokens or completion_tokens:
                yield _sse(
                    "usage",
                    {
                        "prompt_tokens": prompt_tokens,
                        "completion_tokens": completion_tokens,
                    },
                )
            yield _sse("done", {})

        except (httpx.ConnectError, httpx.ConnectTimeout):
            api_model_errors_total.labels(code=CODE_MODEL_UNAVAILABLE).inc()
            yield _sse(
                "error",
                {"code": CODE_MODEL_UNAVAILABLE, "message": "The model is unavailable."},
            )
        except (httpx.ReadTimeout, asyncio.TimeoutError, TimeoutError):
            api_model_errors_total.labels(code=CODE_MODEL_TIMEOUT).inc()
            yield _sse(
                "error",
                {"code": CODE_MODEL_TIMEOUT, "message": "The model timed out."},
            )
        except httpx.HTTPError:
            api_model_errors_total.labels(code=CODE_MODEL_ERROR).inc()
            yield _sse(
                "error",
                {"code": CODE_MODEL_ERROR, "message": "The model returned an error."},
            )
        finally:
            api_stream_duration_seconds.observe(time.monotonic() - start)

    async def complete_chat(self, req: ChatCompletionRequest) -> Dict[str, Any]:
        """Non-streaming completion: aggregate and return a JSON result.

        Raises UpstreamError on failure so the route can map to an HTTP status.
        """
        payload = build_payload(req, self._settings, stream=False)
        try:
            async with asyncio.timeout(self._settings.GENERATION_TIMEOUT_SECONDS):
                resp = await self._client.post("/v1/chat/completions", json=payload)
        except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
            api_model_errors_total.labels(code=CODE_MODEL_UNAVAILABLE).inc()
            raise UpstreamError(CODE_MODEL_UNAVAILABLE, "The model is unavailable.") from exc
        except (httpx.ReadTimeout, asyncio.TimeoutError, TimeoutError) as exc:
            api_model_errors_total.labels(code=CODE_MODEL_TIMEOUT).inc()
            raise UpstreamError(CODE_MODEL_TIMEOUT, "The model timed out.") from exc
        except httpx.HTTPError as exc:
            api_model_errors_total.labels(code=CODE_MODEL_ERROR).inc()
            raise UpstreamError(CODE_MODEL_ERROR, "The model returned an error.") from exc

        if resp.status_code >= 400:
            api_model_errors_total.labels(code=CODE_MODEL_ERROR).inc()
            raise UpstreamError(CODE_MODEL_ERROR, "The model returned an error.")

        body = resp.json()
        choice = (body.get("choices") or [{}])[0]
        message = choice.get("message") or {}
        usage = body.get("usage") or {}
        prompt_tokens = usage.get("prompt_tokens", 0)
        completion_tokens = usage.get("completion_tokens", 0)
        if prompt_tokens:
            api_prompt_tokens_total.inc(prompt_tokens)
        if completion_tokens:
            api_completion_tokens_total.inc(completion_tokens)

        return {
            "id": body.get("id", ""),
            "model": self._settings.SERVED_MODEL_NAME,
            "content": message.get("content", ""),
            "finish_reason": choice.get("finish_reason"),
            "usage": {
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "total_tokens": usage.get(
                    "total_tokens", prompt_tokens + completion_tokens
                ),
            },
        }
