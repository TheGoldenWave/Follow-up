# Changelog

All notable changes to Follow-up are documented in this file.

## [0.3.0] - 2026-09-09

- 新增 Python Acquisition Runtime、Signal Batch 契约、source registry、受控 vendoring
  与 RSS/官网 Blog Adapter。
- 新增四种采集输入模式的 Digest 消费、批次原子发布和 shadow 指标模块。
- 尚待完成运行时安装、采集到 Digest 的统一入口、完整迁移门禁及发布验收；保持 central
  默认输入，未确认中心 Feed 已下线。详见 [项目进度](docs/project-progress.md) 和
  [版本开发计划](docs/version-roadmap.md)。

## [0.2.0] - 2026-09-07

### Added

- Added production collection for 17 official Blogs with source-level completeness
  status and a 72-hour discovery-recovery window.
- Added executable channel selection, a retained rolling candidate pool, cross-source
  Digest scoring and selection, and daily or weekly schedule gates.
- Added an append-only delivery ledger and outbox with at-most-once automatic delivery,
  explicit resolution for uncertain attempts, and no duplicate automatic resend.
- Added a verified three-platform installer, immutable installed release pointers,
  preserved `~/.follow-builders/` user data, and the user-facing `doctor` command.
- Renamed the installed Skill and user entry point to `follow-up`, with `set up follow-up`
  and `/follow-up` as the supported onboarding and on-demand invocations.

### Known limitations

- Local acquisition, authenticated Sidecars, long-term feedback learning, industry
  reports, a paginated personal Feed, explicit read-state interaction, automatic update
  discovery, and automatic rollback are not implemented in this release.
- Scheduled delivery is daily or weekly; this release does not send immediate alerts
  when an official site publishes.

## [0.1.0] - 2026-09-02

### Added

- Established the first Stable product version and machine-readable release manifest.
- Defined the centralized Feed baseline for X, podcasts, official blogs, newsletters,
  academic papers, and Chinese technology media.
- Added release metadata validation for product version, runtime, channel, trust mode,
  and current capability boundaries.

### Known limitations

- Local acquisition and authenticated Sidecars are planned; they are not included in
  this release.
- Persistent feedback state and an automatic updater are not implemented.
- Industry reports remain a planned category rather than a seventh live Feed.
