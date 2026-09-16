"""Pure bounded models shared by the GitHub acquisition modules."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Mapping

from ..runtime import AdapterError, CheckpointUpdate, SourceCandidate


class BudgetExhausted(AdapterError):
    def __init__(self) -> None:
        super().__init__("GitHub request budget exhausted", status="partial", retryable=True)


class BreakerOpen(AdapterError):
    def __init__(self, status: str) -> None:
        super().__init__("GitHub request circuit is open", status=status, retryable=status == "rate-limited")


class GitHubModelError(AdapterError):
    def __init__(self, message: str) -> None:
        super().__init__(message, status="schema-drift")


@dataclass(frozen=True)
class CredentialResolution:
    status: str
    token: str | None = None

    @property
    def authenticated(self) -> bool:
        return self.status == "resolved"

    @classmethod
    def parse(cls, value: Any) -> "CredentialResolution":
        if type(value) is not dict:
            raise AdapterError("GitHub credential resolution is invalid", status="auth-failed")
        status = value.get("status")
        if status in {"absent", "resolution-error"} and set(value) == {"status"}:
            return cls(status)
        if status != "resolved" or set(value) != {"status", "token"}:
            raise AdapterError("GitHub credential resolution is invalid", status="auth-failed")
        token = value["token"]
        if type(token) is not str or not token or token != token.strip():
            raise AdapterError("GitHub credential resolution is invalid", status="auth-failed")
        try:
            encoded = token.encode("latin-1")
        except UnicodeEncodeError as exc:
            raise AdapterError("GitHub credential resolution is invalid", status="auth-failed") from exc
        if len(encoded) > 4096 or any(byte < 0x20 or 0x7F <= byte <= 0x9F for byte in encoded):
            raise AdapterError("GitHub credential resolution is invalid", status="auth-failed")
        return cls(status, token)


def _canonical_time(value: Any, label: str) -> str:
    if type(value) is not str or not value:
        raise AdapterError(f"{label} is invalid", status="error")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise AdapterError(f"{label} is invalid", status="error") from exc
    if parsed.tzinfo is None:
        raise AdapterError(f"{label} is invalid", status="error")
    return parsed.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


@dataclass(frozen=True)
class Window:
    start: str | None
    end: str

    def to_dict(self) -> dict[str, str | None]:
        return {"start": self.start, "end": self.end}

    @classmethod
    def from_request(cls, value: Any, *, previous_end: str | None, now: str) -> "Window":
        canonical_now = _canonical_time(now, "GitHub clock")
        if value is None:
            start = _canonical_time(previous_end, "previous window") if previous_end is not None else None
            return cls(start, canonical_now)
        if type(value) is not dict or set(value) != {"start", "end"}:
            raise AdapterError("request.window is invalid", status="error")
        start = _canonical_time(value["start"], "request.window.start") if value["start"] is not None else None
        end = _canonical_time(value["end"], "request.window.end") if value["end"] is not None else canonical_now
        if start is not None and start > end:
            raise AdapterError("request.window is invalid", status="error")
        return cls(start, end)


@dataclass
class RequestBudget:
    authenticated: bool
    total_used: int = 0
    used: dict[str, int] = field(default_factory=lambda: {"search": 0, "core": 0, "graphql": 0})

    @property
    def total_limit(self) -> int:
        return 64 if self.authenticated else 24

    @property
    def search_limit(self) -> int:
        return 27 if self.authenticated else 9

    @property
    def core_limit(self) -> int:
        return 31 if self.authenticated else 15

    @property
    def graphql_limit(self) -> int:
        return 6 if self.authenticated else 0

    def consume(self, kind: str) -> None:
        limits = {"search": self.search_limit, "core": self.core_limit, "graphql": self.graphql_limit}
        if kind not in limits or self.total_used >= self.total_limit or self.used[kind] >= limits[kind]:
            raise BudgetExhausted()
        self.used[kind] += 1
        self.total_used += 1


@dataclass
class Breaker:
    status: str | None = None
    discussions_open: bool = False


@dataclass(frozen=True)
class LaneOutcome:
    lane_id: str
    status: str
    candidates: tuple[SourceCandidate, ...] = ()
    checkpoint_update: CheckpointUpdate | None = None
    code: str | None = None
    message: str | None = None
    progressed: bool = False
    complete: bool = False
    state: Mapping[str, Any] | None = None
