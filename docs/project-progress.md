# Follow-up 项目进度

更新日期：2026-09-08

## 当前状态

Follow-up 当前产品版本为 `0.2.0`。本版本的功能开发、文档、发布归档与本地验收均已
完成；公开发布状态以 [GitHub Releases](https://github.com/TheGoldenWave/Follow-up/releases)
中的 `v0.2.0` 为准。

`v0.3.0` 规划已于 2026-09-08 启动：范围冻结为 Acquisition Runtime、Signal Batch、
source registry、受控 vendoring 与 RSS/Blog shadow mode。规划文档见
[superpowers/plans/2026-09-08-v0.3.0-acquisition-runtime.md](superpowers/plans/2026-09-08-v0.3.0-acquisition-runtime.md)，
canonical 方向见
[2026-09-01 本地采集与 Adapter 设计](superpowers/specs/2026-09-01-local-acquisition-adapters-design.md)。

## v0.2.0 已完成

- 统一用户入口为 `set up follow-up` 和 `/follow-up`，继续兼容
  `~/.follow-builders/` 用户数据目录。
- 接入 6 类中心化公共 Feed，共 70 个稳定 namespaced 信源，其中包含 17 个官网 Blog。
- 建立滚动 candidate Feed，支持初始化、增量合并、有界留存和来源完整性披露。
- 对全部已启用来源执行跨源聚类与个性化重要性排序，使用 60 分门槛，每期目标为
  6-10 条，不以低重要性内容凑数。
- daily、weekly 和按需 Digest 只选择符合资格的未推送内容；pending、已投递和
  `delivery-uncertain` 内容不会自动重复发送。
- 完整检查无达标内容时发送“今日无重要更新”或“本周无重要更新”；`partial` 和
  `incomplete-history` 不会冒充完整无更新。
- 提供 stdout、Telegram 和 email 投递编排，以及 append-only ledger、outbox、失败与
  不确定投递的人工处置。
- 提供 Codex、Claude Code 和 custom Skill 目录安装，支持 v0.1 升级、不可变安装对象、
  完整性校验与 `doctor` 诊断。

完整信源清单见 [信源目录](source-catalog.md)，详细行为边界见
[v0.2.0 产品设计](superpowers/specs/2026-09-05-v0.2.0-product-closure-design.md)。

## v0.3.0 进行中

核心范围已全部落地（Task 1–7）：

- 新增 Python 3.12 包 `follow_up_acquisition`（`src/`、`pyproject.toml`）：核心层
  （contracts/runtime/config/cache/redaction）纯标准库、离线可跑；`rss`/`blog` 额外
  依赖 `feedparser==6.0.14`/`trafilatura==2.2.0` 以 optional extras 声明，保持基础层
  可离线安装。CLI 提供 `--version`、`doctor`、`run`。
- 新增版本化 Signal Batch 契约：`contracts/signal-batch.schema.json`（JSON Schema
  2020-12）+ 纯标准库校验器 `contracts.py`，含 10 种来源状态分类与凭据键名递归拒绝。
- 新增 Acquisition Runtime（`runtime.py`）：窄 Adapter 协议、候选标准化、跨源去重
  （原生 ID → canonical URL）、来源状态聚合与契约序列化；附带 7/90 天 TTL 缓存与脱敏。
- 新增权威 source registry（`config/sources.json`，82 来源 / 70 live / 7 频道），由
  `scripts/build-source-registry.py` 生成；`config.py` 校验唯一不可变 ID、channel
  policy、adapter 引用与凭据引用约束。
- 新增受控 vendoring：`vendor/manifest.json` + `vendor.py` 校验器（结构 + 哈希比对，
  哈希过期即失败）+ `scripts/vendor/sync-last30days.sh` + 溯源文档；已复刻
  `last30days-skill@3.22.0`（commit `fcebe321`）的 MIT 许可证与 `cjk.py`（CJK 分词，
  jieba 可选、无 jieba 时退化为二元字符）。
- 新增共享 RSS Adapter（`adapters/rss.py`，feedparser）：覆盖 blog/newsletter/
  podcast/中文科技 fixture，以及缺失 GUID、畸形日期、CDATA、播客 enclosure 等边界，
  缺失日期/无稳定 ID 时产出 item_warning。
- 新增官网 Blog Adapter（`adapters/web_publication.py`，feedparser + trafilatura）：
  发现顺序固定为 RSS → sitemap → 索引页；索引布局漂移→`schema-drift`、单篇抽取
  失败→`item_warnings`、整体不可达→`unreachable`。
- `run` 命令接通 shadow mode（`collect.py`）：按注册表构造 rss/web-publication
  Adapter，产出写入隔离的 `~/.follow-builders/acquisition/`；`doctor` 报告注册表摘要。
- 测试：Python 124 例 + Node 5 例全绿；secret 扫描零命中；`git diff --check` 干净；
  实网 smoke test（36kr / apple-ml / openai-alignment）产出的 batch 均通过契约校验。

尚未纳入 v0.3.0（按冻结范围归入后续版本）：GitHub/HN/Reddit/Techmeme/arXiv（v0.4.0）、
YouTube/播客/Digg（v0.5.0）、X（v0.6.0）、小红书/微信公众号 Sidecar（v0.7.0），以及
Digest 集成与中心 Feed 下线（Task 17–21，由质量门禁驱动）。

## 使用路径

1. 从 `v0.2.0` GitHub Release 下载归档、checksum 和 `release-manifest.json`。
2. 按项目 [中文 README](../README.zh-CN.md#安装-v020) 完成校验、安装和 `doctor` 检查。
3. 输入 `set up follow-up`，选择关注频道、daily 或 weekly 频率及投递目标并逐项授权。
4. 输入 `/follow-up` 请求一次按需 Digest；定时推送仅在 Onboarding、schedule 和确切
   destination 三项授权均有效时运行。

## 当前边界

`0.2.0` 尚未实现本地采集、认证 Sidecar、长期反馈学习、行业报告、分页个人 Feed、
显式已读/未读操作、自动更新发现和自动回滚。官网 Blog 的 72 小时窗口用于采集恢复，
并不是固定推送最近 72 小时内容；Digest 实际从滚动历史里的合格未推送候选中选取。

## 后续方向

- `v0.3.0` 起：建设 Acquisition Runtime、Signal Batch、source registry，并按质量门禁
  将公共来源逐步迁移到本地采集。
- 后续采集版本：逐步覆盖 GitHub、Hacker News、Reddit、Techmeme、arXiv、YouTube、
  播客及获得授权的认证来源。
- 后续产品版本：建设已推、看过、未推状态、按需加载更多内容、反馈学习、行业报告和
  自动更新能力；具体版本号尚未冻结。

以上是路线图方向，不代表已交付能力；具体范围以对应版本的产品设计与开发计划为准。

## 验证与发布门禁

- 完整 Node 测试、Feed/candidate Feed、Schema、secret、provenance、license 和 release
  validator 是发布前必过项。
- 发布归档仅包含 Git tracked 内容，禁止包含 `.hermes/`、`docker/`、`.env`、
  `node_modules/`、`dist/` 和 `docs/wechat-integration.md`。
- 正式版本由受保护的 `v0.2.0` tag 触发 GitHub Actions 构建和发布；公开资产发布后需
  再验证 checksum、tag target 和安装流程。
