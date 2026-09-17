"""Bounded Hugging Face Papers acquisition adapter."""

from __future__ import annotations

import json
from datetime import date, datetime, timezone
from typing import Any, Callable, Mapping
from urllib.parse import urlencode, urlsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from ..http_client import HttpClient
from ..runtime import AcquisitionRuntime, AdapterError, CheckpointUpdate, SourceCandidate, SourceResult
from ..source_state import MAX_RECENT_NATIVE_IDS
from .arxiv import normalize_arxiv_id

_HOST = "huggingface.co"
_API_PATH = "/api"
_INPUT_FIELDS = frozenset({"structured_endpoint", "page_base_url", "views", "timezone"})
_VIEW_NAMES = ("daily", "trending", "weekly")
_MODES = frozenset({"central", "shadow", "hybrid", "local"})
_MAX_EVIDENCE_BYTES = 4096


def _now(value: Any) -> datetime:
    if isinstance(value, datetime):
        parsed = value
    else:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    return (parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)).astimezone(timezone.utc)


def _now_iso(value: Any) -> str:
    return _now(value).isoformat(timespec="seconds").replace("+00:00", "Z")


def build_views(run_at: Any, timezone_name: str) -> tuple[tuple[str, str, str], ...]:
    """Return ``(kind, endpoint, provenance page)`` in contractual order."""
    try:
        local = _now(run_at).astimezone(ZoneInfo(timezone_name))
    except ZoneInfoNotFoundError as exc:
        raise AdapterError("Hugging Face timezone is invalid", status="schema-drift") from exc
    local_day = local.date()
    iso = local_day.isocalendar()
    return (
        ("daily", f"https://{_HOST}/api/daily_papers?{urlencode({'date': local_day.isoformat()})}", f"https://{_HOST}/papers/date/{local_day.isoformat()}"),
        ("trending", f"https://{_HOST}/api/daily_papers?{urlencode({'view': 'trending'})}", f"https://{_HOST}/papers/trending"),
        ("weekly", f"https://{_HOST}/api/daily_papers?{urlencode({'week': f'{iso.year}-W{iso.week:02d}'})}", f"https://{_HOST}/papers/week/{iso.year}-W{iso.week:02d}"),
    )


def _text(value: Any) -> str | None:
    if isinstance(value, str):
        value = " ".join(value.split())
        return value or None
    return None


def _integer(value: Any, lower: int, upper: int) -> int | None:
    return value if type(value) is int and lower <= value <= upper else None


def _published(value: Any) -> str | None:
    text = _text(value)
    if text is None:
        return None
    try:
        return _now(text).isoformat(timespec="seconds").replace("+00:00", "Z")
    except ValueError:
        return None


def _authors(value: Any) -> str | None:
    if not isinstance(value, list):
        return _text(value)
    names = [_text(item.get("name")) if isinstance(item, dict) else _text(item) for item in value]
    return ", ".join(name for name in names if name) or None


def _paper_id(value: Mapping[str, Any]) -> str | None:
    arxiv = normalize_arxiv_id(value.get("arxivId") or value.get("arxiv_id") or value.get("arxiv"))
    if arxiv:
        return arxiv
    paper_id = _text(value.get("id") or value.get("paperId") or value.get("paper_id"))
    return f"hf:{paper_id}" if paper_id else None


def _paper_url(value: Mapping[str, Any], paper_id: str) -> str:
    raw = _text(value.get("url") or value.get("paperUrl") or value.get("paper_url"))
    if raw and urlsplit(raw).scheme == "https" and urlsplit(raw).hostname == _HOST:
        return AcquisitionRuntime.canonical_url(raw)
    suffix = _text(value.get("id") or value.get("paperId") or value.get("paper_id")) or paper_id.split(":", 1)[1]
    return f"https://{_HOST}/papers/{suffix}"


def _github(value: Mapping[str, Any]) -> dict[str, Any] | None:
    raw = value.get("github") or value.get("githubRepo") or value.get("github_repo")
    if isinstance(raw, str):
        raw = {"url": raw}
    if not isinstance(raw, Mapping):
        return None
    url = _text(raw.get("url") or raw.get("repoUrl"))
    if not url or urlsplit(url).scheme != "https" or urlsplit(url).hostname != "github.com":
        return None
    output: dict[str, Any] = {"url": AcquisitionRuntime.canonical_url(url)}
    stars = _integer(raw.get("stars"), 0, 1_000_000_000)
    if stars is not None:
        output["stars"] = stars
    return output


def parse_paper(paper: Any, view: str, page_url: str, fetched_at: str) -> dict[str, Any] | None:
    """Extract a candidate while retaining only bounded source-native data."""
    if not isinstance(paper, Mapping) or view not in _VIEW_NAMES:
        return None
    native_id = _paper_id(paper)
    if native_id is None:
        return None
    rank = _integer(paper.get("rank"), 1, 1_000_000)
    upvotes = _integer(paper.get("upvotes"), 0, 1_000_000_000)
    evidence_view: dict[str, Any] = {"kind": view, "pageUrl": page_url}
    if rank is not None:
        evidence_view["rank"] = rank
    if upvotes is not None:
        evidence_view["upvotes"] = upvotes
    evidence: dict[str, Any] = {"role": "community-discovery", "views": [evidence_view]}
    github = _github(paper)
    if github:
        evidence["github"] = github
    return {
        "native_id": native_id,
        "url": _paper_url(paper, native_id),
        "source_type": "paper",
        "date_confidence": "exact" if _published(paper.get("publishedAt") or paper.get("published_at")) else "unknown",
        "fetched_at": fetched_at,
        "title": _text(paper.get("title")),
        "author": _authors(paper.get("authors") or paper.get("author")),
        "published_at": _published(paper.get("publishedAt") or paper.get("published_at")),
        "text": _text(paper.get("summary") or paper.get("abstract")),
        "native_metrics": {"community_evidence": evidence},
        "provenance": {"views": [{"kind": view, "page_url": page_url}]},
        "item_warnings": [],
    }


def _checkpoint(now: str, recent: list[str]) -> dict[str, Any]:
    return {"successful_window_end": now, "cursor": None, "etag": None, "last_modified": None,
            "recent_native_ids": recent[:MAX_RECENT_NATIVE_IDS], "checkpoint_at": now}


class HuggingFacePapersAdapter:
    adapter_id = "hugging-face-papers"
    adapter_version = "0.4.0"

    def __init__(self, resolve_source: Callable[[str], Any], http_client: HttpClient | None = None,
                 clock: Callable[[], Any] | None = None,
                 checkpoint_resolver: Callable[[str], Mapping[str, Any] | None] | None = None) -> None:
        self._resolve = resolve_source
        self._http = http_client or HttpClient()
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._checkpoints = checkpoint_resolver or (lambda _source: None)

    def availability_probe(self) -> str:
        return "ok"

    def validate_request(self, request: dict[str, Any]) -> None:
        if type(request) is not dict or request.get("mode") not in _MODES or set(request) - {"mode", "topic", "subject", "window"}:
            raise AdapterError("request is invalid", status="error")

    def _config(self, source: str) -> dict[str, Any]:
        config = self._resolve(source)
        if type(config) is not dict or config.get("id") != source or config.get("adapter") != self.adapter_id:
            raise AdapterError("Hugging Face source configuration is unavailable", status="skipped-unconfigured")
        inp = config.get("input")
        if type(inp) is not dict or set(inp) != _INPUT_FIELDS or inp.get("views") != list(_VIEW_NAMES) or type(config.get("budget")) is not int:
            raise AdapterError("Hugging Face source input is invalid", status="schema-drift")
        for field, path in (("structured_endpoint", _API_PATH), ("page_base_url", "/papers")):
            value = inp.get(field)
            parsed = urlsplit(value) if type(value) is str else None
            if not parsed or parsed.scheme != "https" or parsed.hostname != _HOST or not (parsed.path or "/").startswith(path):
                raise AdapterError("Hugging Face source input is invalid", status="schema-drift")
        try:
            ZoneInfo(inp["timezone"])
        except (TypeError, ZoneInfoNotFoundError) as exc:
            raise AdapterError("Hugging Face timezone is invalid", status="schema-drift") from exc
        return config

    def collect(self, source: str, request: dict[str, Any]) -> SourceResult:
        self.validate_request(request)
        config = self._config(source)
        now = _now_iso(self._clock())
        state = self._checkpoints(source)
        streams = state.get("streams", {}) if isinstance(state, Mapping) else {}
        collected: dict[str, dict[str, Any]] = {}
        statuses: dict[str, str] = {}
        updates: list[CheckpointUpdate] = []
        for kind, endpoint, page_url in build_views(self._clock(), config["input"]["timezone"]):
            try:
                response = self._http.get(endpoint, allowed_hosts={_HOST}, allowed_paths={_API_PATH})
                payload = response.body
                papers = payload if isinstance(payload, list) else payload.get("papers") if isinstance(payload, Mapping) else None
                if not isinstance(papers, list):
                    raise AdapterError("Hugging Face response is invalid", status="schema-drift")
                statuses[kind] = "ok"
                for paper in papers:
                    parsed = parse_paper(paper, kind, page_url, now)
                    if parsed is None:
                        continue
                    existing = collected.setdefault(parsed["native_id"], parsed)
                    if existing is parsed:
                        continue
                    existing["native_metrics"]["community_evidence"]["views"].extend(parsed["native_metrics"]["community_evidence"]["views"])
                    existing["provenance"]["views"].extend(parsed["provenance"]["views"])
                previous = streams.get(kind) if isinstance(streams, Mapping) else None
                recent = [value for value in collected if value] + list(previous.get("recent_native_ids", ())) if isinstance(previous, Mapping) else list(collected)
                updates.append(CheckpointUpdate(kind, previous.get("checkpoint_at") if isinstance(previous, Mapping) else None, _checkpoint(now, list(dict.fromkeys(recent)))))
            except AdapterError as exc:
                statuses[kind] = exc.status
        candidates = list(collected.values())[:config["budget"]]
        for candidate in candidates:
            evidence = candidate["native_metrics"]["community_evidence"]
            encoded = json.dumps(evidence, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
            if len(encoded) > _MAX_EVIDENCE_BYTES:
                candidate["native_metrics"] = {}
                candidate["item_warnings"].append({"code": "hf-community-evidence-dropped", "message": "Hugging Face community evidence exceeded its size limit"})
        failed = [kind for kind in _VIEW_NAMES if statuses.get(kind) != "ok"]
        successful = len(failed) != len(_VIEW_NAMES)
        if not failed:
            status, code, message = ("ok" if candidates else "no-results"), None, None
        elif successful:
            status, code = "partial", "hf-view-partial"
            message = "; ".join(f"{kind}={statuses.get(kind, 'error')}" for kind in _VIEW_NAMES)
        else:
            status, code = "error", "hf-views-failed"
            message = "; ".join(f"{kind}={statuses.get(kind, 'error')}" for kind in _VIEW_NAMES)
        return SourceResult(self.adapter_id, self.adapter_version, source, status,
                            candidates=tuple(SourceCandidate(**value) for value in candidates), code=code,
                            message=message, retryable=status in {"partial", "error"}, request=request,
                            checkpoint_updates=tuple(updates))
