# Changelog

All notable changes to Follow-up are documented in this file.

## [0.3.1] - 2026-09-09

- 修复摘要校验与最终生成的文件名约定不一致：validator 在写入前拒绝无法被 finalize 消费的输出文件名，避免报告校验成功后才失败。
- Skill 明确原始 selection 与验证后 selection 使用独立目录、相同 `<digestId>.json` 文件名；保留准备和生成阶段的错误诊断。
- 新增校验到生成、stdout 投递的交接回归，保留 requestHash、确定性选择、原子激活和失败时不投递旧内容的防护。
- Feed 过期和来源覆盖不足仍按 `partial` 披露；本补丁不声称修复中央采集覆盖，也不更改用户日程、凭据或投递目标。

## [0.3.0] - 2026-09-09

已于 2026-09-09 公开发布。

- 新增 Python Acquisition Runtime、Signal Batch 契约、source registry、受控 vendoring
  与 RSS/官网 Blog Adapter。
- 新增四种采集输入模式的 Digest 消费、批次原子发布和 shadow 指标模块。
- 新增隔离 Python 3.12 安装、哈希锁定依赖与 wheel，使用登记的绝对解释器和 `-I` 运行。
- 统一采集与 Digest 准备入口，保留授权门禁，落实正文 7 天、元数据 90 天留存。
- 新增来源级运行历史、人工复核、切换与重置 CLI；迁移要求 14 天观察、至少 3 次通过
  检查的真实运行及不低于 80% 人工相关性。hybrid 回滚到中心，local 隔离失败来源。
- 最终发布验收仍在进行；保持 central 默认输入，未执行中心 Feed 来源下线。详见 [项目进度](docs/project-progress.md) 和
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
