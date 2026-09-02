# Follow-up Version Release and Upgrade Design

Status: Approved direction; `v0.1.0` is the first release baseline

Date: 2026-09-02

## Purpose

Follow-up needs a release model that lets the Skill, acquisition runtime, Adapter
bundle, managed tools, and authenticated Sidecars evolve without forcing users to
reinstall everything or lose local configuration and login state.

The product currently has no Git tag or GitHub Release. The repository can only be
identified by commit. The first release is therefore `v0.1.0`, a reproducible
baseline of the existing centralized-Feed product. Local acquisition remains a
planned capability until its per-source migration gates pass.

## User-facing release policy

- GitHub Releases are the canonical distribution source.
- The Follow-up Skill is the primary install and upgrade entry point.
- Only a Stable channel is maintained.
- The Skill may check for a newer release, but it must explain the change and obtain
  user confirmation before downloading or switching versions.
- Update checks must not upload the installed configuration, source list, credentials,
  login state, or usage telemetry.
- Users see one product version. Internal component versions and compatibility checks
  are handled by the release manifest and `doctor`.

## Version model

The user-facing product uses Semantic Versioning while the project is below `1.0`:

- Patch releases contain compatible fixes, source-protocol repairs, and security
  updates that preserve configuration meaning.
- Minor releases add compatible product capabilities, sources, or configuration.
- Major releases may require an explicit product choice or remove compatibility.
- Before `1.0`, minor releases may still contain substantial changes. Every such
  change must preserve old behavior through migration or require explicit consent.

The product version coordinates independently versioned internals:

| Component | Version form | Compatibility owner |
|---|---|---|
| Skill and Follow-up Core | SemVer | Product release |
| Acquisition Runtime | SemVer | Release manifest |
| Adapter Bundle | `YYYY.MM.revision` | Acquisition Runtime compatibility range |
| Managed Tools | Exact upstream version and artifact hash | Tool manifest |
| Xiaohongshu/WeChat Sidecar wrapper | SemVer | Versioned local proxy protocol |
| Upstream Sidecar | Exact release, commit, or image digest | Sidecar manifest |
| Configuration Schema | Monotonic integer | Migration engine |
| Signal Batch Contract | Major/minor schema version | Producer/consumer compatibility |

Internal versions are diagnostic information, not independent choices presented
during normal onboarding.

## Stable release manifest

Every release contains `release-manifest.json`. It is the machine-readable authority
for installation and upgrade and contains:

- product version, release date, channel, minimum supported prior product version,
  and release notes URL;
- each component's version, artifact, SHA-256 digest, supported operating systems and
  architectures, license/provenance reference, compatibility constraints, minimum
  secure version, and revoked versions;
- configuration migrations and supported Signal Batch and Sidecar protocol versions;
- whether a component requires user authorization, a login refresh, or sensitive-data
  migration;
- package-level integrity information and, when supported by that release's declared
  trust mode, the release signing identity.

The manifest schema is versioned. Installers reject unknown required fields,
unsupported platforms, signatures that are missing or invalid when the declared trust
mode requires them, digest mismatches, incompatible or revoked component ranges, and
missing migration paths before changing the active installation.

`v0.1.0` uses a transitional `github-tag-sha256` trust mode: the user obtains the
release from the canonical `TheGoldenWave/Follow-up` repository over GitHub HTTPS and
confirms that the release tag resolves to the commit declared by the Release. The
manifest stored in the tag records the repository tree identity and hashes for critical
release files; it cannot contain the digest of an archive that itself contains that
manifest. A separate checksums Release asset records the complete archive digest and is
published by the tag-triggered workflow. This detects corruption and accidental
replacement within the stated GitHub trust boundary but does not protect against
compromise of the GitHub repository or owner account. `v0.1.0` therefore distributes
source and JavaScript only, not prebuilt native executables or Sidecar images.

Before distributing managed executable or Sidecar artifacts, a later release must
introduce a stronger trust mode with a pinned verification identity, documented key or
identity rotation, revocation handling, and CI-produced attestations or signatures.
The upgrader applies the trust policy declared by the installed release; it must not
silently downgrade from a signature-required mode to `github-tag-sha256`.

## Installation layout and atomic activation

Installed product and mutable user data are separated:

```text
~/.follow-builders/
  active.json                 # atomic pointer to the active product/component set
  releases/<product-version>/ # immutable Skill/Core release content
  runtime/<version>/          # versioned Acquisition environments
  adapters/<version>/         # immutable Adapter bundles
  tools/<tool>/<version>/     # pinned managed tools
  sidecars/<name>/<version>/  # wrappers and immutable program content
  config/generations/<id>/    # immutable-at-activation configuration generations
  config/current              # convenience pointer resolved from active.json
  state/                      # user-owned state and reading history
  credentials/                # local secret references/material
  sidecar-data/<name>/        # persistent login/session data
  backups/                    # bounded migration backups
```

An upgrade downloads into staging, verifies the manifest and artifacts, creates new
immutable component directories, copies and migrates configuration into a new
generation, and runs `doctor`. `active.json` identifies both the executable component
set and its configuration generation; one atomic replacement activates them together.
`config/current` is repaired from `active.json` and is not an independent source of
truth. Mutable state, credentials, and Sidecar login data are never stored inside a
release directory.

The prior active manifest and release directories remain available through the
post-upgrade observation window. Garbage collection retains at least the active and
previous known-good product versions and never deletes user data or login state.

## Upgrade classes

The Skill classifies an available update before asking for confirmation:

| Class | Examples | Behavior after confirmation |
|---|---|---|
| Compatible | Skill text, Core fix, compatible Adapter fix | Stage, verify, switch, observe |
| Migrating | Configuration or local metadata schema change | Back up, migrate copy, verify, switch |
| Authorization required | QR login, broader Cookie/API scope, credential rewrite | Upgrade unaffected components; keep that source on its old component until separately authorized |
| Incompatible/blocking | No valid migration, unsupported OS, contract mismatch | Refuse activation and keep the current version |

Authorization is scoped to the affected source. A normal product-upgrade confirmation
does not authorize scanning a QR code, reading browser cookies, expanding permissions,
or moving sensitive data.

## Partial component activation

The product release manifest describes a compatible set, but components that require
new authorization may remain on their previous compatible version. The active manifest
records the effective version of every component, so diagnostics distinguish the
desired release from the currently active source component.

Partial activation is allowed only when the new product manifest explicitly declares
the old component compatible. If it does not, the source stays disabled or the whole
activation is refused. The installer must never guess compatibility.

Compatibility cannot override security revocation. If the release manifest marks the
installed component below its minimum secure version or lists it as revoked, the
affected source is disabled until the secure component is installed and any required
authorization is completed. Other sources may continue upgrading. The Skill explains
that the source was disabled for security rather than presenting it as merely offline.

After the user completes authorization, the new Sidecar is started against a copy or
explicitly supported reuse of its data directory, checked through the authenticated
localhost proxy, and switched independently. A failed authorization or health check
leaves the old component and session untouched.

## Configuration and data migrations

- Configuration carries an integer `schema_version`.
- Migrations are ordered, deterministic functions that advance exactly one version.
- Every migration is tested against representative old fixtures and is idempotent or
  protected from double execution by recorded migration state.
- The upgrader creates a new configuration generation before migration; it never
  mutates the active generation in place.
- Rollback atomically restores the previous executable set and its previous
  configuration generation from the old `active.json`. It does not attempt a lossy
  reverse migration.
- User edits made after activation remain preserved in the failed generation. They are
  not silently replayed into the old schema; the Skill may offer an explicit,
  compatibility-checked recovery after rollback.
- Unknown user fields are preserved unless a documented migration explicitly replaces
  them. Credentials remain references and must not appear in backups or logs as clear
  text beyond their already protected local store.
- Content cache migrations may discard reproducible cache entries, but must preserve
  source subscriptions, feedback, reading state, delivery settings, and handoff records.

## Health checks, observation, and rollback

Before activation, `doctor` checks package integrity, runtime compatibility, manifest
constraints, configuration validity, required local tools, Sidecar protocol support,
and write access to owned directories. Network or platform authorization failures are
reported per source and do not become a false global success.

After activation, the first real run is an observation run. A crash, unreadable
configuration, contract failure, manifest mismatch, or failure to start the core
runtime automatically restores the previous `active.json`, which restores the prior
executable and configuration generation together. Source-specific network,
rate-limit, or expired-login states do not roll back unrelated components; they use
the source status and fallback rules defined by the local-acquisition design.

Automatic rollback does not silently restore stale content, roll credentials backward,
or overwrite mutable user state outside the versioned configuration generation.

## First installation

`v0.1.0` does not depend on an updater that has not yet been built. Its supported first
installation path is intentionally simple:

1. The user opens the canonical GitHub Release and downloads the source archive and
   checksum file for `v0.1.0`, or asks an Agent capable of installing a repository Skill
   to install that exact tag.
2. The user or Agent verifies the archive using the `github-tag-sha256` trust mode and
   extracts it to a user-selected local directory.
3. The Agent registers the tagged `SKILL.md` using its normal local Skill mechanism.
   Follow-up does not modify an Agent's global Skill registry without user approval.
4. When local Digest or delivery scripts are needed, the installer runs `npm ci` in
   the tagged `scripts/` directory using Node.js 20 or a compatible supported runtime.
5. The installation reports the product version from the root `VERSION` file and the
   release manifest. A mismatch is an installation error.

The `v0.1.0` release notes document these steps. Automatic discovery, staging,
activation, and rollback are delivered with the upgrade foundation in `v0.2.0`.

## Runtime content compatibility

Release code and executable Prompt behavior are immutable. `v0.1.0` loads Prompt files
from its tagged local installation by default; it must not automatically replace them
from a mutable `main` branch. An explicitly configured custom Prompt is user data and
is reported separately in diagnostics.

Central Feeds remain mutable content services during the migration period, but each
Feed carries a schema version. The released consumer declares the Feed schema versions
it supports, validates every Feed before use, and reports an incompatible future schema
instead of guessing. A schema change that remains compatible may increment a minor Feed
schema version; an incompatible schema requires a new product release with a transition
window in which the central generator can publish both representations or the consumer
can read both. Feed payload changes do not alter the installed product version.

## Release pipeline

A Stable release is produced only from a clean, reviewed commit:

1. Verify repository tests, schemas, secret scanning, license/provenance manifests,
   generated-file consistency, and clean-install fixtures.
2. Validate `release-manifest.json` against its schema, repository tree identity, and
   critical tracked-file hashes.
3. Build release archives from tracked files only and generate a separate checksums
   Release asset for complete-archive verification.
4. Create the signed/annotated immutable `vX.Y.Z` tag.
5. Let the tag-triggered workflow publish one GitHub Release with manifest, checksums,
   release archive, release notes,
   compatibility notes, and any manual authorization requirements.
6. Install the public assets into a temporary home and run the clean-install and
   reinstall-recovery smoke tests before marking `v0.1.0` complete. Executable and
   configuration rollback exercises become mandatory when the upgrade foundation is
   introduced in `v0.2.0`.

For `v0.1.0`, reinstall recovery means extracting the same tagged archive into a fresh
program directory and running `npm ci` again while an existing test
`~/.follow-builders` contains configuration, custom Prompts, and placeholder delivery
credentials. The operation must leave that entire user directory byte-for-byte
unchanged. It does not claim automatic rollback or migration.

Tags and release assets are never replaced. A defective release is deprecated and
superseded by a new patch version.

## `v0.1.0` baseline

`v0.1.0` establishes versioning without claiming the planned updater exists. It includes:

- the current Skill-first product using centralized public Feeds;
- the six currently described live Feed categories: X, podcasts, official blogs,
  Newsletters, academic papers, and Chinese technology media;
- Digest preparation and current delivery behavior;
- `VERSION`, `CHANGELOG.md`, the first release manifest, manifest validation, a tracked
  release archive/checksum build path, and a Stable GitHub Release;
- release-local Prompt loading and versioned/validated central Feed contracts so the
  tagged consumer does not execute mutable `main`-branch Prompt behavior;
- documentation that local acquisition, Adapter management, authorized Sidecars,
  automated configuration migration, and Skill-driven upgrades are planned rather
  than present capabilities.

The draft WeChat Docker integration is excluded from `v0.1.0`: it uses an unpinned
image and exposes a host port outside the approved authenticated localhost-proxy model.
It must be absent from `v0.1.0` release artifacts and replaced before WeChat is
released as a supported capability.

## Planned product milestones

| Version | Scope |
|---|---|
| `v0.1.0` | Reproducible centralized-Feed baseline and release metadata |
| `v0.2.0` | Acquisition Runtime, Signal Batch contract, vendoring, and upgrade foundation |
| `v0.3.0` | Source registry, managed tools, RSS/blog/GitHub/HN/Reddit in shadow mode |
| `v0.4.0` | YouTube, podcasts, Digg, Techmeme, and arXiv; source-level hybrid migration |
| `v0.5.0` | Authorized X, Xiaohongshu, and WeChat Sidecars |
| `v0.6.0` | Local-acquisition onboarding, diagnostics, and source-level fallback |
| `v0.7.0` | Central acquisition retired after all source observation gates pass |
| `v0.8.x` | Reliability, security, recovery, and cross-platform hardening |
| `v0.9.0` | Configuration, Signal Batch, Sidecar, and upgrade contract freeze |
| `v1.0.0` | Stable local-first product with documented compatibility commitments |

Milestones describe intended scope, not deadlines or already delivered capability.

## Release support policy

- Before `v1.0`, the project supports the latest Stable release and one previous minor
  release for upgrade and rollback testing.
- From `v1.0`, each minor release supports direct upgrade from the latest patch of the
  previous two minor releases. Older installations upgrade through documented bridge
  releases.
- Security or platform breakage is fixed in a new patch release. Upstream Adapter and
  Sidecar changes are reviewed, pinned, attributed, and tested before distribution.
- Release notes separate user-visible changes, source behavior changes, migration
  actions, authorization actions, security changes, and known limitations.

## `v0.1.0` acceptance criteria

- The release is built from tracked files at a clean, immutable commit.
- The source archive, manifest, checksums, Tag, and GitHub Release all report `0.1.0`
  consistently.
- A clean installation can identify its product version offline and run the documented
  centralized-Feed preparation path using release-local Prompts.
- Every published central Feed has a declared schema version, and the released consumer
  rejects unsupported schemas with an actionable error.
- The six documented live Feed categories are present; planned local acquisition and
  Sidecars are not represented as implemented.
- The release archive contains no untracked files, local credentials, generated login
  state, unsafe WeChat Docker draft, or unrelated development artifacts.
- Release verification includes syntax/configuration checks, secret scanning, manifest
  validation, checksum verification, and a clean-install smoke test.

## Upgrade-foundation acceptance criteria

These criteria become release gates when the upgrade foundation is introduced in
`v0.2.0`; they do not block the initial `v0.1.0` baseline:

- A clean installation can identify its product and component versions offline.
- Upgrade discovery exposes only newer Stable releases and requires confirmation.
- Failed verification or migration leaves the prior installation active.
- Configuration, user state, credentials, and Sidecar login data survive compatible
  upgrades and executable rollback.
- An authorization-required source can remain on its previous compatible component
  without blocking unrelated upgrades.
- No manifest, log, archive, backup, or diagnostic output exposes source or delivery
  credentials.
- `v0.1.0` artifacts reproduce the documented centralized-Feed behavior and do not
  include untracked development files.
