"""Acquisition configuration: source registry and credential-safe config.

The registry in ``config/sources.json`` is the sole authoritative source
catalog. Legacy central-Feed files (``feed-blogs.json``, ``feed-x.json``, ...)
become generated compatibility artifacts and must not be edited independently
once a source has been migrated into the registry.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .contracts import is_credential_key

CHANNEL_IDS = frozenset({
    "x", "podcasts", "blogs", "newsletters", "academic", "zh-tech", "reports",
})

ADAPTER_IDS = frozenset({
    "x", "rss", "web-publication", "podcast", "newsletter", "arxiv",
    "github", "hackernews", "reddit", "youtube", "techmeme", "digg",
    "xiaohongshu", "wechat", "report",
})

CHANNEL_POLICIES = frozenset({"fixed", "core-topic"})
CADENCES = frozenset({"daily", "weekly", "monthly"})
ACQUISITION_MODES = frozenset({"central", "shadow", "hybrid", "local"})

_REGISTRY_SCHEMA_VERSION = "1.0"

_REGISTRY_REQUIRED = (
    "id",
    "name",
    "channel",
    "channel_policy",
    "adapter",
    "requires_credentials",
    "default_enabled",
    "cadence",
    "budget",
    "input",
    "legacy",
)


class ConfigError(ValueError):
    """Raised when an acquisition config or registry fails validation."""


def _namespace_of(source_id: str) -> str:
    return source_id.split(":", 1)[0]


def _require_non_empty_string(value: Any, label: str) -> None:
    if not isinstance(value, str) or not value:
        raise ConfigError(f"{label} must be a non-empty string")


def _iter_credential_keys(value: Any, path: str = "$"):
    if isinstance(value, dict):
        for key, child in value.items():
            child_path = f"{path}.{key}"
            if is_credential_key(key):
                yield child_path, child
            yield from _iter_credential_keys(child, child_path)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from _iter_credential_keys(child, f"{path}[{index}]")


def validate_source_registry(registry: Any) -> list[dict[str, Any]]:
    """Validate a source registry object and return its source list."""
    if not isinstance(registry, dict):
        raise ConfigError("registry must be an object")
    if registry.get("schema_version") != _REGISTRY_SCHEMA_VERSION:
        raise ConfigError(f"registry.schema_version must be '{_REGISTRY_SCHEMA_VERSION}'")
    sources = registry.get("sources")
    if not isinstance(sources, list):
        raise ConfigError("registry.sources must be an array")

    seen_ids: set[str] = set()
    for index, source in enumerate(sources):
        _validate_source(source, index, seen_ids)
    return sources


def _validate_source(source: Any, index: int, seen_ids: set[str]) -> None:
    if not isinstance(source, dict):
        raise ConfigError(f"sources[{index}] must be an object")
    for field in _REGISTRY_REQUIRED:
        if field not in source:
            raise ConfigError(f"sources[{index}] is missing required field: {field}")
    extra = set(source) - set(_REGISTRY_REQUIRED)
    if extra:
        raise ConfigError(f"sources[{index}] has unknown field(s): {', '.join(sorted(extra))}")

    source_id = source["id"]
    _require_non_empty_string(source_id, f"sources[{index}].id")
    if ":" not in source_id or not source_id.split(":", 1)[1]:
        raise ConfigError(
            f"sources[{index}].id must be namespaced (e.g. 'x:karpathy')"
        )
    if source_id in seen_ids:
        raise ConfigError(f"duplicate source id: {source_id}")
    seen_ids.add(source_id)

    _require_non_empty_string(source["name"], f"sources[{index}].name")

    policy = source["channel_policy"]
    if policy not in CHANNEL_POLICIES:
        raise ConfigError(
            f"sources[{index}].channel_policy must be one of {sorted(CHANNEL_POLICIES)}"
        )
    channel = source["channel"]
    if policy == "fixed":
        if channel not in CHANNEL_IDS:
            raise ConfigError(
                f"sources[{index}].channel must be one of {sorted(CHANNEL_IDS)} for a fixed policy"
            )
    elif channel is not None:
        raise ConfigError(
            f"sources[{index}].channel must be null for a core-topic policy"
        )

    if source["adapter"] not in ADAPTER_IDS:
        raise ConfigError(
            f"sources[{index}].adapter must be one of {sorted(ADAPTER_IDS)}"
        )
    for flag in ("requires_credentials", "default_enabled"):
        if not isinstance(source[flag], bool):
            raise ConfigError(f"sources[{index}].{flag} must be a boolean")
    if source["cadence"] not in CADENCES:
        raise ConfigError(f"sources[{index}].cadence must be one of {sorted(CADENCES)}")

    budget = source["budget"]
    if not isinstance(budget, int) or isinstance(budget, bool) or budget < 1:
        raise ConfigError(f"sources[{index}].budget must be a positive integer")

    if not isinstance(source["input"], dict):
        raise ConfigError(f"sources[{index}].input must be an object")
    # Inputs are non-secret by construction; a credential-shaped key here is a bug.
    for path, _value in _iter_credential_keys(source["input"]):
        raise ConfigError(f"sources[{index}].input embeds a credential-shaped key: {path}")

    legacy = source["legacy"]
    if not isinstance(legacy, dict) or "feed" not in legacy:
        raise ConfigError(f"sources[{index}].legacy must be an object with a 'feed' field")
    if legacy["feed"] is not None:
        _require_non_empty_string(legacy["feed"], f"sources[{index}].legacy.feed")


def load_source_registry(path: str | Path) -> list[dict[str, Any]]:
    """Load and validate the source registry from disk."""
    with open(path, encoding="utf-8") as handle:
        return validate_source_registry(json.load(handle))


def validate_credential_references(config: Any) -> None:
    """Reject raw credential values: credential keys must reference a secret store."""
    if not isinstance(config, dict):
        raise ConfigError("config must be an object")
    for path, value in _iter_credential_keys(config):
        if not isinstance(value, dict) or "ref" not in value:
            raise ConfigError(
                f"{path} must be a credential reference (an object with a 'ref' field)"
            )


def validate_acquisition_mode(mode: Any) -> None:
    if mode not in ACQUISITION_MODES:
        raise ConfigError(f"acquisition mode must be one of {sorted(ACQUISITION_MODES)}")
