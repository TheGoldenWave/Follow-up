"""Time-to-live cache for acquisition outputs.

Text, snippets, and transcripts default to 7 days; candidate metadata and user
state default to 90 days. The cache is in-memory for this increment and is
injected into the runtime so persistence can be layered on without changing
callers.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

TEXT_TTL_SECONDS = 7 * 24 * 60 * 60
METADATA_TTL_SECONDS = 90 * 24 * 60 * 60


@dataclass
class _Entry:
    value: Any
    expires_at: float


class TTLCache:
    def __init__(self, now: Callable[[], float] | None = None) -> None:
        self._now = now if now is not None else _monotonic
        self._entries: dict[str, _Entry] = {}

    def put(self, key: str, value: Any, ttl_seconds: float) -> None:
        if ttl_seconds <= 0:
            raise ValueError("ttl_seconds must be positive")
        self._entries[key] = _Entry(value, self._now() + ttl_seconds)

    def get(self, key: str, default: Any = None) -> Any:
        entry = self._entries.get(key)
        if entry is None:
            return default
        if self._now() >= entry.expires_at:
            del self._entries[key]
            return default
        return entry.value

    def contains(self, key: str) -> bool:
        entry = self._entries.get(key)
        return entry is not None and self._now() < entry.expires_at

    def expire(self) -> int:
        """Drop expired entries and return how many were removed."""
        now = self._now()
        expired = [key for key, entry in self._entries.items() if now >= entry.expires_at]
        for key in expired:
            del self._entries[key]
        return len(expired)

    def __len__(self) -> int:
        return len(self._entries)


def _monotonic() -> float:
    import time

    return time.monotonic()
