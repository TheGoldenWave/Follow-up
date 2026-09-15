"""Adversarial tests for the POSIX directory-fd state backend."""

from __future__ import annotations

import os
from pathlib import Path
import tempfile
import unittest

from follow_up_acquisition.state_store_posix import (
    PosixBackendError,
    PosixStateBackend,
    posix_backend_available,
)


class PosixBackendTests(unittest.TestCase):
    def test_backend_probe_rejects_non_posix_without_fallback(self) -> None:
        self.assertTrue(posix_backend_available("posix"))
        self.assertFalse(posix_backend_available("nt"))
        with tempfile.TemporaryDirectory() as temp_dir, self.assertRaises(PosixBackendError) as ctx:
            PosixStateBackend(Path(temp_dir), platform_name="nt").read("source.json", 100)
        self.assertEqual(ctx.exception.code, "unsupported-platform")

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


if __name__ == "__main__":
    unittest.main()
