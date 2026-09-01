#!/usr/bin/env python3
"""Fail-closed, descriptor-relative filesystem capability for IPFS publication.

Node does not expose openat(2) or directory-FD-relative unlink/rename.  This
small, long-lived stdlib helper owns one verified output-root directory FD and
performs every descendant operation through that FD.  Its JSON-lines protocol
intentionally has no absolute-path operation.
"""

from __future__ import annotations

import argparse
import base64
import ctypes
import errno
import json
import os
import platform
import select
import stat
import sys
import time
from typing import Any


MAX_MESSAGE_BYTES = 1024 * 1024
MAX_CHUNK_BYTES = 64 * 1024
MAX_HANDLES = 64
MAX_DIRECTORY_ENTRIES = 65536
RENAME_NOREPLACE_LINUX = 1
RENAME_EXCL_DARWIN = 0x00000004


class RootFsError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def wire_stat(value: os.stat_result) -> dict[str, str]:
    if stat.S_ISREG(value.st_mode):
        kind = "file"
    elif stat.S_ISDIR(value.st_mode):
        kind = "directory"
    elif stat.S_ISLNK(value.st_mode):
        kind = "symlink"
    else:
        kind = "other"
    return {
        "type": kind,
        "dev": str(value.st_dev),
        "ino": str(value.st_ino),
        "size": str(value.st_size),
        "mtimeNs": str(value.st_mtime_ns),
        "ctimeNs": str(value.st_ctime_ns),
    }


def safe_rel(value: Any, *, allow_root: bool = True) -> list[str]:
    if not isinstance(value, str):
        raise RootFsError("EINVAL", "rootfs path must be a string")
    if value == "" and allow_root:
        return []
    if not value or value.startswith("/") or "\\" in value:
        raise RootFsError("EINVAL", "rootfs path is not a safe relative path")
    parts = value.split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise RootFsError("EINVAL", "rootfs path is not a safe relative path")
    return parts


def same_identity(actual: os.stat_result, expected: Any) -> bool:
    if not isinstance(expected, dict):
        return False
    actual_wire = wire_stat(actual)
    keys = ("type", "dev", "ino") if actual_wire["type"] == "directory" else ("type", "dev", "ino", "size", "mtimeNs", "ctimeNs")
    return all(actual_wire[key] == expected.get(key) for key in keys)


class RootFs:
    def __init__(self, root: str, expected_dev: str, expected_ino: str):
        required = (os.open, os.stat, os.mkdir, os.unlink, os.rename, os.rmdir)
        if any(operation not in os.supports_dir_fd for operation in required):
            raise RootFsError("ENOTSUP", "platform lacks required dir_fd filesystem operations")
        if not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "O_DIRECTORY"):
            raise RootFsError("ENOTSUP", "platform lacks O_NOFOLLOW/O_DIRECTORY")
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
        self.root_fd = os.open(root, flags)
        root_stat = os.fstat(self.root_fd)
        if not stat.S_ISDIR(root_stat.st_mode) or str(root_stat.st_dev) != expected_dev or str(root_stat.st_ino) != expected_ino:
            os.close(self.root_fd)
            raise RootFsError("ESTALE", "output root changed before descriptor capability initialization")
        self.handles: dict[int, int] = {}
        self.next_handle = 1
        self.system = platform.system()
        self.libc = ctypes.CDLL(None, use_errno=True)
        if self.system == "Darwin":
            try:
                self.rename_no_replace = self.libc.renameatx_np
            except AttributeError as error:
                self.close()
                raise RootFsError("ENOTSUP", "platform lacks renameatx_np no-clobber activation") from error
            self.rename_no_replace.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
            self.rename_no_replace.restype = ctypes.c_int
        elif self.system == "Linux":
            try:
                self.rename_no_replace = self.libc.renameat2
            except AttributeError as error:
                self.close()
                raise RootFsError("ENOTSUP", "platform lacks renameat2 no-clobber activation") from error
            self.rename_no_replace.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
            self.rename_no_replace.restype = ctypes.c_int
        else:
            self.close()
            raise RootFsError("ENOTSUP", "platform lacks an audited no-clobber rename primitive")

    def close(self) -> None:
        for descriptor in self.handles.values():
            try:
                os.close(descriptor)
            except OSError:
                pass
        self.handles.clear()
        if self.root_fd >= 0:
            os.close(self.root_fd)
            self.root_fd = -1

    def _open_dir(self, parts: list[str]) -> int:
        descriptor = os.dup(self.root_fd)
        try:
            for part in parts:
                next_descriptor = os.open(
                    part,
                    os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0),
                    dir_fd=descriptor,
                )
                os.close(descriptor)
                descriptor = next_descriptor
            return descriptor
        except BaseException:
            os.close(descriptor)
            raise

    def _parent(self, relative: Any) -> tuple[int, str]:
        parts = safe_rel(relative, allow_root=False)
        descriptor = self._open_dir(parts[:-1])
        return descriptor, parts[-1]

    def _handle(self, token: Any) -> int:
        if not isinstance(token, int) or token not in self.handles:
            raise RootFsError("EBADF", "unknown rootfs handle")
        return self.handles[token]

    def _new_handle(self, descriptor: int) -> int:
        if len(self.handles) >= MAX_HANDLES:
            os.close(descriptor)
            raise RootFsError("EMFILE", "rootfs handle limit exceeded")
        token = self.next_handle
        self.next_handle += 1
        self.handles[token] = descriptor
        return token

    def lstat(self, relative: Any) -> dict[str, str]:
        parts = safe_rel(relative)
        if not parts:
            return wire_stat(os.fstat(self.root_fd))
        parent, leaf = self._parent(relative)
        try:
            return wire_stat(os.stat(leaf, dir_fd=parent, follow_symlinks=False))
        finally:
            os.close(parent)

    def readdir(self, relative: Any) -> list[str]:
        descriptor = self._open_dir(safe_rel(relative))
        try:
            entries = [entry.name for entry in os.scandir(descriptor)]
        finally:
            os.close(descriptor)
        if len(entries) > MAX_DIRECTORY_ENTRIES:
            raise RootFsError("E2BIG", "rootfs directory entry limit exceeded")
        return sorted(entries)

    def mkdir(self, relative: Any, mode: Any) -> dict[str, str]:
        if not isinstance(mode, int) or mode < 0 or mode > 0o777:
            raise RootFsError("EINVAL", "rootfs mkdir mode is invalid")
        parent, leaf = self._parent(relative)
        try:
            os.mkdir(leaf, mode, dir_fd=parent)
            return wire_stat(os.stat(leaf, dir_fd=parent, follow_symlinks=False))
        finally:
            os.close(parent)

    def open(self, relative: Any, access: Any, create: Any, exclusive: Any, mode: Any) -> dict[str, Any]:
        if access not in ("read", "write", "readwrite"):
            raise RootFsError("EINVAL", "rootfs open access is invalid")
        if not isinstance(create, bool) or not isinstance(exclusive, bool) or not isinstance(mode, int) or mode < 0 or mode > 0o777:
            raise RootFsError("EINVAL", "rootfs open arguments are invalid")
        parts = safe_rel(relative)
        if not parts:
            if create or exclusive:
                raise RootFsError("EINVAL", "rootfs cannot create the output root")
            descriptor = os.dup(self.root_fd)
        else:
            parent, leaf = self._parent(relative)
            try:
                flags = {
                    "read": os.O_RDONLY,
                    "write": os.O_WRONLY,
                    "readwrite": os.O_RDWR,
                }[access] | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
                if create:
                    flags |= os.O_CREAT
                if exclusive:
                    flags |= os.O_EXCL
                descriptor = os.open(leaf, flags, mode, dir_fd=parent)
            finally:
                os.close(parent)
        try:
            return {"handle": self._new_handle(descriptor), "stat": wire_stat(os.fstat(descriptor))}
        except BaseException:
            os.close(descriptor)
            raise

    def fstat(self, token: Any) -> dict[str, str]:
        return wire_stat(os.fstat(self._handle(token)))

    def read(self, token: Any, maximum: Any, position: Any) -> dict[str, str]:
        if not isinstance(maximum, int) or maximum < 0 or maximum > MAX_CHUNK_BYTES:
            raise RootFsError("EINVAL", "rootfs read length is invalid")
        descriptor = self._handle(token)
        if position is None:
            payload = os.read(descriptor, maximum)
        elif isinstance(position, int) and position >= 0:
            payload = os.pread(descriptor, maximum, position)
        else:
            raise RootFsError("EINVAL", "rootfs read position is invalid")
        return {"data": base64.b64encode(payload).decode("ascii")}

    def write(self, token: Any, encoded: Any, position: Any) -> dict[str, int]:
        if not isinstance(encoded, str):
            raise RootFsError("EINVAL", "rootfs write payload is invalid")
        try:
            payload = base64.b64decode(encoded.encode("ascii"), validate=True)
        except (ValueError, UnicodeError) as error:
            raise RootFsError("EINVAL", "rootfs write payload is not base64") from error
        if len(payload) > MAX_CHUNK_BYTES:
            raise RootFsError("E2BIG", "rootfs write payload exceeds chunk limit")
        descriptor = self._handle(token)
        offset = 0
        while offset < len(payload):
            if position is None:
                written = os.write(descriptor, payload[offset:])
            elif isinstance(position, int) and position >= 0:
                written = os.pwrite(descriptor, payload[offset:], position + offset)
            else:
                raise RootFsError("EINVAL", "rootfs write position is invalid")
            if written <= 0:
                raise RootFsError("EIO", "rootfs write made no progress")
            offset += written
        return {"written": offset}

    def fsync(self, token: Any) -> dict[str, bool]:
        os.fsync(self._handle(token))
        return {"synced": True}

    def close_handle(self, token: Any) -> dict[str, bool]:
        descriptor = self._handle(token)
        del self.handles[token]
        os.close(descriptor)
        return {"closed": True}

    def fsync_dir(self, relative: Any) -> dict[str, bool]:
        descriptor = self._open_dir(safe_rel(relative))
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        return {"synced": True}

    def rename_noreplace(self, source: Any, destination: Any) -> dict[str, bool]:
        source_parent, source_leaf = self._parent(source)
        destination_parent, destination_leaf = self._parent(destination)
        try:
            flags = RENAME_EXCL_DARWIN if self.system == "Darwin" else RENAME_NOREPLACE_LINUX
            result = self.rename_no_replace(
                source_parent, source_leaf.encode("utf-8"), destination_parent, destination_leaf.encode("utf-8"), flags,
            )
            if result != 0:
                code = errno.errorcode.get(ctypes.get_errno(), "EIO")
                raise RootFsError(code, "rootfs no-clobber rename failed")
        finally:
            os.close(source_parent)
            os.close(destination_parent)
        return {"renamed": True}

    def statfs(self) -> dict[str, str]:
        value = os.fstatvfs(self.root_fd)
        return {
            "bsize": str(value.f_bsize),
            "frsize": str(value.f_frsize),
            "blocks": str(value.f_blocks),
            "bavail": str(value.f_bavail),
        }


def response(identifier: Any, *, result: dict[str, Any] | list[str] | None = None, error: BaseException | None = None) -> None:
    if error is None:
        payload: dict[str, Any] = {"id": identifier, "ok": True, "result": result}
    elif isinstance(error, RootFsError):
        payload = {"id": identifier, "ok": False, "code": error.code, "message": str(error)}
    elif isinstance(error, OSError):
        payload = {
            "id": identifier,
            "ok": False,
            "code": errno.errorcode.get(error.errno or 0, "EIO"),
            "message": error.strerror or str(error),
        }
    else:
        payload = {"id": identifier, "ok": False, "code": "EIO", "message": str(error)}
    encoded = json.dumps(payload, separators=(",", ":"), ensure_ascii=True).encode("utf-8") + b"\n"
    if len(encoded) > MAX_MESSAGE_BYTES:
        encoded = b'{"id":null,"ok":false,"code":"E2BIG","message":"rootfs response exceeds limit"}\n'
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def main() -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--root", required=True)
    parser.add_argument("--dev", required=True)
    parser.add_argument("--ino", required=True)
    parser.add_argument("--parent-pid", required=True, type=int)
    args = parser.parse_args()
    try:
        rootfs = RootFs(args.root, args.dev, args.ino)
    except BaseException as error:
        response(None, error=error)
        return 1
    response(None, result={"ready": True, "root": wire_stat(os.fstat(rootfs.root_fd))})
    last_activity = time.monotonic()
    operations = {
        "lstat": lambda request: rootfs.lstat(request["path"]),
        "readdir": lambda request: rootfs.readdir(request["path"]),
        "mkdir": lambda request: rootfs.mkdir(request["path"], request["mode"]),
        "open": lambda request: rootfs.open(request["path"], request["access"], request["create"], request["exclusive"], request["mode"]),
        "fstat": lambda request: rootfs.fstat(request["handle"]),
        "read": lambda request: rootfs.read(request["handle"], request["maximum"], request["position"]),
        "write": lambda request: rootfs.write(request["handle"], request["data"], request["position"]),
        "fsync": lambda request: rootfs.fsync(request["handle"]),
        "close": lambda request: rootfs.close_handle(request["handle"]),
        "fsync_dir": lambda request: rootfs.fsync_dir(request["path"]),
        "rename_noreplace": lambda request: rootfs.rename_noreplace(request["source"], request["destination"]),
        "statfs": lambda request: rootfs.statfs(),
    }
    try:
        while True:
            ready, _, _ = select.select([sys.stdin.buffer], [], [], 1)
            if not ready:
                try:
                    os.kill(args.parent_pid, 0)
                except OSError:
                    break
                if time.monotonic() - last_activity > 900:
                    break
                continue
            raw = sys.stdin.buffer.readline(MAX_MESSAGE_BYTES + 1)
            if not raw:
                break
            last_activity = time.monotonic()
            if len(raw) > MAX_MESSAGE_BYTES or not raw.endswith(b"\n"):
                response(None, error=RootFsError("E2BIG", "rootfs request exceeds limit"))
                continue
            request = None
            try:
                request = json.loads(raw)
                if not isinstance(request, dict) or not isinstance(request.get("id"), int):
                    raise RootFsError("EINVAL", "rootfs request is invalid")
                identifier = request["id"]
                operation = request.get("op")
                if operation == "shutdown":
                    response(identifier, result={"shutdown": True})
                    break
                if operation not in operations:
                    raise RootFsError("EINVAL", "rootfs operation is invalid")
                response(identifier, result=operations[operation](request))
            except BaseException as error:
                response(request.get("id") if isinstance(request, dict) else None, error=error)
    finally:
        rootfs.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
