#!/usr/bin/env python3
"""Read-only validator for the canonical source registry and legacy projections."""
from __future__ import annotations
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / "config"

def _load(name: str) -> dict:
    with open(CONFIG / name, encoding="utf-8") as handle:
        return json.load(handle)

def _expect(errors: list[str], source: dict, field: str, expected) -> None:
    if source.get(field) != expected:
        errors.append(f"{source.get('id', '<missing>')}: canonical {field} metadata drift")

def validate() -> list[str]:
    document = _load("sources.json")
    sources = document.get("sources")
    if document.get("schema_version") != "1.0" or not isinstance(sources, list):
        return ["canonical registry envelope is invalid"]
    errors: list[str] = []
    if len(sources) != 89:
        errors.append("canonical registry must contain 89 sources")
    by_id = {source.get("id"): source for source in sources if isinstance(source, dict)}
    if len(by_id) != len(sources):
        errors.append("canonical registry source IDs must be unique")
    central = [source for source in sources if source.get("legacy", {}).get("feed") is not None]
    if len(central) != 70:
        errors.append("canonical registry must contain 70 central-live sources")
    default = _load("default-sources.json")
    groups = [
        ("feed-x.json", default["x_accounts"]),
        ("feed-podcasts.json", default["podcasts"]),
        ("feed-blogs.json", _load("feed-blogs.json")["sources"]),
        ("feed-newsletters.json", _load("feed-newsletters.json")["sources"]),
        ("feed-academic.json", _load("feed-academic.json")["sources"]),
        ("feed-zh-tech.json", _load("feed-zh-tech.json")["sources"]),
    ]
    checked = 0
    for feed_name, legacy_sources in groups:
        for legacy in legacy_sources:
            checked += 1
            source = by_id.get(legacy.get("id"))
            if source is None:
                errors.append(f"{feed_name}: legacy source ID is absent from canonical registry")
                continue
            if source.get("legacy", {}).get("feed") != feed_name:
                errors.append(f"{feed_name}: canonical legacy.feed metadata drift")
            _expect(errors, source, "name", legacy.get("name"))
            input_value = source.get("input", {})
            if "handle" in legacy:
                _expect(errors, input_value, "handle", legacy["handle"])
            rss = legacy.get("rss") or legacy.get("rssUrl")
            if rss is not None:
                _expect(errors, input_value, "rss_url", rss)
            if legacy.get("url") is not None:
                _expect(errors, input_value, "url", legacy["url"])
            if "tags" in legacy:
                _expect(errors, input_value, "tags", legacy["tags"])
            if "maxArticles" in legacy:
                _expect(errors, source, "budget", legacy["maxArticles"])
            if "cadence" in legacy:
                _expect(errors, source, "cadence", legacy["cadence"])
            for legacy_key, canonical_key in (
                ("language", "language"),
                ("discovery", "discovery"),
                ("articleUrlPatterns", "article_url_patterns"),
                ("excludeUrlPatterns", "exclude_url_patterns"),
                ("fetchUrlPatterns", "fetch_url_patterns"),
                ("parser", "parser"),
                ("contentSelectors", "content_selectors"),
                ("contentSelectorPriority", "content_selector_priority"),
            ):
                if legacy_key in legacy:
                    _expect(errors, input_value, canonical_key, legacy[legacy_key])
    if checked != 70:
        errors.append("legacy compatibility inputs must contain exactly 70 sources")
    return errors

def main() -> int:
    errors = validate()
    if errors:
        for error in errors:
            print(error, file=sys.stderr)
        return 1
    print("canonical source registry valid: 89 total, 70 central-live")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
