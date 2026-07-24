"""Environment-driven application settings."""
from __future__ import annotations

from functools import lru_cache
from typing import List

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings sourced from environment variables.

    All fields are env-driven. Secrets are never logged (see logging_config).
    """

    model_config = SettingsConfigDict(
        env_file=None,
        case_sensitive=True,
        extra="ignore",
    )

    # --- Cognito / auth ---
    COGNITO_REGION: str = "us-east-1"
    COGNITO_USER_POOL_ID: str = "us-east-1_example"
    COGNITO_APP_CLIENT_ID: str = "example-client-id"
    COGNITO_ISSUER: str = ""
    COGNITO_JWKS_URL: str = ""

    # --- Upstream vLLM ---
    VLLM_BASE_URL: str = "http://vllm.llama-pilot.svc.cluster.local:8000"
    SERVED_MODEL_NAME: str = "llama-pilot"
    MAX_MODEL_LENGTH: int = 4096
    MAX_OUTPUT_TOKENS: int = 512

    # --- Prompting ---
    SYSTEM_PROMPT: str = (
        "You are a helpful, honest, and concise assistant. "
        "Answer the user's questions accurately and refuse unsafe requests."
    )

    # --- Concurrency / timeouts ---
    MAX_CONCURRENT_INFERENCE: int = 4
    REQUEST_TIMEOUT_SECONDS: int = 120
    GENERATION_TIMEOUT_SECONDS: int = 300

    # --- Conversation memory (in-memory, see app.sessions) ---
    # Number of user+assistant turn pairs kept per session (sliding window).
    SESSION_MAX_TURNS: int = 12
    # Idle time before a session's memory is dropped.
    SESSION_TTL_SECONDS: int = 1800
    # Hard cap on concurrently-remembered sessions (LRU eviction beyond this).
    SESSION_MAX_SESSIONS: int = 1000

    # --- Observability ---
    LOG_LEVEL: str = "INFO"
    LOG_PROMPTS: bool = False

    # --- Escape hatches / CORS ---
    AUTH_DISABLED: bool = False
    CORS_ALLOW_ORIGINS: str = ""

    def issuer(self) -> str:
        """Return the configured issuer, deriving it from region/pool if unset."""
        if self.COGNITO_ISSUER:
            return self.COGNITO_ISSUER
        return (
            f"https://cognito-idp.{self.COGNITO_REGION}.amazonaws.com/"
            f"{self.COGNITO_USER_POOL_ID}"
        )

    def jwks_url(self) -> str:
        """Return the configured JWKS URL, deriving it from the issuer if unset."""
        if self.COGNITO_JWKS_URL:
            return self.COGNITO_JWKS_URL
        return f"{self.issuer()}/.well-known/jwks.json"

    def cors_origins(self) -> List[str]:
        """Parse CORS_ALLOW_ORIGINS comma list into a list of origins."""
        if not self.CORS_ALLOW_ORIGINS.strip():
            return []
        return [o.strip() for o in self.CORS_ALLOW_ORIGINS.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    """Return a cached Settings instance."""
    return Settings()
