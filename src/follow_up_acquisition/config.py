"""Acquisition configuration: source registry and credential-safe config.

The registry in ``config/sources.json`` is the sole authoritative source
catalog. Legacy central-Feed files (``feed-blogs.json``, ``feed-x.json``, ...)
become generated compatibility artifacts and must not be edited independently
once a source has been migrated into the registry.
"""

from __future__ import annotations

import json
from pathlib import Path
import re
from typing import Any
from urllib.parse import urlparse

from .contracts import is_credential_key

CHANNEL_IDS = frozenset({
    "x", "podcasts", "blogs", "newsletters", "academic", "zh-tech", "reports",
})

ADAPTER_IDS = frozenset({
    "x", "rss", "web-publication", "podcast", "newsletter", "arxiv",
    "github", "hackernews", "reddit", "youtube", "techmeme", "digg",
    "xiaohongshu", "wechat", "report",
    "hugging-face-papers",
})

CHANNEL_POLICIES = frozenset({"fixed", "core-topic"})
CADENCES = frozenset({"daily", "weekly", "monthly"})
ACQUISITION_MODES = frozenset({"central", "shadow", "hybrid", "local"})

_REGISTRY_SCHEMA_VERSION = "1.0"

_QUERY_ID_RE = re.compile(r"^[a-z][a-z0-9-]{0,31}$")
_INPUT_FIELDS = {
    "x": frozenset({"handle"}),
    "rss": frozenset({"rss_url", "url", "language"}),
    "podcast": frozenset({"rss_url", "url"}),
    "arxiv": frozenset({"rss_url", "url"}),
    "report": frozenset({"url"}),
    "web-publication": frozenset({
        "url", "language", "discovery", "article_url_patterns",
        "exclude_url_patterns", "parser", "fetch_url_patterns",
        "content_selectors", "content_selector_priority",
    }),
    "github": frozenset({"rest_api_url", "graphql_url", "include_discussions", "queries"}),
    "hackernews": frozenset({
        "firebase_url", "algolia_url", "top_enabled", "new_enabled", "queries",
    }),
    "techmeme": frozenset({"front_url", "archive_url_template"}),
    "reddit": frozenset({"subreddit", "rss_url", "listing_url"}),
    "hugging-face-papers": frozenset({
        "structured_endpoint", "page_base_url", "views", "timezone",
    }),
}
_REQUIRED_INPUT_FIELDS = {
    adapter: fields for adapter, fields in _INPUT_FIELDS.items()
}
_REQUIRED_INPUT_FIELDS["rss"] = frozenset({"rss_url", "url"})
_REQUIRED_INPUT_FIELDS["web-publication"] = frozenset({
    "url", "language", "discovery", "article_url_patterns", "exclude_url_patterns", "parser",
})
_GITHUB_FILTERS = frozenset({"entities", "language", "min_stars", "owner", "topics"})
_GITHUB_ENTITIES = frozenset({"repository", "release", "commit", "issue", "pull-request"})
_HN_FILTERS = frozenset({"tags", "min_points"})
_HN_TAGS = frozenset({"story", "ask_hn", "show_hn", "front_page"})
_CHANNEL_NAMESPACES = {
    "x": "x", "podcasts": "podcast", "blogs": "blog",
    "newsletters": "newsletter", "academic": "academic",
    "zh-tech": "zh-tech", "reports": "report",
}

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


def _require_https_url(value: Any, label: str, *, template: bool = False) -> None:
    _require_non_empty_string(value, label)
    parsed = urlparse(value.replace("{date}", "2000-01-01") if template else value)
    if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password:
        raise ConfigError(f"{label} must be a public HTTPS URL")
    if template and value.count("{date}") != 1:
        raise ConfigError(f"{label} must contain exactly one {{date}} placeholder")


def _validate_queries(value: Any, label: str, *, adapter: str) -> None:
    if not isinstance(value, list) or not value:
        raise ConfigError(f"{label} must be a non-empty array")
    seen: set[str] = set()
    allowed_filters = _GITHUB_FILTERS if adapter == "github" else _HN_FILTERS
    allowed_sorts = {"updated", "stars"} if adapter == "github" else {"date", "points"}
    for index, query in enumerate(value):
        query_label = f"{label}[{index}]"
        if not isinstance(query, dict) or set(query) != {"id", "query", "sort", "filters"}:
            raise ConfigError(f"{query_label} must contain only id, query, sort, and filters")
        query_id = query["id"]
        if not isinstance(query_id, str) or _QUERY_ID_RE.fullmatch(query_id) is None:
            raise ConfigError(f"{query_label}.id must be a stable lowercase query ID")
        if query_id in seen:
            raise ConfigError(f"{label} contains duplicate query id: {query_id}")
        seen.add(query_id)
        _require_non_empty_string(query["query"], f"{query_label}.query")
        if query["sort"] not in allowed_sorts:
            raise ConfigError(f"{query_label}.sort is not allowed for {adapter}")
        filters = query["filters"]
        if not isinstance(filters, dict) or set(filters) - allowed_filters:
            raise ConfigError(f"{query_label}.filters has unknown filter keys")
        for key, item in filters.items():
            if key in {"entities", "topics", "tags"}:
                if not isinstance(item, list) or not item or not all(isinstance(v, str) and v for v in item):
                    raise ConfigError(f"{query_label}.filters.{key} must be a non-empty string array")
                if len(item) != len(set(item)):
                    raise ConfigError(f"{query_label}.filters.{key} must not contain duplicates")
            elif key in {"language", "owner"}:
                _require_non_empty_string(item, f"{query_label}.filters.{key}")
            elif not isinstance(item, int) or isinstance(item, bool) or item < 0:
                raise ConfigError(f"{query_label}.filters.{key} must be a non-negative integer")
        if adapter == "github":
            entities = filters.get("entities")
            if not entities or set(entities) - _GITHUB_ENTITIES:
                raise ConfigError(f"{query_label}.filters.entities contains an unknown entity")
            if "min_stars" in filters and "repository" not in entities:
                raise ConfigError(f"{query_label}.filters.min_stars requires repository entities")
        elif "tags" in filters and set(filters["tags"]) - _HN_TAGS:
            raise ConfigError(f"{query_label}.filters.tags contains an unknown tag")


def _validate_input(source: dict[str, Any], index: int) -> None:
    adapter = source["adapter"]
    value = source["input"]
    allowed = _INPUT_FIELDS.get(adapter)
    if allowed is None:
        # Reserved adapters are accepted for compatibility until registered.
        return
    extra = set(value) - allowed
    if extra:
        raise ConfigError(f"sources[{index}] has unknown input field(s): {', '.join(sorted(extra))}")
    missing = _REQUIRED_INPUT_FIELDS[adapter] - set(value)
    if missing:
        raise ConfigError(f"sources[{index}].input is missing field(s): {', '.join(sorted(missing))}")

    for key, item in value.items():
        if key.endswith("_url") or key in {"url", "structured_endpoint"}:
            _require_https_url(item, f"sources[{index}].input.{key}")
    if adapter == "web-publication":
        if not isinstance(value["discovery"], list):
            raise ConfigError(f"sources[{index}].input.discovery must be an array")
        for discovery_index, discovery in enumerate(value["discovery"]):
            expected = ({"type", "url", "publicUrl", "detailUrl"}
                        if isinstance(discovery, dict) and discovery.get("type") == "json"
                        else {"type", "url"})
            if not isinstance(discovery, dict) or set(discovery) != expected:
                raise ConfigError(f"sources[{index}].input.discovery[{discovery_index}] is invalid")
            if discovery["type"] not in {"rss", "sitemap", "html", "json"}:
                raise ConfigError(f"sources[{index}].input.discovery[{discovery_index}].type is invalid")
            _require_https_url(discovery["url"], f"sources[{index}].input.discovery[{discovery_index}].url")
            for key in ("publicUrl", "detailUrl"):
                if key in discovery:
                    _require_https_url(discovery[key].replace("{path}", "entry"),
                                       f"sources[{index}].input.discovery[{discovery_index}].{key}")
    elif adapter == "github":
        if not isinstance(value["include_discussions"], bool):
            raise ConfigError(f"sources[{index}].input.include_discussions must be a boolean")
        _validate_queries(value["queries"], f"sources[{index}].input.queries", adapter=adapter)
    elif adapter == "hackernews":
        if not isinstance(value["top_enabled"], bool) or not isinstance(value["new_enabled"], bool):
            raise ConfigError(f"sources[{index}].input top/new flags must be booleans")
        _validate_queries(value["queries"], f"sources[{index}].input.queries", adapter=adapter)
    elif adapter == "reddit":
        _require_non_empty_string(value["subreddit"], f"sources[{index}].input.subreddit")
        marker = f"/r/{value['subreddit']}/"
        if marker not in value["rss_url"] or marker not in value["listing_url"]:
            raise ConfigError(f"sources[{index}].input subreddit must match both Reddit URLs")
    elif adapter == "techmeme":
        _require_https_url(value["archive_url_template"],
                           f"sources[{index}].input.archive_url_template", template=True)
    elif adapter == "hugging-face-papers":
        if value["views"] != ["daily", "trending", "weekly"]:
            raise ConfigError(f"sources[{index}].input.views must use daily, trending, weekly order")
        if value["timezone"] != "Asia/Shanghai":
            raise ConfigError(f"sources[{index}].input.timezone must be Asia/Shanghai")


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
    namespace = _namespace_of(source_id)
    if policy == "core-topic" and namespace != "community":
        raise ConfigError(f"sources[{index}].id must use the community namespace for core-topic policy")
    if policy == "fixed" and _CHANNEL_NAMESPACES.get(channel) != namespace:
        raise ConfigError(f"sources[{index}].id namespace must match fixed channel {channel}")

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
    _validate_input(source, index)

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
