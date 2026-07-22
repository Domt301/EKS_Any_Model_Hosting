"""Prometheus metrics and the /metrics endpoint content."""
from __future__ import annotations

from prometheus_client import (
    CONTENT_TYPE_LATEST,
    CollectorRegistry,
    Counter,
    Gauge,
    Histogram,
    generate_latest,
)

# A dedicated registry keeps test isolation clean and avoids clashing with
# any default-registry collectors pulled in by dependencies.
REGISTRY = CollectorRegistry()

api_requests_total = Counter(
    "api_requests_total",
    "Total HTTP requests handled by the API boundary.",
    ["method", "path", "status"],
    registry=REGISTRY,
)

api_request_duration_seconds = Histogram(
    "api_request_duration_seconds",
    "HTTP request duration in seconds.",
    ["method", "path"],
    registry=REGISTRY,
)

api_time_to_first_token_seconds = Histogram(
    "api_time_to_first_token_seconds",
    "Time from inference start to first streamed token, in seconds.",
    registry=REGISTRY,
)

api_stream_duration_seconds = Histogram(
    "api_stream_duration_seconds",
    "Total duration of a streaming inference response, in seconds.",
    registry=REGISTRY,
)

api_active_inference_requests = Gauge(
    "api_active_inference_requests",
    "Number of in-flight inference requests holding a concurrency slot.",
    registry=REGISTRY,
)

api_rate_limited_total = Counter(
    "api_rate_limited_total",
    "Requests rejected with 429 due to concurrency saturation.",
    registry=REGISTRY,
)

api_auth_failures_total = Counter(
    "api_auth_failures_total",
    "Authentication failures (401).",
    ["reason"],
    registry=REGISTRY,
)

api_model_errors_total = Counter(
    "api_model_errors_total",
    "Upstream model errors surfaced to clients.",
    ["code"],
    registry=REGISTRY,
)

api_prompt_tokens_total = Counter(
    "api_prompt_tokens_total",
    "Total prompt tokens reported by the upstream model.",
    registry=REGISTRY,
)

api_completion_tokens_total = Counter(
    "api_completion_tokens_total",
    "Total completion tokens reported by the upstream model.",
    registry=REGISTRY,
)


def render_metrics() -> tuple[bytes, str]:
    """Return the exposition payload and its content type."""
    return generate_latest(REGISTRY), CONTENT_TYPE_LATEST
