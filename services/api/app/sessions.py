"""Lightweight in-memory conversation memory.

A process-local store that maintains short-term conversational context between
turns without any external database (see ADR-008/009: browser + in-memory only).

Responsibilities:
  * Hold each session's running conversation in memory, keyed by an opaque
    client-supplied ``session_id``.
  * Apply a server-side sliding context window (last ``max_turns`` user+assistant
    pairs) so long chats never exceed the model's context or leak unbounded
    history to the model.
  * Bound total memory: evict least-recently-used sessions past ``max_sessions``
    and lazily drop sessions idle longer than ``ttl_seconds``.

Design notes:
  * The client remains the transport source of truth for its transcript, so a
    turn is still answered correctly even if it lands on a cold replica or after
    a pod restart (the store is synced from the request each turn). The store is
    what the server *reasons over* — it is the authoritative, windowed context
    handed to the model, and it survives between turns within a replica.
  * Guarded by a plain lock. Operations are O(window) and never await, so the
    single-threaded event loop sees no contention; the lock only makes the
    check-mutate sequences atomic and keeps the store safe under a threaded
    server too.
  * Stores metadata + message content only in memory; nothing is logged or
    persisted. Content never leaves the process.
"""
from __future__ import annotations

import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional

# A single conversation message as handed to the model.
Message = Dict[str, str]  # {"role": "user"|"assistant", "content": str}


@dataclass
class _Session:
    messages: List[Message] = field(default_factory=list)
    last_seen: float = 0.0
    created: float = 0.0
    turns: int = 0


class ConversationStore:
    """In-memory, bounded, TTL'd conversation memory keyed by session id."""

    def __init__(
        self,
        *,
        max_turns: int = 12,
        ttl_seconds: int = 1800,
        max_sessions: int = 1000,
        clock: Optional[Callable[[], float]] = None,
    ) -> None:
        # Keep the last ``max_turns`` user+assistant pairs => 2*max_turns msgs.
        self._max_messages = max(2, max_turns * 2)
        self._ttl = max(1, ttl_seconds)
        self._max_sessions = max(1, max_sessions)
        self._clock = clock or time.monotonic
        self._lock = threading.Lock()
        self._sessions: "OrderedDict[str, _Session]" = OrderedDict()

    # -- internal helpers (call with the lock held) -----------------------
    def _expired(self, sess: _Session, now: float) -> bool:
        return (now - sess.last_seen) > self._ttl

    def _sweep(self, now: float) -> None:
        # Drop expired sessions (cheap: only those at/near the LRU front matter,
        # but a full pass stays O(n) and n is bounded by max_sessions).
        for sid in [s for s, v in self._sessions.items() if self._expired(v, now)]:
            del self._sessions[sid]
        # Enforce the hard cap by evicting least-recently-used sessions.
        while len(self._sessions) > self._max_sessions:
            self._sessions.popitem(last=False)

    @staticmethod
    def _window(messages: List[Message], limit: int) -> List[Message]:
        return messages[-limit:] if len(messages) > limit else messages

    # -- public API -------------------------------------------------------
    def sync(self, session_id: str, transcript: List[Message]) -> List[Message]:
        """Replace a session's memory with the client's transcript (windowed).

        Returns the windowed context the server will reason over. Only
        ``user``/``assistant`` roles are retained; anything else is dropped
        defensively (the system prompt is injected downstream, never stored).
        """
        now = self._clock()
        cleaned = [
            {"role": m["role"], "content": m["content"]}
            for m in transcript
            if m.get("role") in ("user", "assistant") and m.get("content")
        ]
        windowed = self._window(cleaned, self._max_messages)
        with self._lock:
            self._sweep(now)
            sess = self._sessions.get(session_id)
            if sess is None:
                sess = _Session(created=now)
            sess.messages = list(windowed)
            sess.last_seen = now
            sess.turns += 1
            # Move/insert at MRU position.
            self._sessions[session_id] = sess
            self._sessions.move_to_end(session_id)
            self._sweep(now)
            return list(sess.messages)

    def append_assistant(self, session_id: str, content: str) -> None:
        """Record the assistant's reply so it persists as memory for next turn."""
        if not content:
            return
        now = self._clock()
        with self._lock:
            sess = self._sessions.get(session_id)
            if sess is None:
                return
            sess.messages.append({"role": "assistant", "content": content})
            sess.messages = self._window(sess.messages, self._max_messages)
            sess.last_seen = now
            self._sessions.move_to_end(session_id)

    def context(self, session_id: str) -> List[Message]:
        """Return a copy of the windowed context for a session (empty if none)."""
        now = self._clock()
        with self._lock:
            sess = self._sessions.get(session_id)
            if sess is None or self._expired(sess, now):
                return []
            return list(sess.messages)

    def forget(self, session_id: str) -> bool:
        """Drop a session's memory. Returns True if something was removed."""
        with self._lock:
            return self._sessions.pop(session_id, None) is not None

    def info(self, session_id: str) -> Optional[Dict[str, int]]:
        """Return lightweight metadata for a session, or None if unknown."""
        now = self._clock()
        with self._lock:
            sess = self._sessions.get(session_id)
            if sess is None or self._expired(sess, now):
                return None
            return {
                "messages": len(sess.messages),
                "turns": sess.turns,
                "idle_seconds": int(now - sess.last_seen),
            }

    def stats(self) -> Dict[str, int]:
        now = self._clock()
        with self._lock:
            self._sweep(now)
            return {
                "sessions": len(self._sessions),
                "max_sessions": self._max_sessions,
                "window_messages": self._max_messages,
                "ttl_seconds": self._ttl,
            }
