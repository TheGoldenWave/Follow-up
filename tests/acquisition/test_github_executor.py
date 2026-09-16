from __future__ import annotations

import unittest

from follow_up_acquisition.adapters.github_executor import GitHubExecutor
from follow_up_acquisition.adapters.github_models import BreakerOpen, BudgetExhausted, RequestBudget
from follow_up_acquisition.runtime import AdapterError, RateLimitedError


class GitHubExecutorTests(unittest.TestCase):
    def test_each_call_consumes_one_quantum_and_budget_stops_transport(self):
        calls = []
        executor = GitHubExecutor(RequestBudget(authenticated=False))
        for _ in range(9):
            executor.execute("search", lambda: calls.append(1) or "ok")
        with self.assertRaises(BudgetExhausted):
            executor.execute("search", lambda: calls.append(1))
        self.assertEqual(len(calls), 9)

    def test_rate_and_authenticated_auth_open_global_breaker(self):
        for authenticated, failure, expected in (
            (False, RateLimitedError(), "rate-limited"),
            (True, AdapterError("unsafe", status="auth-failed"), "auth-failed"),
        ):
            with self.subTest(authenticated=authenticated):
                executor = GitHubExecutor(RequestBudget(authenticated=authenticated))
                with self.assertRaises(AdapterError):
                    executor.execute("search", lambda failure=failure: (_ for _ in ()).throw(failure))
                self.assertEqual(executor.breaker.status, expected)
                with self.assertRaises(BreakerOpen):
                    executor.execute("core", lambda: self.fail("transport after breaker"))

    def test_anonymous_auth_is_lane_error_and_discussion_permission_is_capability_only(self):
        executor = GitHubExecutor(RequestBudget(authenticated=False))
        with self.assertRaises(AdapterError) as caught:
            executor.execute("search", lambda: (_ for _ in ()).throw(AdapterError("x", status="auth-failed")))
        self.assertEqual(caught.exception.status, "error")
        self.assertIsNone(executor.breaker.status)
        executor.open_discussion_permission()
        with self.assertRaises(BreakerOpen):
            executor.execute("graphql", lambda: None)

    def test_transport_response_is_not_success_until_payload_is_validated(self):
        executor = GitHubExecutor(RequestBudget(authenticated=True))
        executor.execute("graphql", lambda: {"errors": [{"type": "UNAUTHENTICATED"}]})
        self.assertEqual(executor.successful_calls, 0)
        executor.mark_validated_success()
        self.assertEqual(executor.successful_calls, 1)


if __name__ == "__main__":
    unittest.main()
