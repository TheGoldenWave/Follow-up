"""Race-resistant POSIX storage using pinned directory descriptors."""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
import errno
import os
from pathlib import Path
import platform
import secrets
import stat
from typing import Any, Callable, Iterator, Mapping

_INIT_LOCK_NAME = ".source-state.init.lock"


class PosixBackendError(OSError):
    """Stable low-level state backend failure."""

    code = "unsafe-state"

    def __init__(self, message: str, *, code: str | None = None) -> None:
        super().__init__(message)
        if code is not None:
            self.code = code


class _RootMissing(Exception):
    pass


@dataclass(frozen=True)
class _PinnedDirectory:
    directory_fd: int
    parent_fd: int
    name: str
    device: int
    inode: int
    mode: int
    require_private: bool


@dataclass(frozen=True)
class _InitGuard:
    parent_fd: int
    lock_fd: int
    identity: tuple[int, int]


def posix_backend_available(platform_name: str | None = None) -> bool:
    """Return whether the secure persistent-state backend is available."""
    selected = os.name if platform_name is None else platform_name
    required = ("O_DIRECTORY", "O_NOFOLLOW", "O_EXCL")
    if selected != "posix" or not all(hasattr(os, name) for name in required):
        return False
    try:
        import fcntl  # noqa: F401
    except ImportError:
        return False
    return True


def _normalize_system_alias(absolute: str, *, system_name: str | None = None) -> str:
    """Resolve only the verified Darwin /tmp and /var compatibility aliases."""
    if (platform.system() if system_name is None else system_name) != "Darwin":
        return absolute
    for alias in ("/tmp", "/var"):
        if absolute != alias and not absolute.startswith(alias + "/"):
            continue
        try:
            info = os.lstat(alias)
            target = os.readlink(alias)
        except OSError:
            return absolute
        expected = "/private" + alias
        resolved = os.path.abspath(os.path.join(os.path.dirname(alias), target))
        if stat.S_ISLNK(info.st_mode) and resolved == expected:
            return expected + absolute[len(alias):]
        return absolute
    return absolute


class PosixStateBackend:
    """Pin a directory chain and perform every transaction relative to its fd."""

    def __init__(
        self, root: str | os.PathLike[str], *, platform_name: str | None = None,
        system_name: str | None = None,
        hooks: Mapping[str, Callable[[], None]] | None = None,
    ) -> None:
        if not posix_backend_available(platform_name):
            raise PosixBackendError(
                "persistent source state requires the POSIX secure backend",
                code="unsupported-platform",
            )
        absolute = os.path.abspath(os.fspath(root))
        absolute = _normalize_system_alias(absolute, system_name=system_name)
        self.root = Path(absolute)
        self._hooks = dict(hooks or {})

    def _hook(self, name: str) -> None:
        callback = self._hooks.get(name)
        if callback is not None:
            callback()

    @staticmethod
    def _validate_name(name: str) -> None:
        if (
            not isinstance(name, str) or not name or name in {".", ".."}
            or "/" in name or "\x00" in name
        ):
            raise PosixBackendError("state backend received an unsafe basename")

    @staticmethod
    def _identity(info: os.stat_result) -> tuple[int, int]:
        return info.st_dev, info.st_ino

    @contextmanager
    def _pinned_root(
        self, *, create: bool,
    ) -> Iterator[tuple[int, list[_PinnedDirectory], _InitGuard]]:
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
        descriptors: list[int] = []
        links: list[_PinnedDirectory] = []
        init_fd: int | None = None
        init_locked = False
        try:
            parent_fd = os.open(self.root.anchor, flags)
            descriptors.append(parent_fd)
            parts = self.root.parent.parts[1:]
            for index, part in enumerate(parts):
                try:
                    child_fd = os.open(part, flags, dir_fd=parent_fd)
                except FileNotFoundError as exc:
                    raise PosixBackendError(
                        "state parent is missing; acquisition setup is required",
                        code="state-parent-missing",
                    ) from exc
                except OSError as exc:
                    raise PosixBackendError("state directory chain is unsafe") from exc
                descriptors.append(child_fd)
                info = os.fstat(child_fd)
                if not stat.S_ISDIR(info.st_mode):
                    raise PosixBackendError("state directory chain contains a non-directory")
                links.append(_PinnedDirectory(
                    directory_fd=child_fd,
                    parent_fd=parent_fd,
                    name=part,
                    device=info.st_dev,
                    inode=info.st_ino,
                    mode=stat.S_IMODE(info.st_mode),
                    require_private=index == len(parts) - 1,
                ))
                parent_fd = child_fd
            if not links or stat.S_IMODE(os.fstat(parent_fd).st_mode) & 0o077:
                raise PosixBackendError("state parent permissions exceed 0700")

            init_fd = self._open_lock(parent_fd, _INIT_LOCK_NAME)
            init_info = os.fstat(init_fd)
            self._validate_regular(init_info, "state initialization lock")
            init_identity = self._identity(init_info)
            import fcntl
            fcntl.flock(init_fd, fcntl.LOCK_EX)
            init_locked = True
            self._verify_chain(links)
            self._verify_named_identity(
                parent_fd, _INIT_LOCK_NAME, init_identity, "state initialization lock",
            )
            try:
                os.fchmod(init_fd, 0o600)
                os.fsync(init_fd)
                os.fsync(parent_fd)
            except OSError as exc:
                raise PosixBackendError(
                    "state initialization lock durability could not be confirmed",
                    code="state-durability-uncertain",
                ) from exc

            leaf = self.root.name
            created = False
            try:
                root_fd = os.open(leaf, flags, dir_fd=parent_fd)
            except FileNotFoundError:
                if not create:
                    raise _RootMissing
                os.mkdir(leaf, 0o700, dir_fd=parent_fd)
                root_fd = os.open(leaf, flags, dir_fd=parent_fd)
                created = True
            except OSError as exc:
                raise PosixBackendError("state root is unsafe") from exc
            descriptors.append(root_fd)
            root_info = os.fstat(root_fd)
            if not stat.S_ISDIR(root_info.st_mode) or stat.S_IMODE(root_info.st_mode) & 0o077:
                raise PosixBackendError("state root must be a private directory")
            if created:
                self._verify_chain(links)
            links.append(_PinnedDirectory(
                directory_fd=root_fd,
                parent_fd=parent_fd,
                name=leaf,
                device=root_info.st_dev,
                inode=root_info.st_ino,
                mode=stat.S_IMODE(root_info.st_mode),
                require_private=True,
            ))
            if created:
                try:
                    self._hook("before_parent_directory_fsync")
                    os.fsync(parent_fd)
                except OSError as exc:
                    raise PosixBackendError(
                        "new state directory durability could not be confirmed",
                        code="state-durability-uncertain",
                    ) from exc
                self._hook("after_directory_created")
            self._verify_chain(links)
            self._verify_named_identity(
                parent_fd, _INIT_LOCK_NAME, init_identity, "state initialization lock",
            )
            yield root_fd, links, _InitGuard(parent_fd, init_fd, init_identity)
        finally:
            if init_fd is not None:
                if init_locked:
                    try:
                        import fcntl
                        fcntl.flock(init_fd, fcntl.LOCK_UN)
                    except OSError:
                        pass
                try:
                    os.close(init_fd)
                except OSError:
                    pass
            for descriptor in reversed(descriptors):
                try:
                    os.close(descriptor)
                except OSError:
                    pass

    @staticmethod
    def _verify_chain(links: list[_PinnedDirectory]) -> None:
        for trusted in links:
            try:
                pinned = os.fstat(trusted.directory_fd)
                named = os.stat(
                    trusted.name, dir_fd=trusted.parent_fd, follow_symlinks=False,
                )
            except OSError as exc:
                raise PosixBackendError("state directory identity changed") from exc
            pinned_mode = stat.S_IMODE(pinned.st_mode)
            named_mode = stat.S_IMODE(named.st_mode)
            if (
                not stat.S_ISDIR(pinned.st_mode)
                or not stat.S_ISDIR(named.st_mode)
                or (pinned.st_dev, pinned.st_ino) != (trusted.device, trusted.inode)
                or (named.st_dev, named.st_ino) != (pinned.st_dev, pinned.st_ino)
                or pinned_mode != trusted.mode
                or named_mode != trusted.mode
                or pinned.st_nlink <= 0
                or named.st_nlink <= 0
                or (trusted.require_private and named_mode & 0o077)
            ):
                raise PosixBackendError("state directory identity changed")

    @staticmethod
    def _validate_regular(info: os.stat_result, label: str) -> None:
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise PosixBackendError(f"{label} must be a single-link regular file")
        if stat.S_IMODE(info.st_mode) & 0o077:
            raise PosixBackendError(f"{label} permissions exceed 0600")

    @classmethod
    def _verify_named_identity(
        cls, root_fd: int, name: str, expected: tuple[int, int], label: str,
    ) -> None:
        try:
            info = os.stat(name, dir_fd=root_fd, follow_symlinks=False)
        except OSError as exc:
            raise PosixBackendError(f"{label} identity changed") from exc
        cls._validate_regular(info, label)
        if cls._identity(info) != expected:
            raise PosixBackendError(f"{label} identity changed")

    def _verify_init_guard(self, guard: _InitGuard) -> None:
        info = os.fstat(guard.lock_fd)
        self._validate_regular(info, "state initialization lock")
        if self._identity(info) != guard.identity:
            raise PosixBackendError("state initialization lock identity changed")
        self._verify_named_identity(
            guard.parent_fd,
            _INIT_LOCK_NAME,
            guard.identity,
            "state initialization lock",
        )

    def _open_relative(self, root_fd: int, name: str, flags: int, mode: int = 0o600) -> int:
        try:
            return os.open(
                name, flags | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0), mode,
                dir_fd=root_fd,
            )
        except OSError as exc:
            if exc.errno in {errno.ELOOP, errno.ENOTDIR}:
                raise PosixBackendError("state path contains a symlink") from exc
            raise

    def _read_relative(
        self, root_fd: int, name: str, max_bytes: int,
    ) -> tuple[bytes | None, tuple[int, int] | None]:
        try:
            descriptor = self._open_relative(root_fd, name, os.O_RDONLY)
        except FileNotFoundError:
            return None, None
        try:
            info = os.fstat(descriptor)
            self._validate_regular(info, "state file")
            identity = self._identity(info)
            chunks: list[bytes] = []
            remaining = max_bytes + 1
            while remaining:
                chunk = os.read(descriptor, min(remaining, 64 * 1024))
                if not chunk:
                    break
                chunks.append(chunk)
                remaining -= len(chunk)
            payload = b"".join(chunks)
            if len(payload) > max_bytes:
                raise PosixBackendError("state file exceeds its maximum size", code="invalid-state")
            self._verify_named_identity(root_fd, name, identity, "state file")
            return payload, identity
        finally:
            os.close(descriptor)

    @staticmethod
    def _verify_absent(root_fd: int, name: str, label: str) -> None:
        try:
            os.stat(name, dir_fd=root_fd, follow_symlinks=False)
        except FileNotFoundError:
            return
        except OSError as exc:
            raise PosixBackendError(f"{label} identity changed") from exc
        raise PosixBackendError(f"{label} identity changed")

    def _open_lock(self, root_fd: int, name: str) -> int:
        # On Darwin, simultaneous O_CREAT|O_NOFOLLOW opens can make one caller
        # observe ENOENT. Elect a creator with O_EXCL, then open the winner.
        for _attempt in range(100):
            try:
                return self._open_relative(
                    root_fd, name, os.O_RDWR | os.O_CREAT | os.O_EXCL,
                )
            except FileExistsError:
                try:
                    return self._open_relative(root_fd, name, os.O_RDWR)
                except FileNotFoundError:
                    continue
        raise PosixBackendError("state lock identity did not stabilize")

    def read(self, name: str, max_bytes: int) -> bytes | None:
        """Read a private regular file without following any directory symlink."""
        self._validate_name(name)
        try:
            with self._pinned_root(create=False) as (root_fd, links, init_guard):
                self._verify_chain(links)
                self._verify_init_guard(init_guard)
                payload, _identity = self._read_relative(root_fd, name, max_bytes)
                self._verify_chain(links)
                self._verify_init_guard(init_guard)
                return payload
        except _RootMissing:
            return None

    def atomic_update(
        self, name: str, lock_name: str, max_bytes: int,
        transform: Callable[[bytes | None], tuple[bytes, Any]],
    ) -> Any:
        """Serialize a read-transform-replace transaction under a per-source lock."""
        self._validate_name(name)
        self._validate_name(lock_name)
        import fcntl

        with self._pinned_root(create=True) as (root_fd, links, init_guard):
            self._verify_chain(links)
            lock_fd = self._open_lock(root_fd, lock_name)
            locked = False
            temp_name: str | None = None
            published = False
            try:
                lock_info = os.fstat(lock_fd)
                self._validate_regular(lock_info, "state lock")
                lock_identity = self._identity(lock_info)
                self._verify_chain(links)
                self._hook("after_lock_open")
                self._verify_named_identity(root_fd, lock_name, lock_identity, "state lock")
                os.fchmod(lock_fd, 0o600)
                fcntl.flock(lock_fd, fcntl.LOCK_EX)
                locked = True
                self._verify_named_identity(root_fd, lock_name, lock_identity, "state lock")
                self._verify_chain(links)
                current, current_identity = self._read_relative(root_fd, name, max_bytes)
                payload, result = transform(current)
                if not isinstance(payload, bytes) or len(payload) > max_bytes:
                    raise PosixBackendError("replacement state exceeds its maximum size", code="invalid-state")
                for _attempt in range(100):
                    candidate = f".{name}.{secrets.token_hex(16)}.tmp"
                    try:
                        temp_fd = self._open_relative(
                            root_fd, candidate, os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                        )
                        temp_name = candidate
                        self._verify_chain(links)
                        break
                    except FileExistsError:
                        continue
                else:
                    raise PosixBackendError("could not allocate an exclusive state temp file")
                try:
                    temp_info = os.fstat(temp_fd)
                    self._validate_regular(temp_info, "state temp file")
                    temp_identity = self._identity(temp_info)
                    os.fchmod(temp_fd, 0o600)
                    view = memoryview(payload)
                    while view:
                        written = os.write(temp_fd, view)
                        if written <= 0:
                            raise OSError("short state write")
                        view = view[written:]
                    self._hook("before_temp_fsync")
                    os.fsync(temp_fd)
                finally:
                    os.close(temp_fd)
                self._hook("before_publish_identity_check")
                self._verify_chain(links)
                self._verify_init_guard(init_guard)
                self._verify_named_identity(root_fd, lock_name, lock_identity, "state lock")
                self._verify_named_identity(root_fd, temp_name, temp_identity, "state temp file")
                if current_identity is None:
                    self._verify_absent(root_fd, name, "state file")
                else:
                    self._verify_named_identity(root_fd, name, current_identity, "state file")
                self._hook("before_replace")
                os.replace(temp_name, name, src_dir_fd=root_fd, dst_dir_fd=root_fd)
                temp_name = None
                published = True
                self._verify_chain(links)
                self._hook("after_replace")
                self._hook("before_directory_fsync")
                os.fsync(root_fd)
                self._hook("after_directory_fsync")
                self._verify_chain(links)
                self._verify_init_guard(init_guard)
                self._verify_named_identity(root_fd, lock_name, lock_identity, "state lock")
                self._verify_named_identity(root_fd, name, temp_identity, "state file")
                return result
            except BaseException as exc:
                if published and not (
                    isinstance(exc, PosixBackendError)
                    and exc.code == "state-durability-uncertain"
                ):
                    raise PosixBackendError(
                        "state was replaced but durability could not be confirmed",
                        code="state-durability-uncertain",
                    ) from exc
                raise
            finally:
                if temp_name is not None:
                    try:
                        os.unlink(temp_name, dir_fd=root_fd)
                    except FileNotFoundError:
                        pass
                if locked:
                    try:
                        fcntl.flock(lock_fd, fcntl.LOCK_UN)
                    except OSError:
                        pass
                os.close(lock_fd)
