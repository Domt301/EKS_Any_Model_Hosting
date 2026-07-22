"""Cognito access-token validation tests."""
from __future__ import annotations

from tests.conftest import TEST_CLIENT_ID, auth_headers


def test_missing_token_returns_401(app_client):
    resp = app_client.get("/api/v1/me")
    assert resp.status_code == 401
    assert "WWW-Authenticate" in resp.headers
    assert resp.json()["error"]["code"] == "UNAUTHORIZED"


def test_invalid_token_returns_401(app_client):
    resp = app_client.get("/api/v1/me", headers=auth_headers("not-a-jwt"))
    assert resp.status_code == 401


def test_wrong_issuer_returns_401(app_client, make_token):
    token = make_token(issuer="https://evil.example.com/pool")
    resp = app_client.get("/api/v1/me", headers=auth_headers(token))
    assert resp.status_code == 401


def test_id_token_rejected(app_client, make_token):
    token = make_token(token_use="id")
    resp = app_client.get("/api/v1/me", headers=auth_headers(token))
    assert resp.status_code == 401


def test_wrong_client_id_rejected(app_client, make_token):
    token = make_token(client_id="some-other-client")
    resp = app_client.get("/api/v1/me", headers=auth_headers(token))
    assert resp.status_code == 401


def test_expired_token_rejected(app_client, make_token):
    token = make_token(exp_delta=-10)
    resp = app_client.get("/api/v1/me", headers=auth_headers(token))
    assert resp.status_code == 401


def test_unknown_kid_rejected(app_client, make_token):
    token = make_token(kid="nonexistent-kid")
    resp = app_client.get("/api/v1/me", headers=auth_headers(token))
    assert resp.status_code == 401


def test_valid_access_token_returns_200(app_client, make_token):
    token = make_token()
    resp = app_client.get("/api/v1/me", headers=auth_headers(token))
    assert resp.status_code == 200
    body = resp.json()
    assert body["sub"] == "user-abc-123"
    assert body["token_use"] == "access"
    assert body["client_id"] == TEST_CLIENT_ID
    # Non-sensitive claims only; no email or raw token echoed.
    assert "email" not in body
    assert "scope" in body


def test_auth_disabled_bypass(monkeypatch):
    """AUTH_DISABLED yields a synthetic principal without a token."""
    monkeypatch.setenv("AUTH_DISABLED", "true")
    from app.config import get_settings
    from app.main import create_app
    from fastapi.testclient import TestClient

    get_settings.cache_clear()
    app = create_app()
    with TestClient(app) as c:
        resp = c.get("/api/v1/me")
    assert resp.status_code == 200
    assert resp.json()["sub"] == "dev-user"
    get_settings.cache_clear()
