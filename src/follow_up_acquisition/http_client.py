"""Restricted public HTTP client shared by acquisition adapters.

The client deliberately exposes only decoded content and cache validators.  Raw
response headers stay inside this module so credentials, cookies, and unrelated
server metadata cannot accidentally enter checkpoints or logs.
"""

from __future__ import annotations

import errno
import ipaddress
import json
import socket
import ssl
import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from typing import Any, Callable, Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import unquote, urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from .runtime import AdapterError, RateLimitedError, SchemaDriftError


USER_AGENT = "Follow-up/0.4"
_REDIRECT_STATUSES = frozenset({301, 302, 303, 307, 308})
_MAX_REDIRECTS = 5


@dataclass(frozen=True)
class HttpResponse:
    """Safe adapter-facing HTTP response."""

    status: int
    url: str
    body: Any
    etag: str | None = None
    last_modified: str | None = None


@dataclass(frozen=True)
class _TransportResponse:
    status: int
    url: str
    headers: Mapping[str, str]
    body: bytes


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> None:
        del req, fp, code, msg, headers, newurl
        return None


class _ApplicationResponseFailure(Exception):
    """Transport failed after response headers had already been received."""

    def __init__(self, *, timed_out: bool = False) -> None:
        super().__init__("response read failed")
        self.timed_out = timed_out


def _system_resolver(host: str, port: int) -> list[str]:
    return list({answer[4][0] for answer in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)})


class HttpClient:
    """HTTPS-only HTTP client with allowlists and SSRF protections.

    An injected ``fetch`` receives ``(url, headers, timeout, max_bytes)`` and
    returns a response-like object with ``status``, ``url``, ``headers``, and
    ``body`` attributes.  This narrow boundary keeps adapter tests fully offline.
    """

    def __init__(
        self,
        fetch: Callable[[str, dict[str, str], float, int], Any] | None = None,
        clock: Callable[[], float] | None = None,
        sleeper: Callable[[float], None] | None = None,
        resolver: Callable[[str, int], list[str]] | None = None,
    ) -> None:
        self._fetch = fetch or self._default_fetch
        self._clock = clock or time.monotonic
        self._sleeper = sleeper or time.sleep
        self._resolver = resolver or _system_resolver

    def get(
        self,
        url: str,
        *,
        allowed_hosts: set[str] | frozenset[str] | tuple[str, ...] | list[str],
        allowed_paths: set[str] | frozenset[str] | tuple[str, ...] | list[str],
        headers: Mapping[str, str] | None = None,
        timeout: float = 15,
        max_bytes: int = 2_000_000,
    ) -> HttpResponse:
        if not isinstance(timeout, (int, float)) or timeout <= 0:
            raise SchemaDriftError("HTTP timeout must be positive")
        if not isinstance(max_bytes, int) or isinstance(max_bytes, bool) or max_bytes <= 0:
            raise SchemaDriftError("HTTP body limit must be a positive integer")

        hosts = self._normalize_hosts(allowed_hosts)
        paths = self._normalize_paths(allowed_paths)
        initial_host = self._validate_url(url, hosts, paths)
        request_headers = {str(key): str(value) for key, value in (headers or {}).items()}
        for key in tuple(request_headers):
            if key.lower() == "user-agent":
                del request_headers[key]
        request_headers["User-Agent"] = USER_AGENT

        current_url = url
        redirects = 0
        while True:
            response = self._request(current_url, request_headers, float(timeout), max_bytes)
            response_url = str(self._response_field(response, "url"))
            self._validate_url(response_url, hosts, paths, required_host=initial_host)
            status = self._parse_status(self._response_field(response, "status"))
            raw_headers = self._response_field(response, "headers") or {}
            if not isinstance(raw_headers, Mapping):
                raise SchemaDriftError("HTTP response headers have an invalid shape")
            safe_headers = {str(key).lower(): str(value) for key, value in raw_headers.items()}

            if status in _REDIRECT_STATUSES:
                location = safe_headers.get("location")
                if not location:
                    raise SchemaDriftError("HTTP redirect omitted its location")
                redirects += 1
                if redirects > _MAX_REDIRECTS:
                    raise SchemaDriftError("HTTP redirect limit exceeded")
                redirected_url = urljoin(response_url, location)
                self._validate_url(redirected_url, hosts, paths, required_host=initial_host)
                current_url = redirected_url
                continue

            if status == 429 or self._is_explicit_rate_limit(status, safe_headers):
                raise RateLimitedError("public source rate limited the request")
            if status in (401, 403):
                raise AdapterError("public source rejected authentication", status="auth-failed", retryable=False)
            if status >= 400:
                raise AdapterError(
                    f"public source returned HTTP {status}", status="unreachable", retryable=status >= 500
                )

            raw_body = self._response_field(response, "body")
            if not isinstance(raw_body, (bytes, bytearray)):
                raise SchemaDriftError("HTTP response body is not bytes")
            if len(raw_body) > max_bytes:
                raise SchemaDriftError("HTTP response body exceeded the configured limit")
            body = None if status == 304 else self._decode(bytes(raw_body), safe_headers.get("content-type", ""))
            return HttpResponse(
                status=status,
                url=response_url,
                body=body,
                etag=safe_headers.get("etag"),
                last_modified=safe_headers.get("last-modified"),
            )

    def _request(
        self, url: str, headers: dict[str, str], timeout: float, max_bytes: int
    ) -> Any:
        for attempt in range(2):
            started_at = self._clock()
            try:
                response = self._fetch(url, dict(headers), timeout, max_bytes)
                if self._clock() - started_at > timeout:
                    raise TimeoutError
                return response
            except HTTPError as error:
                try:
                    return self._http_error_response(error, max_bytes)
                except _ApplicationResponseFailure as failure:
                    self._raise_response_failure(failure)
            except _ApplicationResponseFailure as failure:
                self._raise_response_failure(failure)
            except (TimeoutError, socket.timeout):
                raise AdapterError("public source request timed out", status="timeout", retryable=True) from None
            except URLError as error:
                if isinstance(error.reason, (TimeoutError, socket.timeout)):
                    raise AdapterError(
                        "public source request timed out", status="timeout", retryable=True
                    ) from None
                transient = self._is_transient_connection_failure(error)
                if attempt == 0 and transient:
                    self._sleeper(0.0)
                    continue
                raise AdapterError(
                    "public source is unreachable", status="unreachable", retryable=transient
                ) from None
            except (ConnectionError, OSError) as error:
                transient = self._is_transient_connection_failure(error)
                if attempt == 0 and transient:
                    self._sleeper(0.0)
                    continue
                raise AdapterError(
                    "public source is unreachable", status="unreachable", retryable=transient
                ) from None
        raise AssertionError("unreachable")

    @staticmethod
    def _raise_response_failure(failure: _ApplicationResponseFailure) -> None:
        if failure.timed_out:
            raise AdapterError(
                "public source response timed out", status="timeout", retryable=True
            ) from None
        raise AdapterError(
            "public source response could not be read", status="unreachable", retryable=True
        ) from None

    @staticmethod
    def _is_transient_connection_failure(error: BaseException) -> bool:
        reason = error.reason if isinstance(error, URLError) else error
        if isinstance(reason, socket.gaierror):
            return reason.errno == socket.EAI_AGAIN
        if isinstance(reason, (ssl.SSLError, PermissionError, FileNotFoundError)):
            return False
        if isinstance(
            reason,
            (ConnectionResetError, ConnectionRefusedError, ConnectionAbortedError, BrokenPipeError),
        ):
            return True
        if type(reason) is ConnectionError:
            return True
        if isinstance(reason, OSError):
            return reason.errno in {
                errno.ECONNABORTED,
                errno.ECONNREFUSED,
                errno.ECONNRESET,
                errno.EHOSTUNREACH,
                errno.ENETDOWN,
                errno.ENETUNREACH,
            }
        return False

    def _validate_url(
        self,
        url: str,
        allowed_hosts: frozenset[str],
        allowed_paths: tuple[str, ...],
        required_host: str | None = None,
    ) -> str:
        try:
            parsed = urlsplit(url)
            host = (parsed.hostname or "").encode("idna").decode("ascii").lower().rstrip(".")
            port = parsed.port or 443
        except (UnicodeError, ValueError) as error:
            raise SchemaDriftError("HTTP URL is invalid") from error
        if parsed.scheme.lower() != "https":
            raise SchemaDriftError("public HTTP requests require HTTPS")
        if not host or parsed.username is not None or parsed.password is not None:
            raise SchemaDriftError("HTTP URL authority is invalid")
        if port != 443:
            raise SchemaDriftError("public HTTP requests require the HTTPS default port")
        if host not in allowed_hosts:
            raise SchemaDriftError("HTTP host is not allowlisted")
        if required_host is not None and host != required_host:
            raise SchemaDriftError("cross-host HTTP redirects are not allowed")
        self._validate_path(parsed.path or "/", allowed_paths)
        try:
            addresses = self._resolver(host, port)
        except (OSError, socket.gaierror):
            raise AdapterError(
                "public source host could not be resolved", status="unreachable", retryable=True
            ) from None
        if not addresses:
            raise AdapterError(
                "public source host could not be resolved", status="unreachable", retryable=True
            )
        try:
            if any(not ipaddress.ip_address(address.split("%", 1)[0]).is_global for address in addresses):
                raise SchemaDriftError("HTTP host resolved to a non-public address")
        except ValueError as error:
            raise SchemaDriftError("HTTP host resolution returned an invalid address") from error
        return host

    @staticmethod
    def _normalize_hosts(hosts: Any) -> frozenset[str]:
        if isinstance(hosts, (str, bytes)):
            raise SchemaDriftError("HTTP host allowlist has an invalid shape")
        try:
            normalized = frozenset(
                str(host).encode("idna").decode("ascii").lower().rstrip(".") for host in hosts
            )
        except (TypeError, UnicodeError) as error:
            raise SchemaDriftError("HTTP host allowlist is invalid") from error
        if not normalized or "" in normalized:
            raise SchemaDriftError("HTTP host allowlist must not be empty")
        return normalized

    @classmethod
    def _normalize_paths(cls, paths: Any) -> tuple[str, ...]:
        if isinstance(paths, (str, bytes)):
            raise SchemaDriftError("HTTP path allowlist has an invalid shape")
        try:
            normalized = tuple(str(path) for path in paths)
        except TypeError as error:
            raise SchemaDriftError("HTTP path allowlist is invalid") from error
        if not normalized:
            raise SchemaDriftError("HTTP path allowlist must not be empty")
        for path in normalized:
            if not path.startswith("/") or "?" in path or "#" in path or "\\" in path:
                raise SchemaDriftError("HTTP path allowlist contains an invalid prefix")
            cls._reject_dot_segments(path)
        return normalized

    @classmethod
    def _validate_path(cls, path: str, allowed_paths: tuple[str, ...]) -> None:
        if not path.startswith("/") or "\\" in path:
            raise SchemaDriftError("HTTP URL path is invalid")
        decoded = path
        for _ in range(3):
            expanded = unquote(decoded)
            if expanded == decoded:
                break
            decoded = expanded
        if "\\" in decoded:
            raise SchemaDriftError("HTTP URL path is invalid")
        cls._reject_dot_segments(decoded)
        if not any(
            prefix == "/" or decoded == prefix.rstrip("/") or decoded.startswith(prefix.rstrip("/") + "/")
            for prefix in allowed_paths
        ):
            raise SchemaDriftError("HTTP URL path is not allowlisted")

    @staticmethod
    def _reject_dot_segments(path: str) -> None:
        if any(segment in (".", "..") for segment in path.split("/")):
            raise SchemaDriftError("HTTP URL path contains dot segments")

    @staticmethod
    def _response_field(response: Any, field: str) -> Any:
        try:
            if isinstance(response, Mapping):
                if field not in response:
                    raise SchemaDriftError("HTTP transport returned an invalid response")
                return response[field]
            return getattr(response, field)
        except AttributeError as error:
            raise SchemaDriftError("HTTP transport returned an invalid response") from error
        except (TimeoutError, socket.timeout):
            raise AdapterError(
                "public source response timed out", status="timeout", retryable=True
            ) from None
        except (ConnectionError, OSError) as error:
            raise AdapterError(
                "public source response could not be read",
                status="unreachable",
                retryable=HttpClient._is_transient_connection_failure(error),
            ) from None

    @staticmethod
    def _parse_status(value: Any) -> int:
        if isinstance(value, bool) or not isinstance(value, int) or not 100 <= value <= 599:
            raise SchemaDriftError("HTTP response status is invalid")
        return value

    @staticmethod
    def _is_explicit_rate_limit(status: int, headers: Mapping[str, str]) -> bool:
        return status == 403 and (
            headers.get("x-ratelimit-remaining") == "0" or "retry-after" in headers
        )

    @staticmethod
    def _decode(body: bytes, content_type: str) -> Any:
        media_type, _, parameters = content_type.lower().partition(";")
        charset = "utf-8"
        for parameter in parameters.split(";"):
            key, separator, value = parameter.strip().partition("=")
            if separator and key == "charset":
                charset = value.strip().strip('"') or "utf-8"
        try:
            if media_type == "application/json" or media_type.endswith("+json"):
                return json.loads(body.decode(charset))
            if media_type in ("application/xml", "text/xml") or media_type.endswith("+xml"):
                return ET.fromstring(body)
            if media_type.startswith("text/"):
                return body.decode(charset)
        except (LookupError, UnicodeDecodeError, json.JSONDecodeError, ET.ParseError) as error:
            raise SchemaDriftError("HTTP response could not be decoded as declared") from error
        return body

    @staticmethod
    def _http_error_response(error: HTTPError, max_bytes: int) -> _TransportResponse:
        try:
            body = error.read(max_bytes + 1)
        except (TimeoutError, socket.timeout):
            raise _ApplicationResponseFailure(timed_out=True) from None
        except (ConnectionError, OSError):
            raise _ApplicationResponseFailure() from None
        return _TransportResponse(
            status=error.code,
            url=error.geturl(),
            headers=dict(error.headers.items()) if error.headers is not None else {},
            body=body,
        )

    @staticmethod
    def _default_fetch(
        url: str, headers: dict[str, str], timeout: float, max_bytes: int
    ) -> _TransportResponse:
        request = Request(url, headers=headers, method="GET")
        opener = build_opener(_NoRedirect())
        try:
            response = opener.open(request, timeout=timeout)
        except HTTPError as error:
            return HttpClient._http_error_response(error, max_bytes)
        try:
            with response:
                return _TransportResponse(
                    status=response.status,
                    url=response.geturl(),
                    headers=dict(response.headers.items()),
                    body=response.read(max_bytes + 1),
                )
        except (TimeoutError, socket.timeout):
            raise _ApplicationResponseFailure(timed_out=True) from None
        except (ConnectionError, OSError):
            raise _ApplicationResponseFailure() from None
