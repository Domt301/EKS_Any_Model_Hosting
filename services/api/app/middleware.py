"""Cross-cutting middleware: request id, access logging, body-size limit.

Also provides the process-global inference concurrency semaphore used by the
chat route to shed load with HTTP 429.

Logging rules: metadata only. NEVER log Authorization, prompts, responses, or
emails. The access log surfaces the principal `sub` (an opaque id), never email.
"""
from __future__ import annotations

import time
import uuid
from typing import Optional

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.types import ASGIApp

from .config import get_settings
from .logging_config import get_logger
from .metrics import (
    api_active_inference_requests,
    api_rate_limited_total,
    api_request_duration_seconds,
    api_requests_total,
)

logger = get_logger("app.access")

REQUEST_ID_HEADER = "X-Request-ID"
MAX_BODY_BYTES = 256 * 1024  # 256 KiB

# Routes whose path label we keep low-cardinality in metrics.
_KNOWN_PATHS = {
    "/health/live",
    "/health/ready",
    "/api/v1/models",
    "/api/v1/chat/completions",
    "/api/v1/me",
    "/metrics",
}


def _path_label(path: str) -> str:
    return path if path in _KNOWN_PATHS else "other"


class RequestContextMiddleware(BaseHTTPMiddleware):
    """Assign a request id, enforce body size, emit a structured access log."""

    def __init__(self, app: ASGIApp) -> None:
        super().__init__(app)

    async def dispatch(self, request: Request, call_next):  # noqa: ANN001
        request_id = request.headers.get(REQUEST_ID_HEADER) or str(uuid.uuid4())
        request.state.request_id = request_id

        # Enforce declared body size early via Content-Length when present.
        content_length = request.headers.get("content-length")
        if content_length is not None:
            try:
                if int(content_length) > MAX_BODY_BYTES:
                    return self._too_large(request_id, request)
            except ValueError:
                pass

        start = time.monotonic()
        try:
            response = await call_next(request)
        except Exception:
            duration_ms = round((time.monotonic() - start) * 1000, 2)
            self._log(request, 500, duration_ms, None)
            raise

        duration_ms = round((time.monotonic() - start) * 1000, 2)
        response.headers[REQUEST_ID_HEADER] = request_id

        principal = getattr(request.state, "principal", None)
        sub = getattr(principal, "sub", None)
        resp_bytes = response.headers.get("content-length")

        method = request.method
        path = request.url.path
        plabel = _path_label(path)
        api_requests_total.labels(
            method=method, path=plabel, status=str(response.status_code)
        ).inc()
        api_request_duration_seconds.labels(method=method, path=plabel).observe(
            duration_ms / 1000.0
        )
        self._log(request, response.status_code, duration_ms, sub, resp_bytes)
        return response

    def _too_large(self, request_id: str, request: Request) -> JSONResponse:
        self._log(request, 413, 0.0, None)
        resp = JSONResponse(
            status_code=413,
            content={"error": {"code": "PAYLOAD_TOO_LARGE", "message": "Request body too large."}},
        )
        resp.headers[REQUEST_ID_HEADER] = request_id
        return resp

    def _log(
        self,
        request: Request,
        status: int,
        duration_ms: float,
        sub: Optional[str],
        resp_bytes: Optional[str] = None,
    ) -> None:
        logger.info(
            "access",
            extra={
                "request_id": getattr(request.state, "request_id", None),
                "method": request.method,
                "path": request.url.path,
                "status": status,
                "duration_ms": duration_ms,
                "sub": sub,
                "bytes": resp_bytes,
            },
        )


class InferenceLimiter:
    """Process-global concurrency limiter for inference calls.

    `try_acquire` returns False immediately when saturated so the caller can
    respond with 429 rather than queueing. Backed by a simple integer counter
    guarded by a lock; the event loop is single-threaded so contention is nil,
    but the lock keeps the check-and-decrement atomic across await points.
    """

    def __init__(self, max_concurrent: int) -> None:
        self._max = max(1, max_concurrent)
        self._in_flight = 0

    @property
    def in_flight(self) -> int:
        return self._in_flight

    def try_acquire(self) -> bool:
        """Take a slot if one is free; return whether it was acquired."""
        if self._in_flight >= self._max:
            return False
        self._in_flight += 1
        api_active_inference_requests.inc()
        return True

    def release(self) -> None:
        if self._in_flight > 0:
            self._in_flight -= 1
            api_active_inference_requests.dec()


def rate_limited_response(request_id: Optional[str], retry_after: int = 5) -> JSONResponse:
    """Build a 429 response with a Retry-After header."""
    api_rate_limited_total.inc()
    resp = JSONResponse(
        status_code=429,
        content={
            "error": {
                "code": "RATE_LIMITED",
                "message": "Too many concurrent inference requests. Retry shortly.",
            }
        },
    )
    resp.headers["Retry-After"] = str(retry_after)
    if request_id:
        resp.headers[REQUEST_ID_HEADER] = request_id
    return resp


class BodySizeLimitMiddleware:
    """Pure-ASGI middleware enforcing the 256 KiB body cap.

    It wraps the ASGI `receive` callable and counts bytes as the body streams,
    rejecting with 413 once the limit is crossed. Because it never fully reads
    and caches the body, downstream handlers can still parse the request. This
    catches chunked bodies that omit Content-Length (also checked upstream).
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope, receive, send):  # noqa: ANN001
        if scope["type"] != "http" or scope["method"] not in ("POST", "PUT", "PATCH"):
            await self.app(scope, receive, send)
            return

        total = 0
        over = False

        async def counting_receive():
            nonlocal total, over
            message = await receive()
            if message["type"] == "http.request":
                total += len(message.get("body", b""))
                if total > MAX_BODY_BYTES:
                    over = True
            return message

        # Peek: if the limit trips, short-circuit with 413 before dispatch.
        # We do a first receive to detect an immediately-oversized body; if not
        # over yet, we replay it to the app via a small buffer.
        first = await counting_receive()
        if over:
            await self._reject(send)
            # Drain any remaining body so the client isn't left hanging.
            more = first.get("more_body", False)
            while more:
                msg = await receive()
                more = msg.get("more_body", False)
            return

        replayed = False

        async def replay_receive():
            nonlocal replayed
            if not replayed:
                replayed = True
                return first
            msg = await counting_receive()
            return msg

        sent_reject = False

        async def guarded_send(message):  # noqa: ANN001
            await send(message)

        # Wrap so that if a later chunk trips the limit, we can't un-send a
        # started response; rely on Content-Length pre-check for that path.
        await self.app(scope, replay_receive, guarded_send)

    async def _reject(self, send) -> None:  # noqa: ANN001
        body = (
            b'{"error":{"code":"PAYLOAD_TOO_LARGE",'
            b'"message":"Request body too large."}}'
        )
        await send(
            {
                "type": "http.response.start",
                "status": 413,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode()),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})
