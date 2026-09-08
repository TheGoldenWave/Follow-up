"""Tests for credential redaction helpers."""

from __future__ import annotations

import unittest

from follow_up_acquisition.redaction import REDACTED, redact_mapping, redact_text


class RedactionTests(unittest.TestCase):
    def test_redact_mapping_replaces_sensitive_keys(self) -> None:
        self.assertEqual(
            redact_mapping({"cookie": "abc", "title": "hello"}),
            {"cookie": REDACTED, "title": "hello"},
        )

    def test_redact_mapping_matches_separator_normalized_keys(self) -> None:
        for key in ("api_key", "api-key", "API_KEY", "apiKey"):
            self.assertEqual(redact_mapping({key: "secret"}), {key: REDACTED})

    def test_redact_mapping_recurses_into_nested_structures(self) -> None:
        value = {"auth": {"token": "abc"}, "items": [{"phone": "123"}]}
        self.assertEqual(
            redact_mapping(value),
            {"auth": {"token": REDACTED}, "items": [{"phone": REDACTED}]},
        )

    def test_redact_mapping_leaves_scalars_untouched(self) -> None:
        self.assertEqual(redact_mapping("plain"), "plain")
        self.assertEqual(redact_mapping(42), 42)

    def test_redact_text_scrubs_authorization_header(self) -> None:
        out = redact_text("Authorization: Bearer abc123def")
        self.assertNotIn("abc123def", out)
        self.assertIn(REDACTED, out)

    def test_redact_text_scrubs_cookie_header(self) -> None:
        out = redact_text("cookie: session=secret123")
        self.assertNotIn("secret123", out)
        self.assertIn(REDACTED, out)

    def test_redact_text_leaves_benign_text_alone(self) -> None:
        self.assertEqual(redact_text("a normal sentence"), "a normal sentence")


if __name__ == "__main__":
    unittest.main()
