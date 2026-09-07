**English** | [中文](README.zh-CN.md)

# Follow-up

Follow-up is a Skill-first personal AI Signal digest. Version `0.2.0` reads six
centrally generated public Feed channels, ranks important updates across all enabled
sources, and delivers a daily, weekly, or on-demand Digest. It is derived from
[follow-builders](https://github.com/zarazhangrui/follow-builders) and keeps compatible
user data under `~/.follow-builders/`.

The supported user entry points are:

- say `set up follow-up` to start onboarding;
- invoke `/follow-up` for onboarding or an on-demand Digest.

The former product-name invocation is migration history, not a supported user entry
point in v0.2.

## Install v0.2.0

Requirements: Node.js 20 or newer and a pristine, extracted, verified GitHub Release
archive.

```text
curl -LO https://github.com/TheGoldenWave/Follow-up/releases/download/v0.2.0/Follow-up-v0.2.0.tar.gz
curl -LO https://github.com/TheGoldenWave/Follow-up/releases/download/v0.2.0/Follow-up-v0.2.0-checksums.txt
curl -LO https://github.com/TheGoldenWave/Follow-up/releases/download/v0.2.0/release-manifest.json
shasum -a 256 -c Follow-up-v0.2.0-checksums.txt
tar -xzf Follow-up-v0.2.0.tar.gz
cmp release-manifest.json Follow-up-v0.2.0/release-manifest.json
cd Follow-up-v0.2.0
node scripts/release/validate-release.js --archive-critical-only
cd scripts
npm ci
npm run validate-release:archive
npm run test:archive
cd ..
node scripts/install.js --platform <codex|claude-code|custom> [--skill-dir <absolute-path>] --register
node ~/.follow-builders/releases/0.2.0/scripts/doctor.js --json
```

`--register` explicitly approves creation of the `follow-up` Skill link. The installer
supports Codex, Claude Code, and a custom absolute Skill directory. Reinstalling the
same verified release preserves mutable configuration, custom Prompts, credentials,
delivery history, and candidate state under `~/.follow-builders/` byte for byte.

To upgrade from v0.1 when an old `follow-builders` registration exists, add
`--replace-follow-builders`. The installer removes the old link only after the new
link and local `doctor` checks succeed; it never renames or removes the user-data
directory.

`doctor` verifies the installed version and manifest, Node runtime, dependencies,
configuration, Skill registration, candidate Feed history, unresolved delivery
attempts, and network freshness. A network-only warning uses exit code 2; a local
integrity or configuration failure uses exit code 1.

The dependency-free `--archive-critical-only` check must run before `npm ci`. The
separate release checksum authenticates the complete archive within the declared
GitHub trust boundary; archive validation then checks every manifest-declared critical
file. The tracked content digest is recomputed only from the matching Git checkout
because an extracted archive contains no Git object database. This release has no
verified ClawHub first-install path and no automatic updater.

For maintainers, the release workflow is enabled only after an administrator has
externally confirmed a ruleset that protects `v*` tags and GitHub immutable releases,
then set `RELEASE_IMMUTABILITY_CONFIRMED=true`. The variable is a gate, not proof by
itself. Running the validator while checking the validator's own hash is
self-verification and cannot establish trust alone; the protected tag, separately
downloaded manifest, and complete-archive checksum remain the external anchors.

## What v0.2.0 Includes

Six live centralized channels are available:

| Channel | Current source path |
|---|---|
| X builders | Curated builder accounts |
| Podcasts | RSS and available transcripts |
| Official Blogs | 17 production official sites |
| Newsletters | Configured newsletter Feeds |
| Academic | arXiv-based research Feed |
| Chinese tech | Configured Chinese technology Feeds |

Industry reports remain planned and are not a seventh live Feed. The complete factual
inventory, including [Google Antigravity Blog](https://antigravity.google/blog), is in
the [source catalog](docs/source-catalog.md).

## Discovery, History, and Ranking

Official Blog collection inspects the most recent **72 hours** and up to 12 discovered
links per source, then accepts at most three valid new posts per source in one run.
This is a discovery-recovery window, not the user's delivery window.

The rolling candidate Feed retains history independently. Daily and weekly Digests
consider the eligible **unpushed** portion of that history, not simply everything
published in the last 72 hours. A successfully delivered item becomes pushed, unseen
until richer read-state interaction exists; pushed, unseen items are not automatically
resent. Pending or delivery-uncertain attempts also block automatic duplicates.

All enabled sources compete in one cross-source ranking. Candidates are clustered by
event and scored out of 100 for impact, user relevance, source authority, novelty, and
corroboration. The importance threshold is **60 points**. Selection targets **6-10**
items, caps concentration by source and channel, and never pads a Digest: 1-5 items are
valid when only that many qualify.

## Delivery Outcomes

Automatic delivery runs only after onboarding, schedule approval, and approval of the
exact destination. v0.2 supports daily and weekly schedules; it **does not send immediate alerts**
when an official site publishes.

- A complete run with qualifying items sends the ranked Digest.
- A complete daily run without qualifying items sends "Today: no important updates";
  a complete weekly run sends "This week: no important updates".
- `partial` means one or more enabled sources were not checked completely. Available
  qualifying items may be sent, but Follow-up does not claim that no important update
  exists.
- `incomplete-history` means the requested interval is not fully covered. The first
  weekly Digest remains in this bootstrap state until seven complete history days are
  proven; the available interval is disclosed instead.
- `delivery-uncertain` (delivery uncertain) means a provider handoff may have happened but cannot be
  confirmed. Follow-up keeps the attempt pending and requires explicit manual
  resolution; it does not retry or fall back automatically.

An empty channel selection produces `no-channels`, not a no-update message.

## Configuration

Onboarding writes `~/.follow-builders/config.json`. The six stable `enabledChannels`
values are `x`, `podcasts`, `blogs`, `newsletters`, `academic`, and `zh-tech`. A missing
field keeps all six enabled for v0.1 compatibility; an empty array is valid and pauses
Digest generation.

Scheduled runs require separate, current approvals for onboarding, schedule, and the
exact delivery destination. Manual `/follow-up` runs do not require schedule approval;
manual Telegram or email delivery still requires destination approval or immediate
confirmation.

## Product Boundary

v0.2.0 uses centralized public Feeds. It does **not** implement local acquisition,
authenticated Sidecars, long-term feedback learning, industry-report ingestion, a
paginated personal Feed, explicit read/unread actions, automatic update discovery, or
automatic rollback. These remain later-version work. A Signal or delivered Digest is
not evidence that the user read, understood, or endorsed it, and Follow-up never
automatically writes authoritative Malow or GoldenWave state.

## License and Authorization

Follow-up is distributed under the MIT terms in [LICENSE](LICENSE). Upstream-derived
code from `zarazhangrui/follow-builders` is included under confirmed MIT authorization
recorded through maintainer attestation on 2026-09-02. The public upstream repository
had no license file when reviewed, so this project does not claim that repository was
publicly MIT licensed. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
