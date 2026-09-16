"""Acquisition configuration: source registry and credential-safe config.

The registry in ``config/sources.json`` is the sole authoritative source
catalog. Legacy central-Feed files (``feed-blogs.json``, ``feed-x.json``, ...)
become generated compatibility artifacts and must not be edited independently
once a source has been migrated into the registry.
"""

from __future__ import annotations

import ipaddress
import json
import math
from pathlib import Path
import re
from typing import Any
from urllib.parse import urlparse

from .contracts import is_credential_key
from .source_state import SourceStateError, query_fingerprint

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
_SOURCE_ID_RE = re.compile(r"^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9._-]*$")
_CREDENTIAL_REF_RE = re.compile(r"^env\.[A-Z_][A-Z0-9_]{0,127}$")
_SECRET_VALUE_PATTERNS = (
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,255}\b"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,255}\b"),
    re.compile(r"\bsk-[A-Za-z0-9]{32,255}\b"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
)
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f-\x9f]")
_DNS_LABEL_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$")
_MAX_STRING_LENGTH = 4096
_MAX_METRIC_FILTER = 1_000_000_000
_MAX_BUDGET = 1000
_INPUT_FIELDS = {
    "x": frozenset({"handle", "url"}),
    "rss": frozenset({"rss_url", "url", "language", "tags"}),
    "newsletter": frozenset({"rss_url", "url", "language", "tags"}),
    "podcast": frozenset({"rss_url", "url", "language"}),
    "arxiv": frozenset({"rss_url", "url", "tags"}),
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
    "youtube": frozenset(),
    "digg": frozenset(),
    "xiaohongshu": frozenset(),
    "wechat": frozenset(),
}
_REQUIRED_INPUT_FIELDS = {adapter: fields for adapter, fields in _INPUT_FIELDS.items()}
_REQUIRED_INPUT_FIELDS["x"] = frozenset({"handle"})
for _feed_adapter in ("rss", "newsletter", "podcast"):
    _REQUIRED_INPUT_FIELDS[_feed_adapter] = frozenset({"rss_url"})
_REQUIRED_INPUT_FIELDS["arxiv"] = frozenset({"rss_url", "url"})
_REQUIRED_INPUT_FIELDS["web-publication"] = frozenset({
    "url", "language", "discovery", "article_url_patterns", "exclude_url_patterns",
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


def _require_string(value: Any, label: str, *, nonempty: bool = True) -> str:
    if type(value) is not str:
        raise ConfigError(f"{label} must be an exact string")
    if nonempty and not value:
        raise ConfigError(f"{label} must be a non-empty string")
    if len(value) > _MAX_STRING_LENGTH:
        raise ConfigError(f"{label} exceeds the string length limit")
    if _CONTROL_RE.search(value):
        raise ConfigError(f"{label} contains a forbidden control character")
    return value


def _require_non_empty_string(value: Any, label: str) -> None:
    _require_string(value, label)


def _require_exact_dict(value: Any, label: str) -> dict[str, Any]:
    if type(value) is not dict:
        raise ConfigError(f"{label} must be an exact object")
    for key in value:
        _require_string(key, f"{label} field name")
    return value


def _require_exact_list(value: Any, label: str, *, nonempty: bool = False) -> list[Any]:
    if type(value) is not list or (nonempty and not value):
        qualifier = "non-empty exact array" if nonempty else "exact array"
        raise ConfigError(f"{label} must be a {qualifier}")
    return value


def _require_closed_fields(
    value: Any,
    label: str,
    *,
    allowed: frozenset[str] | set[str],
    required: frozenset[str] | set[str] = frozenset(),
) -> dict[str, Any]:
    result = _require_exact_dict(value, label)
    actual = set(result)
    extra = actual - set(allowed)
    missing = set(required) - actual
    if extra:
        raise ConfigError(f"{label} has unknown input field(s): {', '.join(sorted(extra))}")
    if missing:
        raise ConfigError(f"{label} is missing field(s): {', '.join(sorted(missing))}")
    return result


def _require_string_list(
    value: Any,
    label: str,
    *,
    nonempty: bool = False,
    unique: bool = True,
) -> list[str]:
    items = _require_exact_list(value, label, nonempty=nonempty)
    for index, item in enumerate(items):
        _require_string(item, f"{label}[{index}]")
    if unique and len(items) != len(set(items)):
        raise ConfigError(f"{label} must not contain duplicates")
    return items


def _require_boolean(value: Any, label: str) -> None:
    if type(value) is not bool:
        raise ConfigError(f"{label} must be an exact boolean")


def _require_bounded_integer(value: Any, label: str, *, minimum: int, maximum: int) -> None:
    if type(value) is not int or not minimum <= value <= maximum:
        raise ConfigError(f"{label} must be an integer from {minimum} to {maximum}")


def _require_https_url(value: Any, label: str, *, template: str | bool = False) -> None:
    text = _require_string(value, label)
    if template:
        placeholder = "{date}" if template is True else str(template)
        replacement = "2000-01-01" if placeholder == "{date}" else "260915/h2000"
        if text.count(placeholder) != 1:
            raise ConfigError(f"{label} must contain exactly one {placeholder} placeholder")
        candidate = text.replace(placeholder, replacement)
        if re.search(r"\{[^}]*\}", candidate):
            raise ConfigError(f"{label} must contain only the {placeholder} placeholder")
    else:
        candidate = text
    try:
        parsed = urlparse(candidate)
        hostname = parsed.hostname
        port = parsed.port
    except ValueError as exc:
        raise ConfigError(f"{label} must be a public HTTPS URL") from exc
    if (parsed.scheme != "https" or not parsed.netloc
            or parsed.username is not None or parsed.password is not None):
        raise ConfigError(f"{label} must be a public HTTPS URL")
    if not hostname:
        raise ConfigError(f"{label} must be a public HTTPS URL")
    if any(character.isspace() for character in parsed.netloc):
        raise ConfigError(f"{label} has invalid HTTPS authority whitespace")
    if port is not None and not 1 <= port <= 65535:
        raise ConfigError(f"{label} has an invalid HTTPS port")
    if parsed.netloc.endswith(":"):
        raise ConfigError(f"{label} has an invalid HTTPS port")
    if ":" in hostname:
        try:
            ipaddress.IPv6Address(hostname)
        except ValueError as exc:
            raise ConfigError(f"{label} has an invalid IPv6 host") from exc
        if not parsed.netloc.startswith("["):
            raise ConfigError(f"{label} must bracket an IPv6 host")
        return
    if all(character.isdigit() or character == "." for character in hostname):
        try:
            ipaddress.IPv4Address(hostname)
        except ValueError as exc:
            raise ConfigError(f"{label} has an invalid IPv4 host") from exc
        return
    if any(character.isspace() for character in hostname):
        raise ConfigError(f"{label} has invalid HTTPS authority whitespace")
    try:
        ascii_hostname = hostname.encode("idna").decode("ascii")
    except (UnicodeError, ValueError) as exc:
        raise ConfigError(f"{label} has an invalid IDNA host") from exc
    labels = ascii_hostname.split(".")
    if not labels or any(not item for item in labels):
        raise ConfigError(f"{label} has an invalid DNS host")
    ascii_labels: list[str] = []
    for ascii_label in labels:
        if len(ascii_label) > 63 or _DNS_LABEL_RE.fullmatch(ascii_label) is None:
            raise ConfigError(f"{label} has an invalid DNS label")
        ascii_labels.append(ascii_label)
    if len(".".join(ascii_labels)) > 253:
        raise ConfigError(f"{label} has an invalid DNS host")


def _require_path_url_template(value: Any, label: str) -> None:
    text = _require_string(value, label)
    if text.count("{path}") != 1:
        raise ConfigError(f"{label} must contain exactly one {{path}} placeholder")
    _require_https_url(text.replace("{path}", "entry"), label)


def _validate_regex_list(value: Any, label: str, *, nonempty: bool) -> None:
    patterns = _require_string_list(value, label, nonempty=nonempty)
    for index, pattern in enumerate(patterns):
        try:
            re.compile(pattern)
        except re.error as exc:
            raise ConfigError(f"{label}[{index}] must be a valid regular expression") from exc


def _same_url_origin(left: str, right: str) -> bool:
    def origin(value: str) -> tuple[str, str, int]:
        parsed = urlparse(value)
        hostname = parsed.hostname or ""
        try:
            host = ipaddress.ip_address(hostname).compressed
        except ValueError:
            host = hostname.encode("idna").decode("ascii").lower()
        return parsed.scheme.lower(), host, parsed.port or 443

    return origin(left) == origin(right)


def _validate_queries(value: Any, label: str, *, adapter: str) -> None:
    queries = _require_exact_list(value, label, nonempty=True)
    seen: set[str] = set()
    allowed_filters = _GITHUB_FILTERS if adapter == "github" else _HN_FILTERS
    allowed_sorts = {"updated", "stars"} if adapter == "github" else {"date", "points"}
    for index, query in enumerate(queries):
        query_label = f"{label}[{index}]"
        query = _require_closed_fields(
            query, query_label,
            allowed={"id", "query", "sort", "filters"},
            required={"id", "query", "sort", "filters"},
        )
        query_id = query["id"]
        _require_string(query_id, f"{query_label}.id")
        if _QUERY_ID_RE.fullmatch(query_id) is None:
            raise ConfigError(f"{query_label}.id must be a stable lowercase query ID")
        if query_id in seen:
            raise ConfigError(f"{label} contains duplicate query id: {query_id}")
        seen.add(query_id)
        _require_string(query["query"], f"{query_label}.query")
        sort = _require_string(query["sort"], f"{query_label}.sort")
        if sort not in allowed_sorts:
            raise ConfigError(f"{query_label}.sort is not allowed for {adapter}")
        filters = _require_closed_fields(
            query["filters"], f"{query_label}.filters", allowed=allowed_filters,
        )
        for key, item in filters.items():
            if key in {"entities", "topics", "tags"}:
                _require_string_list(item, f"{query_label}.filters.{key}", nonempty=True)
            elif key in {"language", "owner"}:
                _require_string(item, f"{query_label}.filters.{key}")
            else:
                _require_bounded_integer(
                    item, f"{query_label}.filters.{key}", minimum=0, maximum=_MAX_METRIC_FILTER,
                )
        if adapter == "github":
            entities = filters.get("entities")
            if not entities or set(entities) - _GITHUB_ENTITIES:
                raise ConfigError(f"{query_label}.filters.entities contains an unknown entity")
            if "min_stars" in filters and "repository" not in entities:
                raise ConfigError(f"{query_label}.filters.min_stars requires repository entities")
        elif "tags" in filters and set(filters["tags"]) - _HN_TAGS:
            raise ConfigError(f"{query_label}.filters.tags contains an unknown tag")
        try:
            query_fingerprint(adapter, query)
        except SourceStateError as exc:
            raise ConfigError(f"{query_label} violates the authoritative query contract") from exc


def _validate_input(source: dict[str, Any], index: int) -> None:
    adapter = source["adapter"]
    value = source["input"]
    label = f"sources[{index}].input"
    value = _require_closed_fields(
        value, label, allowed=_INPUT_FIELDS[adapter], required=_REQUIRED_INPUT_FIELDS[adapter],
    )

    for key, item in value.items():
        if key.endswith("_url") or key in {"url", "structured_endpoint"}:
            _require_https_url(item, f"{label}.{key}")
    if adapter == "x":
        _require_string(value["handle"], f"{label}.handle")
    elif adapter in {"rss", "newsletter", "podcast"}:
        if "language" in value:
            _require_string(value["language"], f"{label}.language")
    if "tags" in value:
        _require_string_list(value["tags"], f"{label}.tags", nonempty=True)
    if adapter == "web-publication":
        _require_string(value["language"], f"{label}.language")
        discovery_items = _require_exact_list(value["discovery"], f"{label}.discovery", nonempty=True)
        discovery_signatures: set[tuple[tuple[str, Any], ...]] = set()
        for discovery_index, discovery in enumerate(discovery_items):
            discovery_label = f"{label}.discovery[{discovery_index}]"
            discovery = _require_exact_dict(discovery, discovery_label)
            discovery_type = _require_string(discovery.get("type"), f"{discovery_label}.type")
            expected = ({"type", "url", "publicUrl", "detailUrl"}
                        if discovery_type == "json" else {"type", "url"})
            discovery = _require_closed_fields(
                discovery, discovery_label, allowed=expected, required=expected,
            )
            if discovery_type not in {"rss", "sitemap", "html", "json"}:
                raise ConfigError(f"{discovery_label}.type is invalid")
            _require_https_url(discovery["url"], f"{discovery_label}.url")
            if discovery_type == "json":
                _require_path_url_template(discovery["publicUrl"], f"{discovery_label}.publicUrl")
                _require_path_url_template(discovery["detailUrl"], f"{discovery_label}.detailUrl")
            signature = tuple(sorted(discovery.items()))
            if signature in discovery_signatures:
                raise ConfigError(f"{label}.discovery must not contain duplicates")
            discovery_signatures.add(signature)
        _validate_regex_list(value["article_url_patterns"], f"{label}.article_url_patterns", nonempty=True)
        _validate_regex_list(value["exclude_url_patterns"], f"{label}.exclude_url_patterns", nonempty=False)
        if "fetch_url_patterns" in value:
            _validate_regex_list(value["fetch_url_patterns"], f"{label}.fetch_url_patterns", nonempty=True)
        if any(item["type"] == "json" for item in discovery_items) and "fetch_url_patterns" not in value:
            raise ConfigError(f"{label}.fetch_url_patterns is required for JSON discovery")
        for discovery_index, discovery in enumerate(discovery_items):
            if discovery["type"] != "json":
                continue
            discovery_label = f"{label}.discovery[{discovery_index}]"
            public_url = discovery["publicUrl"].replace("{path}", "entry")
            detail_url = discovery["detailUrl"].replace("{path}", "entry")
            if not all(_same_url_origin(value["url"], item)
                       for item in (discovery["url"], public_url, detail_url)):
                raise ConfigError(f"{discovery_label} URLs must use the source origin")
            if not any(re.search(pattern, public_url) for pattern in value["article_url_patterns"]):
                raise ConfigError(f"{discovery_label}.publicUrl must match article_url_patterns")
            if not any(re.search(pattern, detail_url) for pattern in value["fetch_url_patterns"]):
                raise ConfigError(f"{discovery_label}.detailUrl must match fetch_url_patterns")
        if "parser" in value and value["parser"] is not None:
            _require_string(value["parser"], f"{label}.parser")
        if "content_selectors" in value:
            _require_string_list(value["content_selectors"], f"{label}.content_selectors", nonempty=True)
        if "content_selector_priority" in value:
            _require_boolean(value["content_selector_priority"], f"{label}.content_selector_priority")
            if "content_selectors" not in value:
                raise ConfigError(f"{label}.content_selectors is required with content_selector_priority")
    elif adapter == "github":
        _require_boolean(value["include_discussions"], f"{label}.include_discussions")
        _validate_queries(value["queries"], f"{label}.queries", adapter=adapter)
    elif adapter == "hackernews":
        _require_boolean(value["top_enabled"], f"{label}.top_enabled")
        _require_boolean(value["new_enabled"], f"{label}.new_enabled")
        _validate_queries(value["queries"], f"{label}.queries", adapter=adapter)
    elif adapter == "reddit":
        _require_string(value["subreddit"], f"{label}.subreddit")
        marker = f"/r/{value['subreddit']}/"
        if marker not in value["rss_url"] or marker not in value["listing_url"]:
            raise ConfigError(f"{label}.subreddit must match both Reddit URLs")
    elif adapter == "techmeme":
        _require_https_url(value["archive_url_template"],
                           f"{label}.archive_url_template", template="{snapshot}")
    elif adapter == "hugging-face-papers":
        _require_string_list(value["views"], f"{label}.views", nonempty=True)
        if value["views"] != ["daily", "trending", "weekly"]:
            raise ConfigError(f"{label}.views must use daily, trending, weekly order")
        _require_string(value["timezone"], f"{label}.timezone")
        if value["timezone"] != "Asia/Shanghai":
            raise ConfigError(f"{label}.timezone must be Asia/Shanghai")


def _iter_credential_keys(value: Any, path: str = "$"):
    if type(value) is dict:
        for key, child in value.items():
            child_path = f"{path}.{key}"
            if is_credential_key(key):
                yield child_path, child
            yield from _iter_credential_keys(child, child_path)
    elif type(value) is list:
        for index, child in enumerate(value):
            yield from _iter_credential_keys(child, f"{path}[{index}]")


def validate_source_registry(registry: Any) -> list[dict[str, Any]]:
    """Validate a source registry object and return its source list."""
    registry = _require_closed_fields(
        registry, "registry", allowed={"schema_version", "sources"},
        required={"schema_version", "sources"},
    )
    _require_string(registry["schema_version"], "registry.schema_version")
    if registry.get("schema_version") != _REGISTRY_SCHEMA_VERSION:
        raise ConfigError(f"registry.schema_version must be '{_REGISTRY_SCHEMA_VERSION}'")
    sources = _require_exact_list(registry.get("sources"), "registry.sources")

    seen_ids: dict[str, int] = {}
    for index, source in enumerate(sources):
        _validate_source(source, index, seen_ids)
    return sources


def _validate_source(source: Any, index: int, seen_ids: dict[str, int]) -> None:
    label = f"sources[{index}]"
    source = _require_closed_fields(
        source, label, allowed=set(_REGISTRY_REQUIRED), required=set(_REGISTRY_REQUIRED),
    )

    source_id = source["id"]
    _require_non_empty_string(source_id, f"sources[{index}].id")
    if len(source_id) > 128 or _SOURCE_ID_RE.fullmatch(source_id) is None:
        raise ConfigError(f"sources[{index}].id must match the canonical source ID grammar")
    if source_id in seen_ids:
        raise ConfigError(f"sources[{seen_ids[source_id]}].id duplicates sources[{index}].id")
    seen_ids[source_id] = index

    _require_non_empty_string(source["name"], f"sources[{index}].name")

    policy = _require_string(source["channel_policy"], f"{label}.channel_policy")
    if policy not in CHANNEL_POLICIES:
        raise ConfigError(
            f"sources[{index}].channel_policy must be one of {sorted(CHANNEL_POLICIES)}"
        )
    channel = source["channel"]
    if policy == "fixed":
        _require_string(channel, f"{label}.channel")
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

    adapter = _require_string(source["adapter"], f"{label}.adapter")
    if adapter not in ADAPTER_IDS:
        raise ConfigError(
            f"sources[{index}].adapter must be one of {sorted(ADAPTER_IDS)}"
        )
    for flag in ("requires_credentials", "default_enabled"):
        _require_boolean(source[flag], f"{label}.{flag}")
    cadence = _require_string(source["cadence"], f"{label}.cadence")
    if cadence not in CADENCES:
        raise ConfigError(f"sources[{index}].cadence must be one of {sorted(CADENCES)}")

    budget = source["budget"]
    _require_bounded_integer(budget, f"{label}.budget", minimum=1, maximum=_MAX_BUDGET)

    _require_exact_dict(source["input"], f"{label}.input")
    # Inputs are non-secret by construction; a credential-shaped key here is a bug.
    for path, _value in _iter_credential_keys(source["input"]):
        raise ConfigError(f"sources[{index}].input embeds a credential-shaped key: {path}")
    _validate_input(source, index)

    legacy = source["legacy"]
    legacy = _require_closed_fields(
        legacy, f"{label}.legacy", allowed={"feed"}, required={"feed"},
    )
    if legacy["feed"] is not None:
        _require_non_empty_string(legacy["feed"], f"sources[{index}].legacy.feed")


def load_source_registry(path: str | Path) -> list[dict[str, Any]]:
    """Load and validate the source registry from disk."""
    with open(path, encoding="utf-8") as handle:
        return validate_source_registry(json.load(handle))


def _validate_credential_tree(value: Any, path: str) -> None:
    if type(value) is dict:
        for key, child in value.items():
            _require_string(key, f"{path} field name")
            child_path = f"{path}.{key}"
            if is_credential_key(key):
                reference = _require_closed_fields(
                    child, child_path, allowed={"ref"}, required={"ref"},
                )
                ref = _require_string(reference["ref"], f"{child_path}.ref")
                if _CREDENTIAL_REF_RE.fullmatch(ref) is None:
                    raise ConfigError(f"{child_path}.ref must use env.VARIABLE_NAME")
            _validate_credential_tree(child, child_path)
        return
    if type(value) is list:
        for index, child in enumerate(value):
            _validate_credential_tree(child, f"{path}[{index}]")
        return
    if type(value) is str and any(pattern.search(value) for pattern in _SECRET_VALUE_PATTERNS):
        raise ConfigError(f"{path} contains a forbidden credential value")
    if type(value) is float and not math.isfinite(value):
        raise ConfigError(f"{path} must be a finite number")
    if type(value) not in {str, int, float, bool, type(None)}:
        raise ConfigError(f"{path} must use exact JSON container and scalar types")


def validate_credential_references(config: Any) -> None:
    """Reject raw credential values: credential keys must reference a secret store."""
    if type(config) is not dict:
        raise ConfigError("$ must be an exact config object")
    _validate_credential_tree(config, "$")


def validate_acquisition_mode(mode: Any) -> None:
    if mode not in ACQUISITION_MODES:
        raise ConfigError(f"acquisition mode must be one of {sorted(ACQUISITION_MODES)}")
