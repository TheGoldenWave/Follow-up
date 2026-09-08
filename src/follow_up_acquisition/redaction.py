"""Redaction helpers: scrub credential-shaped content before logging or persisting."""

from __future__ import annotations

import re
from typing import Any

from .contracts import is_credential_key

REDACTED = "[REDACTED]"

_HEADER_PATTERNS = (
    re.compile(r"(?i)\b(authorization|proxy-authorization)\s*[:=]\s*[^\n\r]+"),
    re.compile(r"(?i)\b(cookie|set-cookie)\s*[:=]\s*[^;\n\r]+"),
    re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]+"),
)


def redact_mapping(value: Any) -> Any:
    """Return a copy with values under credential-shaped keys replaced.

    Non-mapping scalars are returned unchanged; mappings and lists are
    traversed recursively.
    """
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for key, child in value.items():
            out[key] = REDACTED if is_credential_key(key) else redact_mapping(child)
        return out
    if isinstance(value, list):
        return [redact_mapping(item) for item in value]
    return value


def redact_text(text: str) -> str:
    """Best-effort redaction of authorization/cookie/bearer content in free text."""
    out = text
    out = _HEADER_PATTERNS[0].sub(r"\1: " + REDACTED, out)
    out = _HEADER_PATTERNS[1].sub(r"\1: " + REDACTED, out)
    out = _HEADER_PATTERNS[2].sub("bearer " + REDACTED, out)
    return out
