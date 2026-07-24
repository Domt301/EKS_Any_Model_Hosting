"""FastAPI application: routes, lifespan, middleware wiring."""
from __future__ import annotations

import time
from contextlib import asynccontextmanager

import httpx
from fastapi import Depends, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse

from .auth import AuthError, Principal, require_auth
from .config import Settings, get_settings
from .inference import STATUS_FOR_CODE, InferenceClient, UpstreamError
from .logging_config import configure_logging, get_logger
from .metrics import render_metrics
from .middleware import (
    BodySizeLimitMiddleware,
    InferenceLimiter,
    RequestContextMiddleware,
    rate_limited_response,
)
from .models import ChatCompletionRequest, ModelList, ModelObject
from .sessions import ConversationStore

logger = get_logger("app.main")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Create shared resources: httpx client, inference client, limiter."""
    settings = get_settings()
    configure_logging(settings.LOG_LEVEL)

    timeout = httpx.Timeout(
        connect=10.0,
        read=settings.REQUEST_TIMEOUT_SECONDS,
        write=30.0,
        pool=10.0,
    )
    client = httpx.AsyncClient(base_url=settings.VLLM_BASE_URL, timeout=timeout)
    app.state.http_client = client
    app.state.inference = InferenceClient(settings, client)
    app.state.limiter = InferenceLimiter(settings.MAX_CONCURRENT_INFERENCE)
    app.state.sessions = ConversationStore(
        max_turns=settings.SESSION_MAX_TURNS,
        ttl_seconds=settings.SESSION_TTL_SECONDS,
        max_sessions=settings.SESSION_MAX_SESSIONS,
    )
    logger.info("startup complete", extra={"event": "startup"})
    try:
        yield
    finally:
        await client.aclose()
        logger.info("shutdown complete", extra={"event": "shutdown"})


def create_app() -> FastAPI:
    """Application factory."""
    settings = get_settings()
    configure_logging(settings.LOG_LEVEL)

    app = FastAPI(
        title="Llama Pilot API",
        version="0.1.0",
        description="Application boundary for the Self-Hosted Llama Pilot on EKS.",
        lifespan=lifespan,
    )

    # add_middleware prepends (last added = outermost). We want
    # RequestContextMiddleware outermost so the access log and request id cover
    # everything, then CORS, then the body-size limiter closest to the routes.
    app.add_middleware(BodySizeLimitMiddleware)

    origins = settings.cors_origins()
    if origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=origins,
            allow_credentials=True,
            allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
            allow_headers=["Authorization", "Content-Type", "X-Request-ID"],
            expose_headers=["X-Request-ID"],
        )

    app.add_middleware(RequestContextMiddleware)

    _register_exception_handlers(app)
    _register_routes(app)
    return app


def _register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(AuthError)
    async def _auth_error_handler(request: Request, exc: AuthError):  # noqa: ANN001
        return JSONResponse(
            status_code=401,
            content={"error": {"code": "UNAUTHORIZED", "message": exc.message}},
            headers={"WWW-Authenticate": 'Bearer error="invalid_token"'},
        )

    @app.exception_handler(RequestValidationError)
    async def _validation_handler(request: Request, exc: RequestValidationError):  # noqa: ANN001
        # 422 for schema/limit violations. We surface a stable envelope and the
        # first error's message, never echoing prompt content beyond field names.
        errors = exc.errors()
        message = "Invalid request body."
        status = 422
        if errors:
            first = errors[0]
            loc = ".".join(str(p) for p in first.get("loc", []) if p != "body")
            message = f"{loc}: {first.get('msg', 'invalid')}".strip(": ")
            # A client-supplied `system` role fails the Literal check on role.
            if loc.endswith("role") or "role" in loc:
                status = 400
        return JSONResponse(
            status_code=status,
            content={"error": {"code": "INVALID_REQUEST", "message": message}},
        )

    @app.exception_handler(UpstreamError)
    async def _upstream_handler(request: Request, exc: UpstreamError):  # noqa: ANN001
        status = STATUS_FOR_CODE.get(exc.code, 502)
        return JSONResponse(
            status_code=status,
            content={"error": {"code": exc.code, "message": exc.message}},
        )


def _register_routes(app: FastAPI) -> None:
    # ----- Health -----
    @app.get("/health/live", tags=["health"])
    async def health_live() -> dict:
        # MUST NOT call vLLM.
        return {"status": "live"}

    @app.get("/health/ready", tags=["health"])
    async def health_ready(request: Request) -> Response:
        inference: InferenceClient = request.app.state.inference
        ready = await inference.check_ready()
        if ready:
            return JSONResponse(status_code=200, content={"status": "ready"})
        return JSONResponse(
            status_code=503,
            content={"status": "not_ready", "reason": "upstream_unreachable"},
        )

    # ----- Metrics -----
    @app.get("/metrics", tags=["observability"])
    async def metrics() -> Response:
        payload, content_type = render_metrics()
        return Response(content=payload, media_type=content_type)

    # ----- Identity -----
    @app.get("/api/v1/me", tags=["auth"])
    async def me(principal: Principal = Depends(require_auth)) -> dict:
        return {
            "sub": principal.sub,
            "token_use": principal.token_use,
            "client_id": principal.client_id,
            "scope": principal.scope,
        }

    # ----- Models -----
    @app.get("/api/v1/models", response_model=ModelList, tags=["models"])
    async def list_models(
        principal: Principal = Depends(require_auth),
        settings: Settings = Depends(get_settings),
    ) -> ModelList:
        # Only the public alias is exposed; never the real upstream model id.
        return ModelList(
            data=[
                ModelObject(
                    id=settings.SERVED_MODEL_NAME,
                    created=int(time.time()),
                    owned_by="llama-pilot",
                )
            ]
        )

    # ----- Chat completions -----
    @app.post("/api/v1/chat/completions", tags=["chat"])
    async def chat_completions(
        body: ChatCompletionRequest,
        request: Request,
        principal: Principal = Depends(require_auth),
        settings: Settings = Depends(get_settings),
    ) -> Response:
        limiter: InferenceLimiter = request.app.state.limiter
        inference: InferenceClient = request.app.state.inference
        sessions: ConversationStore = request.app.state.sessions
        request_id = getattr(request.state, "request_id", None)

        # Build the effective conversation. With a session_id the server keeps
        # the windowed conversation in memory across turns; without one the
        # request is answered statelessly from its own messages.
        transcript = [{"role": m.role, "content": m.content} for m in body.messages]
        if body.session_id:
            conversation = sessions.sync(body.session_id, transcript)
        else:
            conversation = transcript

        if not limiter.try_acquire():
            return rate_limited_response(request_id)

        if body.stream:
            # Streaming: the limiter slot is held for the life of the generator.
            def _remember(text: str) -> None:
                if body.session_id:
                    sessions.append_assistant(body.session_id, text)

            async def event_source():
                try:
                    async for frame in inference.stream_chat(
                        body,
                        conversation=conversation,
                        is_disconnected=request.is_disconnected,
                        on_complete=_remember,
                    ):
                        yield frame
                finally:
                    limiter.release()

            headers = {
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no",
            }
            if request_id:
                headers["X-Request-ID"] = request_id
            return StreamingResponse(
                event_source(),
                media_type="text/event-stream",
                headers=headers,
            )

        # Non-streaming: aggregate then release the slot.
        try:
            result = await inference.complete_chat(body, conversation=conversation)
        finally:
            limiter.release()
        if body.session_id:
            sessions.append_assistant(body.session_id, result.get("content", ""))
        return JSONResponse(status_code=200, content=result)

    # ----- Session memory (in-memory conversation context) -----
    @app.get("/api/v1/sessions/{session_id}", tags=["sessions"])
    async def session_info(
        session_id: str,
        request: Request,
        principal: Principal = Depends(require_auth),
    ) -> Response:
        sessions: ConversationStore = request.app.state.sessions
        info = sessions.info(session_id)
        if info is None:
            return JSONResponse(status_code=404, content={"status": "unknown"})
        return JSONResponse(status_code=200, content={"status": "active", **info})

    @app.delete("/api/v1/sessions/{session_id}", tags=["sessions"])
    async def session_forget(
        session_id: str,
        request: Request,
        principal: Principal = Depends(require_auth),
    ) -> Response:
        sessions: ConversationStore = request.app.state.sessions
        removed = sessions.forget(session_id)
        return JSONResponse(status_code=200, content={"forgotten": removed})


# Module-level app for `uvicorn app.main:app`.
app = create_app()
