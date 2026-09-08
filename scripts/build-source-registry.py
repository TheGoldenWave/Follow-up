#!/usr/bin/env python3
"""Build ``config/sources.json`` from the legacy source config files.

Run once per migration: the emitted file is the authoritative source registry,
and the legacy central-Feed config files become generated compatibility
artifacts. Pure standard library.
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / "config"

# Reports have no legacy runtime config yet; their IDs are assigned here and
# are immutable once emitted.
REPORT_IDS = {
    "State of AI Report": "report:state-of-ai",
    "Stanford HAI AI Index": "report:stanford-ai-index",
    "a16z AI Canon": "report:a16z-ai-canon",
    "CB Insights AI Research": "report:cbinsights-ai",
    "FirstMark MAD Landscape": "report:firstmark-mad",
}


def _load(name: str) -> dict:
    with open(CONFIG / name, encoding="utf-8") as handle:
        return json.load(handle)


def _entry(
    source_id: str,
    name: str,
    channel: str,
    adapter: str,
    requires_credentials: bool,
    default_enabled: bool,
    cadence: str,
    budget: int,
    input_: dict,
    feed: str | None,
) -> dict:
    return {
        "id": source_id,
        "name": name,
        "channel": channel,
        "channel_policy": "fixed",
        "adapter": adapter,
        "requires_credentials": requires_credentials,
        "default_enabled": default_enabled,
        "cadence": cadence,
        "budget": budget,
        "input": input_,
        "legacy": {"feed": feed},
    }


def build() -> dict:
    sources: list[dict] = []
    default_sources = _load("default-sources.json")

    for account in default_sources["x_accounts"]:
        sources.append(_entry(
            account["id"], account["name"], "x", "x",
            requires_credentials=True, default_enabled=False,
            cadence="daily", budget=5,
            input_={"handle": account["handle"]}, feed="feed-x.json",
        ))

    for podcast in default_sources["podcasts"]:
        sources.append(_entry(
            podcast["id"], podcast["name"], "podcasts", "podcast",
            requires_credentials=False, default_enabled=True,
            cadence="daily", budget=3,
            input_={"rss_url": podcast["rssUrl"], "url": podcast["url"]},
            feed="feed-podcasts.json",
        ))

    for blog in _load("feed-blogs.json")["sources"]:
        sources.append(_entry(
            blog["id"], blog["name"], "blogs", "web-publication",
            requires_credentials=False, default_enabled=True,
            cadence="daily", budget=3,
            input_={
                "url": blog["url"],
                "language": blog.get("language", "en"),
                "discovery": blog.get("discovery", []),
                "article_url_patterns": blog.get("articleUrlPatterns", []),
                "exclude_url_patterns": blog.get("excludeUrlPatterns", []),
                "parser": blog.get("parser"),
            },
            feed="feed-blogs.json",
        ))

    newsletter_by_id: dict[str, dict] = {}
    for newsletter in _load("feed-newsletters.json")["sources"]:
        newsletter_by_id[newsletter["id"]] = newsletter
    for newsletter in default_sources["newsletters"]:
        newsletter_by_id.setdefault(newsletter["id"], newsletter)

    live_newsletters = {n["id"] for n in _load("feed-newsletters.json")["sources"]}
    for source_id in sorted(newsletter_by_id):
        newsletter = newsletter_by_id[source_id]
        live = source_id in live_newsletters
        sources.append(_entry(
            source_id, newsletter["name"], "newsletters", "rss",
            requires_credentials=False, default_enabled=True,
            cadence=newsletter.get("cadence", "weekly"),
            budget=newsletter.get("maxArticles", 2),
            input_={
                "rss_url": newsletter.get("rss") or newsletter.get("rssUrl"),
                "url": newsletter.get("url"),
            },
            feed="feed-newsletters.json" if live else None,
        ))

    for paper in _load("feed-academic.json")["sources"]:
        sources.append(_entry(
            paper["id"], paper["name"], "academic", "arxiv",
            requires_credentials=False, default_enabled=True,
            cadence="daily", budget=paper.get("maxArticles", 3),
            input_={"rss_url": paper["rss"], "url": paper["url"]},
            feed="feed-academic.json",
        ))

    zh_by_id: dict[str, dict] = {}
    for source in _load("feed-zh-tech.json")["sources"]:
        zh_by_id[source["id"]] = source
    for source in default_sources["chinese_tech"]:
        zh_by_id.setdefault(source["id"], source)

    live_zh = {s["id"] for s in _load("feed-zh-tech.json")["sources"]}
    for source_id in sorted(zh_by_id):
        source = zh_by_id[source_id]
        live = source_id in live_zh
        sources.append(_entry(
            source_id, source["name"], "zh-tech", "rss",
            requires_credentials=False, default_enabled=True,
            cadence="daily", budget=source.get("maxArticles", 3),
            input_={
                "rss_url": source.get("rss") or source.get("rssUrl"),
                "url": source.get("url"),
                "language": "zh",
            },
            feed="feed-zh-tech.json" if live else None,
        ))

    for report in default_sources["reports"]:
        sources.append(_entry(
            REPORT_IDS[report["name"]], report["name"], "reports", "report",
            requires_credentials=False, default_enabled=False,
            cadence="monthly", budget=1,
            input_={"url": report["url"]}, feed=None,
        ))

    sources.sort(key=lambda source: source["id"])
    return {"schema_version": "1.0", "sources": sources}


if __name__ == "__main__":
    registry = build()
    out = CONFIG / "sources.json"
    out.write_text(
        json.dumps(registry, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(f"wrote {out} ({len(registry['sources'])} sources)")
