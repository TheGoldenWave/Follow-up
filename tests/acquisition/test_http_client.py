"""Tests for the restricted shared acquisition HTTP client."""

from __future__ import annotations

import json
import socket
import unittest
from dataclasses import dataclass
from unittest.mock import Mock, patch
from urllib.error import URLError

from follow_up_acquisition.http_client import HttpClient, HttpResponse
from follow_up_acquisition.runtime import AdapterError, RateLimitedError, SchemaDriftError


PUBLIC_ADDRESS = "93.184.216.34"


@dataclass
class RawResponse:
    status: int = 200
    url: str = "https://api.example.test/v1/items"
    headers: dict[str, str] | None = None
    body: bytes = b"ok"

    def __post_init__(self) -> None:
        if self.headers is None:
            self.headers = {"Content-Type": "text/plain; charset=utf-8"}


class RecordingFetch:
    def __init__(self, *outcomes: object):
        self.outcomes = list(outcomes)
        self.calls: list[tuple[str, dict[str, str], float, int]] = []

    def __call__(
        self, url: str, headers: dict[str, str], timeout: float, max_bytes: int
    ) -> RawResponse:
        self.calls.append((url, headers, timeout, max_bytes))
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome  # type: ignore[return-value]


def public_resolver(host: str, port: int) -> list[str]:
    del host, port
    return [PUBLIC_ADDRESS]


class HttpClientTests(unittest.TestCase):
    def get(self, fetch: RecordingFetch, **kwargs: object) -> HttpResponse:
        client = HttpClient(fetch=fetch, resolver=public_resolver, sleeper=lambda _: None)
        options = {
            "allowed_hosts": {"api.example.test"},
            "allowed_paths": {"/v1"},
        }
        options.update(kwargs)
        return client.get("https://api.example.test/v1/items", **options)

    def assert_schema_drift(self, client: HttpClient, url: str, **kwargs: object) -> None:
        with self.assertRaises(SchemaDriftError) as caught:
            client.get(url, allowed_hosts={"api.example.test"}, allowed_paths={"/v1"}, **kwargs)
        self.assertEqual(caught.exception.status, "schema-drift")
        self.assertFalse(caught.exception.retryable)

    def test_injected_fetch_uses_unified_user_agent_without_network(self) -> None:
        fetch = RecordingFetch(RawResponse())

        response = self.get(fetch, headers={"Accept": "application/json", "User-Agent": "other"})

        self.assertEqual(response.body, "ok")
        self.assertEqual(len(fetch.calls), 1)
        self.assertEqual(fetch.calls[0][1]["User-Agent"], "Follow-up/0.4")
        self.assertEqual(fetch.calls[0][1]["Accept"], "application/json")

    def test_rejects_non_https_before_fetch(self) -> None:
        fetch = RecordingFetch()
        client = HttpClient(fetch=fetch, resolver=public_resolver)

        self.assert_schema_drift(client, "http://api.example.test/v1/items")

        self.assertEqual(fetch.calls, [])

    def test_rejects_non_allowlisted_host_before_fetch(self) -> None:
        fetch = RecordingFetch()
        client = HttpClient(fetch=fetch, resolver=public_resolver)

        self.assert_schema_drift(client, "https://evil.example/v1/items")

        self.assertEqual(fetch.calls, [])

    def test_rejects_host_resolving_to_private_address(self) -> None:
        fetch = RecordingFetch()
        client = HttpClient(fetch=fetch, resolver=lambda _host, _port: ["127.0.0.1"])

        self.assert_schema_drift(client, "https://api.example.test/v1/items")

        self.assertEqual(fetch.calls, [])

    def test_default_resolver_rejects_private_ip_resolution(self) -> None:
        fetch = RecordingFetch()
        client = HttpClient(fetch=fetch)
        answer = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.7", 443))]

        with patch("follow_up_acquisition.http_client.socket.getaddrinfo", return_value=answer):
            self.assert_schema_drift(client, "https://api.example.test/v1/items")

    def test_follows_same_host_allowed_redirect_and_revalidates_it(self) -> None:
        fetch = RecordingFetch(
            RawResponse(status=302, headers={"Location": "/v1/page/2"}, body=b""),
            RawResponse(url="https://api.example.test/v1/page/2", body=b"page two"),
        )

        response = self.get(fetch)

        self.assertEqual(response.url, "https://api.example.test/v1/page/2")
        self.assertEqual(response.body, "page two")
        self.assertEqual(len(fetch.calls), 2)

    def test_rejects_cross_host_redirect(self) -> None:
        fetch = RecordingFetch(
            RawResponse(status=302, headers={"Location": "https://evil.example/v1/items"}, body=b"")
        )

        with self.assertRaises(SchemaDriftError):
            self.get(fetch)

        self.assertEqual(len(fetch.calls), 1)

    def test_rejects_redirect_that_resolves_to_private_address(self) -> None:
        fetch = RecordingFetch(
            RawResponse(status=302, headers={"Location": "/v1/internal"}, body=b"")
        )
        resolutions = iter(([PUBLIC_ADDRESS], ["192.168.1.2"]))
        client = HttpClient(fetch=fetch, resolver=lambda _host, _port: next(resolutions))

        self.assert_schema_drift(client, "https://api.example.test/v1/items")

        self.assertEqual(len(fetch.calls), 1)

    def test_rejects_redirect_outside_allowed_path(self) -> None:
        fetch = RecordingFetch(
            RawResponse(status=302, headers={"Location": "/admin/secrets"}, body=b"")
        )

        with self.assertRaises(SchemaDriftError):
            self.get(fetch)

        self.assertEqual(len(fetch.calls), 1)

    def test_connection_failure_retries_at_most_once(self) -> None:
        sleeps: list[float] = []
        fetch = RecordingFetch(ConnectionResetError("local /secret/path"), RawResponse(body=b"recovered"))
        client = HttpClient(fetch=fetch, resolver=public_resolver, sleeper=sleeps.append)

        response = client.get(
            "https://api.example.test/v1/items",
            allowed_hosts={"api.example.test"},
            allowed_paths={"/v1"},
        )

        self.assertEqual(response.body, "recovered")
        self.assertEqual(len(fetch.calls), 2)
        self.assertEqual(sleeps, [0.0])

    def test_connection_failure_after_retry_is_unreachable_and_sanitized(self) -> None:
        fetch = RecordingFetch(URLError("/local/private/path"), ConnectionError("token=secret"))

        with self.assertRaises(AdapterError) as caught:
            self.get(fetch)

        self.assertEqual(caught.exception.status, "unreachable")
        self.assertTrue(caught.exception.retryable)
        self.assertNotIn("/local/private/path", str(caught.exception))
        self.assertNotIn("secret", str(caught.exception))
        self.assertEqual(len(fetch.calls), 2)

    def test_connection_and_read_timeouts_map_to_timeout_without_retry(self) -> None:
        for failure in (TimeoutError("connect"), socket.timeout("read")):
            with self.subTest(failure=type(failure).__name__):
                fetch = RecordingFetch(failure)
                with self.assertRaises(AdapterError) as caught:
                    self.get(fetch)
                self.assertEqual(caught.exception.status, "timeout")
                self.assertTrue(caught.exception.retryable)
                self.assertEqual(len(fetch.calls), 1)

    def test_default_transport_does_not_retry_failure_while_reading_response(self) -> None:
        response = Mock()
        response.status = 200
        response.geturl.return_value = "https://api.example.test/v1/items"
        response.headers.items.return_value = [("Content-Type", "text/plain")]
        response.read.side_effect = ConnectionResetError("socket reset during read")
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        opener = Mock()
        opener.open.return_value = response
        client = HttpClient(resolver=public_resolver, sleeper=lambda _: None)

        with patch("follow_up_acquisition.http_client.build_opener", return_value=opener):
            with self.assertRaises(AdapterError) as caught:
                client.get(
                    "https://api.example.test/v1/items",
                    allowed_hosts={"api.example.test"},
                    allowed_paths={"/v1"},
                )

        self.assertEqual(caught.exception.status, "unreachable")
        self.assertEqual(opener.open.call_count, 1)

    def test_rejects_body_over_limit(self) -> None:
        fetch = RecordingFetch(RawResponse(body=b"12345"))

        with self.assertRaises(SchemaDriftError):
            self.get(fetch, max_bytes=4)

    def test_429_maps_to_rate_limited_without_retry_or_header_leak(self) -> None:
        fetch = RecordingFetch(
            RawResponse(
                status=429,
                headers={"Retry-After": "60", "Authorization": "Bearer private"},
                body=b"slow down",
            )
        )

        with self.assertRaises(RateLimitedError) as caught:
            self.get(fetch)

        self.assertEqual(caught.exception.status, "rate-limited")
        self.assertNotIn("Authorization", str(caught.exception))
        self.assertNotIn("private", str(caught.exception))
        self.assertEqual(len(fetch.calls), 1)

    def test_304_returns_empty_body_and_safe_cache_metadata(self) -> None:
        fetch = RecordingFetch(
            RawResponse(
                status=304,
                headers={
                    "ETag": '"abc"',
                    "Last-Modified": "Mon, 14 Sep 2026 10:00:00 GMT",
                    "Set-Cookie": "private=secret",
                },
                body=b"ignored",
            )
        )

        response = self.get(fetch)

        self.assertEqual(
            response,
            HttpResponse(
                status=304,
                url="https://api.example.test/v1/items",
                body=None,
                etag='"abc"',
                last_modified="Mon, 14 Sep 2026 10:00:00 GMT",
            ),
        )
        self.assertEqual(set(response.__dataclass_fields__), {"status", "url", "body", "etag", "last_modified"})
        self.assertNotIn("secret", repr(response))

    def test_decodes_json_xml_and_text_by_content_type(self) -> None:
        cases = (
            ("application/json; charset=utf-8", b'{"items": [1]}', {"items": [1]}),
            ("application/atom+xml", b"<feed><title>News</title></feed>", "feed"),
            ("text/plain; charset=utf-8", "café".encode(), "café"),
        )
        for content_type, body, expected in cases:
            with self.subTest(content_type=content_type):
                response = self.get(
                    RecordingFetch(RawResponse(headers={"Content-Type": content_type}, body=body))
                )
                if content_type == "application/atom+xml":
                    self.assertEqual(response.body.tag, expected)
                else:
                    self.assertEqual(response.body, expected)

    def test_invalid_json_or_xml_maps_to_schema_drift(self) -> None:
        for content_type, body in (("application/json", b"{"), ("application/xml", b"<broken>")):
            with self.subTest(content_type=content_type):
                fetch = RecordingFetch(RawResponse(headers={"Content-Type": content_type}, body=body))
                with self.assertRaises(SchemaDriftError):
                    self.get(fetch)

    def test_fetch_receives_requested_timeout_and_body_limit(self) -> None:
        fetch = RecordingFetch(RawResponse())

        self.get(fetch, timeout=2.5, max_bytes=77)

        self.assertEqual(fetch.calls[0][2:], (2.5, 77))

    def test_response_json_remains_serializable_when_requested_by_adapter(self) -> None:
        response = self.get(
            RecordingFetch(
                RawResponse(headers={"Content-Type": "application/json"}, body=b'{"ok": true}')
            )
        )

        self.assertEqual(json.dumps(response.body, sort_keys=True), '{"ok": true}')


if __name__ == "__main__":
    unittest.main()
