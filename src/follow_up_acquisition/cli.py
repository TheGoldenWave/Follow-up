"""Command-line entry point for the Follow-up acquisition runtime."""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

from . import __version__


def _default_registry_path() -> Path:
    # Repo-relative default for the source checkout; a wheel install must pass
    # --registry explicitly (mirrors contracts.py schema resolution).
    return Path(__file__).resolve().parents[2] / "config" / "sources.json"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="follow_up_acquisition",
        description="Follow-up local acquisition runtime.",
    )
    parser.add_argument(
        "--version",
        action="version",
        version=f"%(prog)s {__version__}",
    )
    sub = parser.add_subparsers(dest="command")

    doctor = sub.add_parser(
        "doctor",
        help="validate the registry and report per-source status",
    )
    doctor.add_argument(
        "--registry",
        help="path to config/sources.json (defaults to the repo checkout)",
    )
    doctor.add_argument(
        "--json",
        action="store_true",
        help="emit a machine-readable JSON summary",
    )

    run_parser = sub.add_parser(
        "run",
        help="collect configured sources into Signal Batches (shadow mode)",
    )
    run_parser.add_argument(
        "--source",
        help="collect a single stable source_id instead of all enabled sources",
    )
    run_parser.add_argument(
        "--registry",
        help="path to config/sources.json (defaults to the repo checkout)",
    )
    run_parser.add_argument(
        "--output",
        help="directory for shadow Signal Batches (defaults to ~/.follow-builders/acquisition)",
    )

    return parser


def _cmd_doctor(args: argparse.Namespace) -> int:
    from .config import ConfigError, load_source_registry

    path = Path(args.registry) if args.registry else _default_registry_path()
    try:
        sources = load_source_registry(path)
    except (ConfigError, OSError) as exc:
        if args.json:
            print(json.dumps({"ok": False, "error": str(exc)}))
        else:
            print(f"doctor: failed to load registry: {exc}")
        return 1

    live = [s for s in sources if s["legacy"]["feed"] is not None]
    enabled = [s for s in sources if s["default_enabled"]]
    credentialed = [s for s in sources if s["requires_credentials"]]
    by_channel = Counter(s["channel"] for s in sources)

    summary = {
        "ok": True,
        "registry": str(path),
        "totals": {
            "sources": len(sources),
            "live": len(live),
            "planned": len(sources) - len(live),
            "enabled_by_default": len(enabled),
            "require_credentials": len(credentialed),
        },
        "channels": {channel: by_channel[channel] for channel in sorted(by_channel)},
    }

    if args.json:
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    else:
        totals = summary["totals"]
        print(f"doctor: registry {path}")
        print(
            f"  sources: {totals['sources']} "
            f"(live {totals['live']}, planned {totals['planned']})"
        )
        print(
            f"  enabled by default: {totals['enabled_by_default']}; "
            f"require credentials: {totals['require_credentials']}"
        )
        print(
            "  channels: "
            + ", ".join(f"{channel}={count}" for channel, count in sorted(by_channel.items()))
        )
        print("  per-source runtime health requires the acquisition adapters.")
    return 0


def _default_output_dir() -> Path:
    return Path.home() / ".follow-builders" / "acquisition"


def _cmd_run(args: argparse.Namespace) -> int:
    from .collect import collect_sources
    from .config import ConfigError, load_source_registry

    path = Path(args.registry) if args.registry else _default_registry_path()
    try:
        sources = load_source_registry(path)
    except (ConfigError, OSError) as exc:
        print(f"run: failed to load registry: {exc}")
        return 1

    if args.source:
        targets = [s for s in sources if s["id"] == args.source]
        if not targets:
            print(f"run: unknown source_id: {args.source}")
            return 1
    else:
        targets = [s for s in sources if s["default_enabled"]]

    batches = collect_sources(targets)
    if not batches:
        print("run: no collectable sources (v0.3.0 adapters are rss and web-publication)")
        return 0

    output_dir = Path(args.output) if args.output else _default_output_dir()
    output_dir.mkdir(parents=True, exist_ok=True)
    for source_id, batch in batches.items():
        out = output_dir / f"{source_id}.json"
        out.write_text(
            json.dumps(batch, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )

    statuses = sorted({b["source_status"]["status"] for b in batches.values()})
    print(
        f"run: collected {len(batches)} source(s) into {output_dir} "
        f"(statuses: {', '.join(statuses)})"
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "doctor":
        return _cmd_doctor(args)
    if args.command == "run":
        return _cmd_run(args)
    # No subcommand: a CLI must be told what to do rather than silently exit 0.
    build_parser().print_help(sys.stderr)
    return 2
