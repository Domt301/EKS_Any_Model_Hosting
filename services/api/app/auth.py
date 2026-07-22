"""Cognito access-token validation with JWKS caching.

Validates AWS Cognito **access** tokens (not id tokens):
  * a Bearer token must be present;
  * RS256 signature verified against the pool JWKS (cached, refetched on kid miss);
  * `iss` equals the configured issuer;
  * `exp` not in the past;
  * `token_use == "access"` (id tokens are rejected);
  * `client_id` equals the configured app client id.

Any failure raises HTTP 401 with a `WWW-Authenticate` header.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Optional

import jwt
from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jwt import PyJWKClient

from .config import Settings, get_settings
from .metrics import api_auth_failures_total

_bearer = HTTPBearer(auto_error=False)

# Module-level JWKS client cache keyed by URL so we reuse the in-memory key cache
# across requests. PyJWKClient itself caches keys and refetches on kid miss.
_jwks_clients: Dict[str, PyJWKClient] = {}


@dataclass
class Principal:
    """Validated caller identity derived from the access token."""

    sub: str
    token_use: str
    client_id: Optional[str]
    scope: Optional[str]
    username: Optional[str] = None
    claims: Optional[Dict[str, Any]] = None


class AuthError(Exception):
    """Raised when authentication fails; carries a stable reason code."""

    def __init__(self, reason: str, message: str) -> None:
        super().__init__(message)
        self.reason = reason
        self.message = message


def _get_jwks_client(settings: Settings) -> PyJWKClient:
    url = settings.jwks_url()
    client = _jwks_clients.get(url)
    if client is None:
        client = PyJWKClient(url, cache_keys=True)
        _jwks_clients[url] = client
    return client


def reset_jwks_cache() -> None:
    """Clear cached JWKS clients (used by tests)."""
    _jwks_clients.clear()


def _synthetic_principal() -> Principal:
    return Principal(
        sub="dev-user",
        token_use="access",
        client_id="dev-client",
        scope="openid",
        username="dev",
        claims={"sub": "dev-user", "token_use": "access"},
    )


def validate_token(token: str, settings: Settings) -> Principal:
    """Validate a raw JWT access token and return a Principal, or raise AuthError."""
    try:
        signing_key = _get_jwks_client(settings).get_signing_key_from_jwt(token)
    except jwt.PyJWKClientError as exc:
        raise AuthError("jwks_error", "Unable to resolve signing key") from exc
    except jwt.DecodeError as exc:
        raise AuthError("malformed", "Malformed token") from exc

    try:
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            issuer=settings.issuer(),
            options={
                # Cognito access tokens have no `aud`; we check client_id below.
                "verify_aud": False,
                "require": ["exp", "iss"],
            },
        )
    except jwt.ExpiredSignatureError as exc:
        raise AuthError("expired", "Token expired") from exc
    except jwt.InvalidIssuerError as exc:
        raise AuthError("issuer", "Invalid issuer") from exc
    except jwt.InvalidTokenError as exc:
        raise AuthError("invalid", "Invalid token") from exc

    token_use = claims.get("token_use")
    if token_use != "access":
        raise AuthError("token_use", "Expected an access token")

    client_id = claims.get("client_id")
    if client_id != settings.COGNITO_APP_CLIENT_ID:
        raise AuthError("client_id", "Token was not issued for this client")

    return Principal(
        sub=claims.get("sub", ""),
        token_use=token_use,
        client_id=client_id,
        scope=claims.get("scope"),
        username=claims.get("username"),
        claims=claims,
    )


async def require_auth(
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(_bearer),
    settings: Settings = Depends(get_settings),
) -> Principal:
    """FastAPI dependency enforcing a valid Cognito access token.

    Raises AuthError (translated to 401 by the exception handler) on any failure.
    When AUTH_DISABLED is true, returns a synthetic dev principal.
    """
    if settings.AUTH_DISABLED:
        principal = _synthetic_principal()
        request.state.principal = principal
        return principal

    if credentials is None or not credentials.credentials:
        api_auth_failures_total.labels(reason="missing").inc()
        raise AuthError("missing", "Missing bearer token")

    try:
        principal = validate_token(credentials.credentials, settings)
    except AuthError as exc:
        api_auth_failures_total.labels(reason=exc.reason).inc()
        raise

    request.state.principal = principal
    return principal
