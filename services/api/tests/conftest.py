"""Shared pytest fixtures.

We generate a real RSA keypair in-process and sign JWTs with the private half.
Signature verification runs the real PyJWT RS256 path against the matching
public key; only the *network fetch* of the JWKS is stubbed (PyJWKClient uses
urllib, not httpx, so respx cannot intercept it). vLLM's HTTP calls DO go
through httpx and are mocked with respx.
"""
from __future__ import annotations

import time
import uuid
from typing import Callable, Dict, Optional

import httpx
import jwt
import pytest
import respx
from cryptography.hazmat.primitives.asymmetric import rsa

# --- Test Cognito configuration ---
TEST_REGION = "us-east-1"
TEST_POOL_ID = "us-east-1_testpool"
TEST_CLIENT_ID = "test-app-client-id"
TEST_ISSUER = f"https://cognito-idp.{TEST_REGION}.amazonaws.com/{TEST_POOL_ID}"
TEST_JWKS_URL = f"{TEST_ISSUER}/.well-known/jwks.json"
TEST_KID = "test-key-1"

VLLM_BASE_URL = "http://vllm.llama-pilot.svc.cluster.local:8000"


@pytest.fixture(scope="session")
def rsa_key() -> rsa.RSAPrivateKey:
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


class _StubSigningKey:
    def __init__(self, key) -> None:  # noqa: ANN001
        self.key = key


class _StubJWKClient:
    """Stand-in for PyJWKClient that resolves keys from a known public key.

    It still parses the token header (so malformed tokens raise DecodeError,
    exercising the real error path) and honors a configured kid.
    """

    def __init__(self, public_key, valid_kid: str = TEST_KID) -> None:  # noqa: ANN001
        self._public_key = public_key
        self._valid_kid = valid_kid

    def get_signing_key_from_jwt(self, token: str) -> _StubSigningKey:
        header = jwt.get_unverified_header(token)  # raises DecodeError if garbage
        kid = header.get("kid")
        if kid != self._valid_kid:
            raise jwt.PyJWKClientError(f"Unknown kid: {kid}")
        return _StubSigningKey(self._public_key)


@pytest.fixture(autouse=True)
def _env(monkeypatch, rsa_key):
    """Set Cognito + vLLM env, stub the JWKS client, reset caches per test."""
    monkeypatch.setenv("COGNITO_REGION", TEST_REGION)
    monkeypatch.setenv("COGNITO_USER_POOL_ID", TEST_POOL_ID)
    monkeypatch.setenv("COGNITO_APP_CLIENT_ID", TEST_CLIENT_ID)
    monkeypatch.setenv("COGNITO_ISSUER", TEST_ISSUER)
    monkeypatch.setenv("COGNITO_JWKS_URL", TEST_JWKS_URL)
    monkeypatch.setenv("VLLM_BASE_URL", VLLM_BASE_URL)
    monkeypatch.setenv("SERVED_MODEL_NAME", "llama-pilot")
    monkeypatch.setenv("MAX_OUTPUT_TOKENS", "512")
    monkeypatch.setenv("MAX_CONCURRENT_INFERENCE", "4")
    monkeypatch.setenv("AUTH_DISABLED", "false")
    monkeypatch.setenv("LOG_PROMPTS", "false")

    from app import auth
    from app.config import get_settings

    get_settings.cache_clear()
    auth.reset_jwks_cache()

    stub = _StubJWKClient(rsa_key.public_key())
    monkeypatch.setattr(auth, "_get_jwks_client", lambda settings: stub)

    yield
    get_settings.cache_clear()
    auth.reset_jwks_cache()


@pytest.fixture
def make_token(rsa_key: rsa.RSAPrivateKey) -> Callable[..., str]:
    """Factory producing signed JWTs. Defaults to a valid Cognito access token."""

    def _make(
        *,
        token_use: str = "access",
        issuer: str = TEST_ISSUER,
        client_id: str = TEST_CLIENT_ID,
        sub: str = "user-abc-123",
        scope: str = "aws.cognito.signin.user.admin",
        exp_delta: int = 3600,
        kid: str = TEST_KID,
        extra: Optional[Dict] = None,
    ) -> str:
        now = int(time.time())
        claims = {
            "sub": sub,
            "iss": issuer,
            "token_use": token_use,
            "client_id": client_id,
            "scope": scope,
            "username": "tester",
            "iat": now,
            "exp": now + exp_delta,
            "jti": str(uuid.uuid4()),
        }
        if extra:
            claims.update(extra)
        return jwt.encode(claims, rsa_key, algorithm="RS256", headers={"kid": kid})

    return _make


@pytest.fixture
def respx_router():
    """respx router scoped to the vLLM base URL for mocking upstream calls."""
    with respx.mock(base_url=VLLM_BASE_URL, assert_all_called=False) as router:
        yield router


@pytest.fixture
def app_client(respx_router):
    """A FastAPI TestClient with lifespan run; respx router attached as .respx."""
    from fastapi.testclient import TestClient

    from app.main import create_app

    app = create_app()
    with TestClient(app) as c:
        c.respx = respx_router  # type: ignore[attr-defined]
        yield c


def auth_headers(token: str) -> Dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def sse_chunk(content: Optional[str] = None, *, usage: Optional[Dict] = None,
              finish_reason: Optional[str] = None) -> str:
    """Build a vLLM-style streaming SSE `data:` line."""
    import json

    delta = {}
    if content is not None:
        delta["content"] = content
    chunk = {
        "id": "cmpl-test",
        "object": "chat.completion.chunk",
        "model": "meta-llama/real-model",
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
    }
    if usage is not None:
        chunk["usage"] = usage
    return f"data: {json.dumps(chunk)}\n\n"
