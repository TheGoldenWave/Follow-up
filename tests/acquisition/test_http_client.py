"""Tests for the restricted shared acquisition HTTP client."""

from __future__ import annotations

import http.client
import inspect
import json
import os
import socket
import ssl
import unittest
from dataclasses import dataclass
from unittest.mock import Mock, patch
from urllib.error import URLError

import follow_up_acquisition.http_client as http_client
from follow_up_acquisition.http_client import HttpClient, HttpResponse
from follow_up_acquisition.runtime import AdapterError, RateLimitedError, SchemaDriftError


PUBLIC_ADDRESS = "93.184.216.34"
SECOND_PUBLIC_ADDRESS = "93.184.216.35"
PUBLIC_IPV6 = "2606:4700:4700::1111"


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


class BodyReadFailureResponse:
    status = 200
    url = "https://api.example.test/v1/items"
    headers = {"Content-Type": "text/plain"}

    @property
    def body(self) -> bytes:
        raise ConnectionResetError("response stream reset")


class FakeSocket:
    def __init__(self, peer: str = PUBLIC_ADDRESS):
        self.peer = peer
        self.connected_to: object = None
        self.sent: list[bytes] = []
        self.closed = False

    def settimeout(self, timeout: float) -> None:
        self.timeout = timeout

    def bind(self, address: object) -> None:
        self.bound_to = address

    def connect(self, address: object) -> None:
        self.connected_to = address

    def getpeername(self) -> tuple[str, int]:
        return self.peer, 443

    def setsockopt(self, *args: object) -> None:
        del args

    def sendall(self, data: bytes) -> None:
        self.sent.append(bytes(data))

    def close(self) -> None:
        self.closed = True


class FakeTlsContext:
    check_hostname = True
    verify_mode = ssl.CERT_REQUIRED

    def __init__(self) -> None:
        self.server_hostnames: list[str] = []

    def wrap_socket(self, sock: FakeSocket, *, server_hostname: str) -> FakeSocket:
        self.server_hostnames.append(server_hostname)
        return sock


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

    def test_constructor_documents_injected_fetch_as_fixture_only(self) -> None:
        documentation = inspect.getdoc(HttpClient.__init__) or ""

        self.assertIn("offline fixture", documentation.lower())
        self.assertIn("must not be used as a production network transport", documentation.lower())

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

    def test_temporary_dns_failure_retries_once(self) -> None:
        fetch = RecordingFetch(
            URLError(socket.gaierror(socket.EAI_AGAIN, "temporary DNS failure")),
            RawResponse(body=b"recovered"),
        )

        response = self.get(fetch)

        self.assertEqual(response.body, "recovered")
        self.assertEqual(len(fetch.calls), 2)

    def test_real_resolver_temporary_failure_is_inside_retry_boundary(self) -> None:
        resolutions: list[object] = [
            socket.gaierror(socket.EAI_AGAIN, "temporary DNS failure"),
            [PUBLIC_ADDRESS],
        ]
        calls: list[str] = []

        def resolver(_host: str, _port: int) -> list[str]:
            outcome = resolutions.pop(0)
            if isinstance(outcome, BaseException):
                raise outcome
            return outcome  # type: ignore[return-value]

        client = HttpClient(
            fetch=RecordingFetch(RawResponse(body=b"recovered")),
            resolver=resolver,
            sleeper=lambda _delay: calls.append("sleep"),
        )

        response = client.get(
            "https://api.example.test/v1/items",
            allowed_hosts={"api.example.test"},
            allowed_paths={"/v1"},
        )

        self.assertEqual(response.body, "recovered")
        self.assertEqual(calls, ["sleep"])
        self.assertEqual(resolutions, [])

    def test_real_resolver_permanent_failure_is_not_retryable(self) -> None:
        calls = 0

        def resolver(_host: str, _port: int) -> list[str]:
            nonlocal calls
            calls += 1
            raise socket.gaierror(socket.EAI_NONAME, "host does not exist")

        client = HttpClient(fetch=RecordingFetch(), resolver=resolver, sleeper=lambda _delay: None)

        with self.assertRaises(AdapterError) as caught:
            client.get(
                "https://api.example.test/v1/items",
                allowed_hosts={"api.example.test"},
                allowed_paths={"/v1"},
            )

        self.assertEqual(calls, 1)
        self.assertEqual(caught.exception.status, "unreachable")
        self.assertFalse(caught.exception.retryable)

    def test_non_transient_transport_failures_are_not_retried(self) -> None:
        failures = (
            ssl.SSLCertVerificationError(1, "certificate rejected"),
            PermissionError("operation denied"),
            FileNotFoundError("local file missing"),
            URLError(socket.gaierror(socket.EAI_NONAME, "host does not exist")),
        )
        for failure in failures:
            with self.subTest(failure=type(failure).__name__):
                fetch = RecordingFetch(failure, RawResponse(body=b"must not be used"))

                with self.assertRaises(AdapterError) as caught:
                    self.get(fetch)

                self.assertEqual(caught.exception.status, "unreachable")
                self.assertFalse(caught.exception.retryable)
                self.assertEqual(len(fetch.calls), 1)

    def test_connection_failure_after_retry_is_unreachable_and_sanitized(self) -> None:
        fetch = RecordingFetch(
            URLError(ConnectionResetError("/local/private/path")),
            ConnectionError("token=secret"),
        )

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
        response.headers = {"Content-Type": "text/plain"}
        response.read.side_effect = ConnectionResetError("socket reset during read")
        connection = Mock()
        connection.getresponse.return_value = response
        client = HttpClient(resolver=public_resolver, sleeper=lambda _: None)

        with patch(
            "follow_up_acquisition.http_client._PinnedHTTPSConnection", return_value=connection
        ) as factory:
            with self.assertRaises(AdapterError) as caught:
                client.get(
                    "https://api.example.test/v1/items",
                    allowed_hosts={"api.example.test"},
                    allowed_paths={"/v1"},
                )

        self.assertEqual(caught.exception.status, "unreachable")
        self.assertEqual(factory.call_count, 1)

    def test_injected_response_body_failure_is_classified_without_retry(self) -> None:
        fetch = RecordingFetch(BodyReadFailureResponse(), RawResponse(body=b"must not be used"))

        with self.assertRaises(AdapterError) as caught:
            self.get(fetch)

        self.assertEqual(caught.exception.status, "unreachable")
        self.assertTrue(caught.exception.retryable)
        self.assertEqual(len(fetch.calls), 1)

    def test_http_client_rejects_caller_host_override(self) -> None:
        fetch = RecordingFetch(RawResponse())

        with self.assertRaises(SchemaDriftError):
            self.get(fetch, headers={"Host": "127.0.0.1"})

        self.assertEqual(fetch.calls, [])

    def test_incomplete_read_after_headers_is_classified_without_retry(self) -> None:
        self._assert_default_body_failure_is_classified(
            http.client.IncompleteRead(b"partial", 3)
        )

    def test_http_exception_after_headers_is_classified_without_retry(self) -> None:
        self._assert_default_body_failure_is_classified(http.client.HTTPException("bad framing"))

    def test_fixed_content_length_early_eof_is_classified_without_retry(self) -> None:
        response = Mock()
        response.status = 200
        response.headers = {"Content-Type": "text/plain", "Content-Length": "5"}
        response.read.side_effect = [b"abc", b""]
        connection = Mock()
        connection.getresponse.return_value = response
        client = HttpClient(resolver=public_resolver)

        with patch(
            "follow_up_acquisition.http_client._PinnedHTTPSConnection", return_value=connection
        ) as factory:
            with self.assertRaises(AdapterError) as caught:
                client.get(
                    "https://api.example.test/v1/items",
                    allowed_hosts={"api.example.test"},
                    allowed_paths={"/v1"},
                )

        self.assertEqual(caught.exception.status, "unreachable")
        self.assertEqual(factory.call_count, 1)

    def test_default_transport_body_limit_wins_over_declared_content_length(self) -> None:
        response = Mock()
        response.status = 200
        response.headers = {"Content-Type": "text/plain", "Content-Length": "10"}
        response.read.return_value = b"12345"
        connection = Mock()
        connection.getresponse.return_value = response
        client = HttpClient(resolver=public_resolver)

        with patch(
            "follow_up_acquisition.http_client._PinnedHTTPSConnection", return_value=connection
        ):
            with self.assertRaises(SchemaDriftError):
                client.get(
                    "https://api.example.test/v1/items",
                    allowed_hosts={"api.example.test"},
                    allowed_paths={"/v1"},
                    max_bytes=4,
                )

    def test_rejects_body_over_limit(self) -> None:
        fetch = RecordingFetch(RawResponse(body=b"12345"))

        with self.assertRaises(SchemaDriftError):
            self.get(fetch, max_bytes=4)

    def test_malformed_response_status_maps_to_schema_drift(self) -> None:
        fetch = RecordingFetch(RawResponse(status="bogus"))  # type: ignore[arg-type]

        with self.assertRaises(SchemaDriftError) as caught:
            self.get(fetch)

        self.assertEqual(caught.exception.status, "schema-drift")
        self.assertFalse(caught.exception.retryable)

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

    def _assert_default_body_failure_is_classified(self, failure: BaseException) -> None:
        response = Mock()
        response.status = 200
        response.headers = {"Content-Type": "text/plain"}
        response.read.side_effect = failure
        connection = Mock()
        connection.getresponse.return_value = response
        client = HttpClient(resolver=public_resolver)

        with patch(
            "follow_up_acquisition.http_client._PinnedHTTPSConnection", return_value=connection
        ) as factory:
            with self.assertRaises(AdapterError) as caught:
                client.get(
                    "https://api.example.test/v1/items",
                    allowed_hosts={"api.example.test"},
                    allowed_paths={"/v1"},
                )

        self.assertEqual(caught.exception.status, "unreachable")
        self.assertEqual(factory.call_count, 1)


class PinnedHttpsConnectionTests(unittest.TestCase):
    def test_second_attempt_uses_next_validated_public_address(self) -> None:
        first = Mock()
        first.request.side_effect = ConnectionRefusedError("first address refused")
        second = Mock()
        second.getresponse.return_value = self._fake_response()
        resolver_calls: list[str] = []

        def resolver(host: str, _port: int) -> list[str]:
            resolver_calls.append(host)
            return [PUBLIC_ADDRESS, SECOND_PUBLIC_ADDRESS]

        with patch(
            "follow_up_acquisition.http_client._PinnedHTTPSConnection",
            side_effect=[first, second],
        ) as factory:
            result = HttpClient(resolver=resolver, sleeper=lambda _delay: None).get(
                "https://api.example.test/v1/items",
                allowed_hosts={"api.example.test"},
                allowed_paths={"/v1"},
            )

        pins = [call.kwargs["pinned_address"] for call in factory.call_args_list]
        self.assertEqual(result.body, "ok")
        self.assertEqual(pins, [PUBLIC_ADDRESS, SECOND_PUBLIC_ADDRESS])
        self.assertEqual(resolver_calls, ["api.example.test", "api.example.test"])
        self.assertEqual(factory.call_count, 2)

    def test_retry_never_attempts_address_from_mixed_public_private_answer(self) -> None:
        first = Mock()
        first.request.side_effect = ConnectionRefusedError("first address refused")
        answers = iter(([PUBLIC_ADDRESS], [SECOND_PUBLIC_ADDRESS, "127.0.0.1"]))

        with patch(
            "follow_up_acquisition.http_client._PinnedHTTPSConnection", return_value=first
        ) as factory:
            with self.assertRaises(SchemaDriftError):
                HttpClient(
                    resolver=lambda _host, _port: list(next(answers)),
                    sleeper=lambda _delay: None,
                ).get(
                    "https://api.example.test/v1/items",
                    allowed_hosts={"api.example.test"},
                    allowed_paths={"/v1"},
                )

        attempted = [call.kwargs["pinned_address"] for call in factory.call_args_list]
        self.assertEqual(attempted, [PUBLIC_ADDRESS])
        self.assertEqual(factory.call_count, 1)

    def test_connects_to_pinned_numeric_address_and_preserves_origin_identity(self) -> None:
        raw_socket = FakeSocket()
        context = FakeTlsContext()

        with patch("follow_up_acquisition.http_client.socket.socket", return_value=raw_socket):
            connection = http_client._PinnedHTTPSConnection(
                "api.example.test",
                443,
                pinned_address=PUBLIC_ADDRESS,
                timeout=3,
                context=context,
            )
            connection.connect()
            connection.request("GET", "/v1/items", headers={"User-Agent": "Follow-up/0.4"})

        wire = b"".join(raw_socket.sent)
        self.assertEqual(raw_socket.connected_to, (PUBLIC_ADDRESS, 443))
        self.assertEqual(context.server_hostnames, ["api.example.test"])
        self.assertIn(b"Host: api.example.test\r\n", wire)
        self.assertTrue(context.check_hostname)
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)

    def test_ipv6_pin_normalizes_peer_and_preserves_origin_identity(self) -> None:
        raw_socket = FakeSocket(peer="2606:4700:4700:0:0:0:0:1111")
        context = FakeTlsContext()

        with patch("follow_up_acquisition.http_client.socket.socket", return_value=raw_socket) as factory:
            connection = http_client._PinnedHTTPSConnection(
                "api.example.test",
                443,
                pinned_address=PUBLIC_IPV6,
                timeout=3,
                context=context,
            )
            connection.connect()
            connection.request("GET", "/v1/items", headers={"User-Agent": "Follow-up/0.4"})

        wire = b"".join(raw_socket.sent)
        self.assertEqual(factory.call_args.args[0], socket.AF_INET6)
        self.assertEqual(raw_socket.connected_to, (PUBLIC_IPV6, 443, 0, 0))
        self.assertEqual(context.server_hostnames, ["api.example.test"])
        self.assertIn(b"Host: api.example.test\r\n", wire)

    def test_rejects_connected_peer_that_does_not_match_pin(self) -> None:
        raw_socket = FakeSocket(peer="127.0.0.1")

        with patch("follow_up_acquisition.http_client.socket.socket", return_value=raw_socket):
            connection = http_client._PinnedHTTPSConnection(
                "api.example.test",
                443,
                pinned_address=PUBLIC_ADDRESS,
                timeout=3,
                context=FakeTlsContext(),
            )
            with self.assertRaises(SchemaDriftError):
                connection.connect()

        self.assertTrue(raw_socket.closed)

    def test_default_transport_is_direct_only_when_https_proxy_is_set(self) -> None:
        response = self._fake_response()
        connection = Mock()
        connection.getresponse.return_value = response
        connection.__enter__ = Mock(return_value=connection)
        connection.__exit__ = Mock(return_value=False)
        resolver_hosts: list[str] = []

        def resolver(host: str, _port: int) -> list[str]:
            resolver_hosts.append(host)
            return [PUBLIC_ADDRESS]

        with (
            patch.dict(os.environ, {"HTTPS_PROXY": "http://proxy.example.test:8080"}, clear=False),
            patch("follow_up_acquisition.http_client._PinnedHTTPSConnection", return_value=connection) as factory,
        ):
            result = HttpClient(resolver=resolver).get(
                "https://api.example.test/v1/items",
                allowed_hosts={"api.example.test"},
                allowed_paths={"/v1"},
            )

        self.assertEqual(result.body, "ok")
        self.assertEqual(resolver_hosts, ["api.example.test"])
        self.assertEqual(factory.call_args.args[:2], ("api.example.test", 443))
        self.assertEqual(factory.call_args.kwargs["pinned_address"], PUBLIC_ADDRESS)

    @staticmethod
    def _fake_response() -> Mock:
        response = Mock()
        response.status = 200
        response.headers = {"Content-Type": "text/plain", "Content-Length": "2"}
        response.read.side_effect = [b"ok", b""]
        return response


if __name__ == "__main__":
    unittest.main()
