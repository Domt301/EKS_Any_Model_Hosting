"""Pydantic request/response models and validation limits.

The public contract is intentionally narrow: clients may only send `user` and
`assistant` messages. A `system` role from the client is rejected. Clients may
not choose the upstream model; the server forces SERVED_MODEL_NAME.
"""
from __future__ import annotations

from typing import List, Literal, Optional

from pydantic import BaseModel, Field, field_validator, model_validator

# --- Validation limits (also see middleware for the 256 KiB body cap) ---
MAX_MESSAGES = 20
MAX_CHARS_PER_MESSAGE = 8000
MAX_TOTAL_CHARS = 24000
MAX_OUTPUT_TOKENS_CEILING = 512
MIN_OUTPUT_TOKENS = 1
MIN_TEMPERATURE = 0.0
MAX_TEMPERATURE = 1.5

# Only these roles are accepted from clients. `system` is deliberately excluded.
ClientRole = Literal["user", "assistant"]


class ChatMessage(BaseModel):
    """A single chat message from the client."""

    role: ClientRole
    content: str = Field(..., min_length=1, max_length=MAX_CHARS_PER_MESSAGE)

    model_config = {"extra": "forbid"}


class ChatCompletionRequest(BaseModel):
    """Public chat-completion request body."""

    messages: List[ChatMessage] = Field(..., min_length=1, max_length=MAX_MESSAGES)
    temperature: float = Field(default=0.2, ge=MIN_TEMPERATURE, le=MAX_TEMPERATURE)
    max_output_tokens: int = Field(
        default=256, ge=MIN_OUTPUT_TOKENS, le=MAX_OUTPUT_TOKENS_CEILING
    )
    stream: bool = True

    model_config = {"extra": "forbid"}

    @field_validator("messages")
    @classmethod
    def _check_total_chars(cls, messages: List[ChatMessage]) -> List[ChatMessage]:
        total = sum(len(m.content) for m in messages)
        if total > MAX_TOTAL_CHARS:
            raise ValueError(
                f"total message content exceeds {MAX_TOTAL_CHARS} characters"
            )
        return messages

    @model_validator(mode="after")
    def _last_message_is_user(self) -> "ChatCompletionRequest":
        # A well-formed conversation ends with a user turn to respond to.
        if self.messages and self.messages[-1].role != "user":
            raise ValueError("the final message must have role 'user'")
        return self

    def clamped_max_tokens(self, ceiling: int) -> int:
        """Clamp requested output tokens to the server ceiling."""
        return max(MIN_OUTPUT_TOKENS, min(self.max_output_tokens, ceiling))


class ModelObject(BaseModel):
    """OpenAI-style model object for GET /api/v1/models."""

    id: str
    object: str = "model"
    created: int = 0
    owned_by: str = "llama-pilot"


class ModelList(BaseModel):
    """OpenAI-style model list."""

    object: str = "list"
    data: List[ModelObject]


class ErrorBody(BaseModel):
    """Stable public error envelope."""

    code: str
    message: str


class ErrorResponse(BaseModel):
    """Wrapper matching the SSE error event payload shape for JSON errors."""

    error: ErrorBody


class Usage(BaseModel):
    """Token usage returned on non-streaming completions."""

    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0


class ChatCompletionResponse(BaseModel):
    """Aggregated (non-streaming) completion response."""

    id: str
    model: str
    content: str
    finish_reason: Optional[str] = None
    usage: Usage
