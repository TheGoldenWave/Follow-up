"""Tests for the acquisition TTL cache."""

from __future__ import annotations

import unittest

from follow_up_acquisition.cache import (
    METADATA_TTL_SECONDS,
    TEXT_TTL_SECONDS,
    TTLCache,
)


class FakeClock:
    def __init__(self, start: float = 1000.0) -> None:
        self.value = start

    def __call__(self) -> float:
        return self.value

    def advance(self, seconds: float) -> None:
        self.value += seconds


class TTLCacheTests(unittest.TestCase):
    def test_default_ttls_are_7_and_90_days(self) -> None:
        self.assertEqual(TEXT_TTL_SECONDS, 7 * 24 * 60 * 60)
        self.assertEqual(METADATA_TTL_SECONDS, 90 * 24 * 60 * 60)

    def test_get_returns_value_within_ttl(self) -> None:
        clock = FakeClock()
        cache = TTLCache(now=clock)
        cache.put("k", "v", 10)
        clock.advance(9)
        self.assertEqual(cache.get("k"), "v")

    def test_get_returns_default_after_expiry(self) -> None:
        clock = FakeClock()
        cache = TTLCache(now=clock)
        cache.put("k", "v", 10)
        clock.advance(10)
        self.assertEqual(cache.get("k"), None)
        self.assertEqual(cache.get("k", "fallback"), "fallback")

    def test_contains_respects_ttl(self) -> None:
        clock = FakeClock()
        cache = TTLCache(now=clock)
        cache.put("k", "v", 10)
        self.assertTrue(cache.contains("k"))
        clock.advance(10)
        self.assertFalse(cache.contains("k"))

    def test_expire_removes_expired_entries(self) -> None:
        clock = FakeClock()
        cache = TTLCache(now=clock)
        cache.put("a", 1, 5)
        cache.put("b", 2, 50)
        clock.advance(10)
        self.assertEqual(cache.expire(), 1)
        self.assertEqual(len(cache), 1)
        self.assertFalse(cache.contains("a"))
        self.assertTrue(cache.contains("b"))

    def test_put_rejects_non_positive_ttl(self) -> None:
        cache = TTLCache()
        with self.assertRaises(ValueError):
            cache.put("k", "v", 0)

    def test_get_on_missing_key_returns_default(self) -> None:
        cache = TTLCache()
        self.assertEqual(cache.get("missing", "dflt"), "dflt")


if __name__ == "__main__":
    unittest.main()
