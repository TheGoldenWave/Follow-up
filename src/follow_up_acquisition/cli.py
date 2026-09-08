"""Command-line entry point for the Follow-up acquisition runtime."""

from __future__ import annotations

import argparse
import sys

from . import __version__


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

    sub.add_parser("doctor", help="validate the runtime and report per-source status")

    run_parser = sub.add_parser(
        "run",
        help="collect configured sources into a Signal Batch",
    )
    run_parser.add_argument(
        "--source",
        help="collect a single stable source_id instead of all enabled sources",
    )

    return parser


def _cmd_doctor() -> int:
    # The doctor subcommand gains real behavior once the runtime and source
    # registry land (v0.3.0 later tasks). Until then it reports honestly.
    print("doctor: acquisition runtime not yet bootstrapped (no sources configured)")
    return 0


def _cmd_run(args: argparse.Namespace) -> int:
    print(f"run: acquisition not yet implemented (source={args.source or 'all'})")
    return 0


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "doctor":
        return _cmd_doctor()
    if args.command == "run":
        return _cmd_run(args)
    # No subcommand: a CLI must be told what to do rather than silently exit 0.
    build_parser().print_help(sys.stderr)
    return 2
