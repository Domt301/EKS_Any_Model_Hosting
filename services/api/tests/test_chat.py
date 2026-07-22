"""Chat-completion proxy tests: streaming, error mapping, saturation, logging."""
from __future__ import annotations

import asyncio
import logging

import httpx
import pytest

from tests.conftest import VLLM_BASE_URL, auth_headers, sse_chunk


def _stream_body() -> bytes:
    parts = [
        sse_chunk("Hello"),
        sse_chunk(" world"),
        sse_chunk(None, usage={"prompt_tokens": 10, "completion_tokens": 2},
                  finish_reason="stop"),
        "data: [DONE]\n\n",
    ]
    return "".join(parts).encode()


def test_streaming_relays_tokens(app_client, make_token):
    token = make_token()
    app_client.respx.post("/v1/chat/completions").mock(
        return_value=httpx.Response(
            200, content=_stream_body(), headers={"content-type": "text/event-stream"}
        )
    )
    body = {"messages": [{"role": "user", "content": "hi"}], "stream": True}
    resp = app_client.post("/api/v1/chat/completions", json=body, headers=auth_headers(token))
    assert resp.status_code == 200
    text = resp.text
    assert "event: token" in text
    assert '"text":"Hello"' in text
    assert '"text":" world"' in text
    assert "event: usage" in text
    assert "event: done" in text


def test_non_streaming_aggregates(app_client, make_token):
    token = make_token()
    app_client.respx.post("/v1/chat/completions").mock(
        return_value=httpx.Response(
            200,
            json={
                "id": "cmpl-1",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "Hello world"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12},
            },
        )
    )
    body = {"messages": [{"role": "user", "content": "hi"}], "stream": False}
    resp = app_client.post("/api/v1/chat/completions", json=body, headers=auth_headers(token))
    assert resp.status_code == 200
    data = resp.json()
    assert data["content"] == "Hello world"
    assert data["model"] == "llama-pilot"
    assert data["usage"]["total_tokens"] == 12


def test_streaming_timeout_emits_error_event(app_client, make_token):
    token = make_token()
    app_client.respx.post("/v1/chat/completions").mock(
        side_effect=httpx.ReadTimeout("slow")
    )
    body = {"messages": [{"role": "user", "content": "hi"}], "stream": True}
    resp = app_client.post("/api/v1/chat/completions", json=body, headers=auth_headers(token))
    assert resp.status_code == 200
    assert "event: error" in resp.text
    assert "MODEL_TIMEOUT" in resp.text


def test_non_streaming_timeout_returns_504(app_client, make_token):
    token = make_token()
    app_client.respx.post("/v1/chat/completions").mock(
        side_effect=httpx.ReadTimeout("slow")
    )
    body = {"messages": [{"role": "user", "content": "hi"}], "stream": False}
    resp = app_client.post("/api/v1/chat/completions", json=body, headers=auth_headers(token))
    assert resp.status_code == 504
    assert resp.json()["error"]["code"] == "MODEL_TIMEOUT"


def test_streaming_unavailable_emits_error_event(app_client, make_token):
    token = make_token()
    app_client.respx.post("/v1/chat/completions").mock(
        side_effect=httpx.ConnectError("refused")
    )
    body = {"messages": [{"role": "user", "content": "hi"}], "stream": True}
    resp = app_client.post("/api/v1/chat/completions", json=body, headers=auth_headers(token))
    assert resp.status_code == 200
    assert "MODEL_UNAVAILABLE" in resp.text


def test_non_streaming_unavailable_returns_503(app_client, make_token):
    token = make_token()
    app_client.respx.post("/v1/chat/completions").mock(
        side_effect=httpx.ConnectError("refused")
    )
    body = {"messages": [{"role": "user", "content": "hi"}], "stream": False}
    resp = app_client.post("/api/v1/chat/completions", json=body, headers=auth_headers(token))
    assert resp.status_code == 503
    assert resp.json()["error"]["code"] == "MODEL_UNAVAILABLE"


def test_saturation_returns_429(app_client, make_token):
    token = make_token()
    limiter = app_client.app.state.limiter
    # Exhaust all inference slots so the next request is shed.
    while limiter.try_acquire():
        pass
    try:
        body = {"messages": [{"role": "user", "content": "hi"}], "stream": False}
        resp = app_client.post(
            "/api/v1/chat/completions", json=body, headers=auth_headers(token)
        )
    finally:
        # Release everything we took.
        while limiter.in_flight > 0:
            limiter.release()
    assert resp.status_code == 429
    assert resp.headers.get("Retry-After") is not None
    assert resp.json()["error"]["code"] == "RATE_LIMITED"


def test_prompt_text_absent_from_logs(app_client, make_token):
    token = make_token()
    marker = "SUPER_SECRET_PROMPT_MARKER_XYZ"
    app_client.respx.post("/v1/chat/completions").mock(
        return_value=httpx.Response(
            200, content=_stream_body(), headers={"content-type": "text/event-stream"}
        )
    )

    # Capture everything the root logger emits during the request.
    from app.logging_config import JsonFormatter

    records = []

    class _Capture(logging.Handler):
        def emit(self, record):  # noqa: ANN001
            records.append(self.format(record))

    handler = _Capture()
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.addHandler(handler)
    try:
        body = {"messages": [{"role": "user", "content": marker}], "stream": True}
        resp = app_client.post(
            "/api/v1/chat/completions", json=body, headers=auth_headers(token)
        )
        assert resp.status_code == 200
    finally:
        root.removeHandler(handler)

    joined = "\n".join(records)
    assert marker not in joined
    # The Authorization header value must also never appear.
    assert token not in joined


@pytest.mark.asyncio
async def test_client_disconnect_closes_upstream(make_token):
    """Best-effort: is_disconnected short-circuits the stream early."""
    import respx

    from app.config import get_settings
    from app.inference import InferenceClient

    get_settings.cache_clear()
    settings = get_settings()

    calls = {"n": 0}

    async def is_disconnected() -> bool:
        # Report disconnected after the first line is inspected.
        calls["n"] += 1
        return calls["n"] > 1

    with respx.mock(base_url=VLLM_BASE_URL, assert_all_called=False) as router:
        router.post("/v1/chat/completions").mock(
            return_value=httpx.Response(
                200, content=_stream_body(),
                headers={"content-type": "text/event-stream"},
            )
        )
        async with httpx.AsyncClient(base_url=VLLM_BASE_URL) as http:
            inference = InferenceClient(settings, http)
            from app.models import ChatCompletionRequest

            req = ChatCompletionRequest(
                messages=[{"role": "user", "content": "hi"}], stream=True
            )
            frames = []
            async for frame in inference.stream_chat(
                req, is_disconnected=is_disconnected
            ):
                frames.append(frame)

    joined = b"".join(frames).decode()
    # We disconnected early, so no `done` event should be emitted.
    assert "event: done" not in joined
    get_settings.cache_clear()
