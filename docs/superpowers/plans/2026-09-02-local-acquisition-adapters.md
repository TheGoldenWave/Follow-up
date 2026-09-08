# Follow-up Local Acquisition Adapters Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the maintainer-operated central Feed pipeline with user-local acquisition while reusing audited mature Adapter implementations and preserving per-source rollback.

**Architecture:** Add a Python 3.12 Acquisition Runtime that produces versioned Signal Batches for the existing Node.js digest and delivery scripts. Import the required `last30days` infrastructure and Adapters as an audited vendor snapshot, manage compatible local CLI versions, and isolate persistent login platforms behind local Sidecars. Migrate one source at a time through shadow mode; do not remove central Feeds until every existing source completes acceptance and observation.

**Tech Stack:** Python 3.12, pytest, JSON Schema 2020-12, `feedparser`, `trafilatura`, Node.js 20, native `fetch`, `yt-dlp`, pinned Printing Press CLIs, local MCP/HTTP Sidecars, Docker for `we-mp-rss`.

**Canonical design:** `docs/superpowers/specs/2026-09-01-local-acquisition-adapters-design.md`

**Roadmap assignment:** This plan begins in `v0.3.0`. The former `v0.2.0`
assignment was too broad and has been replaced by the focused product-closure plan
in `docs/superpowers/plans/2026-09-05-v0.2.0-product-closure.md`. Execute the
runtime, contract, registry, and RSS/Blog shadow work first; later chunks map to the
subsequent milestones in the version-release design. Central acquisition retirement
remains conditional on source-level observation gates and is not tied to a fixed
product version.

---

## Chunk 1: Runtime Foundation

### Task 1: Establish the Python package and test harness

**Files:**
- Create: `pyproject.toml`
- Create: `src/follow_up_acquisition/__init__.py`
- Create: `src/follow_up_acquisition/__main__.py`
- Create: `src/follow_up_acquisition/cli.py`
- Create: `requirements-acquisition.lock`
- Create: `scripts/bootstrap-acquisition.js`
- Create: `scripts/test/bootstrap-acquisition.test.js`
- Create: `tests/acquisition/test_cli.py`
- Modify: `.gitignore`

- [ ] Add a Python 3.12 package with `pytest`, `pytest-cov`, `jsonschema`, `feedparser==6.0.14`, and `trafilatura==2.2.0`; generate `requirements-acquisition.lock` with transitive hashes.
- [ ] Write a failing CLI test for `python -m follow_up_acquisition --help`, `doctor`, and `run` command discovery.
- [ ] Implement `__main__.py` and the minimal argparse command tree.
- [ ] Implement bootstrap using a Python 3.12 interpreter to create `~/.follow-builders/runtime/python`, install locked dependencies with `--require-hashes`, install the Follow-up wheel with `--no-deps`, and persist the absolute interpreter path plus package version in `~/.follow-builders/runtime.json`.
- [ ] Make all Node launchers read `runtime.json`; they must never fall back silently to an unrelated global Python. A missing or incompatible runtime returns an actionable bootstrap error.
- [ ] Define upgrade as build wheel, create a new versioned virtual environment, run doctor, then atomically replace `runtime.json`; preserve the previous environment for rollback until verification passes.
- [ ] Run `python -m pytest tests/acquisition/test_cli.py -v`; expect all tests to pass.
- [ ] Run the existing Node scripts' non-mutating help or fixture checks to confirm the new package does not alter current Feed behavior.
- [ ] Run a clean-install test in a temporary home, invoke the module through the persisted interpreter, then test upgrade failure leaves the previous runtime active.
- [ ] Commit only the Python scaffold and test harness as `build: add local acquisition package`.

### Task 2: Define the versioned Signal Batch contract

**Files:**
- Create: `contracts/signal-batch.schema.json`
- Create: `src/follow_up_acquisition/contracts.py`
- Create: `tests/acquisition/fixtures/signal-batch-valid.json`
- Create: `tests/acquisition/test_contracts.py`

- [ ] Write failing tests for required envelope fields, allowed source statuses, empty successful batches, malformed items, and rejection of embedded credential fields.
- [ ] Define schema version `1.0` with `batch_id`, timestamps, Adapter identity, request metadata, batch-level `source_status`, and candidate `items`.
- [ ] Implement serialization and JSON Schema validation without embedding source secrets.
- [ ] Map exceptions only to the approved status taxonomy: `ok`, `no-results`, `partial`, `rate-limited`, `auth-failed`, `unreachable`, `timeout`, `schema-drift`, `skipped-unconfigured`, and `error`.
- [ ] Run `python -m pytest tests/acquisition/test_contracts.py -v`; expect all contract cases to pass.
- [ ] Commit as `feat: define signal batch contract`.

### Task 3: Add upstream provenance and controlled vendoring

**Files:**
- Create: `vendor/last30days/`
- Create: `vendor/README.md`
- Create: `vendor/manifest.json`
- Create: `docs/third-party/acquisition-dependencies.md`
- Create: `vendor/licenses/last30days-MIT.txt`
- Create: `vendor/licenses/we-mp-rss-MIT.txt`
- Create: `scripts/vendor/sync-last30days.sh`
- Create: `tests/acquisition/test_vendor_manifest.py`

- [ ] Start from `mvanhorn/last30days-skill` release `3.22.0`, commit `fcebe321c22e5e97e3ef5712e4bc00f2b33bba37`, and record imported paths, hashes, MIT license, and local patch list.
- [ ] Lock `@mvanhorn/printing-press-library` to `0.1.16` with npm integrity `sha512-2CSe85z5RVp92vI8Wca/v9n33KmRSa7V1TVOM4nZFsK6U+wjAImBe+SHzAZsozWuKUEsbVoTVMwi4sPfTyHvzg==`.
- [ ] Lock `we-mp-rss` to repository commit `f54aba50cbf349ed7e4ee1dae8bfe9990d0c5894`; build and pin the resulting container by digest rather than using `latest`.
- [ ] Fix the Xiaohongshu implementation input to Apache-2.0 `xpzouying/xiaohongshu-mcp` commit `332d196854a9eac0d2b8c2c0e3d0cc43139d724c`; record supported platforms, artifact hash, NOTICE obligations, and API compatibility before Sidecar coding. If binary redistribution fails review, run the same commit as a user-installed external Sidecar and vendor only the MIT `last30days` wrapper.
- [ ] Pin `yt-dlp==2026.8.19`, `feedparser==6.0.14`, and `trafilatura==2.2.0`; record their exact artifact hashes in the dependency document before Adapter coding. No floating branch, image tag, npm range, or Python range is allowed after this gate.
- [ ] Import only the shared modules required by approved sources: HTTP, dates, health, subprocess handling, query shaping, relevance, normalization, dedupe, schema helpers, and Adapter dependencies.
- [ ] Import the upstream Fixture tests that exercise those modules before changing their behavior.
- [ ] Make the sync script download to a temporary directory, verify the expected commit and file hashes, and produce a reviewable diff; it must never auto-merge upstream changes.
- [ ] Add tests that fail when a vendored file lacks provenance or its recorded hash is stale.
- [ ] Run the imported upstream tests plus `tests/acquisition/test_vendor_manifest.py`.
- [ ] Commit as `build: vendor audited acquisition foundation`.

### Task 4: Implement orchestration, health, cache, and deduplication

**Files:**
- Create: `src/follow_up_acquisition/runtime.py`
- Create: `src/follow_up_acquisition/registry.py`
- Create: `src/follow_up_acquisition/cache.py`
- Create: `src/follow_up_acquisition/redaction.py`
- Create: `tests/acquisition/test_runtime.py`
- Create: `tests/acquisition/test_redaction.py`

- [ ] Write failing tests for Adapter timeout, partial batches, independent source failure, native-ID dedupe, canonical-URL fallback, cache expiry, and secret redaction.
- [ ] Define a narrow Adapter protocol: identity, availability probe, request validation, and `collect(request) -> SourceResult`, where `SourceResult` contains raw source candidates plus one classified source outcome.
- [ ] Define `SourceCandidate` as source-native parsed data: `native_id`, `url`, `title`, `author`, source timestamp, text/excerpt, native metrics, query/subscription provenance, raw date confidence, and item warnings. It contains no `batch_id`, channel assignment, canonical dedupe key, or batch status.
- [ ] Make Acquisition Runtime the only component allowed to normalize candidates, assign `batch_id`, aggregate status, deduplicate across sources, and serialize Signal Batch envelopes.
- [ ] Reuse vendored health, timeout, retry, and dedupe semantics where compatible; write Follow-up-specific glue only at the Signal Batch boundary.
- [ ] Store runtime output under `~/.follow-builders/acquisition/`; keep shadow batches separate from live inputs.
- [ ] Default raw snippets and transcripts to 7-day expiry and candidate metadata to 90-day expiry.
- [ ] Run `python -m pytest tests/acquisition/test_runtime.py tests/acquisition/test_redaction.py -v`.
- [ ] Commit as `feat: add acquisition runtime`.

## Chunk 2: Configuration and Managed Tools

### Task 5: Extend configuration without exposing credentials

**Files:**
- Modify: `config/config-schema.json`
- Create: `config/sources.json`
- Modify: `config/default-sources.json`
- Modify: `config/feed-newsletters.json`
- Modify: `config/feed-academic.json`
- Modify: `config/feed-zh-tech.json`
- Create: `src/follow_up_acquisition/config.py`
- Create: `tests/acquisition/test_config.py`
- Modify: `SKILL.md`

- [ ] Write failing tests for `central`, `shadow`, `hybrid`, and `local` acquisition modes and source-level `enabled`, `cadence`, `depth`, `budget`, and `input` fields.
- [ ] Add an explicit stable `source_id` to every configured source. Use namespaced IDs such as `x:karpathy`, `podcast:latent-space`, `blog:anthropic-engineering`, `newsletter:the-batch`, `academic:arxiv`, and `zh-tech:jiqizhixin`; IDs are immutable after release.
- [ ] Make `config/sources.json` the sole authoritative source registry. Each entry owns ID, `channel_policy`, Adapter, default state, cadence, budget, non-secret input, and legacy central-Feed selector.
- [ ] Define `channel_policy` as either `fixed` with one of the seven channel IDs, or `core-topic`. Use `core-topic` for Reddit and Digg; all other v1 sources use their specified fixed channel.
- [ ] Migrate every source currently spread across `default-sources.json`, `feed-newsletters.json`, `feed-academic.json`, and `feed-zh-tech.json` into the registry. During migration, legacy files are generated compatibility artifacts and must not be edited independently.
- [ ] Add tests for unique immutable IDs, valid channel policies, complete legacy-to-registry mapping, valid Adapter references, and complete central/local selectors.
- [ ] Default keyless sources on and API-Key/Cookie/scan-login sources off.
- [ ] Permit credential references only; reject raw cookies, bearer tokens, passwords, and Sidecar tokens in `config.json`.
- [ ] Preserve old configurations by defaulting missing `acquisition.mode` to `central` until migration explicitly begins.
- [ ] Update agent instructions to request authorization immediately before credential writes, cookie reads, Sidecar login, or schedule changes.
- [ ] Validate the schema against old and new fixtures, then run `python -m pytest tests/acquisition/test_config.py -v`.
- [ ] Commit as `feat: add local source configuration`.

### Task 6: Build the pinned local-tool manager

**Files:**
- Create: `config/tool-manifest.json`
- Create: `src/follow_up_acquisition/tools.py`
- Create: `tests/acquisition/test_tools.py`

- [ ] Record platform-specific versions, download/install commands, executable names, checksums where distributable, license links, and compatibility probes for `yt-dlp`, `digg-pp-cli`, `techmeme-pp-cli`, and `arxiv-pp-cli`.
- [ ] Write failing tests for missing, correct, stale, broken, and incompatible binaries.
- [ ] Implement `doctor` probes and explicit install/update actions; never silently install during normal collection.
- [ ] Use a Follow-up-managed local bin directory and avoid modifying global package-manager state unless the user explicitly approves it.
- [ ] Map missing tools to `skipped-unconfigured`, broken tools to `unreachable`, timeouts to `timeout`, and incompatible output to `schema-drift`.
- [ ] Run `python -m pytest tests/acquisition/test_tools.py -v`.
- [ ] Commit as `feat: manage local acquisition tools`.

## Chunk 3: Keyless and Existing Sources

### Task 7: Replace ad hoc RSS parsing with a shared RSS Adapter

**Files:**
- Create: `src/follow_up_acquisition/adapters/rss.py`
- Create: `tests/acquisition/fixtures/rss/`
- Create: `tests/acquisition/test_rss_adapter.py`
- Modify: `config/sources.json`

- [ ] Capture representative RSS and Atom Fixtures for blogs, newsletters, podcasts, Chinese tech, missing GUIDs, malformed dates, CDATA, and redirects.
- [ ] Write failing tests before replacing the current regex-based parsing behavior.
- [ ] Implement the Adapter using `feedparser` and parse every entry into `SourceCandidate`; Acquisition Runtime performs canonical Signal conversion.
- [ ] Preserve podcast discovery separately from YouTube search and transcription.
- [ ] Do not persist paid Newsletter full text; retain metadata, link, and short-lived authorized input only.
- [ ] Run the RSS Adapter tests and compare output against current Feed Fixtures.
- [ ] Commit as `feat: add local rss acquisition`.

### Task 8: Migrate official-blog discovery and extraction

**Files:**
- Create: `src/follow_up_acquisition/adapters/web_publication.py`
- Create: `tests/acquisition/fixtures/blogs/`
- Create: `tests/acquisition/test_web_publication_adapter.py`
- Modify: `config/sources.json`

- [ ] Capture sanitized Fixtures for every current official blog before replacing its existing parser.
- [ ] Use discovery in this fixed order: declared RSS/Atom feed, sitemap, then configured index page. Use `feedparser` and `trafilatura`; retain a source-specific selector only when all generic paths fail and cover it with a Fixture.
- [ ] Parse URL, title, author, publication time, raw date confidence, article excerpt, and extraction warnings into `SourceCandidate` under the configured stable `source_id`; leave canonical URL and channel normalization to Runtime.
- [ ] Treat index-layout drift as `schema-drift`, individual article extraction failures as `item_warnings`, and total reachability failures as `unreachable`.
- [ ] Shadow-compare all eight current blogs against `feed-blogs.json`; no current official-blog source may be dropped during central retirement.
- [ ] Commit as `feat: migrate official blog acquisition`.

### Task 9: Vendor GitHub and Hacker News Adapters

**Files:**
- Create: `src/follow_up_acquisition/adapters/github.py`
- Create: `src/follow_up_acquisition/adapters/hackernews.py`
- Create: `tests/acquisition/test_github_adapter.py`
- Create: `tests/acquisition/test_hackernews_adapter.py`

- [ ] Import the upstream Adapter tests and Fixtures first, retaining attribution.
- [ ] Adapt `last30days` GitHub search, token/`gh` fallback, retry, relevance, and comment enrichment to Signal Batch.
- [ ] Extend GitHub collection with official API calls for Release, Commit, and Discussion evidence only after the imported Issues/PR path passes.
- [ ] Adapt the HN Algolia story and comment implementation without replacing its mature date and relevance handling.
- [ ] Verify both sources run without credentials; GitHub credentials only raise limits.
- [ ] Run both imported and Follow-up contract tests.
- [ ] Commit as `feat: add github and hacker news adapters`.

### Task 10: Vendor the keyless-first Reddit chain

**Files:**
- Create: `src/follow_up_acquisition/adapters/reddit.py`
- Create: `tests/acquisition/fixtures/reddit/`
- Create: `tests/acquisition/test_reddit_adapter.py`

- [ ] Import upstream public, RSS, listing, Shreddit, thread, enrichment, and dedupe tests required by the keyless path.
- [ ] Make the public/RSS/page chain the default and ScrapeCreators an optional enrichment backend.
- [ ] Ensure a missing paid key never disables the free path.
- [ ] Parse subreddit, post, author, score, comment signals, query provenance, and partial enrichment warnings into `SourceCandidate`.
- [ ] Test rate limiting, deleted comments, empty search, HTML drift, paid-backend failure with public fallback, and cross-backend dedupe.
- [ ] Commit as `feat: add keyless reddit adapter`.

## Chunk 4: Managed Tool Sources

### Task 11: Vendor YouTube search, transcript, and comments

**Files:**
- Create: `src/follow_up_acquisition/adapters/youtube.py`
- Create: `tests/acquisition/fixtures/youtube/`
- Create: `tests/acquisition/test_youtube_adapter.py`

- [ ] Import the upstream `yt-dlp` Adapter tests and output Fixtures before adapting the code.
- [ ] Support topic search, fixed-channel discovery, subtitles, transcript fallback, and useful comments within a bounded depth budget.
- [ ] Preserve upstream protections for stale `yt-dlp`, bot gating, caption language preference, and partial transcript failures.
- [ ] Keep ScrapeCreators optional as fallback or enrichment, never as a default requirement.
- [ ] Apply 7-day retention to transcript/comment text and keep stable metadata for 90 days.
- [ ] Run Fixture tests without live network access, then a user-authorized smoke test.
- [ ] Commit as `feat: add youtube adapter`.

### Task 12: Preserve podcast discovery and transcript coverage

**Files:**
- Create: `src/follow_up_acquisition/adapters/podcast.py`
- Create: `tests/acquisition/fixtures/podcasts/`
- Create: `tests/acquisition/test_podcast_adapter.py`

- [ ] Use the shared RSS Adapter for episode discovery and preserve stable GUID/link fallback behavior for all ten current podcasts.
- [ ] Match an episode to its configured YouTube channel or playlist using the existing title-overlap behavior, then obtain captions through the managed YouTube Adapter.
- [ ] When no YouTube match exists, use Pod2Text only if the user configured a local `POD2TXT_API_KEY` reference; the user owns that cost.
- [ ] When neither transcript path is available, emit episode metadata as a partial candidate with a `transcript-unavailable` item warning rather than dropping it.
- [ ] Test RSS-only, YouTube match, Pod2Text processing/ready/error, missing credentials, and transcript retention expiry.
- [ ] Shadow-compare against `feed-podcasts.json` before podcast cutover.
- [ ] Commit as `feat: migrate podcast acquisition`.

### Task 13: Vendor Digg, Techmeme, and arXiv wrappers

**Files:**
- Create: `src/follow_up_acquisition/adapters/digg.py`
- Create: `src/follow_up_acquisition/adapters/techmeme.py`
- Create: `src/follow_up_acquisition/adapters/arxiv.py`
- Create: `tests/acquisition/test_digg_adapter.py`
- Create: `tests/acquisition/test_techmeme_adapter.py`
- Create: `tests/acquisition/test_arxiv_adapter.py`

- [ ] Import the corresponding upstream wrapper code and tests with provenance intact.
- [ ] Invoke only binaries resolved by the managed-tool layer; never execute arbitrary configured commands.
- [ ] Preserve Digg cluster/post enrichment, Techmeme archive date filtering, and arXiv quoted relevance plus recency guards.
- [ ] Route Digg across channels as discovery evidence, Techmeme to technical/news evidence, and arXiv to academic primary-source candidates.
- [ ] Test old/new CLI envelopes, prose zero-result output, malformed dates, timeout, missing binary, and schema drift.
- [ ] Commit as `feat: add managed discovery adapters`.

## Chunk 5: Authorized Sources and Sidecars

### Task 14: Upgrade X behind explicit authorization

**Files:**
- Create: `src/follow_up_acquisition/adapters/x.py`
- Create: `vendor/last30days/bird-search/`
- Create: `tests/acquisition/test_x_adapter.py`

- [ ] Import the license-compatible `bird-search` client, runtime query metadata, cookie diagnostics, and relevant upstream tests.
- [ ] Keep API Token and authorized browser-cookie paths separate and observable.
- [ ] Require explicit user approval before reading browser cookies; never copy cookies into Signal Batches or logs.
- [ ] Support configured builder timelines and topic-related discussion, with per-run limits.
- [ ] Treat login expiry as `auth-failed` and query metadata drift as `schema-drift`.
- [ ] Commit as `feat: add authorized x adapter`.

### Task 15: Add the common Sidecar control plane

**Files:**
- Create: `contracts/sidecar-v1.schema.json`
- Create: `src/follow_up_acquisition/sidecars/base.py`
- Create: `src/follow_up_acquisition/sidecars/manager.py`
- Create: `tests/acquisition/test_sidecar_manager.py`

- [ ] Write failing tests for local binding, random token generation, file permissions, health checks, protocol negotiation, response redaction, and independent failure.
- [ ] Expose only read-only collection, health, and authorization status through the Follow-up wrapper.
- [ ] Reject non-loopback addresses and unknown protocol versions.
- [ ] Put upstream Sidecars behind a Follow-up-owned authentication proxy. The proxy binds to a Unix socket or `127.0.0.1`, requires the generated token, and is the only endpoint used by Adapters.
- [ ] Run containerized upstream services on an internal Docker network with no host-published port. For a non-container process, bind it to a separate loopback-only random port and firewall it from non-wrapper use where supported.
- [ ] Proxy login UI only during explicit setup using a one-time local setup token; never expose the raw upstream API or persistent login storage.
- [ ] Store each Sidecar in an isolated data directory and never provide credential-export functions.
- [ ] Add `sidecar start`, `status`, and `stop` commands that require explicit enablement.
- [ ] Commit as `feat: add local sidecar control plane`.

### Task 16: Integrate Xiaohongshu and WeChat Official Accounts

**Files:**
- Create: `src/follow_up_acquisition/adapters/xiaohongshu.py`
- Create: `src/follow_up_acquisition/adapters/wechat.py`
- Create: `src/follow_up_acquisition/sidecars/xiaohongshu.py`
- Create: `src/follow_up_acquisition/sidecars/wechat.py`
- Modify: `docker/docker-compose.yml`
- Create: `tests/acquisition/test_xiaohongshu_adapter.py`
- Create: `tests/acquisition/test_wechat_adapter.py`

- [ ] Reuse `last30days` Xiaohongshu response normalization and count parsing; wrap a pinned compatible local MCP service.
- [ ] Pin the reviewed `we-mp-rss` image by digest and consume its authenticated local RSS/API surface instead of copying its login internals into Follow-up.
- [ ] Render Compose with no `ports` entry for `we-mp-rss`; only the authenticated wrapper may publish `127.0.0.1:<port>` or a Unix socket.
- [ ] Limit WeChat v1 to a user-maintained account subscription list; do not implement global keyword search.
- [ ] Map login expiry, unavailable Sidecar, partial article fetch, and protocol drift distinctly.
- [ ] Test with sanitized recorded responses; live QR/login tests must be manual and user-authorized.
- [ ] Add integration tests that inspect rendered Compose/process arguments, prove no service listens on `0.0.0.0`, reject requests without the local token, and verify the raw upstream port is not host-reachable.
- [ ] Commit as `feat: add xiaohongshu and wechat sidecars`.

## Chunk 6: Digest Integration and Migration

### Task 17: Normalize central Feeds for per-source routing

**Files:**
- Create: `scripts/lib/normalize-central-feeds.js`
- Create: `scripts/test/normalize-central-feeds.test.js`
- Create: `tests/fixtures/central-feeds/`

- [ ] Convert every current aggregate Feed shape into the same candidate model and stable `source_id` used by local Adapters.
- [ ] Resolve all identity and legacy selectors exclusively through `config/sources.json`; do not infer IDs from display names or maintain a second routing catalog.
- [ ] Split nested X accounts, podcasts, blogs, newsletters, arXiv categories, and Chinese sources into independent source records before comparison or routing.
- [ ] Store routing and observation state at `~/.follow-builders/acquisition/migration.json`, keyed by stable `source_id`, with `input`, `cutover_at`, `observation_until`, `last_success_at`, and `rollback_reason`.
- [ ] Use local-plus-central union only in shadow comparison diagnostics, with local winning on native ID and then canonical URL. Never use that union as delivered hybrid content.
- [ ] In hybrid observation, a current local `ok`, `no-results`, or `partial` result is authoritative for that source. `no-results` must not fall back to central. Any failure status falls back to central and records the failure.
- [ ] After observation, local-only source failures remain visible and empty for that run; stale local content is never silently replayed as new content.
- [ ] Run normalization tests against all six current Feed Fixtures.
- [ ] Commit as `feat: normalize central feeds for source routing`.

### Task 18: Teach the Node digest layer to consume Signal Batches

**Files:**
- Create: `scripts/lib/load-signal-batches.js`
- Create: `scripts/lib/route-channels.js`
- Create: `scripts/test/load-signal-batches.test.js`
- Create: `scripts/test/route-channels.test.js`
- Modify: `scripts/prepare-digest.js`
- Modify: `scripts/package.json`

- [ ] Add Node tests for schema validation, seven-channel mapping, empty sources, mixed central/local inputs, and source-status reporting.
- [ ] Add `central`, `shadow`, `hybrid`, and `local` input behavior while keeping `central` as the migration-safe default.
- [ ] Apply fixed registry routing for GitHub, HN, Techmeme, Xiaohongshu, WeChat, and other fixed sources.
- [ ] Implement Follow-up Core topic routing for `core-topic` candidates using their configured query/topic and cluster labels. Reddit and Digg may map to one or more existing seven channels, but must never create platform-named channels or use arbitrary Adapter-side channel assignments.
- [ ] Test deterministic routing for representative AI Builder, video, technical community, academic, Chinese tech, and report topics, including ambiguous/unclassified fallback to a review queue rather than a new channel.
- [ ] In shadow mode, never include local candidates in the delivered Digest.
- [ ] In hybrid mode, apply the source routing and fallback semantics defined in Task 17.
- [ ] Run Node tests plus `node scripts/prepare-digest.js` against local Fixtures.
- [ ] Commit as `feat: consume local signal batches`.

### Task 19: Add scheduled collection and atomic publication

**Files:**
- Create: `scripts/collect-and-prepare.js`
- Create: `scripts/lib/run-acquisition.js`
- Create: `scripts/test/collect-and-prepare.test.js`
- Modify: `SKILL.md`

- [ ] Make `collect-and-prepare.js` the single on-demand and scheduled preparation entry point. It reads mode/config, invokes Python acquisition when needed, then calls Digest preparation.
- [ ] Publish each source run by writing `runs/<run_id>/<source_id>.json.tmp`, fsyncing and atomically renaming it, then atomically updating that source's `latest.json` pointer only after schema validation succeeds.
- [ ] In `central` mode, skip local collection. In `shadow`, collect and record metrics but prepare only central content. In `hybrid`, apply Task 17 routing. In `local`, never call central Feed URLs.
- [ ] A process crash or invalid batch must leave the previous pointer intact but must not cause stale data to be presented as a new run.
- [ ] Update the Skill's Content Delivery workflow and scheduler examples to invoke this entry point instead of calling `prepare-digest.js` directly.
- [ ] Test acquisition timeout, process crash, invalid JSON, partial source failure, atomic pointer update, central fallback during observation, and continued operation of unrelated sources.
- [ ] Commit as `feat: schedule local acquisition before digest`.

### Task 20: Add migration metrics, gates, and rollback

**Files:**
- Create: `src/follow_up_acquisition/migration.py`
- Create: `scripts/report-shadow.js`
- Create: `tests/acquisition/test_migration.py`
- Create: `docs/operations/local-acquisition-runbook.md`

- [ ] Compute native-ID/canonical-URL overlap, duplicate rate, classified error rate, run streak, and review-sample relevance.
- [ ] Prevent cutover unless contracts and Fixtures pass, secret scans are clean, duplicates are absent, run thresholds are met, and reviewed relevance is at least 80%.
- [ ] Preserve the low-frequency exception of three real runs plus representative Fixture replay.
- [ ] Implement source-level rollback when secrets leak, two consecutive unclassified failures occur, duplicates exceed 5%, or relevance falls below 80%.
- [ ] Document cutover order: RSS newsletters/Chinese sources, official blogs, podcasts, arXiv, GitHub/HN, Techmeme/Digg, Reddit, YouTube, X, Xiaohongshu, WeChat.
- [ ] Commit as `feat: enforce source migration gates`.

### Task 21: Retire the central Feed only after observation

**Files:**
- Modify: `.github/workflows/generate-feed.yml`
- Modify: `scripts/generate-feed.js`
- Modify: `scripts/prepare-digest.js`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `SKILL.md`

- [ ] Confirm every existing source has completed at least 14 days of local observation with no active rollback condition.
- [ ] Archive representative Feed files under test Fixtures and remove them from runtime resolution.
- [ ] Remove the maintainer-operated scheduled generation job and central source credentials.
- [ ] Change onboarding and documentation from central Feed claims to local acquisition and user-owned credentials.
- [ ] Run the full Python and Node suites, a clean-install rehearsal, a local scheduled collection, Digest generation, and delivery smoke test.
- [ ] Commit central retirement separately as `refactor: retire central feed runtime` so it can be reverted independently.

## Final Verification

- [ ] Run `python -m pytest -v`; expect all local, imported upstream, contract, Adapter, and migration tests to pass.
- [ ] Run `npm --prefix scripts test`; expect all digest and delivery tests to pass.
- [ ] Run `python -m follow_up_acquisition doctor`; verify every enabled source reports an actionable classified status.
- [ ] Scan configuration, logs, shadow batches, Fixtures, and git diff for Cookie, Authorization, API Key, QR-session, email, phone, and Sidecar-token leakage.
- [ ] Run `git diff --check` and confirm no unrelated dirty-worktree files are included in implementation commits.
- [ ] Review all third-party notices and hashes against `vendor/manifest.json` and `config/tool-manifest.json`.

## Fixed Assumptions

- Python owns acquisition; Node.js continues to own current Digest preparation and delivery.
- Controlled Vendor snapshots are preferred over Git subtree and manual isolated copying.
- Managed local tools are pinned and compatibility-checked; normal collection never silently installs them.
- Keyless sources default on; sources requiring API Key, Cookie, or scan login default off.
- Reddit is keyless-first with optional ScrapeCreators enrichment.
- Raw snippets and transcripts expire after 7 days; candidate metadata and user state expire after 90 days by default.
- Paid Newsletter full text is not retained.
- Xiaohongshu and WeChat use local-only Sidecars; WeChat v1 supports selected-account subscriptions only.
- Central Feeds remain the current runtime until per-source migration succeeds.
