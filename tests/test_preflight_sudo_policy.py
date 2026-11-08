from __future__ import annotations

import hashlib
import importlib.util
import os
from pathlib import Path
import shutil
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "preflight_sudo_policy", ROOT / "deploy" / "preflight_sudo_policy.py"
)
assert SPEC is not None and SPEC.loader is not None
policy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(policy)


def listing(*commands: str, defaults_header: str | None = None) -> bytes:
    header = defaults_header or "Matching Defaults entries for plane-preflight on target-host:"
    lines = [
        header,
        "    env_reset, mail_badpass,",
        "    secure_path=/usr/local/sbin\\:/usr/local/bin\\:/usr/sbin\\:/usr/bin",
        "",
        "User plane-preflight may run the following commands on target-host:",
        *(f"    {command}" for command in commands),
    ]
    return ("\n".join(lines) + "\n").encode()


class SudoListingTests(unittest.TestCase):
    def test_exact_root_nopasswd_no_argument_rule_passes(self) -> None:
        policy.parse_sudo_listing(listing(policy.EXPECTED_COMMAND), b"")

    def test_every_broader_or_additional_grant_fails(self) -> None:
        rejected = [
            [policy.EXPECTED_COMMAND, "(root) NOPASSWD: /usr/bin/id"],
            ["(root) NOPASSWD: /usr/local/sbin/plane-game-preflight-report"],
            ["(root) NOPASSWD: /usr/local/sbin/plane-game-preflight-report *"],
            ["(root) NOPASSWD: /usr/local/sbin/plane-game-preflight-report --verbose"],
            ["(root) NOPASSWD: ALL"],
            ["(root) NOPASSWD: /usr/local/sbin/*"],
            ["(root) NOPASSWD: REPORTS"],
            ['(root) NOPASSWD: /usr/local/sbin/plane-game-preflight-report "", /usr/bin/id'],
            ['(root) NOPASSWD: SETENV: /usr/local/sbin/plane-game-preflight-report ""'],
            ['(ALL) NOPASSWD: /usr/local/sbin/plane-game-preflight-report ""'],
            ['(plane-preflight) NOPASSWD: /usr/local/sbin/plane-game-preflight-report ""'],
            ['(root : root) NOPASSWD: /usr/local/sbin/plane-game-preflight-report ""'],
        ]
        for commands in rejected:
            with self.subTest(commands=commands), self.assertRaises(policy.PolicyError):
                policy.parse_sudo_listing(listing(*commands), b"")

    def test_unexpected_locale_stderr_and_unparseable_output_fail(self) -> None:
        cases = [
            (listing(policy.EXPECTED_COMMAND), b"sudo: warning\n"),
            (listing(policy.EXPECTED_COMMAND,
                defaults_header="Entradas predeterminadas para plane-preflight en target-host:"), b""),
            (b"User plane-preflight may run ALL commands\n", b""),
            (listing(policy.EXPECTED_COMMAND).rstrip(b"\n"), b""),
            (listing(policy.EXPECTED_COMMAND).replace(b"\n", b"\r\n"), b""),
            (listing(policy.EXPECTED_COMMAND) + b"unexpected\n", b""),
        ]
        for stdout, stderr in cases:
            with self.subTest(stdout=stdout, stderr=stderr), self.assertRaises(policy.PolicyError):
                policy.parse_sudo_listing(stdout, stderr)


class ReportTargetTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.mkdtemp(prefix="plane-preflight-policy-")
        os.chmod(self.temporary, 0o755)
        self.root = Path(self.temporary)
        self.report = self.root / "usr" / "local" / "sbin" / "plane-game-preflight-report"
        self.report.parent.mkdir(parents=True)
        for component in [self.root / "usr", self.root / "usr" / "local", self.report.parent]:
            component.chmod(0o755)
        self.content = b"#!/usr/bin/env bash\nprintf 'fixed report\\n'\n"
        self.report.write_bytes(self.content)
        self.report.chmod(0o755)
        self.digest = hashlib.sha256(self.content).hexdigest()
        self.uid = os.getuid()

    def tearDown(self) -> None:
        shutil.rmtree(self.temporary, ignore_errors=True)

    def verify(self, digest: str | None = None) -> None:
        policy.validate_report_target(
            digest or self.digest, anchor=self.temporary, expected_uid=self.uid
        )

    def test_exact_canonical_root_owned_equivalent_fixture_passes(self) -> None:
        self.verify()

    def test_mutable_component_and_mutable_or_wrong_mode_target_fail(self) -> None:
        for target, mode in [
            (self.root / "usr" / "local", 0o775),
            (self.report, 0o775),
            (self.report, 0o754),
        ]:
            with self.subTest(target=target, mode=oct(mode)):
                original = target.stat().st_mode & 0o7777
                target.chmod(mode)
                try:
                    with self.assertRaises(policy.PolicyError):
                        self.verify()
                finally:
                    target.chmod(original)

    def test_symlinked_component_and_final_target_fail(self) -> None:
        real_sbin = self.report.parent.with_name("sbin-real")
        self.report.parent.rename(real_sbin)
        self.report.parent.symlink_to(real_sbin, target_is_directory=True)
        with self.assertRaises(policy.PolicyError):
            self.verify()
        self.report.parent.unlink()
        real_sbin.rename(self.report.parent)
        real_report = self.report.with_name("plane-game-preflight-report.real")
        self.report.rename(real_report)
        self.report.symlink_to(real_report)
        with self.assertRaises(policy.PolicyError):
            self.verify()

    def test_changed_content_unpinned_digest_and_wrong_owner_fail(self) -> None:
        with self.report.open("ab") as handle:
            handle.write(b"changed\n")
        with self.assertRaises(policy.PolicyError):
            self.verify()
        with self.assertRaises(policy.PolicyError):
            self.verify("__PINNED_REPORT_SHA256__")
        with self.assertRaises(policy.PolicyError):
            policy.validate_report_target(
                self.digest, anchor=self.temporary, expected_uid=self.uid + 1
            )


class ProductionConstantsTests(unittest.TestCase):
    def test_absolute_sudo_and_exact_contract_are_fixed(self) -> None:
        self.assertEqual(policy.SUDO_BINARY, "/usr/bin/sudo")
        self.assertEqual(policy.REPORT_PATH, "/usr/local/sbin/plane-game-preflight-report")
        self.assertRegex(policy.REPORT_SHA256, r"^[0-9a-f]{64}$")
        self.assertNotEqual(policy.REPORT_SHA256, "0" * 64)


if __name__ == "__main__":
    unittest.main()
