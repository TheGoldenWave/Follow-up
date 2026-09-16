"""Pure GitHub lane construction, fingerprinting and round-robin state."""

from __future__ import annotations

import hashlib
from typing import Any, Iterable, Mapping

from .github_models import GitHubModelError

_ENTITY_LANES = {
    "repository": ("repository-search",),
    "release": ("release-roster", "release-poll"),
    "commit": ("commit-search",),
    "issue": ("issue-search",),
    "pull-request": ("pull-request-search",),
}


class LaneSetChanged(GitHubModelError):
    def __init__(self) -> None:
        super().__init__("GitHub scheduler lane fingerprint changed")


def _frame(fields: Iterable[str]) -> bytes:
    chunks: list[bytes] = []
    for field in fields:
        encoded = field.encode("utf-8")
        chunks.extend((str(len(encoded)).encode("ascii"), b":", encoded))
    return b"".join(chunks)


def build_lane_ids(queries: Iterable[Mapping[str, Any]], *, include_discussions: bool) -> tuple[str, ...]:
    lanes: set[str] = set()
    for query in queries:
        query_id = query["id"]
        for entity in query.get("filters", {}).get("entities", ()):
            for kind in _ENTITY_LANES.get(entity, ()):
                lanes.add(f"{query_id}.{kind}")
        if include_discussions:
            lanes.add(f"{query_id}.discussion-search")
    return tuple(sorted(lanes, key=lambda value: value.encode("utf-8")))


def lane_set_fingerprint(lanes: Iterable[str]) -> str:
    ordered = tuple(sorted(set(lanes), key=lambda value: value.encode("utf-8")))
    return hashlib.sha256(_frame(("github-lanes-v1", *ordered))).hexdigest()


def active_stream_ids(queries: Iterable[Mapping[str, Any]], *, include_discussions: bool) -> tuple[str, ...]:
    values = {"scheduler", *(f"query.{query['id']}" for query in queries)}
    if include_discussions:
        values.add("discussions")
    return tuple(sorted(values, key=lambda value: value.encode("utf-8")))


class LaneScheduler:
    def __init__(self, lanes: Iterable[str], cursor: Mapping[str, Any] | None = None) -> None:
        self.lanes = tuple(sorted(set(lanes), key=lambda value: value.encode("utf-8")))
        if not self.lanes:
            raise GitHubModelError("GitHub lane set is empty")
        self.fingerprint = lane_set_fingerprint(self.lanes)
        if cursor is None:
            self.index = 0
            self.reset = False
        else:
            if set(cursor) != {"lane_set_fingerprint", "next_lane_id"}:
                raise GitHubModelError("GitHub scheduler cursor is invalid")
            if cursor["lane_set_fingerprint"] != self.fingerprint:
                raise LaneSetChanged()
            lane = cursor["next_lane_id"]
            if lane not in self.lanes:
                raise GitHubModelError("GitHub scheduler cursor is invalid")
            self.index = self.lanes.index(lane)
            self.reset = False

    def next_lane(self) -> str:
        lane = self.lanes[self.index]
        self.index = (self.index + 1) % len(self.lanes)
        return lane

    def cursor(self) -> dict[str, str]:
        return {"lane_set_fingerprint": self.fingerprint, "next_lane_id": self.lanes[self.index]}
