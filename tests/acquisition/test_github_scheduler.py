from __future__ import annotations

import unittest

from follow_up_acquisition.adapters.github_scheduler import (
    LaneScheduler, active_stream_ids, build_lane_ids, lane_set_fingerprint,
)
from follow_up_acquisition.runtime import AdapterError


class GitHubSchedulerTests(unittest.TestCase):
    def test_lanes_only_cover_enabled_entities_and_are_utf8_sorted(self):
        queries = [
            {"id": "zeta", "filters": {"entities": ["repository", "release"]}},
            {"id": "alpha", "filters": {"entities": ["issue"]}},
        ]
        lanes = build_lane_ids(queries, include_discussions=True)
        self.assertEqual(lanes, tuple(sorted({
            "zeta.repository-search", "zeta.release-roster", "zeta.release-poll",
            "alpha.issue-search", "alpha.discussion-search", "zeta.discussion-search",
        }, key=lambda value: value.encode("utf-8"))))

    def test_scheduler_resumes_next_lane_and_reorder_keeps_fingerprint(self):
        lanes = ("a.repository-search", "b.issue-search", "c.commit-search")
        fingerprint = lane_set_fingerprint(lanes)
        scheduler = LaneScheduler(lanes, {"lane_set_fingerprint": fingerprint, "next_lane_id": "b.issue-search"})
        self.assertEqual([scheduler.next_lane() for _ in range(4)], ["b.issue-search", "c.commit-search", "a.repository-search", "b.issue-search"])
        self.assertEqual(scheduler.cursor()["next_lane_id"], "c.commit-search")
        self.assertEqual(fingerprint, lane_set_fingerprint(tuple(reversed(lanes))))
        with self.assertRaises(AdapterError):
            LaneScheduler(lanes, {"lane_set_fingerprint": "0" * 64, "next_lane_id": lanes[0]})

    def test_active_streams_always_include_scheduler(self):
        queries = [{"id": "b"}, {"id": "a"}]
        self.assertEqual(active_stream_ids(queries, include_discussions=False), ("query.a", "query.b", "scheduler"))
        self.assertEqual(active_stream_ids(queries, include_discussions=True), ("discussions", "query.a", "query.b", "scheduler"))


if __name__ == "__main__":
    unittest.main()
