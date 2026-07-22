"""Structured JSON logging setup.

Emits one JSON object per log record. NEVER logs secrets, tokens,
Authorization headers, emails, prompts, or model responses. Callers pass
metadata via the `extra` dict; only a whitelisted set of keys is surfaced.
"""
from __future__ import annotations

import json
import logging
import sys
from typing import Any, Dict

# Keys we allow to be surfaced from LogRecord.__dict__ into the JSON line.
_EXTRA_WHITELIST = {
    "request_id",
    "method",
    "path",
    "status",
    "duration_ms",
    "sub",
    "bytes",
    "event",
    "code",
    "retry_after",
    "reason",
}

# Standard LogRecord attributes we never want to blindly copy.
_RESERVED = set(logging.LogRecord("", 0, "", 0, "", (), None).__dict__.keys())
_RESERVED.update({"message", "asctime", "taskName"})


class JsonFormatter(logging.Formatter):
    """Format log records as single-line JSON objects."""

    def format(self, record: logging.LogRecord) -> str:  # noqa: A003
        payload: Dict[str, Any] = {
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
            "timestamp": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
        }
        for key, value in record.__dict__.items():
            if key in _EXTRA_WHITELIST and value is not None:
                payload[key] = value
        if record.exc_info:
            payload["exc_type"] = getattr(record.exc_info[0], "__name__", None)
        return json.dumps(payload, default=str, separators=(",", ":"))


def configure_logging(level: str = "INFO") -> None:
    """Install the JSON formatter on the root logger, replacing prior handlers."""
    root = logging.getLogger()
    root.setLevel(level.upper())
    # Remove existing handlers so we don't double-log under uvicorn.
    for handler in list(root.handlers):
        root.removeHandler(handler)

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root.addHandler(handler)

    # Quiet noisy libraries; align uvicorn access logging with ours.
    for noisy in ("uvicorn.access",):
        logging.getLogger(noisy).handlers = []
        logging.getLogger(noisy).propagate = False


def get_logger(name: str) -> logging.Logger:
    """Return a module logger."""
    return logging.getLogger(name)
