#!/usr/bin/env python3
"""Fail-closed validation for the one test-host preflight report sudo rule."""

from __future__ import annotations

import hashlib
import hmac
import os
import re
import stat
import subprocess
import sys
from pathlib import PurePosixPath

SUDO_BINARY = "/usr/bin/sudo"
REPORT_PATH = "/usr/local/sbin/plane-game-preflight-report"
# Replace only with the independent target digest reviewed with this package.
REPORT_SHA256 = "4951207e5609d1feee257774c4c671ce80d1c1adeee0199b58387bb98d6e68c3"
EXPECTED_COMMAND = f'(root) NOPASSWD: {REPORT_PATH} ""'
EXPECTED_USER = "plane-preflight"
_HOST_RE = r"([A-Za-z0-9][A-Za-z0-9_.-]*)"


class PolicyError(RuntimeError):
    pass


def _decode_exact(data: bytes, stream: str) -> str:
    try:
        text = data.decode("utf-8", errors="strict")
    except UnicodeDecodeError as error:
        raise PolicyError(f"sudo {stream} is not strict UTF-8") from error
    if "\r" in text or "\x00" in text:
        raise PolicyError(f"sudo {stream} contains unsupported control data")
    if any(ord(character) < 32 and character not in "\n\t" for character in text):
        raise PolicyError(f"sudo {stream} contains unsupported control data")
    return text


def parse_sudo_listing(stdout: bytes, stderr: bytes, *, user: str = EXPECTED_USER) -> None:
    """Accept only sudo's C-locale listing of the one no-argument report rule."""
    if stderr:
        _decode_exact(stderr, "stderr")
        raise PolicyError("sudo produced unexpected stderr")
    text = _decode_exact(stdout, "stdout")
    if not text.endswith("\n"):
        raise PolicyError("sudo listing is not newline terminated")
    lines = text.splitlines()
    if not lines:
        raise PolicyError("sudo listing is empty")
    defaults = re.fullmatch(
        rf"Matching Defaults entries for {re.escape(user)} on {_HOST_RE}:", lines[0]
    )
    if defaults is None:
        raise PolicyError("sudo Defaults header is unparseable or not in the C locale")
    host = defaults.group(1)
    command_header = f"User {user} may run the following commands on {host}:"
    indexes = [index for index, line in enumerate(lines) if line == command_header]
    if len(indexes) != 1 or indexes[0] < 1:
        raise PolicyError("sudo command header is missing, repeated, or out of order")
    header_index = indexes[0]
    if any(line and not line[0].isspace() for line in lines[1:header_index]):
        raise PolicyError("sudo Defaults section contains unparseable output")
    commands = [line.strip() for line in lines[header_index + 1 :] if line.strip()]
    if commands != [EXPECTED_COMMAND]:
        raise PolicyError("effective sudo commands are not the one no-argument report rule")


def _permission_bits(metadata: os.stat_result) -> int:
    return stat.S_IMODE(metadata.st_mode)


def _verify_component(metadata: os.stat_result, display_path: str, expected_uid: int) -> None:
    if metadata.st_uid != expected_uid:
        raise PolicyError(f"{display_path} is not owned by the trusted uid")
    if _permission_bits(metadata) & 0o022:
        raise PolicyError(f"{display_path} is group/other writable")


def _snapshot(metadata: os.stat_result) -> tuple[int, ...]:
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_mode,
        metadata.st_uid,
        metadata.st_gid,
        metadata.st_nlink,
        metadata.st_size,
        metadata.st_mtime_ns,
        metadata.st_ctime_ns,
    )


def validate_report_target(
    expected_digest: str = REPORT_SHA256,
    *,
    logical_path: str = REPORT_PATH,
    anchor: str = "/",
    expected_uid: int = 0,
) -> None:
    """Open every component without following links and hash the opened file."""
    if re.fullmatch(r"[0-9a-f]{64}", expected_digest) is None:
        raise PolicyError("reviewed report SHA-256 is not pinned")
    logical = PurePosixPath(logical_path)
    if not logical.is_absolute() or ".." in logical.parts:
        raise PolicyError("report path is not canonical")
    anchor_real = os.path.realpath(anchor)
    if anchor_real != os.path.abspath(anchor):
        raise PolicyError("path-validation anchor is not canonical")
    actual_path = os.path.join(anchor_real, *logical.parts[1:])
    if os.path.realpath(actual_path) != actual_path:
        raise PolicyError("report path contains a symlink or is not canonical")

    directory_flags = os.O_RDONLY | os.O_CLOEXEC | os.O_DIRECTORY | os.O_NOFOLLOW
    file_flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW
    descriptor = os.open(anchor_real, directory_flags)
    display_path = "/"
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISDIR(metadata.st_mode):
            raise PolicyError("path-validation anchor is not a directory")
        _verify_component(metadata, display_path, expected_uid)
        for component in logical.parts[1:-1]:
            next_descriptor = os.open(component, directory_flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = next_descriptor
            display_path = str(PurePosixPath(display_path) / component)
            metadata = os.fstat(descriptor)
            if not stat.S_ISDIR(metadata.st_mode):
                raise PolicyError(f"{display_path} is not a directory")
            _verify_component(metadata, display_path, expected_uid)

        target_descriptor = os.open(logical.name, file_flags, dir_fd=descriptor)
        try:
            before = os.fstat(target_descriptor)
            _verify_component(before, logical_path, expected_uid)
            if not stat.S_ISREG(before.st_mode):
                raise PolicyError("report target is not a regular file")
            if _permission_bits(before) != 0o755:
                raise PolicyError("report target mode is not exactly 0755")
            digest = hashlib.sha256()
            while chunk := os.read(target_descriptor, 128 * 1024):
                digest.update(chunk)
            if _snapshot(before) != _snapshot(os.fstat(target_descriptor)):
                raise PolicyError("report target changed while it was validated")
            if not hmac.compare_digest(digest.hexdigest(), expected_digest):
                raise PolicyError("report target SHA-256 does not match the reviewed identity")
        finally:
            os.close(target_descriptor)
    except OSError as error:
        raise PolicyError(f"cannot safely open report path: {error.strerror}") from error
    finally:
        os.close(descriptor)


def validate_sudo_binary(path: str = SUDO_BINARY) -> None:
    if path != SUDO_BINARY or os.path.realpath(path) != SUDO_BINARY:
        raise PolicyError("trusted sudo binary is missing or not canonical")
    metadata = os.lstat(path)
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0:
        raise PolicyError("trusted sudo binary is not a root-owned regular file")
    if _permission_bits(metadata) != 0o4755:
        raise PolicyError("trusted sudo binary mode is not exactly 4755")


def read_sudo_listing() -> subprocess.CompletedProcess[bytes]:
    validate_sudo_binary()
    environment = os.environ.copy()
    environment["LC_ALL"] = "C"
    return subprocess.run(
        [SUDO_BINARY, "-n", "-l"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=environment,
        check=False,
        timeout=10,
    )


def main() -> int:
    try:
        validate_report_target()
        result = read_sudo_listing()
        if result.returncode != 0:
            raise PolicyError("absolute sudo privilege listing failed")
        parse_sudo_listing(result.stdout, result.stderr)
    except (OSError, subprocess.SubprocessError, PolicyError) as error:
        print(f"plane-preflight: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
