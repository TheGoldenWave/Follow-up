"""Adversarial tests for the POSIX directory-fd state backend."""

from __future__ import annotations

import os
from pathlib import Path
import tempfile
import threading
import sys
import unittest
from unittest.mock import patch

from follow_up_acquisition.state_store_posix import (
    _normalize_system_alias,
    PosixBackendError,
    PosixStateBackend,
    posix_backend_available,
)


class PosixBackendTests(unittest.TestCase):
    def test_system_alias_normalization_is_darwin_only(self) -> None:
        self.assertEqual(
            _normalize_system_alias("/tmp/example", system_name="Linux"),
            "/tmp/example",
        )
        self.assertEqual(
            _normalize_system_alias("/var/example", system_name="FreeBSD"),
            "/var/example",
        )
        backend = PosixStateBackend("/tmp/example", system_name="Linux")
        self.assertEqual(backend.root, Path("/tmp/example"))

    def test_fsyncs_immediate_parent_after_leaf_creation(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            calls = 0
            def record_parent_fsync() -> None:
                nonlocal calls
                calls += 1
            parent = Path(temp_dir) / "one" / "two"
            parent.mkdir(parents=True)
            parent.chmod(0o700)
            root = parent / "state"
            PosixStateBackend(
                root, hooks={"before_parent_directory_fsync": record_parent_fsync},
            ).atomic_update(
                "source.json", ".source.lock", 100, lambda _current: (b"new", None),
            )
            self.assertEqual(calls, 1)

    def test_parent_fsync_failure_is_uncertain_and_never_publishes_state(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            calls = 0
            def fail_parent_fsync() -> None:
                nonlocal calls
                calls += 1
                raise OSError("parent fsync failed")
            parent = Path(temp_dir) / "one" / "two"
            parent.mkdir(parents=True)
            parent.chmod(0o700)
            root = parent / "state"
            backend = PosixStateBackend(
                root, hooks={"before_parent_directory_fsync": fail_parent_fsync},
            )
            with self.assertRaises(PosixBackendError) as ctx:
                backend.atomic_update(
                    "source.json", ".source.lock", 100, lambda _current: (b"new", None),
                )
            self.assertEqual(ctx.exception.code, "state-durability-uncertain")
            self.assertEqual(calls, 1)
            self.assertFalse((root / "source.json").exists())
            self.assertTrue((parent / ".source-state.init.lock").is_file())
            self.assertFalse((root / ".source.lock").exists())

    def test_setup_rejects_immediate_parent_replacement_after_mkdir(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            base = Path(temp_dir)
            parent = base / "parent"
            parent.mkdir(mode=0o700)
            root = parent / "state"
            detached = base / "detached-parent"
            def replace_parent() -> None:
                parent.rename(detached)
                parent.mkdir(mode=0o700)
            backend = PosixStateBackend(root, hooks={"after_directory_created": replace_parent})
            with self.assertRaises(PosixBackendError) as ctx:
                backend.atomic_update(
                    "source.json", ".source.lock", 100, lambda _current: (b"new", None),
                )
            self.assertEqual(ctx.exception.code, "unsafe-state")
            self.assertFalse((parent / "state" / "source.json").exists())
            self.assertFalse((detached / "state" / "source.json").exists())

    def test_setup_rejects_unrelated_ancestor_chmod_after_mkdir(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            base = Path(temp_dir)
            ancestor = base / "ancestor"
            parent = ancestor / "parent"
            parent.mkdir(parents=True, mode=0o700)
            ancestor.chmod(0o700)
            root = parent / "state"
            backend = PosixStateBackend(
                root, hooks={"after_directory_created": lambda: ancestor.chmod(0o777)},
            )
            with self.assertRaises(PosixBackendError) as ctx:
                backend.atomic_update(
                    "source.json", ".source.lock", 100, lambda _current: (b"new", None),
                )
            self.assertEqual(ctx.exception.code, "unsafe-state")
            self.assertFalse((root / "source.json").exists())

    def test_setup_pins_new_root_before_remove_recreate_hook(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            parent = Path(temp_dir) / "parent"
            parent.mkdir(mode=0o700)
            root = parent / "state"
            def recreate_root() -> None:
                root.rmdir()
                root.mkdir(mode=0o700)
            backend = PosixStateBackend(root, hooks={"after_directory_created": recreate_root})
            with self.assertRaises(PosixBackendError) as ctx:
                backend.atomic_update(
                    "source.json", ".source.lock", 100, lambda _current: (b"new", None),
                )
            self.assertEqual(ctx.exception.code, "unsafe-state")
            self.assertFalse((root / "source.json").exists())

    def test_setup_pins_nested_new_directory_before_remove_recreate_hook(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            parent = Path(temp_dir) / "first" / "second"
            parent.mkdir(parents=True)
            parent.chmod(0o700)
            root = parent / "state"
            def recreate_root() -> None:
                root.rmdir()
                root.mkdir(mode=0o700)
            backend = PosixStateBackend(root, hooks={"after_directory_created": recreate_root})
            with self.assertRaises(PosixBackendError) as ctx:
                backend.atomic_update(
                    "source.json", ".source.lock", 100, lambda _current: (b"new", None),
                )
            self.assertEqual(ctx.exception.code, "unsafe-state")
            self.assertFalse((root / "source.json").exists())

    def test_setup_allows_legitimate_nested_directory_creation(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            parent = Path(temp_dir) / "one" / "two"
            parent.mkdir(parents=True)
            parent.chmod(0o700)
            root = parent / "state"
            backend = PosixStateBackend(root)
            backend.atomic_update(
                "source.json", ".source.lock", 100, lambda _current: (b"new", None),
            )
            self.assertEqual(backend.read("source.json", 100), b"new")

    def test_missing_immediate_parent_fails_closed_without_creating_ancestors(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            missing_parent = Path(temp_dir) / "missing"
            backend = PosixStateBackend(missing_parent / "state")
            with self.assertRaises(PosixBackendError) as ctx:
                backend.atomic_update(
                    "source.json", ".source.lock", 100, lambda _current: (b"new", None),
                )
            self.assertEqual(ctx.exception.code, "state-parent-missing")
            self.assertFalse(missing_parent.exists())

    def test_concurrent_different_source_entries_do_not_conflict_on_root_directory_churn(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "state"
            root.mkdir(mode=0o700)
            barrier = threading.Barrier(3)
            failures: list[BaseException] = []
            def write(name: str) -> None:
                barrier.wait()
                try:
                    PosixStateBackend(root).atomic_update(
                        f"{name}.json", f".{name}.lock", 100,
                        lambda _current: (name.encode("ascii"), None),
                    )
                except BaseException as exc:
                    failures.append(exc)
            threads = [threading.Thread(target=write, args=(name,)) for name in ("a", "b")]
            for thread in threads:
                thread.start()
            barrier.wait()
            for thread in threads:
                thread.join(timeout=5)
                self.assertFalse(thread.is_alive())
            self.assertEqual(failures, [])
            self.assertEqual(PosixStateBackend(root).read("a.json", 100), b"a")
            self.assertEqual(PosixStateBackend(root).read("b.json", 100), b"b")

    def test_unrelated_shared_ancestor_sibling_creation_before_publish_is_accepted(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "private" / "state"
            root.parent.mkdir(mode=0o700)
            root.mkdir(mode=0o700)
            sibling = Path(temp_dir).parent / f"{Path(temp_dir).name}-parallel-sibling"
            try:
                backend = PosixStateBackend(
                    root, hooks={"before_publish_identity_check": lambda: sibling.mkdir(mode=0o700)},
                )
                backend.atomic_update(
                    "source.json", ".source.lock", 100, lambda _current: (b"new", None),
                )
                self.assertEqual(backend.read("source.json", 100), b"new")
            finally:
                if sibling.exists():
                    sibling.rmdir()

    def test_unrelated_shared_ancestor_sibling_creation_after_replace_is_accepted(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "private" / "state"
            root.parent.mkdir(mode=0o700)
            root.mkdir(mode=0o700)
            sibling = Path(temp_dir).parent / f"{Path(temp_dir).name}-parallel-sibling"
            try:
                backend = PosixStateBackend(
                    root, hooks={"after_replace": lambda: sibling.mkdir(mode=0o700)},
                )
                backend.atomic_update(
                    "source.json", ".source.lock", 100, lambda _current: (b"new", None),
                )
                self.assertEqual(backend.read("source.json", 100), b"new")
            finally:
                if sibling.exists():
                    sibling.rmdir()

    def test_direct_parent_sibling_churn_during_leaf_initialization_is_accepted(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            parent = Path(temp_dir) / "private"
            parent.mkdir(mode=0o700)
            root = parent / "state"
            sibling = parent / "unrelated-sibling"
            backend = PosixStateBackend(
                root, hooks={"after_directory_created": lambda: sibling.mkdir(mode=0o700)},
            )
            backend.atomic_update(
                "source.json", ".source.lock", 100, lambda _current: (b"new", None),
            )
            self.assertEqual(backend.read("source.json", 100), b"new")

    def test_backend_probe_rejects_non_posix_without_fallback(self) -> None:
        self.assertTrue(posix_backend_available("posix"))
        self.assertFalse(posix_backend_available("nt"))
        with tempfile.TemporaryDirectory() as temp_dir, self.assertRaises(PosixBackendError) as ctx:
            PosixStateBackend(Path(temp_dir), platform_name="nt").read("source.json", 100)
        self.assertEqual(ctx.exception.code, "unsupported-platform")

    def test_backend_probe_requires_fcntl(self) -> None:
        with patch.dict(sys.modules, {"fcntl": None}):
            self.assertFalse(posix_backend_available("posix"))

    def test_atomic_update_round_trips_private_regular_file(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "state"
            backend = PosixStateBackend(root)
            result = backend.atomic_update(
                "source.json", ".source.lock", 100, lambda current: (b"new", current),
            )
            self.assertIsNone(result)
            self.assertEqual(backend.read("source.json", 100), b"new")
            self.assertEqual(root.stat().st_mode & 0o777, 0o700)
            self.assertEqual((root / "source.json").stat().st_mode & 0o777, 0o600)
            self.assertEqual(list(root.glob(".*.tmp")), [])

    def test_rejects_state_symlink_and_hardlink(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "state"
            root.mkdir(mode=0o700)
            outside = Path(temp_dir) / "outside"
            outside.write_bytes(b"outside")
            outside.chmod(0o600)
            target = root / "source.json"
            target.symlink_to(outside)
            with self.assertRaises(PosixBackendError):
                PosixStateBackend(root).read("source.json", 100)
            target.unlink()
            os.link(outside, target)
            with self.assertRaises(PosixBackendError):
                PosixStateBackend(root).read("source.json", 100)

    def test_rejects_lock_symlink_and_hardlink(self) -> None:
        for link_kind in ("symlink", "hardlink"):
            with self.subTest(link_kind=link_kind), tempfile.TemporaryDirectory() as temp_dir:
                root = Path(temp_dir) / "state"
                root.mkdir(mode=0o700)
                outside = Path(temp_dir) / "outside"
                outside.write_bytes(b"x")
                outside.chmod(0o600)
                lock = root / ".source.lock"
                if link_kind == "symlink":
                    lock.symlink_to(outside)
                else:
                    os.link(outside, lock)
                with self.assertRaises(PosixBackendError):
                    PosixStateBackend(root).atomic_update(
                        "source.json", ".source.lock", 100, lambda _current: (b"new", None),
                    )

    def test_rejects_lock_inode_replacement_after_open(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "state"
            root.mkdir(mode=0o700)
            lock = root / ".source.lock"
            def replace_lock() -> None:
                lock.unlink()
                lock.write_bytes(b"replacement")
                lock.chmod(0o600)
            backend = PosixStateBackend(root, hooks={"after_lock_open": replace_lock})
            with self.assertRaises(PosixBackendError) as ctx:
                backend.atomic_update(
                    "source.json", ".source.lock", 100, lambda _current: (b"new", None),
                )
            self.assertEqual(ctx.exception.code, "unsafe-state")
            self.assertFalse((root / "source.json").exists())

    def test_revalidates_lock_identity_at_publish_boundary(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "state"
            root.mkdir(mode=0o700)
            lock = root / ".source.lock"
            def replace_lock() -> None:
                lock.unlink()
                lock.write_bytes(b"replacement")
                lock.chmod(0o600)
            backend = PosixStateBackend(
                root, hooks={"before_publish_identity_check": replace_lock},
            )
            with self.assertRaises(PosixBackendError) as ctx:
                backend.atomic_update(
                    "source.json", ".source.lock", 100, lambda _current: (b"new", None),
                )
            self.assertEqual(ctx.exception.code, "unsafe-state")
            self.assertFalse((root / "source.json").exists())

    def test_init_lock_replacement_before_publish_aborts_transaction(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            parent = Path(temp_dir) / "acquisition"
            parent.mkdir(mode=0o700)
            root = parent / "source-state"
            init_lock = parent / ".source-state.init.lock"
            def replace_init_lock() -> None:
                init_lock.unlink()
                init_lock.write_bytes(b"replacement")
                init_lock.chmod(0o600)
            backend = PosixStateBackend(
                root, hooks={"before_publish_identity_check": replace_init_lock},
            )
            with self.assertRaises(PosixBackendError) as ctx:
                backend.atomic_update(
                    "source.json", ".source.lock", 100, lambda _current: (b"new", None),
                )
            self.assertEqual(ctx.exception.code, "unsafe-state")
            self.assertFalse((root / "source.json").exists())

    def test_init_lock_replacement_after_publish_is_durability_uncertain(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            parent = Path(temp_dir) / "acquisition"
            parent.mkdir(mode=0o700)
            root = parent / "source-state"
            init_lock = parent / ".source-state.init.lock"
            def replace_init_lock() -> None:
                init_lock.unlink()
                init_lock.write_bytes(b"replacement")
                init_lock.chmod(0o600)
            backend = PosixStateBackend(root, hooks={"after_replace": replace_init_lock})
            with self.assertRaises(PosixBackendError) as ctx:
                backend.atomic_update(
                    "source.json", ".source.lock", 100, lambda _current: (b"new", None),
                )
            self.assertEqual(ctx.exception.code, "state-durability-uncertain")
            self.assertEqual((root / "source.json").read_bytes(), b"new")

    def test_rejects_temp_inode_replacement_before_publish(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "state"
            root.mkdir(mode=0o700)
            def replace_temp() -> None:
                temporary = next(root.glob(".*.tmp"))
                temporary.unlink()
                temporary.write_bytes(b"attacker")
                temporary.chmod(0o600)
            backend = PosixStateBackend(
                root, hooks={"before_publish_identity_check": replace_temp},
            )
            with self.assertRaises(PosixBackendError) as ctx:
                backend.atomic_update(
                    "source.json", ".source.lock", 100, lambda _current: (b"new", None),
                )
            self.assertEqual(ctx.exception.code, "unsafe-state")
            self.assertFalse((root / "source.json").exists())

    def test_rejects_state_inode_replacement_during_transaction(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "state"
            PosixStateBackend(root).atomic_update(
                "source.json", ".source.lock", 100, lambda _current: (b"old", None),
            )
            target = root / "source.json"
            def replace_state() -> None:
                target.unlink()
                target.write_bytes(b"concurrent")
                target.chmod(0o600)
            backend = PosixStateBackend(
                root, hooks={"before_publish_identity_check": replace_state},
            )
            with self.assertRaises(PosixBackendError) as ctx:
                backend.atomic_update(
                    "source.json", ".source.lock", 100, lambda _current: (b"new", None),
                )
            self.assertEqual(ctx.exception.code, "unsafe-state")
            self.assertEqual(target.read_bytes(), b"concurrent")

    def test_temp_fsync_failure_preserves_old_state_and_cleans_temp(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "state"
            PosixStateBackend(root).atomic_update(
                "source.json", ".source.lock", 100, lambda _current: (b"old", None),
            )
            def fail() -> None:
                raise OSError("temp fsync failed")
            backend = PosixStateBackend(root, hooks={"before_temp_fsync": fail})
            with self.assertRaises(OSError):
                backend.atomic_update(
                    "source.json", ".source.lock", 100, lambda _current: (b"new", None),
                )
            self.assertEqual(PosixStateBackend(root).read("source.json", 100), b"old")
            self.assertEqual(list(root.glob(".*.tmp")), [])

    def test_replace_failure_preserves_old_state_and_cleans_temp(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "state"
            PosixStateBackend(root).atomic_update(
                "source.json", ".source.lock", 100, lambda _current: (b"old", None),
            )
            def fail() -> None:
                raise OSError("replace failed")
            backend = PosixStateBackend(root, hooks={"before_replace": fail})
            with self.assertRaises(OSError):
                backend.atomic_update(
                    "source.json", ".source.lock", 100, lambda _current: (b"new", None),
                )
            self.assertEqual(PosixStateBackend(root).read("source.json", 100), b"old")
            self.assertEqual(list(root.glob(".*.tmp")), [])

    def test_directory_fsync_failure_is_durability_uncertain_after_replace(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "state"
            PosixStateBackend(root).atomic_update(
                "source.json", ".source.lock", 100, lambda _current: (b"old", None),
            )
            def fail() -> None:
                raise OSError("directory fsync failed")
            backend = PosixStateBackend(root, hooks={"before_directory_fsync": fail})
            with self.assertRaises(PosixBackendError) as ctx:
                backend.atomic_update(
                    "source.json", ".source.lock", 100, lambda _current: (b"new", None),
                )
            self.assertEqual(ctx.exception.code, "state-durability-uncertain")
            self.assertEqual(PosixStateBackend(root).read("source.json", 100), b"new")

    def test_root_replacement_before_publish_cannot_escape_pinned_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            base = Path(temp_dir)
            root = base / "state"
            root.mkdir(mode=0o700)
            detached = base / "detached"
            outside = base / "outside"
            outside.mkdir(mode=0o700)
            def replace_root() -> None:
                root.rename(detached)
                root.symlink_to(outside, target_is_directory=True)
            backend = PosixStateBackend(root, hooks={"before_publish_identity_check": replace_root})
            with self.assertRaises(PosixBackendError) as ctx:
                backend.atomic_update(
                    "source.json", ".source.lock", 100, lambda _current: (b"new", None),
                )
            self.assertEqual(ctx.exception.code, "unsafe-state")
            self.assertFalse((outside / "source.json").exists())
            self.assertEqual(list(detached.glob(".*.tmp")), [])

    def test_root_replacement_after_publish_is_durability_uncertain_and_contained(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            base = Path(temp_dir)
            root = base / "state"
            root.mkdir(mode=0o700)
            detached = base / "detached"
            outside = base / "outside"
            outside.mkdir(mode=0o700)
            def replace_root() -> None:
                root.rename(detached)
                root.symlink_to(outside, target_is_directory=True)
            backend = PosixStateBackend(root, hooks={"after_replace": replace_root})
            with self.assertRaises(PosixBackendError) as ctx:
                backend.atomic_update(
                    "source.json", ".source.lock", 100, lambda _current: (b"new", None),
                )
            self.assertEqual(ctx.exception.code, "state-durability-uncertain")
            self.assertFalse((outside / "source.json").exists())
            self.assertEqual((detached / "source.json").read_bytes(), b"new")

    def test_ancestor_symlink_substitution_before_publish_is_unsafe_and_contained(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            base = Path(temp_dir)
            ancestor = base / "ancestor"
            root = ancestor / "parent" / "state"
            root.mkdir(parents=True, mode=0o700)
            root.parent.chmod(0o700)
            detached = base / "detached"
            outside = base / "outside"
            outside_root = outside / "parent" / "state"
            outside_root.mkdir(parents=True, mode=0o700)
            outside_root.parent.chmod(0o700)
            def replace_ancestor() -> None:
                ancestor.rename(detached)
                ancestor.symlink_to(outside, target_is_directory=True)
            backend = PosixStateBackend(
                root, hooks={"before_publish_identity_check": replace_ancestor},
            )
            with self.assertRaises(PosixBackendError) as ctx:
                backend.atomic_update(
                    "source.json", ".source.lock", 100, lambda _current: (b"new", None),
                )
            self.assertEqual(ctx.exception.code, "unsafe-state")
            self.assertFalse((outside_root / "source.json").exists())
            self.assertFalse((detached / "parent" / "state" / "source.json").exists())

    def test_ancestor_symlink_substitution_after_publish_is_uncertain_and_contained(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            base = Path(temp_dir)
            ancestor = base / "ancestor"
            root = ancestor / "parent" / "state"
            root.mkdir(parents=True, mode=0o700)
            root.parent.chmod(0o700)
            detached = base / "detached"
            outside = base / "outside"
            outside_root = outside / "parent" / "state"
            outside_root.mkdir(parents=True, mode=0o700)
            outside_root.parent.chmod(0o700)
            def replace_ancestor() -> None:
                ancestor.rename(detached)
                ancestor.symlink_to(outside, target_is_directory=True)
            backend = PosixStateBackend(root, hooks={"after_replace": replace_ancestor})
            with self.assertRaises(PosixBackendError) as ctx:
                backend.atomic_update(
                    "source.json", ".source.lock", 100, lambda _current: (b"new", None),
                )
            self.assertEqual(ctx.exception.code, "state-durability-uncertain")
            self.assertFalse((outside_root / "source.json").exists())
            self.assertEqual(
                (detached / "parent" / "state" / "source.json").read_bytes(), b"new",
            )

    def test_ancestor_directory_replacement_before_publish_is_unsafe_and_contained(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            base = Path(temp_dir)
            ancestor = base / "ancestor"
            root = ancestor / "parent" / "state"
            root.mkdir(parents=True, mode=0o700)
            root.parent.chmod(0o700)
            detached = base / "detached"
            replacement_root = ancestor / "parent" / "state"
            def replace_ancestor() -> None:
                ancestor.rename(detached)
                replacement_root.mkdir(parents=True, mode=0o700)
                replacement_root.parent.chmod(0o700)
            backend = PosixStateBackend(
                root, hooks={"before_publish_identity_check": replace_ancestor},
            )
            with self.assertRaises(PosixBackendError) as ctx:
                backend.atomic_update(
                    "source.json", ".source.lock", 100, lambda _current: (b"new", None),
                )
            self.assertEqual(ctx.exception.code, "unsafe-state")
            self.assertFalse((replacement_root / "source.json").exists())
            self.assertFalse((detached / "parent" / "state" / "source.json").exists())

    def test_ancestor_directory_replacement_after_publish_is_uncertain_and_contained(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            base = Path(temp_dir)
            ancestor = base / "ancestor"
            root = ancestor / "parent" / "state"
            root.mkdir(parents=True, mode=0o700)
            root.parent.chmod(0o700)
            detached = base / "detached"
            replacement_root = ancestor / "parent" / "state"
            def replace_ancestor() -> None:
                ancestor.rename(detached)
                replacement_root.mkdir(parents=True, mode=0o700)
                replacement_root.parent.chmod(0o700)
            backend = PosixStateBackend(root, hooks={"after_replace": replace_ancestor})
            with self.assertRaises(PosixBackendError) as ctx:
                backend.atomic_update(
                    "source.json", ".source.lock", 100, lambda _current: (b"new", None),
                )
            self.assertEqual(ctx.exception.code, "state-durability-uncertain")
            self.assertFalse((replacement_root / "source.json").exists())
            self.assertEqual(
                (detached / "parent" / "state" / "source.json").read_bytes(), b"new",
            )

    def test_root_mode_change_before_publish_aborts_without_target_change(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "state"
            PosixStateBackend(root).atomic_update(
                "source.json", ".source.lock", 100, lambda _current: (b"old", None),
            )
            backend = PosixStateBackend(
                root, hooks={"before_publish_identity_check": lambda: root.chmod(0o777)},
            )
            with self.assertRaises(PosixBackendError) as ctx:
                backend.atomic_update(
                    "source.json", ".source.lock", 100, lambda _current: (b"new", None),
                )
            self.assertEqual(ctx.exception.code, "unsafe-state")
            self.assertEqual((root / "source.json").read_bytes(), b"old")

    def test_ancestor_mode_change_before_publish_aborts_without_target_change(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            ancestor = Path(temp_dir) / "private"
            ancestor.mkdir(mode=0o700)
            root = ancestor / "state"
            PosixStateBackend(root).atomic_update(
                "source.json", ".source.lock", 100, lambda _current: (b"old", None),
            )
            backend = PosixStateBackend(
                root, hooks={"before_publish_identity_check": lambda: ancestor.chmod(0o777)},
            )
            with self.assertRaises(PosixBackendError) as ctx:
                backend.atomic_update(
                    "source.json", ".source.lock", 100, lambda _current: (b"new", None),
                )
            self.assertEqual(ctx.exception.code, "unsafe-state")
            self.assertEqual((root / "source.json").read_bytes(), b"old")

    def test_root_mode_change_after_replace_is_durability_uncertain(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "state"
            root.mkdir(mode=0o700)
            backend = PosixStateBackend(root, hooks={"after_replace": lambda: root.chmod(0o777)})
            with self.assertRaises(PosixBackendError) as ctx:
                backend.atomic_update(
                    "source.json", ".source.lock", 100, lambda _current: (b"new", None),
                )
            self.assertEqual(ctx.exception.code, "state-durability-uncertain")
            self.assertEqual((root / "source.json").read_bytes(), b"new")

    def test_direct_parent_sibling_creation_after_replace_is_accepted(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            ancestor = Path(temp_dir) / "private"
            ancestor.mkdir(mode=0o700)
            root = ancestor / "state"
            root.mkdir(mode=0o700)
            def create_sibling() -> None:
                (ancestor / "new-directory").mkdir(mode=0o700)
            backend = PosixStateBackend(root, hooks={"after_replace": create_sibling})
            backend.atomic_update(
                "source.json", ".source.lock", 100, lambda _current: (b"new", None),
            )
            self.assertEqual((root / "source.json").read_bytes(), b"new")

    def test_ancestor_mode_change_after_replace_is_durability_uncertain(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            ancestor = Path(temp_dir) / "private"
            ancestor.mkdir(mode=0o700)
            root = ancestor / "state"
            root.mkdir(mode=0o700)
            backend = PosixStateBackend(
                root, hooks={"after_replace": lambda: ancestor.chmod(0o777)},
            )
            with self.assertRaises(PosixBackendError) as ctx:
                backend.atomic_update(
                    "source.json", ".source.lock", 100, lambda _current: (b"new", None),
                )
            self.assertEqual(ctx.exception.code, "state-durability-uncertain")
            self.assertEqual((root / "source.json").read_bytes(), b"new")


if __name__ == "__main__":
    unittest.main()
