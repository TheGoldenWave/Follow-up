"""Shadow-mode collection: wire the registry, adapters, and runtime together.

This module is the only place that maps registry ``adapter`` values to adapter
instances. Sources whose adapter is not implemented are skipped, so a partial
rollout never breaks the rest of the run.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .adapters.arxiv import ArxivAdapter
from .adapters.rss import RssAdapter
from .adapters.techmeme import TechmemeAdapter
from .adapters.web_publication import WebPublicationAdapter
from .runtime import AcquisitionRuntime
from .runtime import CheckpointUpdate

SHADOW_REQUEST: dict[str, str] = {"mode": "shadow"}

# Adapters wired for local collection. Unimplemented registry adapters stay
# deferred so a partial rollout never breaks the rest of the run.
_COLLECTABLE_ADAPTERS = frozenset({"arxiv", "rss", "techmeme", "web-publication"})


@dataclass(frozen=True)
class CollectionRun:
    """One staged collection with pending state deliberately kept separate."""

    batches: dict[str, dict[str, Any]]
    checkpoint_updates: dict[str, tuple[CheckpointUpdate, ...]]
    active_stream_ids: dict[str, tuple[str, ...]]


def derive_active_stream_ids(source: dict[str, Any]) -> tuple[str, ...]:
    """Derive the complete stable stream set from one validated registry row."""
    adapter = source["adapter"]
    values = source.get("input", {})
    streams: list[str] = []
    if adapter == "github":
        streams.extend(f"query.{query['id']}" for query in values.get("queries", []))
        if values.get("include_discussions"):
            streams.append("discussions")
    elif adapter == "hackernews":
        if values.get("top_enabled"):
            streams.append("top")
        if values.get("new_enabled"):
            streams.append("new")
        streams.extend(f"search.{query['id']}" for query in values.get("queries", []))
    elif adapter == "techmeme":
        streams.extend(("front", "archive"))
    elif adapter == "arxiv":
        streams.extend(("rss", "metadata"))
    elif adapter == "hugging-face-papers":
        streams.extend(values.get("views", ()))
    return tuple(sorted(set(streams), key=lambda item: item.encode("utf-8")))


def build_source_pairs(sources: list[dict[str, Any]]) -> list[tuple[Any, str]]:
    """Return ``[(adapter, source_id)]`` for every collectable source."""
    by_id = {source["id"]: source for source in sources}
    arxiv = ArxivAdapter(resolve_source=lambda source_id: by_id[source_id])
    rss = RssAdapter(resolve_source=lambda source_id: by_id[source_id])
    techmeme = TechmemeAdapter(resolve_source=lambda source_id: by_id[source_id])
    web = WebPublicationAdapter(resolve_source=lambda source_id: by_id[source_id])

    pairs: list[tuple[Any, str]] = []
    for source in sources:
        if source["adapter"] == "arxiv":
            pairs.append((arxiv, source["id"]))
        elif source["adapter"] == "rss":
            pairs.append((rss, source["id"]))
        elif source["adapter"] == "techmeme":
            pairs.append((techmeme, source["id"]))
        elif source["adapter"] == "web-publication":
            pairs.append((web, source["id"]))
    return pairs


def collect_sources(
    sources: list[dict[str, Any]],
    request: dict[str, Any] | None = None,
    source_ids: set[str] | None = None,
) -> dict[str, dict[str, Any]]:
    """Collect the given sources and return ``{source_id: batch}``."""
    return collect_run(sources, request, source_ids).batches


def collect_run(
    sources: list[dict[str, Any]],
    request: dict[str, Any] | None = None,
    source_ids: set[str] | None = None,
) -> CollectionRun:
    """Collect batches while retaining validated immutable checkpoint updates."""
    pairs = build_source_pairs(sources)
    runtime = AcquisitionRuntime()
    effective_request = request if request is not None else SHADOW_REQUEST
    by_id = {source["id"]: source for source in sources}
    batches: dict[str, dict[str, Any]] = {}
    updates: dict[str, tuple[CheckpointUpdate, ...]] = {}
    active: dict[str, tuple[str, ...]] = {}
    for adapter, source_id in pairs:
        if source_ids is not None and source_id not in source_ids:
            continue
        result = runtime.collect_one(adapter, source_id, effective_request)
        batches[source_id] = runtime.build_batch(
            adapter, source_id, effective_request, result,
        )
        updates[source_id] = result.checkpoint_updates
        active[source_id] = derive_active_stream_ids(by_id[source_id])
    return CollectionRun(batches, updates, active)
