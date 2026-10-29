# Changelog

All notable changes to Follow-up are documented in this file.

## [Unreleased]

- 修复中央 Feed 第二次自锁：`feed-contract.test.js` 断言仓库当次发布的 `feed-blogs.json` 非空。
  2026-10-18 博客源当天没有新增，按设计发布了一份合法的空 blogs Feed 并提交到 `main`；次日起
  预检必然读红，排在 Generate feeds 之前的 Test 步骤中止整个作业，空 Feed 永远等不到被替换，
  中央 Feed 停在 `2026-10-18T11:13:09.031Z`，10-19 至 10-28 连续 10 次定时任务失败。现在改为
  与该签入文件逐项比对，并断言不存在 `Blog feed is invalid` 错误——与 X 渠道「凭证缺失发布空
  Feed」的处理同形，空发布与非空发布都成立，测试不再依赖上一次运行发布了什么。
- 新增 `Feed Freshness` 定时工作流：每天读取已发布 `feed-candidates.json` 的 `generatedAt`，
  超过 48 小时即开或更新一条 issue 并让作业失败，把下一次静默停更的发现时间从「数周」缩短到
  「一天」。

- 修复中央 Feed 发布死锁：`release-manifest.json` 的 `integrity.trackedContent.digest` 覆盖
  整棵受版本控制文件树，而 publish 作业每天把 8 个 Feed 文件提交到 `main`，使这个密封值每天
  被提交本身作废，`release-manifest.test.js` 判红，排在 Generate feeds 之前的 Test 步骤随之中止
  整个作业——中央 Feed 自 2026-09-27 起 17 天没有更新。现在该 digest 排除 `ARTIFACT_FILES` 与
  `feed-artifact-checksums.txt`（算法升到 `git-ls-tree-sha256-v2`），Feed 产物自身的完整性仍由
  `scripts/validate-feed-artifact.js` 的校验和门禁负责。
- 修复 `scripts/test/collect-and-prepare.test.js` 统一入口用例的时间炸弹：时钟冻结在
  `2026-09-09`，却用仓库签入的 `feed-candidates.json` 当夹具，Feed 前进后候选 `lastSeenAt`
  晚于 `generatedAt`，central/shadow/hybrid 三个模式返回 1。夹具观测时间戳现在归一到冻结时钟。
- 修复 `scripts/test/feed-contract.test.js` 断言 `result.data.x.length > 0`：X 渠道缺
  `X_BEARER_TOKEN` 时按设计发布空 Feed，该断言把测试与仓库凭据绑定。改为与签入文件逐项比对，
  非空断言移到不依赖凭据的 blogs 渠道。

- 修复中央 Feed 发布作业从未真正可用的缺陷：`Generate Feeds` 的 publish 作业按设计不安装依赖、
  也不执行测试，但它调用的 `scripts/validate-feed-artifact.js` 需要 `ajv`。由于生成环节自
  2026-09-06 起一直在失败，该缺陷始终没有暴露；2026-09-27 生成第一次成功后，publish 作业以
  `Cannot find package 'ajv'` 失败，Feed 仍然没有落地。
- 现在工件校验门只使用标准库：generate 作业保留 schema 与 registry 门禁
  （`npm run validate-feeds`），通过后写出八文件校验和；publish 作业用该校验和核对下载的工件，
  并继续拒绝多余、缺失、符号链接、非 JSON 和被替换的文件。发布内容与 generate 已接受的内容
  逐字节绑定，publish 依旧不安装依赖、不接触凭据、不执行测试。

## [0.4.0-beta.6] - 2026-09-27

- 打通用户配置的采集凭据。spec 已冻结凭据契约、`GitHubAdapter` 也已实现并有单测，但生产调用链从未注入
  `credential_resolver`，`community:github` 只能匿名运行，被硬上限 24/9/15/0 请求钉死在
  `partial` + `github-request-budget-exhausted`。新增用户配置 `acquisition.sourceCredentials`
  （`"<source_id>": {"ref": "env.VARIABLE_NAME"}`），经 `collect-and-prepare.js` 与
  `collect run --credential-ref` 传递到适配器。
- 新增 `src/follow_up_acquisition/credentials.py` 作为引用格式与 token 形状的唯一真源：只接受
  `env.VARIABLE_NAME`，已配置但不可解析时返回 `auth-failed`，不静默降级为匿名；未配置引用时
  匿名行为逐字不变。
- 修复中央 Feed 生成在缺少单一渠道凭据时整体中断：`scripts/generate-feed.js` 过去只要
  `X_BEARER_TOKEN` 或 `POD2TXT_API_KEY` 任一缺失就抛错终止，使 2026-09-06 之后每日定时任务
  连续失败、`feed-candidates.json` 长期冻结（订阅端表现为 `feedFresh=false` 与 42 个来源
  `error`）。现在缺失凭据只降级对应渠道：该渠道发布结构合法的空 Feed，其全部来源状态记为
  `error` 并注明缺失的变量名，其余渠道照常采集与发布；显式 `--<channel>-only` 仍按失败关闭处理。
- 修复 `Generate Feeds` 定时工作流：该工作流的测试步骤执行完整 Node 套件，其中
  “Python staging → 不可变 Node run → Python CAS” 用例会真的启动解释器；CI 既不创建
  文档化的本地 `.venv`，也没有像发布工作流那样传入 `FOLLOW_UP_TEST_PYTHON`，因此
  2026-09-21 至 2026-09-26 每日定时任务都以 `spawn .venv/bin/python ENOENT` 失败，
  Feed 连续 6 天没有更新。现在定时任务显式准备隔离解释器并传入该变量。
- 本版本用于本机安装验证，不代表六来源真实 smoke、人工相关性、shadow 或 live/cutover 门禁已经通过。

## [0.4.0-beta.5] - 2026-09-18

- 发布 v0.4 社区与学术来源的 beta：GitHub、Hacker News、Reddit、Techmeme、arXiv 与 Hugging Face Papers 已接入本地采集。
- 新增逐候选 core-topic 路由、独立 review queue、community evidence、selection/artifact 1.1 与来源 checkpoint 恢复。
- 修复 macOS/Linux 状态文件发布校验：被替换的 inode 在 Linux 上会被立即复用，导致发布边界校验失效；现在 state 与 temp 描述符跨越发布边界保持打开。
- 修复本地隔离安装读取构建 wheel 名称的方式：不再预测 PEP 440 归一化后的文件名，改为读取实际构建产物，使本地采集 bootstrap 在版本变化后仍可用。
- 隔离安装冒烟测试适配 v0.4 的公开 HTTPS 来源限制，改用运行时自签证书的 loopback HTTPS 夹具。
- 这是 prerelease，用于本机验证；不代表六来源真实 smoke、人工相关性、shadow 或 live/cutover 门禁已经通过。

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
