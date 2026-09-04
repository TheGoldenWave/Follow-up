# Official Blog Sources Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect every approved R2/P official article source that passes real shadow validation to the existing `feed-blogs.json` pipeline.

**Architecture:** Separate configuration, discovery, extraction, and orchestration into focused modules. Keep all 17 approved sources in a candidate inventory with offline fixtures; promote a source into the production Blog configuration only after an isolated real shadow run discovers and extracts an official article. `generate-feed.js` remains responsible for CLI selection, state persistence, and feed writing.

**Tech Stack:** Node.js 20 ESM, built-in `fetch`, `node:test`, JSON configuration, existing feed schema and release tooling.

---

## File Map

- Create `config/blog-source-candidates.json`: complete 17-source approved inventory.
- Create `config/feed-blogs.json`: production sources that passed live validation.
- Create `scripts/blog-source-config.js`: validation, canonicalization, and source matching.
- Create `scripts/blog-discovery.js`: RSS/Atom, Sitemap, and HTML discovery.
- Create `scripts/blog-extraction.js`: metadata and body extraction.
- Create `scripts/blog-collector.js`: fetching, concurrency, lookback, dedupe, errors, and state.
- Create `scripts/validate-blog-sources.js`: read-only live validation CLI.
- Create focused tests under `scripts/test/blog-*.test.js` and `scripts/test/validate-blog-sources.test.js`.
- Create compact official fixtures under `scripts/test/fixtures/blogs/<source-id>/`.
- Modify `scripts/generate-feed.js`, `scripts/test/feed-contract.test.js`, `scripts/package.json`, both READMEs, and `docs/source-catalog.md`.

## Chunk 1: Configuration and Pure Discovery

### Task 1: Source configuration and canonical URLs

**Files:** Create `scripts/blog-source-config.js`, `scripts/test/blog-source-config.test.js`.

- [ ] **Step 1: Write failing tests** for required `id`, `name`, HTTPS `url`, `language`, nonempty ordered `discovery`, discovery type/URL, unique IDs, allow patterns, valid allow/exclude regex, parser allowlist, string selectors, and exclude-before-allow matching. Test relative URLs, default ports, fragments, trailing slashes, tracking removal, business query preservation, and invalid protocols.
- [ ] **Step 2: Verify RED:** `cd scripts && node --test test/blog-source-config.test.js`; expect missing-module failure.
- [ ] **Step 3: Implement** `validateBlogSources`, `canonicalizeArticleUrl`, and `matchesBlogSource`. Regex strings match canonical absolute URLs; validation reports source ID and field.
- [ ] **Step 4: Verify GREEN:** `cd scripts && node --test test/blog-source-config.test.js`.
- [ ] **Step 5: Commit:** `git add scripts/blog-source-config.js scripts/test/blog-source-config.test.js && git commit -m "feat: validate official blog source configuration"`.

### Task 2: RSS and Atom discovery

**Files:** Create `scripts/blog-discovery.js`, `scripts/test/blog-discovery.test.js`.

- [ ] **Step 1: Write failing tests** for RSS `item`, Atom `entry`, CDATA, XML entities, alternate links, relative URLs, descriptions, authors, malformed dates, source filtering, malformed XML, and the 12-candidate cap.
- [ ] **Step 2: Verify RED:** `cd scripts && node --test test/blog-discovery.test.js`.
- [ ] **Step 3: Implement pure** `parseBlogFeed(xml, source, baseUrl)` returning `{ title, url, publishedAt, description }` candidates without network or error mutation.
- [ ] **Step 4: Verify GREEN:** `cd scripts && node --test test/blog-discovery.test.js`.
- [ ] **Step 5: Commit:** `git add scripts/blog-discovery.js scripts/test/blog-discovery.test.js && git commit -m "feat: parse official blog feeds"`.

### Task 3: Sitemap and HTML discovery

**Files:** Modify `scripts/blog-discovery.js`, `scripts/test/blog-discovery.test.js`.

- [ ] **Step 1: Write failing Sitemap tests** for `urlset`, Sitemap Index, namespaces, relative URLs, `lastmod`, sorting, one-level child sitemap recursion, filtering, and malformed XML.
- [ ] **Step 2: Verify RED, implement `parseSitemap`, verify GREEN:** run `cd scripts && node --test test/blog-discovery.test.js` before and after.
- [ ] **Step 3: Write failing HTML tests** for quoted/unquoted anchors, relative URLs, nearby title/date metadata, duplicates, source filters, and separate Anthropic Interpretability/Science fixtures proving index membership boundaries.
- [ ] **Step 4: Verify RED, implement `parseBlogIndex`, verify GREEN:** run the same focused command before and after.
- [ ] **Step 5: Commit:** `git add scripts/blog-discovery.js scripts/test/blog-discovery.test.js && git commit -m "feat: parse blog sitemaps and indexes"`.

### Task 4: Ordered discovery fetching

**Files:** Modify `scripts/blog-discovery.js`, `scripts/test/blog-discovery.test.js`.

- [ ] **Step 1: Write failing tests** defining `BlogFetchOptions` defaults as `{ fetchImpl: globalThis.fetch, now: Date.now, timeoutMs: 15000, errors: [], shadow: false }`. Cover timeout signal use, exact sanitized `Blog: <source>: discovery-<type>: <message>` errors, isolated default arrays, fallback after request failure or zero valid candidates, no fallback after valid candidates, successful empty discovery versus total failure, and Sitemap Index child fetching.
- [ ] **Step 2: Verify RED:** `cd scripts && node --test test/blog-discovery.test.js`.
- [ ] **Step 3: Implement** `discoverBlogArticles(source, options)` using one successful strategy and no state mutation.
- [ ] **Step 4: Verify GREEN:** `cd scripts && node --test test/blog-discovery.test.js`.
- [ ] **Step 5: Commit:** `git add scripts/blog-discovery.js scripts/test/blog-discovery.test.js && git commit -m "feat: orchestrate official blog discovery"`.

## Chunk 2: Article Extraction and Collection

### Task 5: Characterize and move legacy article extractors

**Files:** Create `scripts/blog-extraction.js`, `scripts/test/blog-extraction.test.js`; modify `scripts/generate-feed.js`.

- [ ] **Step 1: Export existing article extractors temporarily and write characterization tests** using compact Anthropic Engineering and Claude Blog article fixtures.
- [ ] **Step 2: Verify characterization GREEN:** `cd scripts && node --test test/blog-extraction.test.js`.
- [ ] **Step 3: Move only** `extractAnthropicArticleContent` and `extractClaudeBlogArticleContent` into `blog-extraction.js`; keep test expectations unchanged.
- [ ] **Step 4: Verify GREEN:** `cd scripts && node --test test/blog-extraction.test.js test/feed-contract.test.js`.
- [ ] **Step 5: Commit:** `git add scripts/blog-extraction.js scripts/generate-feed.js scripts/test/blog-extraction.test.js scripts/test/fixtures/blogs && git commit -m "refactor: isolate legacy blog article extraction"`.

### Task 6: Generic article extraction

**Files:** Modify `scripts/blog-extraction.js`, `scripts/test/blog-extraction.test.js`.

- [ ] **Step 1: Write failing tests** for JSON-LD object/array/`@graph`, approved Article types, `articleBody`, canonical, Open Graph/meta/h1/time fallbacks, `article`/`main`, configured selectors, entity decoding, boilerplate removal, and rejection below 200 non-whitespace characters.
- [ ] **Step 2: Verify RED:** `cd scripts && node --test test/blog-extraction.test.js`.
- [ ] **Step 3: Implement** `extractBlogArticle(html, articleUrl, source)`.
- [ ] **Step 4: Verify GREEN:** `cd scripts && node --test test/blog-extraction.test.js`.
- [ ] **Step 5: Commit:** `git add scripts/blog-extraction.js scripts/test/blog-extraction.test.js && git commit -m "feat: extract structured official blog articles"`.

### Task 7: Fetch and validate one article

**Files:** Create `scripts/blog-collector.js`, `scripts/test/blog-collector.test.js`.

- [ ] **Step 1: Write failing tests** for 15-second timeout, redirect URL, canonical precedence, final host/pattern revalidation, invalid content, ISO date, exact Blog item keys, exact sanitized article-stage errors, and isolated error defaults.
- [ ] **Step 2: Verify RED:** `cd scripts && node --test test/blog-collector.test.js`.
- [ ] **Step 3: Implement** `fetchBlogArticle(candidate, source, options)` returning a Blog item or `null` without state mutation.
- [ ] **Step 4: Verify GREEN:** `cd scripts && node --test test/blog-collector.test.js`.
- [ ] **Step 5: Commit:** `git add scripts/blog-collector.js scripts/test/blog-collector.test.js && git commit -m "feat: fetch validated official blog articles"`.

### Task 8: Collection, concurrency, state, and generator integration

**Files:** Modify `scripts/blog-collector.js`, `scripts/blog-discovery.js`, `scripts/generate-feed.js`, collector/contract tests; create `config/feed-blogs.json`.

- [ ] **Step 1: Create a minimal production config fixture** containing only the two already implemented sources, so integration tests have an authoritative runtime config before live promotion.
- [ ] **Step 2: Write failing collection tests** for 72-hour filtering, top-only undated candidates, three-item source cap, global four-request concurrency, canonical/legacy state lookup, cross-source dedupe, state update only after valid extraction, isolated source failures, and exact errors.
- [ ] **Step 3: Verify RED, implement `fetchBlogContent`, verify GREEN:** run `cd scripts && node --test test/blog-collector.test.js` before and after.
- [ ] **Step 4: Write failing generator tests** asserting Blog config override; move `parseAnthropicEngineeringIndex` and `parseClaudeBlogIndex` into discovery; assert `--shadow` and `--blog-source=<id>` never write Feed/state and print a valid envelope.
- [ ] **Step 5: Verify RED, integrate, verify GREEN:** run `cd scripts && node --test test/feed-contract.test.js test/blog-collector.test.js` before and after.
- [ ] **Step 6: Commit:** `git add config/feed-blogs.json scripts/blog-discovery.js scripts/blog-collector.js scripts/generate-feed.js scripts/test/blog-collector.test.js scripts/test/feed-contract.test.js && git commit -m "feat: integrate official blog collection and shadow mode"`.

## Chunk 3: Candidate Inventory, Live Promotion, and Documentation

### Task 9: Candidate inventory and offline fixtures

**Files:** Create `config/blog-source-candidates.json`, `scripts/test/fixtures/blogs/<source-id>/discovery.*`, and `article.html`; modify `scripts/test/blog-source-config.test.js`, `scripts/test/blog-discovery.test.js`, and `scripts/test/blog-extraction.test.js`.

- [ ] **Step 1: Write a failing 17-source inventory contract** asserting exact IDs/names, complete validation, and one compact discovery/article fixture per source. Keep this distinct from the production-enabled list.
- [ ] **Step 2: Verify RED:** `cd scripts && node --test test/blog-source-config.test.js test/blog-discovery.test.js test/blog-extraction.test.js`.
- [ ] **Step 3: Add candidate definitions and official fixtures** from the design matrix, reduced to minimum markup that preserves structure.
- [ ] **Step 4: Verify GREEN:** run the same focused command.
- [ ] **Step 5: Commit:** `git add config/blog-source-candidates.json scripts/test/fixtures/blogs scripts/test/blog-source-config.test.js scripts/test/blog-discovery.test.js scripts/test/blog-extraction.test.js && git commit -m "test: cover approved official blog candidates"`.

### Task 10: Executable live validator

**Files:** Create `scripts/validate-blog-sources.js`, `scripts/test/validate-blog-sources.test.js`; modify `scripts/package.json`.

- [ ] **Step 1: Write failing tests** for `--source=<id>`, candidate all-source mode, `--production`, unknown IDs, read-only behavior, JSON report fields, and nonzero exit unless every selected source discovers and extracts at least one valid article.
- [ ] **Step 2: Verify RED:** `cd scripts && node --test test/validate-blog-sources.test.js`.
- [ ] **Step 3: Implement validator and package commands** `npm run validate-blog-sources -- --source=<id>` and `npm run validate-blog-sources -- --production`, reporting `{ sourceId, discovery, candidates, validArticles, errors, passed }`. Default mode reads the candidate inventory; production mode reads `config/feed-blogs.json`. It must not import feed/state write functions.
- [ ] **Step 4: Verify GREEN:** `cd scripts && node --test test/validate-blog-sources.test.js`.
- [ ] **Step 5: Commit:** `git add scripts/validate-blog-sources.js scripts/package.json scripts/test/validate-blog-sources.test.js && git commit -m "test: add live official blog validator"`.

### Task 11: Validate and promote sources

**Files:** Modify `config/feed-blogs.json`, `docs/source-catalog.md`.

- [ ] **Step 1: Validate all candidates:** `cd scripts && npm run validate-blog-sources -- > /tmp/follow-up-blog-validation.json`. Every source needs `candidates >= 1`, `validArticles >= 1`, and `passed: true`; `no-new-content` is insufficient.
- [ ] **Step 2: Retry each failure:** `cd scripts && npm run validate-blog-sources -- --source=<id>`. Fix evidenced parser/config problems only after a failing fixture test. Official WAF/network failures remain candidates and prevent full completion unless the user approves exclusion.
- [ ] **Step 3: Promote passing objects** from candidate inventory into `config/feed-blogs.json`, then run `cd scripts && npm run validate-blog-sources -- --production > /tmp/follow-up-blog-production-validation.json` and require exit 0.
- [ ] **Step 4: Commit:** `git add config/feed-blogs.json docs/source-catalog.md && git commit -m "feat: enable validated official blog sources"`.

### Task 12: Source truth and full verification

**Files:** Modify `README.md`, `README.zh-CN.md`, `docs/source-catalog.md`.

- [ ] **Step 1: Update source truth** with actual production count, names, discovery methods, validation dates, and catalog links. Never describe candidates as implemented.
- [ ] **Step 2: Verify shadow isolation:** run `rtk shasum feed-blogs.json state-feed.json > /tmp/follow-up-before.sha`; `cd scripts && rtk node generate-feed.js --blogs-only --shadow > /tmp/follow-up-blog-shadow.json`; return to the repository root and run `rtk shasum feed-blogs.json state-feed.json > /tmp/follow-up-after.sha`; then run `rtk cmp /tmp/follow-up-before.sha /tmp/follow-up-after.sha`. Expect `cmp` exit 0.
- [ ] **Step 3: Run full verification:** `cd scripts && npm test`; `cd scripts && npm run validate-feeds`; `cd scripts && npm run validate-release`; `git diff --check`. Expect all exit 0.
- [ ] **Step 4: Commit:** `git add README.md README.zh-CN.md docs/source-catalog.md && git commit -m "docs: record official blog source coverage"`.
