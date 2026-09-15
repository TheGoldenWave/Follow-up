"""Race-resistant POSIX storage using pinned directory descriptors."""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
import errno
import os
from pathlib import Path
import secrets
import stat
from typing import Any, Callable, Iterator, Mapping


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
    parent_fd: int
    name: str
    device: int
    inode: int
    mode: int
    nlink: int
    require_private: bool


def posix_backend_available(platform_name: str | None = None) -> bool:
    """Return whether the secure persistent-state backend is available."""
    selected = os.name if platform_name is None else platform_name
    required = ("O_DIRECTORY", "O_NOFOLLOW", "O_EXCL")
    return selected == "posix" and all(hasattr(os, name) for name in required)


class PosixStateBackend:
    """Pin a directory chain and perform every transaction relative to its fd."""

    def __init__(
        self, root: str | os.PathLike[str], *, platform_name: str | None = None,
        hooks: Mapping[str, Callable[[], None]] | None = None,
    ) -> None:
        if not posix_backend_available(platform_name):
            raise PosixBackendError(
                "persistent source state requires the POSIX secure backend",
                code="unsupported-platform",
            )
        absolute = os.path.abspath(os.fspath(root))
        if absolute == "/var" or absolute.startswith("/var/"):
            absolute = "/private" + absolute
        elif absolute == "/tmp" or absolute.startswith("/tmp/"):
            absolute = "/private" + absolute
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
    ) -> Iterator[tuple[int, list[_PinnedDirectory]]]:
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
        descriptors: list[int] = []
        links: list[_PinnedDirectory] = []
        try:
            parent_fd = os.open(self.root.anchor, flags)
            descriptors.append(parent_fd)
            parts = self.root.parts[1:]
            for index, part in enumerate(parts):
                created_info: os.stat_result | None = None
                try:
                    child_fd = os.open(part, flags, dir_fd=parent_fd)
                except FileNotFoundError:
                    if not create:
                        raise _RootMissing
                    self._verify_chain(links)
                    try:
                        os.mkdir(part, 0o700, dir_fd=parent_fd)
                    except FileExistsError as exc:
                        raise PosixBackendError(
                            "state directory appeared concurrently during setup",
                        ) from exc
                    self._hook("after_directory_created")
                    self._accept_mkdir_parent_nlink_change(links)
                    created_info = os.stat(part, dir_fd=parent_fd, follow_symlinks=False)
                    child_fd = os.open(part, flags, dir_fd=parent_fd)
                except OSError as exc:
                    raise PosixBackendError("state directory chain is unsafe") from exc
                info = os.fstat(child_fd)
                if not stat.S_ISDIR(info.st_mode):
                    raise PosixBackendError("state directory chain contains a non-directory")
                if created_info is not None and (
                    not stat.S_ISDIR(created_info.st_mode)
                    or self._identity(info) != self._identity(created_info)
                    or stat.S_IMODE(info.st_mode) != stat.S_IMODE(created_info.st_mode)
                    or info.st_nlink != created_info.st_nlink
                ):
                    raise PosixBackendError("created state directory identity changed")
                links.append(_PinnedDirectory(
                    parent_fd=parent_fd,
                    name=part,
                    device=info.st_dev,
                    inode=info.st_ino,
                    mode=stat.S_IMODE(info.st_mode),
                    nlink=info.st_nlink,
                    require_private=index == len(parts) - 1,
                ))
                descriptors.append(child_fd)
                parent_fd = child_fd
            root_fd = descriptors[-1]
            root_info = os.fstat(root_fd)
            if stat.S_IMODE(root_info.st_mode) & 0o077:
                raise PosixBackendError("state root permissions exceed 0700")
            yield root_fd, links
        finally:
            for descriptor in reversed(descriptors):
                try:
                    os.close(descriptor)
                except OSError:
                    pass

    @staticmethod
    def _verify_chain(links: list[_PinnedDirectory]) -> None:
        for trusted in links:
            try:
                info = os.stat(
                    trusted.name, dir_fd=trusted.parent_fd, follow_symlinks=False,
                )
            except OSError as exc:
                raise PosixBackendError("state directory identity changed") from exc
            current_mode = stat.S_IMODE(info.st_mode)
            if (
                not stat.S_ISDIR(info.st_mode)
                or (info.st_dev, info.st_ino) != (trusted.device, trusted.inode)
                or current_mode != trusted.mode
                or (trusted.require_private and info.st_nlink <= 0)
                or (not trusted.require_private and info.st_nlink != trusted.nlink)
                or (trusted.require_private and current_mode & 0o077)
            ):
                raise PosixBackendError("state directory identity changed")

    @staticmethod
    def _accept_mkdir_parent_nlink_change(links: list[_PinnedDirectory]) -> None:
        """Accept only the direct parent's causal +1 nlink from mkdir."""
        if not links:
            return
        refreshed: list[_PinnedDirectory] = []
        direct_parent = links[-1]
        for trusted in links:
            info = os.stat(
                trusted.name, dir_fd=trusted.parent_fd, follow_symlinks=False,
            )
            current_mode = stat.S_IMODE(info.st_mode)
            expected_nlink = trusted.nlink + 1 if trusted is direct_parent else trusted.nlink
            if (
                not stat.S_ISDIR(info.st_mode)
                or (info.st_dev, info.st_ino) != (trusted.device, trusted.inode)
                or current_mode != trusted.mode
                or info.st_nlink != expected_nlink
                or (trusted.require_private and current_mode & 0o077)
            ):
                raise PosixBackendError("state directory identity changed during mkdir")
            refreshed.append(_PinnedDirectory(
                parent_fd=trusted.parent_fd,
                name=trusted.name,
                device=trusted.device,
                inode=trusted.inode,
                mode=trusted.mode,
                nlink=expected_nlink,
                require_private=trusted.require_private,
            ))
        links[:] = refreshed

    @staticmethod
    def _accept_controlled_root_nlink_change(links: list[_PinnedDirectory]) -> None:
        """Account for an entry mutation without trusting other metadata changes."""
        refreshed: list[_PinnedDirectory] = []
        for trusted in links:
            info = os.stat(
                trusted.name, dir_fd=trusted.parent_fd, follow_symlinks=False,
            )
            current_mode = stat.S_IMODE(info.st_mode)
            if (
                not stat.S_ISDIR(info.st_mode)
                or (info.st_dev, info.st_ino) != (trusted.device, trusted.inode)
                or current_mode != trusted.mode
                or (not trusted.require_private and info.st_nlink != trusted.nlink)
                or (trusted.require_private and current_mode & 0o077)
            ):
                raise PosixBackendError("state directory identity changed")
            refreshed.append(_PinnedDirectory(
                parent_fd=trusted.parent_fd,
                name=trusted.name,
                device=trusted.device,
                inode=trusted.inode,
                mode=trusted.mode,
                nlink=trusted.nlink,
                require_private=trusted.require_private,
            ))
        links[:] = refreshed

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
            with self._pinned_root(create=False) as (root_fd, links):
                self._verify_chain(links)
                payload, _identity = self._read_relative(root_fd, name, max_bytes)
                self._verify_chain(links)
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

        with self._pinned_root(create=True) as (root_fd, links):
            self._verify_chain(links)
            lock_fd = self._open_lock(root_fd, lock_name)
            locked = False
            temp_name: str | None = None
            published = False
            try:
                lock_info = os.fstat(lock_fd)
                self._validate_regular(lock_info, "state lock")
                lock_identity = self._identity(lock_info)
                self._accept_controlled_root_nlink_change(links)
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
                        self._accept_controlled_root_nlink_change(links)
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
                self._verify_named_identity(root_fd, temp_name, temp_identity, "state temp file")
                if current_identity is None:
                    self._verify_absent(root_fd, name, "state file")
                else:
                    self._verify_named_identity(root_fd, name, current_identity, "state file")
                self._hook("before_replace")
                os.replace(temp_name, name, src_dir_fd=root_fd, dst_dir_fd=root_fd)
                temp_name = None
                published = True
                self._accept_controlled_root_nlink_change(links)
                self._hook("after_replace")
                self._hook("before_directory_fsync")
                os.fsync(root_fd)
                self._hook("after_directory_fsync")
                self._verify_chain(links)
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
