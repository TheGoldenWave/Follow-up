from __future__ import annotations

import copy
import unittest
from pathlib import Path
from urllib.parse import urlsplit

from follow_up_acquisition.http_client import HttpResponse
from follow_up_acquisition.runtime import AdapterError, validate_checkpoint_updates

from follow_up_acquisition.adapters.techmeme import TechmemeAdapter


FIXTURES = Path(__file__).parent / "fixtures" / "techmeme"
NOW = "2026-09-15T09:00:00Z"
SOURCE = "community:techmeme"
FRONT_URL = "https://www.techmeme.com/"
ARCHIVE_TEMPLATE = "https://www.techmeme.com/{snapshot}"


def fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def source(*, budget=10, **extra):
    value = {
        "id": SOURCE,
        "adapter": "techmeme",
        "budget": budget,
        "input": {
            "front_url": FRONT_URL,
            "archive_url_template": ARCHIVE_TEMPLATE,
        },
    }
    value.update(extra)
    return value


class FakeClient:
    def __init__(self, handler):
        self.handler = handler
        self.calls = []

    def get(self, url, **kwargs):
        self.calls.append(("GET", url, copy.deepcopy(kwargs)))
        return self.handler("GET", url, kwargs)


def response(url, body):
    return HttpResponse(200, url, body, None, None)


class TechmemeAdapterTests(unittest.TestCase):
    def make_adapter(self, config, handler, checkpoint=None):
        return TechmemeAdapter(
            resolve_source=lambda source_id: config if source_id == SOURCE else None,
            http_client=FakeClient(handler),
            clock=lambda: NOW,
            checkpoint_resolver=lambda source_id: checkpoint if source_id == SOURCE else None,
        )

    def collect(self, config, handler, request=None, checkpoint=None):
        return self.make_adapter(config, handler, checkpoint).collect(
            SOURCE, request or {"mode": "shadow"},
        )

    @staticmethod
    def handler_for_fixture(calls, front="empty.html", archive="empty.html"):
        def handler(_method, url, kwargs):
            calls.append(("GET", url, copy.deepcopy(kwargs)))
            if url == FRONT_URL:
                return response(url, fixture(front))
            if urlsplit(url).path in {"/260914/h2000", "/260915/h2000"}:
                return response(url, fixture(archive))
            raise AssertionError(f"unexpected Techmeme URL: {url}")

        return handler

    def archive_checkpoint(self, current="2026-09-15", complete=None):
        complete = complete if complete is not None else []
        return {
            "streams": {
                "archive": {
                    "successful_window_end": NOW,
                    "cursor": {
                        "current_processing_date": current,
                        "complete_dates": complete,
                    },
                    "etag": None,
                    "last_modified": None,
                    "recent_native_ids": [],
                    "checkpoint_at": "2026-09-15T08:00:00Z",
                }
            }
        }

    def test_front_stream_maps_candidate_identity_and_provenance(self):
        calls = []
        result = self.collect(
            source(budget=10),
            self.handler_for_fixture(calls, front="front.html", archive="empty.html"),
        )

        self.assertEqual(result.status, "ok")
        self.assertEqual(
            [candidate.native_id for candidate in result.candidates],
            ["260915p50", "260915p51"],
        )
        lead = result.candidates[0]
        self.assertEqual(lead.title, "AI giants race to ship useful agents")
        self.assertEqual(
            lead.url,
            "https://www.ft.com/content/27509db8-b032-4437-9b2a-e909f466022f",
        )
        self.assertEqual(lead.source_type, "story")
        self.assertEqual(lead.date_confidence, "inferred")
        self.assertEqual(lead.published_at, "2026-09-15T20:00:00Z")
        self.assertEqual(lead.native_metrics["rank"], 1)
        self.assertEqual(lead.provenance["stream"], "front")
        self.assertEqual(lead.provenance["techmeme_url"], FRONT_URL)
        self.assertEqual(lead.provenance["cluster_url"], "https://www.techmeme.com/#a260915p50")
        self.assertEqual(
            lead.provenance["related_links"],
            [
                "https://example.com/related-one",
                "https://example.com/related-two",
                "https://example.com/discussion",
                "https://example.com/drhed-link",
            ],
        )
        self.assertEqual(
            {update.stream_id for update in result.checkpoint_updates},
            {"front", "archive"},
        )
        validate_checkpoint_updates(SOURCE, result.checkpoint_updates)
        self.assertTrue(all(
            kwargs["allowed_hosts"] == {"www.techmeme.com"}
            and kwargs["allowed_paths"] == {"/"}
            for _method, _url, kwargs in calls
        ))

    def test_archive_stream_maps_candidate_and_advances_cursor(self):
        calls = []
        checkpoint = self.archive_checkpoint(
            current="2026-09-15", complete=["2026-09-14"],
        )
        result = self.collect(
            source(budget=10),
            self.handler_for_fixture(calls, front="empty.html", archive="archive-260915.html"),
            checkpoint=checkpoint,
        )

        self.assertEqual(result.status, "ok")
        self.assertEqual(
            [candidate.native_id for candidate in result.candidates],
            ["260915p60", "260915p61"],
        )
        self.assertEqual(result.candidates[0].provenance["stream"], "archive")
        self.assertEqual(
            result.candidates[0].provenance["techmeme_url"],
            "https://www.techmeme.com/260915/h2000",
        )
        archive = next(
            update for update in result.checkpoint_updates if update.stream_id == "archive"
        )
        self.assertEqual(archive.checkpoint["cursor"], {
            "current_processing_date": "2026-09-16",
            "complete_dates": ["2026-09-14", "2026-09-15"],
        })
        validate_checkpoint_updates(SOURCE, result.checkpoint_updates)

    def test_archive_without_checkpoint_starts_from_last_complete_date(self):
        calls = []
        result = self.collect(
            source(budget=10),
            self.handler_for_fixture(calls, front="empty.html", archive="empty.html"),
        )
        archive = next(
            update for update in result.checkpoint_updates if update.stream_id == "archive"
        )
        self.assertEqual(archive.checkpoint["cursor"], {
            "current_processing_date": "2026-09-15",
            "complete_dates": ["2026-09-14"],
        })
        archive_urls = [url for _method, url, _kwargs in calls if url != FRONT_URL]
        self.assertEqual(archive_urls, ["https://www.techmeme.com/260914/h2000"])

    def test_archive_fallback_uses_deterministic_identity(self):
        result = self.collect(
            source(budget=10),
            self.handler_for_fixture([], front="empty.html", archive="archive-fallback.html"),
        )
        self.assertEqual(result.status, "ok")
        self.assertEqual(len(result.candidates), 1)
        candidate = result.candidates[0]
        self.assertTrue(candidate.native_id.startswith("tm-"))
        self.assertEqual(candidate.title, "AI giants race to ship useful agents")
        self.assertEqual(candidate.date_confidence, "inferred")

    def test_valid_empty_pages_are_no_results_and_advance_both_streams(self):
        result = self.collect(
            source(budget=10),
            self.handler_for_fixture([], front="empty.html", archive="empty.html"),
        )
        self.assertEqual(result.status, "no-results")
        self.assertEqual(
            {update.stream_id for update in result.checkpoint_updates},
            {"front", "archive"},
        )
        validate_checkpoint_updates(SOURCE, result.checkpoint_updates)

    def test_unrecognized_layout_is_schema_drift_without_checkpoints(self):
        def handler(_method, url, _kwargs):
            return response(url, fixture("drifted.html"))

        result = self.collect(source(budget=10), handler)
        self.assertEqual(result.status, "schema-drift")
        self.assertEqual(result.code, "techmeme-stream-failed")
        self.assertEqual(result.candidates, ())
        self.assertEqual(result.checkpoint_updates, ())

    def test_one_empty_and_one_failed_stream_is_partial(self):
        def handler(_method, url, _kwargs):
            if url == FRONT_URL:
                return response(url, fixture("empty.html"))
            raise AdapterError("archive unavailable", status="unreachable")

        result = self.collect(source(budget=10), handler)
        self.assertEqual(result.status, "partial")
        self.assertEqual(result.code, "techmeme-partial")
        self.assertEqual(result.candidates, ())
        self.assertEqual(
            {update.stream_id for update in result.checkpoint_updates},
            {"front"},
        )
        validate_checkpoint_updates(SOURCE, result.checkpoint_updates)

    def test_failed_archive_does_not_advance_checkpoint(self):
        checkpoint = self.archive_checkpoint(
            current="2026-09-15", complete=["2026-09-14"],
        )

        def handler(_method, url, _kwargs):
            if url == FRONT_URL:
                return response(url, fixture("empty.html"))
            raise AdapterError("archive unavailable", status="unreachable")

        result = self.collect(source(budget=10), handler, checkpoint=checkpoint)
        self.assertEqual(result.status, "partial")
        self.assertNotIn(
            "archive", {update.stream_id for update in result.checkpoint_updates}
        )
        validate_checkpoint_updates(SOURCE, result.checkpoint_updates)

    def test_all_failed_streams_have_no_checkpoint_updates(self):
        def handler(_method, url, _kwargs):
            raise AdapterError("public source unavailable", status="unreachable")

        result = self.collect(source(budget=10), handler)
        self.assertEqual(result.status, "unreachable")
        self.assertEqual(result.code, "techmeme-stream-failed")
        self.assertEqual(result.checkpoint_updates, ())

    def test_budget_is_applied_after_global_dedupe(self):
        result = self.collect(
            source(budget=2),
            self.handler_for_fixture([], front="front.html", archive="archive-260915.html"),
        )
        self.assertEqual(result.status, "ok")
        self.assertEqual(len(result.candidates), 2)
        self.assertEqual(
            {candidate.native_id for candidate in result.candidates},
            {"260915p50", "260915p51"},
        )

    def test_window_filters_page_dates(self):
        result = self.collect(
            source(budget=10),
            self.handler_for_fixture([], front="front.html", archive="empty.html"),
            request={
                "mode": "shadow",
                "window": {
                    "start": "2026-09-15T20:00:00Z",
                    "end": "2026-09-16T00:00:00Z",
                },
            },
        )
        self.assertEqual(result.status, "ok")
        self.assertEqual(
            [candidate.native_id for candidate in result.candidates],
            ["260915p50", "260915p51"],
        )

    def test_validate_request_rejects_bad_mode_window_depth_and_unknown_fields(self):
        adapter = self.make_adapter(source(), lambda _method, _url, _kwargs: None)
        with self.assertRaises(AdapterError):
            adapter.validate_request({"mode": "shadow", "depth": True})
        with self.assertRaises(AdapterError):
            adapter.validate_request({"mode": "shadow", "window": {"start": "bad"}})
        with self.assertRaises(AdapterError):
            adapter.validate_request({"mode": "shadow", "window": {"start": NOW}})
        with self.assertRaises(AdapterError):
            adapter.validate_request({"mode": "shadow", "unknown": True})

    def test_config_rejects_mismatches_and_drift(self):
        bad_configs = [
            {**source(), "adapter": "hackernews"},
            {**source(), "id": "community:techmeme-other"},
            {**source(), "budget": 0},
            {
                **source(),
                "input": {
                    **source()["input"],
                    "front_url": "https://www.techmeme.com/feed",
                },
            },
            {
                **source(),
                "input": {
                    **source()["input"],
                    "archive_url_template": "https://www.techmeme.com/{date}",
                },
            },
            {
                **source(),
                "input": {
                    **source()["input"],
                    "extra": True,
                },
            },
        ]
        for config in bad_configs:
            with self.subTest(config=config):
                with self.assertRaises(AdapterError):
                    self.collect(
                        config,
                        self.handler_for_fixture([], front="empty.html", archive="empty.html"),
                    )

    def test_availability_probe_is_ok(self):
        self.assertEqual(
            self.make_adapter(source(), lambda _method, _url, _kwargs: None).availability_probe(),
            "ok",
        )


if __name__ == "__main__":
    unittest.main()
