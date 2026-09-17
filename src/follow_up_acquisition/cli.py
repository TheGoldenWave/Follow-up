"""Command-line entry point for the Follow-up acquisition runtime."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from . import __version__

MAX_CHECKPOINT_INTENT_BYTES = 1024 * 1024
_RUN_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_STREAM_ID_RE = re.compile(r"^[a-z][a-z0-9._-]{0,63}$")
_SECRET_VALUES = (
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,255}\b"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,255}\b"),
    re.compile(r"\bsk-[A-Za-z0-9]{32,255}\b"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
)


def _default_registry_path() -> Path:
    checkout = Path(__file__).resolve().parents[2] / "config" / "sources.json"
    if checkout.is_file():
        return checkout
    return Path(sys.prefix) / "share" / "follow-up-acquisition" / "config" / "sources.json"


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
        help="path to sources.json (defaults to the bundled registry)",
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
        help="path to sources.json (defaults to the bundled registry)",
    )
    run_parser.add_argument(
        "--output",
        help="directory for shadow Signal Batches (defaults to ~/.follow-builders/acquisition)",
    )
    run_parser.add_argument("--run-id", help="publisher-assigned immutable run ID")
    run_parser.add_argument("--checkpoint-out", help="absolute checkpoint intent path in output")
    run_parser.add_argument("--state-root", help="absolute source-state root for checkpoint reads")

    commit = sub.add_parser("commit-state", help="commit a previously published checkpoint intent")
    commit.add_argument("--intent", required=True, help="absolute checkpoint intent path")
    commit.add_argument("--state-root", required=True, help="absolute source-state leaf path")
    commit.add_argument("--expected-sha256", required=True, help="published intent SHA-256")
    commit.add_argument("--expected-run-id", required=True, help="published run ID")

    return parser


def _cmd_doctor(args: argparse.Namespace) -> int:
    from .config import ConfigError, load_source_registry
    from .source_state import state_store_available

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
    by_channel = Counter(
        "core-topic" if s["channel"] is None and s.get("channel_policy") == "core-topic"
        else s["channel"]
        for s in sources
    )

    summary = {
        "ok": True,
        "central_registry_usable": True,
        "state_backend": "supported" if state_store_available() else "unsupported",
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
        if summary["state_backend"] == "unsupported":
            print("  local source state: unsupported on this platform; central registry remains usable.")
    return 0


def _default_output_dir() -> Path:
    return Path.home() / ".follow-builders" / "acquisition"


def _canonical_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _write_json_atomic(path: Path, value: object) -> None:
    """Write private JSON and make the rename durable without following links."""
    payload = (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()
    temporary = path.parent / f".{path.name}.tmp-{uuid4().hex}"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(temporary, flags, 0o600)
    try:
        with os.fdopen(descriptor, "wb", closefd=False) as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.close(descriptor)
        descriptor = -1
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _intent_from_run(run: object, run_id: str) -> dict:
    from .runtime import thaw_checkpoint_update

    sources = []
    for source_id in sorted(run.batches, key=lambda item: item.encode("utf-8")):
        sources.append({
            "source_id": source_id,
            "batch_id": run.batches[source_id]["batch_id"],
            "active_stream_ids": list(run.active_stream_ids[source_id]),
            "updates": [
                thaw_checkpoint_update(update)
                for update in sorted(
                    run.checkpoint_updates[source_id],
                    key=lambda item: item.stream_id.encode("utf-8"),
                )
            ],
        })
    intent = {
        "schema_version": "1.0",
        "run_id": run_id,
        "generated_at": _canonical_now(),
        "sources": sources,
    }
    encoded_size = len(json.dumps(
        intent, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
    ).encode("utf-8")) + 1
    if encoded_size > MAX_CHECKPOINT_INTENT_BYTES:
        raise ValueError("checkpoint intent exceeds size limit")
    return intent


def _exact_fields(value: object, fields: set[str], label: str) -> dict:
    if not isinstance(value, dict) or set(value) != fields:
        raise ValueError(f"{label} fields are closed")
    return value


def _validate_timestamp(value: object, label: str) -> None:
    if not isinstance(value, str) or not value.endswith("Z"):
        raise ValueError(f"{label} must be canonical UTC")
    try:
        datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as exc:
        raise ValueError(f"{label} must be canonical UTC") from exc


def _validate_intent(value: object) -> dict:
    """Apply the Python semantic contract before any state store is opened."""
    from .runtime import CheckpointUpdate, validate_checkpoint_updates
    from .source_state import prune_state, validate_state

    intent = _exact_fields(
        value, {"schema_version", "run_id", "generated_at", "sources"}, "intent",
    )
    stack = [intent]
    while stack:
        item = stack.pop()
        if isinstance(item, dict):
            for key, child in item.items():
                if re.search(r"(?:^|[_-])(?:token|secret|password|credential|cookie|authorization|api[_-]?key)(?:$|[_-])", key, re.I):
                    raise ValueError("intent contains credential-shaped data")
                stack.append(child)
        elif isinstance(item, list):
            stack.extend(item)
        elif isinstance(item, str) and any(pattern.search(item) for pattern in _SECRET_VALUES):
            raise ValueError("intent contains credential-shaped data")
    if intent["schema_version"] != "1.0":
        raise ValueError("unsupported intent schema")
    if not isinstance(intent["run_id"], str) or _RUN_ID_RE.fullmatch(intent["run_id"]) is None:
        raise ValueError("unsafe run_id")
    if not isinstance(intent["generated_at"], str) or re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", intent["generated_at"],
    ) is None:
        raise ValueError("generated_at must use exact UTC seconds")
    _validate_timestamp(intent["generated_at"], "generated_at")
    if not isinstance(intent["sources"], list):
        raise ValueError("sources must be an array")
    source_ids: list[str] = []
    for index, raw_source in enumerate(intent["sources"]):
        source = _exact_fields(
            raw_source, {"source_id", "batch_id", "active_stream_ids", "updates"},
            f"sources[{index}]",
        )
        source_id = source["source_id"]
        if not isinstance(source_id, str) or not source_id:
            raise ValueError("unsafe source_id")
        source_ids.append(source_id)
        if not isinstance(source["batch_id"], str) or not source["batch_id"]:
            raise ValueError("invalid batch_id")
        active = source["active_stream_ids"]
        if not isinstance(active, list) or any(
            not isinstance(item, str) or _STREAM_ID_RE.fullmatch(item) is None for item in active
        ):
            raise ValueError("invalid active_stream_ids")
        if active != sorted(set(active), key=lambda item: item.encode("utf-8")):
            raise ValueError("active_stream_ids must be a canonical ordered set")
        if not isinstance(source["updates"], list) or len(source["updates"]) > 128:
            raise ValueError("too many updates")
        updates = []
        for update_index, raw_update in enumerate(source["updates"]):
            update = _exact_fields(
                raw_update, {"stream_id", "previous_checkpoint_at", "checkpoint"},
                f"updates[{update_index}]",
            )
            updates.append(CheckpointUpdate(
                update["stream_id"], update["previous_checkpoint_at"], update["checkpoint"],
            ))
        update_ids = [update.stream_id for update in updates]
        if update_ids != sorted(set(update_ids), key=lambda item: item.encode("utf-8")):
            raise ValueError("checkpoint updates must be a canonical ordered set")
        if any(update.stream_id not in active for update in updates):
            raise ValueError("checkpoint update references an inactive stream")
        validate_checkpoint_updates(source_id, updates)
        empty = {"schema_version": "1.0", "source_id": source_id, "streams": {}, "updated_at": None}
        validate_state(empty, expected_source_id=source_id)
        prune_state(empty, active_stream_ids=active, now=intent["generated_at"])
    if source_ids != sorted(set(source_ids), key=lambda item: item.encode("utf-8")):
        raise ValueError("sources must be canonically sorted and unique")
    return intent


def _read_intent(path: Path) -> tuple[dict, bytes, str]:
    if not path.is_absolute() or path.is_symlink():
        raise ValueError("intent path must be absolute and not a symlink")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        before = os.fstat(descriptor)
        if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1
                or before.st_size > MAX_CHECKPOINT_INTENT_BYTES):
            raise ValueError("intent must be a bounded regular file")
        chunks = []
        size = 0
        while size <= MAX_CHECKPOINT_INTENT_BYTES:
            chunk = os.read(descriptor, min(64 * 1024, MAX_CHECKPOINT_INTENT_BYTES + 1 - size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
        after = os.fstat(descriptor)
        if ((after.st_dev, after.st_ino, after.st_nlink, after.st_size)
                != (before.st_dev, before.st_ino, before.st_nlink, before.st_size)
                or size != before.st_size):
            raise ValueError("intent changed while being read")
        payload = b"".join(chunks)
    finally:
        os.close(descriptor)
    if len(payload) > MAX_CHECKPOINT_INTENT_BYTES:
        raise ValueError("intent exceeds size limit")
    digest = hashlib.sha256(payload).hexdigest()
    try:
        intent = _validate_intent(json.loads(payload.decode("utf-8")))
        return intent, payload, digest
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("intent is not valid JSON") from exc


def _cmd_run(args: argparse.Namespace) -> int:
    from .collect import collect_run
    from .config import ConfigError, load_source_registry
    from .source_state import SourceStateError, SourceStateStore

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

    handshake = any((args.run_id, args.checkpoint_out))
    if handshake:
        if not args.run_id or not args.checkpoint_out or not args.output:
            print("run: --run-id, --output, and --checkpoint-out are required together")
            return 1
        output_dir = Path(args.output)
        checkpoint_out = Path(args.checkpoint_out)
        if not output_dir.is_absolute() or not checkpoint_out.is_absolute():
            print("run: output and checkpoint paths must be absolute")
            return 1
        if checkpoint_out.parent != output_dir or checkpoint_out.name != "checkpoint-intent.json":
            print("run: checkpoint must be checkpoint-intent.json inside output staging")
            return 1
        if _RUN_ID_RE.fullmatch(args.run_id) is None:
            print("run: unsafe run_id")
            return 1
    checkpoint_resolver = None
    if args.state_root:
        state_root = Path(args.state_root)
        try:
            if not state_root.is_absolute() or state_root.is_symlink():
                raise ValueError
            checkpoint_resolver = SourceStateStore(state_root).load
        except (OSError, SourceStateError, ValueError):
            print("run: source state is unavailable")
            return 1
    run = collect_run(targets, checkpoint_resolver=checkpoint_resolver)
    batches = run.batches
    stateful_adapters = {"github", "hackernews", "techmeme", "arxiv", "hugging-face-papers"}
    stateful = any(run.active_stream_ids.values()) or any(
        source.get("adapter") in stateful_adapters for source in targets
    )
    if not handshake and stateful:
        print("run: checkpoint handshake required for stateful adapters")
        return 1
    if not batches:
        if handshake:
            try:
                output_info = output_dir.lstat()
            except OSError:
                print("run: private output directory must be precreated by the publisher")
                return 1
            if (output_dir.is_symlink() or not stat.S_ISDIR(output_info.st_mode)
                    or stat.S_IMODE(output_info.st_mode) != 0o700):
                print("run: unsafe output directory")
                return 1
            try:
                _write_json_atomic(checkpoint_out, _intent_from_run(run, args.run_id))
            except (OSError, ValueError):
                print("run: checkpoint intent exceeds size limit or cannot be staged safely")
                return 1
        print("run: no collectable sources")
        return 0

    output_dir = Path(args.output) if args.output else _default_output_dir()
    if handshake:
        try:
            output_info = output_dir.lstat()
        except OSError:
            print("run: private output directory must be precreated by the publisher")
            return 1
        if (output_dir.is_symlink() or not stat.S_ISDIR(output_info.st_mode)
                or stat.S_IMODE(output_info.st_mode) != 0o700):
            print("run: unsafe output directory")
            return 1
    else:
        output_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    if output_dir.is_symlink():
        print("run: unsafe output directory")
        return 1
    for source_id, batch in batches.items():
        out = output_dir / f"{source_id}.json"
        _write_json_atomic(out, batch)
    if handshake:
        try:
            _write_json_atomic(checkpoint_out, _intent_from_run(run, args.run_id))
        except (OSError, ValueError):
            print("run: checkpoint intent exceeds size limit or cannot be staged safely")
            return 1

    statuses = sorted({b["source_status"]["status"] for b in batches.values()})
    print(
        f"run: collected {len(batches)} source(s) into {output_dir} "
        f"(statuses: {', '.join(statuses)})"
    )
    return 0


def _cmd_commit_state(args: argparse.Namespace) -> int:
    from .source_state import SourceStateError, SourceStateStore, StateConflictError

    expected_run_id = args.expected_run_id
    report_run_id = expected_run_id if _RUN_ID_RE.fullmatch(expected_run_id or "") else "invalid-run"

    def emit(status: str, sources: list[dict[str, str]]) -> None:
        print(json.dumps({
            "schema_version": "1.0", "run_id": report_run_id, "status": status,
            "source_count": len(sources), "sources": sources,
        }, sort_keys=True))

    try:
        intent_path = Path(args.intent)
        state_root = Path(args.state_root)
        if not state_root.is_absolute() or state_root.is_symlink():
            raise ValueError("state root must be an absolute non-symlink path")
        parent = state_root.parent
        if not parent.is_dir() or parent.is_symlink() or stat.S_IMODE(parent.stat().st_mode) != 0o700:
            raise ValueError("state root parent setup required")
        intent, _payload, digest = _read_intent(intent_path)
        if not re.fullmatch(r"[0-9a-f]{64}", args.expected_sha256 or ""):
            raise ValueError("invalid expected digest")
        if report_run_id != expected_run_id:
            raise ValueError("invalid expected run ID")
        if digest != args.expected_sha256 or intent["run_id"] != expected_run_id:
            raise ValueError("published intent binding mismatch")
    except (ValueError, OSError):
        emit("partial", [])
        return 1

    try:
        store = SourceStateStore(state_root)
    except SourceStateError:
        emit("partial", [
            {"source_id": source["source_id"], "status": "error"}
            for source in intent["sources"]
        ])
        return 1
    results = []
    failed = 0
    durability_uncertain = False
    for source in intent["sources"]:
        try:
            store.commit(
                source["source_id"], source["updates"],
                active_stream_ids=source["active_stream_ids"],
            )
            results.append({"source_id": source["source_id"], "status": "committed"})
        except StateConflictError:
            failed += 1
            results.append({"source_id": source["source_id"], "status": "conflict"})
        except SourceStateError as exc:
            failed += 1
            status_value = "error"
            if exc.code == "state-durability-uncertain":
                durability_uncertain = True
                try:
                    store.load(source["source_id"])
                    status_value = "uncertain"
                except SourceStateError:
                    status_value = "uncertain"
            results.append({"source_id": source["source_id"], "status": status_value})
    status_value = "committed" if not failed else "uncertain" if durability_uncertain else "partial"
    emit(status_value, results)
    return 0 if not failed else 3


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "doctor":
        return _cmd_doctor(args)
    if args.command == "run":
        return _cmd_run(args)
    if args.command == "commit-state":
        return _cmd_commit_state(args)
    # No subcommand: a CLI must be told what to do rather than silently exit 0.
    build_parser().print_help(sys.stderr)
    return 2
