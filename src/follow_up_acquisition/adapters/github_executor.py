"""The sole request-quantum, budget and breaker owner for GitHub."""

from __future__ import annotations

from typing import Any, Callable, Mapping
from urllib.parse import urlsplit

from ..http_client import HttpClient, HttpResponse
from ..runtime import AdapterError
from .github_models import Breaker, BreakerOpen, RequestBudget


class GitHubExecutor:
    def __init__(
        self, budget: RequestBudget, http_client: HttpClient | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> None:
        self.budget = budget
        self.breaker = Breaker()
        self.http = http_client
        self.headers = dict(headers or {})
        self.successful_calls = 0
        self._core_cache: dict[str, HttpResponse] = {}

    def execute(self, request_kind: str, call: Callable[[], Any]) -> Any:
        if self.breaker.status is not None:
            raise BreakerOpen(self.breaker.status)
        if request_kind == "graphql" and self.breaker.discussions_open:
            raise BreakerOpen("auth-failed")
        self.budget.consume(request_kind)
        try:
            return call()
        except AdapterError as exc:
            if exc.status == "rate-limited":
                self.breaker.status = "rate-limited"
            elif exc.status == "auth-failed":
                if self.budget.authenticated:
                    self.breaker.status = "auth-failed"
                else:
                    raise AdapterError("anonymous GitHub request was rejected", status="error") from None
            raise

    def open_discussion_permission(self) -> None:
        self.breaker.discussions_open = True

    def open_global_auth(self) -> None:
        self.breaker.status = "auth-failed"

    def mark_validated_success(self) -> None:
        self.successful_calls += 1

    def get(self, request_kind: str, url: str, *, allowed_paths: set[str] | frozenset[str]) -> HttpResponse:
        if self.http is None:
            raise AdapterError("GitHub executor has no HTTP client", status="error")
        path_parts = [part for part in urlsplit(url).path.split("/") if part]
        cacheable = request_kind == "core" and len(path_parts) == 3 and path_parts[0] == "repos"
        if cacheable and url in self._core_cache:
            return self._core_cache[url]
        response = self.execute(request_kind, lambda: self.http.get(
            url, allowed_hosts={"api.github.com"}, allowed_paths=allowed_paths,
            headers=self.headers,
        ))
        if cacheable:
            self._core_cache[url] = response
        return response

    def post_json(self, url: str, payload: Any) -> HttpResponse:
        if self.http is None:
            raise AdapterError("GitHub executor has no HTTP client", status="error")
        return self.execute("graphql", lambda: self.http.post_json(
            url, payload, allowed_hosts={"api.github.com"}, allowed_paths={"/graphql"},
            headers=self.headers,
        ))
