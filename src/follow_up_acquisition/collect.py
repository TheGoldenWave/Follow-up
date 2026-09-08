"""Shadow-mode collection: wire the registry, adapters, and runtime together.

This module is the only place that maps registry ``adapter`` values to adapter
instances. Sources whose adapter is not implemented in v0.3.0 (X, podcast,
arXiv, reports, Sidecars) are skipped, so a partial rollout never breaks the
rest of the run.
"""

from __future__ import annotations

from typing import Any

from .adapters.rss import RssAdapter
from .adapters.web_publication import WebPublicationAdapter
from .runtime import AcquisitionRuntime

SHADOW_REQUEST: dict[str, str] = {"mode": "shadow"}

# Adapters wired for v0.3.0 local collection. The remaining adapter ids in the
# registry stay deferred to later versions per the frozen scope.
_COLLECTABLE_ADAPTERS = frozenset({"rss", "web-publication"})


def build_source_pairs(sources: list[dict[str, Any]]) -> list[tuple[Any, str]]:
    """Return ``[(adapter, source_id)]`` for every collectable source."""
    by_id = {source["id"]: source for source in sources}
    rss = RssAdapter(resolve_source=lambda source_id: by_id[source_id])
    web = WebPublicationAdapter(resolve_source=lambda source_id: by_id[source_id])

    pairs: list[tuple[Any, str]] = []
    for source in sources:
        if source["adapter"] == "rss":
            pairs.append((rss, source["id"]))
        elif source["adapter"] == "web-publication":
            pairs.append((web, source["id"]))
    return pairs


def collect_sources(
    sources: list[dict[str, Any]],
    request: dict[str, Any] | None = None,
    source_ids: set[str] | None = None,
) -> dict[str, dict[str, Any]]:
    """Collect the given sources and return ``{source_id: batch}``."""
    pairs = build_source_pairs(sources)
    runtime = AcquisitionRuntime()
    return runtime.run(
        pairs,
        request if request is not None else SHADOW_REQUEST,
        source_ids=source_ids,
    )
