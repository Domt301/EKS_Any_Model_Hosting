"""Tests for in-memory conversation memory (app.sessions) and the session-aware
chat path."""
from __future__ import annotations

import json

import httpx

from app.sessions import ConversationStore
from tests.conftest import auth_headers, sse_chunk


# --------------------------------------------------------------------------
# Unit tests: ConversationStore
# --------------------------------------------------------------------------
def _msgs(*roles_contents):
    return [{"role": r, "content": c} for r, c in roles_contents]


def test_sync_returns_windowed_context():
    store = ConversationStore(max_turns=2)  # window = 4 messages
    transcript = _msgs(
        ("user", "u1"), ("assistant", "a1"),
        ("user", "u2"), ("assistant", "a2"),
        ("user", "u3"),
    )
    ctx = store.sync("s1", transcript)
    # Only the last 4 messages survive the window.
    assert [m["content"] for m in ctx] == ["a1", "u2", "a2", "u3"]
    assert store.context("s1") == ctx


def test_sync_drops_non_user_assistant_roles():
    store = ConversationStore(max_turns=8)
    transcript = _msgs(("system", "leak"), ("user", "hi")) + [{"role": "user", "content": ""}]
    ctx = store.sync("s1", transcript)
    assert ctx == [{"role": "user", "content": "hi"}]


def test_append_assistant_persists_reply():
    store = ConversationStore(max_turns=8)
    store.sync("s1", _msgs(("user", "hi")))
    store.append_assistant("s1", "hello there")
    assert store.context("s1")[-1] == {"role": "assistant", "content": "hello there"}
    info = store.info("s1")
    assert info is not None and info["messages"] == 2


def test_ttl_expiry_forgets_session():
    now = {"t": 1000.0}
    store = ConversationStore(max_turns=8, ttl_seconds=60, clock=lambda: now["t"])
    store.sync("s1", _msgs(("user", "hi")))
    now["t"] += 61
    assert store.context("s1") == []
    assert store.info("s1") is None


def test_lru_eviction_bounds_sessions():
    store = ConversationStore(max_turns=8, max_sessions=2)
    store.sync("s1", _msgs(("user", "a")))
    store.sync("s2", _msgs(("user", "b")))
    store.sync("s3", _msgs(("user", "c")))  # evicts s1 (LRU)
    assert store.context("s1") == []
    assert store.context("s2") != []
    assert store.context("s3") != []
    assert store.stats()["sessions"] == 2


def test_forget_removes_session():
    store = ConversationStore(max_turns=8)
    store.sync("s1", _msgs(("user", "hi")))
    assert store.forget("s1") is True
    assert store.forget("s1") is False


# --------------------------------------------------------------------------
# Route tests: session-aware chat + session endpoints
# --------------------------------------------------------------------------
def _stream_body() -> bytes:
    parts = [
        sse_chunk("Hi"),
        sse_chunk(None, usage={"prompt_tokens": 5, "completion_tokens": 1},
                  finish_reason="stop"),
        "data: [DONE]\n\n",
    ]
    return "".join(parts).encode()


def test_session_chat_sends_windowed_context_upstream(app_client, make_token):
    """The server reasons over the full multi-turn context for a session."""
    token = make_token()
    captured = {}

    def _capture(request: httpx.Request) -> httpx.Response:
        captured["payload"] = json.loads(request.content.decode())
        return httpx.Response(
            200, content=_stream_body(), headers={"content-type": "text/event-stream"}
        )

    app_client.respx.post("/v1/chat/completions").mock(side_effect=_capture)

    body = {
        "session_id": "conv-123",
        "messages": [
            {"role": "user", "content": "my name is Ada"},
            {"role": "assistant", "content": "Nice to meet you, Ada."},
            {"role": "user", "content": "what is my name?"},
        ],
        "stream": True,
    }
    resp = app_client.post("/api/v1/chat/completions", json=body, headers=auth_headers(token))
    assert resp.status_code == 200

    sent = captured["payload"]["messages"]
    # System prompt is injected first, then the whole conversation context.
    assert sent[0]["role"] == "system"
    contents = [m["content"] for m in sent]
    assert "my name is Ada" in contents
    assert "Nice to meet you, Ada." in contents
    assert "what is my name?" in contents

    # Session memory now holds the conversation for the next turn.
    info = app_client.app.state.sessions.info("conv-123")
    assert info is not None and info["turns"] == 1


def test_session_info_and_delete_endpoints(app_client, make_token):
    token = make_token()
    app_client.respx.post("/v1/chat/completions").mock(
        return_value=httpx.Response(
            200, content=_stream_body(), headers={"content-type": "text/event-stream"}
        )
    )
    body = {
        "session_id": "conv-xyz",
        "messages": [{"role": "user", "content": "hello"}],
        "stream": True,
    }
    app_client.post("/api/v1/chat/completions", json=body, headers=auth_headers(token))

    info = app_client.get("/api/v1/sessions/conv-xyz", headers=auth_headers(token))
    assert info.status_code == 200
    assert info.json()["status"] == "active"

    gone = app_client.delete("/api/v1/sessions/conv-xyz", headers=auth_headers(token))
    assert gone.status_code == 200
    assert gone.json()["forgotten"] is True

    missing = app_client.get("/api/v1/sessions/conv-xyz", headers=auth_headers(token))
    assert missing.status_code == 404


def test_invalid_session_id_rejected(app_client, make_token):
    token = make_token()
    body = {
        "session_id": "bad id with spaces!",
        "messages": [{"role": "user", "content": "hi"}],
        "stream": True,
    }
    resp = app_client.post("/api/v1/chat/completions", json=body, headers=auth_headers(token))
    assert resp.status_code == 422
