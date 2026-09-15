"""Restricted public HTTP client shared by acquisition adapters.

The client deliberately exposes only decoded content and cache validators.  Raw
response headers stay inside this module so credentials, cookies, and unrelated
server metadata cannot accidentally enter checkpoints or logs.
"""

from __future__ import annotations

import errno
import http.client
import ipaddress
import json
import socket
import ssl
import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import unquote, urljoin, urlsplit

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


class _ApplicationResponseFailure(Exception):
    """Transport failed after response headers had already been received."""

    def __init__(self, *, timed_out: bool = False) -> None:
        super().__init__("response read failed")
        self.timed_out = timed_out


class _PreResponseProtocolFailure(Exception):
    """The peer did not provide a usable HTTP application response."""


@dataclass(frozen=True)
class _ResolvedTarget:
    url: str
    host: str
    port: int
    addresses: tuple[str, ...]
    selected_address: str


class _Transport(Protocol):
    def fetch(
        self,
        target: _ResolvedTarget,
        headers: dict[str, str],
        timeout: float,
        max_bytes: int,
    ) -> Any: ...


class _InjectedTransport:
    def __init__(self, fetch: Callable[[str, dict[str, str], float, int], Any]) -> None:
        self._fetch = fetch

    def fetch(
        self,
        target: _ResolvedTarget,
        headers: dict[str, str],
        timeout: float,
        max_bytes: int,
    ) -> Any:
        return self._fetch(target.url, headers, timeout, max_bytes)


def _system_resolver(host: str, port: int) -> list[str]:
    addresses: list[str] = []
    for answer in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM):
        address = answer[4][0]
        if address not in addresses:
            addresses.append(address)
    return addresses


def _canonical_ip(address: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address:
    parsed = ipaddress.ip_address(address.split("%", 1)[0])
    if isinstance(parsed, ipaddress.IPv6Address) and parsed.ipv4_mapped is not None:
        return parsed.ipv4_mapped
    return parsed


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    """HTTPS connection whose TCP destination is a prevalidated numeric IP."""

    def __init__(
        self,
        host: str,
        port: int,
        *,
        pinned_address: str,
        timeout: float,
        context: ssl.SSLContext | None = None,
    ) -> None:
        self._pinned_address = str(_canonical_ip(pinned_address))
        super().__init__(host, port, timeout=timeout, context=context)
        self._create_connection = self._create_pinned_connection

    def _create_pinned_connection(
        self,
        _address: tuple[str, int],
        timeout: float,
        source_address: tuple[str, int] | None,
    ) -> socket.socket:
        parsed = _canonical_ip(self._pinned_address)
        family = socket.AF_INET6 if isinstance(parsed, ipaddress.IPv6Address) else socket.AF_INET
        sock = socket.socket(family, socket.SOCK_STREAM)
        try:
            sock.settimeout(timeout)
            if source_address is not None:
                sock.bind(source_address)
            sockaddr: tuple[Any, ...]
            if family == socket.AF_INET6:
                sockaddr = (str(parsed), self.port, 0, 0)
            else:
                sockaddr = (str(parsed), self.port)
            sock.connect(sockaddr)
            self._verify_peer(sock)
            return sock
        except Exception:
            sock.close()
            raise

    def connect(self) -> None:
        try:
            super().connect()
            if self.sock is None:
                raise ConnectionError("HTTPS connection did not create a socket")
            self._verify_peer(self.sock)
        except Exception:
            self.close()
            raise

    def _verify_peer(self, sock: socket.socket) -> None:
        try:
            peer = _canonical_ip(sock.getpeername()[0])
        except (OSError, ValueError, IndexError, TypeError):
            raise SchemaDriftError("HTTPS connected peer could not be verified") from None
        if peer != _canonical_ip(self._pinned_address):
            raise SchemaDriftError("HTTPS connected peer did not match the validated address")


class _DirectHttpsTransport:
    """Direct-only transport; environment proxy configuration is intentionally ignored."""

    def fetch(
        self,
        target: _ResolvedTarget,
        headers: dict[str, str],
        timeout: float,
        max_bytes: int,
    ) -> _TransportResponse:
        connection = _PinnedHTTPSConnection(
            target.host,
            target.port,
            pinned_address=target.selected_address,
            timeout=timeout,
        )
        response_received = False
        try:
            parsed = urlsplit(target.url)
            selector = parsed.path or "/"
            if parsed.query:
                selector += "?" + parsed.query
            connection.request("GET", selector, headers=headers)
            response = connection.getresponse()
            response_received = True
            raw_headers = dict(response.headers.items())
            body = self._read_body(response, raw_headers, max_bytes)
            return _TransportResponse(
                status=response.status,
                url=target.url,
                headers=raw_headers,
                body=body,
            )
        except (TimeoutError, socket.timeout):
            if response_received:
                raise _ApplicationResponseFailure(timed_out=True) from None
            raise
        except http.client.HTTPException as error:
            if response_received:
                raise _ApplicationResponseFailure() from None
            if isinstance(error, ConnectionError):
                raise
            raise _PreResponseProtocolFailure() from None
        except (ConnectionError, OSError):
            if response_received:
                raise _ApplicationResponseFailure() from None
            raise
        finally:
            connection.close()

    @staticmethod
    def _read_body(
        response: http.client.HTTPResponse, headers: Mapping[str, str], max_bytes: int
    ) -> bytes:
        content_length: int | None = None
        raw_length = next(
            (str(value) for key, value in headers.items() if str(key).lower() == "content-length"),
            None,
        )
        if raw_length is not None:
            try:
                content_length = int(raw_length)
            except ValueError:
                content_length = None
            if content_length is not None and content_length < 0:
                content_length = None

        chunks: list[bytes] = []
        total = 0
        while total <= max_bytes:
            chunk = response.read(min(65_536, max_bytes + 1 - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
        if total <= max_bytes and content_length is not None and total < content_length:
            raise http.client.IncompleteRead(b"", content_length - total)
        return b"".join(chunks)


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
        """Create a restricted client.

        ``fetch`` is a legacy injection seam for offline fixture tests.
        It must not be used as a production network transport; only the
        built-in direct transport pins a validated address to TLS.
        """
        self._transport: _Transport = (
            _InjectedTransport(fetch) if fetch is not None else _DirectHttpsTransport()
        )
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
            if key.lower() == "host":
                raise SchemaDriftError("caller-supplied Host headers are not allowed")
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
                target = self._resolve_target(url, attempt)
                response = self._transport.fetch(target, dict(headers), timeout, max_bytes)
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
            except _PreResponseProtocolFailure:
                raise SchemaDriftError("public source returned an invalid HTTP response") from None
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

    def _resolve_target(self, url: str, attempt: int) -> _ResolvedTarget:
        parsed = urlsplit(url)
        host = (parsed.hostname or "").encode("idna").decode("ascii").lower().rstrip(".")
        port = parsed.port or 443
        addresses = self._resolver(host, port)
        if not addresses:
            raise socket.gaierror(socket.EAI_NONAME, "no addresses returned")
        try:
            canonical_ips = sorted(
                {_canonical_ip(str(address)) for address in addresses},
                key=lambda address: (address.version, address.packed),
            )
        except ValueError as error:
            raise SchemaDriftError("HTTP host resolution returned an invalid address") from error
        if any(not address.is_global for address in canonical_ips):
            raise SchemaDriftError("HTTP host resolved to a non-public address")
        canonical = tuple(str(address) for address in canonical_ips)
        return _ResolvedTarget(
            url=url,
            host=host,
            port=port,
            addresses=canonical,
            selected_address=canonical[attempt % len(canonical)],
        )

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
        except (ConnectionError, OSError, http.client.HTTPException):
            raise _ApplicationResponseFailure() from None
        return _TransportResponse(
            status=error.code,
            url=error.geturl(),
            headers=dict(error.headers.items()) if error.headers is not None else {},
            body=body,
        )
