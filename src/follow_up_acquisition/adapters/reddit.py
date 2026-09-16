"""Bounded keyless Reddit acquisition adapter.

The adapter reads one fixed public subreddit. RSS/Atom is the primary path;
if it fails, the same subreddit's public ``new`` listing JSON is used as a
keyless compatibility fallback. It deliberately does not fetch user profiles,
comment bodies, private communities, deleted items, or anything behind a login
wall.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import replace
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any, Callable, Mapping
from urllib.parse import urlsplit
from xml.etree import ElementTree as ET

from ..http_client import HttpClient
from ..runtime import AcquisitionRuntime, AdapterError, SourceCandidate, SourceResult

_MODES = {"central", "shadow", "hybrid", "local"}
_REDDIT_HOST = "www.reddit.com"
_INPUT_FIELDS = frozenset({"subreddit", "rss_url", "listing_url"})
_COMMENTS_PATH_RE = re.compile(r"/r/[^/]+/comments/([A-Za-z0-9]+)(?:/|$)")


def _now_iso(clock: Callable[[], Any]) -> str:
    value = clock()
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        value = value.astimezone(timezone.utc)
    else:
        value = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        value = value.astimezone(timezone.utc)
    return value.isoformat(timespec="seconds").replace("+00:00", "Z")


def _parse_iso(value: Any) -> str | None:
    if type(value) is not str or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _parse_rfc2822(value: Any) -> str | None:
    if type(value) is not str or not value.strip():
        return None
    try:
        parsed = parsedate_to_datetime(value.strip())
    except (TypeError, ValueError, OverflowError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _parse_created_utc(value: Any) -> str | None:
    if type(value) is bool or type(value) not in {int, float}:
        return None
    if not math.isfinite(float(value)):
        return None
    try:
        parsed = datetime.fromtimestamp(float(value), tz=timezone.utc)
    except (OverflowError, OSError, ValueError):
        return None
    if not 1990 <= parsed.year <= 2100:
        return None
    return parsed.isoformat(timespec="seconds").replace("+00:00", "Z")


def _window_bounds(request: dict[str, Any]) -> tuple[str | None, str | None]:
    window = request.get("window")
    if not isinstance(window, Mapping):
        return None, None
    start = _parse_iso(window.get("start"))
    end = _parse_iso(window.get("end"))
    return start, end


def _in_window(published_at: str | None, start: str | None, end: str | None) -> bool:
    if published_at is None:
        return start is None and end is None
    if start is not None and published_at < start:
        return False
    if end is not None and published_at > end:
        return False
    return True


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _children(element: ET.Element, *local_names: str) -> list[ET.Element]:
    return [
        child for child in list(element)
        if _local_name(child.tag) in local_names
    ]


def _child_text(element: ET.Element, *local_names: str) -> str | None:
    for child in _children(element, *local_names):
        value = (child.text or "").strip()
        if value:
            return value
    return None


def _entry_link(entry: ET.Element) -> str | None:
    for child in _children(entry, "link"):
        href = child.get("href")
        if type(href) is str and href.strip():
            return href.strip()
        text = (child.text or "").strip()
        if text:
            return text
    return None


def _entry_text(entry: ET.Element) -> str | None:
    return _child_text(entry, "description", "summary", "content")


def _entries(root: ET.Element) -> list[ET.Element]:
    root_name = _local_name(root.tag)
    if root_name == "rss":
        channel = next(iter(_children(root, "channel")), None)
        if channel is None:
            raise AdapterError("Reddit RSS channel is missing", status="schema-drift")
        return _children(channel, "item")
    if root_name == "feed":
        return _children(root, "entry")
    items = _children(root, "item")
    if items:
        return items
    entries = _children(root, "entry")
    if entries:
        return entries
    raise AdapterError("Reddit feed is not RSS or Atom", status="schema-drift")


def _post_id_from_value(value: Any) -> str | None:
    if type(value) is not str or not value.strip():
        return None
    value = value.strip()
    if value.startswith("t3_"):
        value = value[3:]
    return value.lower() if value and all(
        character.isalnum() or character in {"_", "-"} for character in value
    ) else None


def _post_id_from_url(value: Any) -> str | None:
    if type(value) is not str:
        return None
    try:
        parsed = urlsplit(value)
    except ValueError:
        return None
    path = parsed.path or value
    match = _COMMENTS_PATH_RE.search(path)
    if match:
        return match.group(1).lower()
    return None


def _fullname(post_id: str) -> str:
    post_id = post_id.lower()
    return post_id if post_id.startswith("t3_") else f"t3_{post_id}"


def _canonical_url(value: str) -> str:
    return AcquisitionRuntime.canonical_url(value)


def _comments_url(subreddit: str, post_id: str, permalink: Any = None) -> str:
    if type(permalink) is str and permalink.strip():
        value = permalink.strip()
        try:
            parsed = urlsplit(value)
        except ValueError:
            parsed = None
        path = parsed.path if parsed is not None else value
        if _COMMENTS_PATH_RE.search(path) and (
            path.startswith("/") or (parsed is not None and parsed.netloc == _REDDIT_HOST)
        ):
            if path.startswith("/"):
                value = f"https://{_REDDIT_HOST}{path}"
            return _canonical_url(value)
    return f"https://{_REDDIT_HOST}/r/{subreddit}/comments/{post_id}/"


def _nonnegative_int(value: Any) -> int | None:
    if type(value) is bool:
        return None
    if type(value) is int and value >= 0:
        return value
    if type(value) is float and value.is_integer() and value >= 0:
        return int(value)
    if type(value) is str:
        try:
            parsed = int(value)
        except ValueError:
            return None
        if parsed >= 0:
            return parsed
    return None


def _upvote_ratio(value: Any) -> float | None:
    if type(value) is bool:
        return None
    if type(value) is int and 0 <= value <= 1:
        return float(value)
    if type(value) is float and 0.0 <= value <= 1.0:
        return value
    if type(value) is str:
        try:
            parsed = float(value)
        except ValueError:
            return None
        if 0.0 <= parsed <= 1.0:
            return parsed
    return None


def _entry_date(entry: ET.Element) -> tuple[str | None, str, bool]:
    published = _parse_iso(_child_text(entry, "published"))
    if published is not None:
        return published, "exact", False
    updated = _parse_iso(_child_text(entry, "updated"))
    if updated is not None:
        return updated, "inferred", False
    parsed = _parse_rfc2822(_child_text(entry, "pubDate", "pubdate", "date"))
    if parsed is not None:
        return parsed, "inferred", False
    return None, "unknown", True


def _parse_xml_body(body: Any) -> ET.Element:
    if isinstance(body, ET.Element):
        return body
    try:
        if isinstance(body, bytes):
            return ET.fromstring(body)
        if isinstance(body, str):
            return ET.fromstring(body)
    except ET.ParseError as exc:
        raise AdapterError("Reddit RSS response is malformed XML", status="schema-drift") from exc
    raise AdapterError("Reddit RSS response is not XML", status="schema-drift")


class RedditAdapter:
    adapter_id = "reddit"
    adapter_version = "0.4.0"

    def __init__(
        self,
        resolve_source: Callable[[str], Any],
        http_client: HttpClient | None = None,
        clock: Callable[[], Any] | None = None,
    ) -> None:
        self._resolve = resolve_source
        self._http = http_client or HttpClient()
        self._clock = clock or (lambda: datetime.now(timezone.utc))

    def availability_probe(self) -> str:
        return "ok"

    def validate_request(self, request: dict[str, Any]) -> None:
        if type(request) is not dict or request.get("mode") not in _MODES:
            raise AdapterError("request.mode is invalid", status="error")
        if set(request) - {"mode", "topic", "subject", "window", "depth"}:
            raise AdapterError("request contains unsupported fields", status="error")
        if request.get("depth") is not None and (
            type(request["depth"]) is not int or not 1 <= request["depth"] <= 10
        ):
            raise AdapterError("request.depth is invalid", status="error")
        if request.get("window") is not None and (
            type(request["window"]) is not dict or set(request["window"]) != {"start", "end"}
        ):
            raise AdapterError("request.window is invalid", status="error")
        window = request.get("window")
        if isinstance(window, dict):
            parsed: dict[str, datetime] = {}
            for field in ("start", "end"):
                value = window[field]
                if value is None:
                    continue
                instant = _parse_iso(value)
                if instant is None:
                    raise AdapterError("request.window is invalid", status="error")
                parsed[field] = datetime.fromisoformat(instant.replace("Z", "+00:00"))
            if "start" in parsed and "end" in parsed and parsed["start"] > parsed["end"]:
                raise AdapterError("request.window is invalid", status="error")

    def collect(self, source: str, request: dict[str, Any]) -> SourceResult:
        self.validate_request(request)
        config = self._config(source)
        now = _now_iso(self._clock)
        budget = config["budget"]
        inp = config["input"]
        subreddit = inp["subreddit"]
        window_start, window_end = _window_bounds(request)

        rss_failure: AdapterError | None = None
        try:
            candidates = self._collect_rss(
                inp["rss_url"], subreddit, budget, now, window_start, window_end,
            )
        except AdapterError as exc:
            rss_failure = exc
            try:
                candidates = self._collect_listing(
                    inp["listing_url"], subreddit, budget, now, window_start, window_end,
                )
            except AdapterError as listing_exc:
                return self._failure(source, request, listing_exc, rss_failure)

        status, code, message = self._status(candidates)
        return SourceResult(
            self.adapter_id, self.adapter_version, source, status,
            candidates=tuple(candidates), code=code, message=message,
            retryable=status in {"partial", "rate-limited", "timeout", "unreachable"},
            request=request, checkpoint_updates=(),
        )

    def _config(self, source: str) -> dict[str, Any]:
        value = self._resolve(source)
        if type(value) is not dict or value.get("id") != source or value.get("adapter") != "reddit":
            raise AdapterError("Reddit source configuration is unavailable", status="skipped-unconfigured")
        inp = value.get("input")
        if type(inp) is not dict or set(inp) != _INPUT_FIELDS:
            raise AdapterError("Reddit source input is invalid", status="schema-drift")
        if type(value.get("budget")) is not int or not 1 <= value["budget"] <= 1000:
            raise AdapterError("Reddit source budget is invalid", status="schema-drift")
        subreddit = inp.get("subreddit")
        rss_url = inp.get("rss_url")
        listing_url = inp.get("listing_url")
        if type(subreddit) is not str or not subreddit.strip():
            raise AdapterError("Reddit subreddit is invalid", status="schema-drift")
        expected_rss = f"https://{_REDDIT_HOST}/r/{subreddit}/.rss"
        expected_listing = f"https://{_REDDIT_HOST}/r/{subreddit}/new.json"
        if rss_url != expected_rss or listing_url != expected_listing:
            raise AdapterError("Reddit source endpoint is invalid", status="schema-drift")
        return value

    def _collect_rss(
        self,
        rss_url: str,
        subreddit: str,
        budget: int,
        now: str,
        window_start: str | None,
        window_end: str | None,
    ) -> list[SourceCandidate]:
        entries = self._fetch_rss(rss_url)
        mapped = [
            self._map_rss_entry(entry, subreddit, now)
            for entry in entries
        ]
        candidates = [
            candidate for candidate in mapped
            if candidate is not None and _in_window(candidate.published_at, window_start, window_end)
        ]
        return self._assign_rank(self._finalize(candidates, budget))

    def _collect_listing(
        self,
        listing_url: str,
        subreddit: str,
        budget: int,
        now: str,
        window_start: str | None,
        window_end: str | None,
    ) -> list[SourceCandidate]:
        children = self._fetch_listing(listing_url)
        mapped = [
            self._map_listing_child(child, subreddit, now)
            for child in children
        ]
        candidates = [
            candidate for candidate in mapped
            if candidate is not None and _in_window(candidate.published_at, window_start, window_end)
        ]
        return self._assign_rank(self._finalize(candidates, budget))

    def _fetch_rss(self, rss_url: str) -> list[ET.Element]:
        response = self._http.get(
            rss_url,
            allowed_hosts={_REDDIT_HOST},
            allowed_paths={"/r"},
        )
        return _entries(_parse_xml_body(response.body))

    def _fetch_listing(self, listing_url: str) -> list[Mapping[str, Any]]:
        response = self._http.get(
            listing_url,
            allowed_hosts={_REDDIT_HOST},
            allowed_paths={"/r"},
        )
        body = response.body
        if isinstance(body, (str, bytes)):
            try:
                body = json.loads(body)
            except (TypeError, ValueError, json.JSONDecodeError) as exc:
                raise AdapterError("Reddit listing response is malformed JSON", status="schema-drift") from exc
        if not isinstance(body, Mapping):
            raise AdapterError("Reddit listing response is not an object", status="schema-drift")
        if body.get("kind") != "Listing":
            raise AdapterError("Reddit listing response kind drifted", status="schema-drift")
        data = body.get("data")
        if not isinstance(data, Mapping) or not isinstance(data.get("children"), list):
            raise AdapterError("Reddit listing data drifted", status="schema-drift")
        return [
            child for child in data["children"]
            if isinstance(child, Mapping) and child.get("kind") == "t3"
        ]

    def _map_rss_entry(
        self, entry: ET.Element, subreddit: str, fetched_at: str,
    ) -> SourceCandidate | None:
        permalink = _entry_link(entry)
        post_id = _post_id_from_value(_child_text(entry, "guid", "id"))
        if post_id is None:
            post_id = _post_id_from_url(permalink)
        if post_id is None:
            return None

        published_at, date_confidence, missing_date = _entry_date(entry)
        warnings = []
        if missing_date:
            warnings.append({
                "code": "missing_date",
                "message": "Reddit post has no parseable date",
            })
        metrics: dict[str, Any] = {}
        score = _nonnegative_int(_child_text(entry, "score"))
        comments = _nonnegative_int(_child_text(entry, "num_comments", "comments"))
        upvote_ratio = _upvote_ratio(_child_text(entry, "upvote_ratio"))
        if score is not None:
            metrics["score"] = score
        if comments is not None:
            metrics["comments"] = comments
        if upvote_ratio is not None:
            metrics["upvote_ratio"] = upvote_ratio

        return SourceCandidate(
            native_id=_fullname(post_id),
            url=_comments_url(subreddit, post_id, permalink),
            source_type="post",
            date_confidence=date_confidence,
            fetched_at=fetched_at,
            title=_child_text(entry, "title"),
            author=_child_text(entry, "author", "creator", "name"),
            published_at=published_at,
            text=_entry_text(entry),
            native_metrics=metrics,
            provenance={"subreddit": subreddit, "entry": "rss"},
            item_warnings=warnings,
        )

    def _map_listing_child(
        self, child: Mapping[str, Any], subreddit: str, fetched_at: str,
    ) -> SourceCandidate | None:
        data = child.get("data")
        if not isinstance(data, Mapping):
            return None
        if data.get("subreddit") != subreddit:
            return None
        post_id = _post_id_from_value(data.get("name") or data.get("id"))
        if post_id is None:
            return None
        title = data.get("title")
        if type(title) is not str or not title.strip():
            return None

        permalink = data.get("permalink")
        published_at = _parse_created_utc(data.get("created_utc"))
        date_confidence = "exact" if published_at is not None else "unknown"
        warnings = []
        if published_at is None:
            warnings.append({
                "code": "missing_date",
                "message": "Reddit post has no parseable date",
            })
        metrics: dict[str, Any] = {}
        score = _nonnegative_int(data.get("score"))
        comments = _nonnegative_int(data.get("num_comments"))
        upvote_ratio = _upvote_ratio(data.get("upvote_ratio"))
        if score is not None:
            metrics["score"] = score
        if comments is not None:
            metrics["comments"] = comments
        if upvote_ratio is not None:
            metrics["upvote_ratio"] = upvote_ratio
        outbound_url = data.get("url")
        if type(outbound_url) is str and outbound_url.strip():
            metrics["outbound_url"] = AcquisitionRuntime.canonical_url(outbound_url)

        provenance: dict[str, Any] = {"subreddit": subreddit, "entry": "listing"}
        flair = data.get("link_flair_text")
        if type(flair) is str and flair.strip():
            provenance["flair"] = flair.strip()

        return SourceCandidate(
            native_id=_fullname(post_id),
            url=_comments_url(subreddit, post_id, permalink),
            source_type="post",
            date_confidence=date_confidence,
            fetched_at=fetched_at,
            title=title,
            author=data.get("author") if type(data.get("author")) is str else None,
            published_at=published_at,
            text=data.get("selftext") if type(data.get("selftext")) is str else None,
            native_metrics=metrics,
            provenance=provenance,
            item_warnings=warnings,
        )

    @staticmethod
    def _finalize(
        values: list[SourceCandidate], budget: int,
    ) -> list[SourceCandidate]:
        unique: dict[str, SourceCandidate] = {}
        for value in values:
            unique.setdefault(value.native_id, value)
        return list(unique.values())[:budget]

    @staticmethod
    def _assign_rank(values: list[SourceCandidate]) -> list[SourceCandidate]:
        result: list[SourceCandidate] = []
        for index, value in enumerate(values, start=1):
            result.append(replace(
                value,
                native_metrics={**value.native_metrics, "rank": index},
                provenance={**value.provenance, "rank": index},
            ))
        return result

    @staticmethod
    def _status(
        candidates: list[SourceCandidate],
    ) -> tuple[str, str | None, str | None]:
        return ("ok" if candidates else "no-results"), None, None

    def _failure(
        self,
        source: str,
        request: dict[str, Any],
        exc: AdapterError,
        rss_failure: AdapterError | None,
    ) -> SourceResult:
        message = exc.args[0] if exc.args else "Reddit source failed"
        code = f"reddit-{exc.status}" if not rss_failure else "reddit-fallback-failed"
        return SourceResult(
            self.adapter_id, self.adapter_version, source, exc.status,
            code=code, message=message,
            retryable=exc.status in {"partial", "rate-limited", "timeout", "unreachable"},
            request=request, checkpoint_updates=(),
        )


__all__ = ["RedditAdapter"]
