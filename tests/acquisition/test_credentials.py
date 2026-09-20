"""Tests for credential reference parsing and closed resolution."""

from __future__ import annotations

import unittest

from follow_up_acquisition.credentials import (
    MAX_TOKEN_BYTES,
    CredentialRefError,
    build_credential_resolver,
    is_valid_token,
    parse_credential_refs,
)


class ParseCredentialRefsTests(unittest.TestCase):
    def test_parses_source_id_and_environment_variable(self):
        self.assertEqual(
            parse_credential_refs(["community:github=env.GITHUB_TOKEN"]),
            {"community:github": "GITHUB_TOKEN"},
        )

    def test_empty_input_yields_no_references(self):
        self.assertEqual(parse_credential_refs(None), {})
        self.assertEqual(parse_credential_refs([]), {})

    def test_rejects_references_that_are_not_env_variables(self):
        for value in (
            "community:github",
            "community:github=GITHUB_TOKEN",
            "community:github=env.github_token",
            "community:github=env.1TOKEN",
            "community:github=env.",
            "community:github=env.T OKEN",
            "community:github=env.TOKEN=extra",
            "=env.TOKEN",
            " community:github=env.TOKEN",
        ):
            with self.subTest(value=value), self.assertRaises(CredentialRefError):
                parse_credential_refs([value])

    def test_rejects_non_string_and_duplicate_references(self):
        with self.assertRaises(CredentialRefError):
            parse_credential_refs([{"source_id": "community:github"}])
        with self.assertRaises(CredentialRefError):
            parse_credential_refs([
                "community:github=env.GITHUB_TOKEN",
                "community:github=env.OTHER_TOKEN",
            ])


class IsValidTokenTests(unittest.TestCase):
    def test_accepts_a_header_safe_token(self):
        self.assertTrue(is_valid_token("gho_" + "a" * 36))

    def test_rejects_values_that_cannot_be_an_authorization_value(self):
        for value in (
            None,
            0,
            b"token",
            "",
            " padded",
            "trailing ",
            "line\nbreak",
            "tab\tseparated",
            "del\x7f",
            "c1\x9f",
            "日本語",
            "€uro",
            "a" * (MAX_TOKEN_BYTES + 1),
        ):
            with self.subTest(value=repr(value)):
                self.assertFalse(is_valid_token(value))


class BuildCredentialResolverTests(unittest.TestCase):
    def test_absent_when_no_reference_is_configured(self):
        resolve = build_credential_resolver({}, {"GITHUB_TOKEN": "secret"})
        self.assertEqual(resolve("community:github"), {"status": "absent"})

    def test_resolved_when_the_environment_variable_is_present(self):
        resolve = build_credential_resolver({"community:github": "GITHUB_TOKEN"},
                                            {"GITHUB_TOKEN": "gho_token"})
        self.assertEqual(resolve("community:github"),
                         {"status": "resolved", "token": "gho_token"})

    def test_configured_but_unusable_never_falls_back_to_anonymous(self):
        for environment in ({}, {"GITHUB_TOKEN": ""}, {"GITHUB_TOKEN": " x "}):
            with self.subTest(environment=environment):
                resolve = build_credential_resolver({"community:github": "GITHUB_TOKEN"}, environment)
                self.assertEqual(resolve("community:github"), {"status": "resolution-error"})

    def test_each_source_resolves_independently(self):
        resolve = build_credential_resolver(
            {"community:github": "GITHUB_TOKEN", "community:other": "OTHER_TOKEN"},
            {"GITHUB_TOKEN": "one"},
        )
        self.assertEqual(resolve("community:github"), {"status": "resolved", "token": "one"})
        self.assertEqual(resolve("community:other"), {"status": "resolution-error"})
        self.assertEqual(resolve("community:unconfigured"), {"status": "absent"})


if __name__ == "__main__":
    unittest.main()
