# Follow-up 项目进度

更新日期：2026-09-09

## 当前状态

Follow-up 当前产品版本为 `0.2.0`。本版本的功能开发、文档、发布归档与本地验收均已
完成；公开发布状态以 [GitHub Releases](https://github.com/TheGoldenWave/Follow-up/releases)
中的 `v0.2.0` 为准。

`v0.3.0` 于 2026-09-08 启动，核心实现与 Digest 集成、原子发布、迁移指标已落地，当前在
`feature/v0.3.0-acquisition-runtime` 分支开发，尚未发布正式版本。规划文档见
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

## v0.3.0 进行中：主要模块已实现，端到端与发布待收尾

核心模块已落地（本版本 Task 1–7；不表示原计划全部验收项已完成）：

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
- 历史验证记录（2026-09-08，非本次复验）：Python 140 例 + Node（含新增采集/Digest 集成用例）全绿；secret 扫描零命中；
  `git diff --check` 干净；实网 smoke test（36kr / apple-ml / openai-alignment）产出的
  batch 均通过契约校验。
- Digest 集成（Task 17–18，`scripts/lib/`）：`normalize-central-feeds.js`（中心 Feed
  按 `config/sources.json` 稳定 `source_id` 归一化）、`load-signal-batches.js`
  （Signal Batch snake_case → 内部 camelCase 候选）、`route-channels.js`（固定/核心主题
  路由 + `review` 队列兜底）、`resolve-acquisition-input.js`（central/shadow/hybrid/
  local 四模式合并）；`prepare-digest.js` 已接通 acquisition mode。
- 采集与原子发布模块（Task 19，部分完成）：`collect-and-prepare.js` + `run-acquisition.js`
  调用 Python runtime + `publish-batches.js` 原子写入 `runs/<run_id>/` 与 `latest.json`
  指针（临时文件 fsync + rename，校验失败不改指针）。
- 迁移指标与门禁/回滚（Task 20）：`src/follow_up_acquisition/migration.py`（overlap/
  duplicate/error 指标 + 切入门禁 + 回滚触发）+ `scripts/report-shadow.js` 逐来源报告；
  切换顺序与中心 Feed 下线步骤见 `docs/operations/local-acquisition-runbook.md`。

### 本次核对发现的剩余工作

核对基线为本地 `dcfb979`（2026-09-08），核对开始时工作区干净；本地存在 `v0.1.0`、
`v0.2.0` tag。本次未查询远端发布资产，因此不据此确认线上发布或真实采集状态。

| 优先级 | 缺口与证据 | 完成条件 |
|---|---|---|
| P0 | `bootstrap-acquisition.js` 仅探测 Python 并写 runtime.json；未创建隔离环境、安装锁定依赖或 wheel；`run-acquisition.js` 默认使用 python3.12 | 干净安装可运行 RSS/Blog，采集使用登记的绝对解释器路径 |
| P0 | `collect-and-prepare.js` 仅采集与发布，未调用 Digest 准备；`SKILL.md` 仍直接调用 prepare-digest.js | 手动与定时入口贯通采集、准备、既有授权门禁，使用隔离目录完成端到端验证 |
| P0 | `report-shadow.js` 只统计单批次，runCount 固定为 1、relevance 为 null；Node/Python 门禁均允许未复核相关性通过 | 接入历史记录、人工抽样、完整门禁与来源级迁移状态；缺失证据不得放行 |
| P0 | 版本元数据仍是 0.2.0，Python 包为 0.3.0；release workflow 未运行 Python 测试 | 统一候选版本、更新 manifest 与 Python 发布验证，完成归档安装演练 |
| P1 | 本地 Blog fixture 主要为通用样本，未见 17 来源本地 shadow 对比验收记录 | 补齐逐来源样本与覆盖报告；不能以少量实网 smoke 代替完整观察 |

Task 17–20 因此记为“已有实现，部分验收未闭环”，Task 21 仅有运维计划。
后续可执行任务、依赖和验收标准见 [版本开发计划](version-roadmap.md)。

### 2026-09-09 收尾基线复验

- Python：`PYTHONPATH=src .venv/bin/python -m unittest discover -s tests -q`，140 项通过。
- Feed：`npm --prefix scripts run validate-feeds`，6 类中心 Feed 与 candidate Feed 通过。
- Node：`npm --prefix scripts test`，599 项，593 通过、4 失败、2 取消；包括安装路径
  替换测试超时、归档 npm 安装失败与旧 manifest 完整性不匹配。不得视为全绿。
- release validator：旧 manifest 的 tracked digest 和关键文件哈希与当前 HEAD 不匹配。
- 远端只读核对：GitHub 最新公开版本仍为 v0.2.0；v0.3.0 尚未发布。
- 已进入 R1–R4 收尾开发；完成后需要重新生成完整性信息并复验精确发布归档。

### 收尾实现进展（2026-09-09，尚未发布）

- R1 已通过规格与质量审查，实现隔离 Python 安装、依赖哈希锁、wheel 安装与绝对解释器登记；正常采集使用
  `-I` 隔离环境，屏蔽 pip 安装目标污染。13 项定向 Node 测试通过，全新临时 HOME 安装及真实本地 HTTP
  RSS/Blog 抽取测试通过；发布归档安装仍待 R4 复验。
- R2 修正 local 模式读取中心 Feed 和缺本地加载器静默降级的问题；统一入口调用
  Digest 准备，每次采集使用独立 staging 目录。候选池保留首次发现时间、7/90 天
  正文/元数据留存和失败来源屏蔽，命令加互斥锁；仍需完整四模式端到端验证。
- R3 修正缺人工相关性证据时误放行；报告计算支持去重后的运行历史和显式门禁证据。
  历史落盘、来源级切换与回滚执行尚待接通。
- 最新本地验证：Python 141 项通过，prepare/collect/report 定向 Node 44 项通过；
  安装路径替换安全测试用单次镜像配置重跑通过。原先超时已从隔离安装日志定位到 npm
  tarball ETIMEDOUT；未修改全局配置或降低完整性校验。
- 当前仍未更新正式版本号、生成最终 manifest、打 tag 或发布 v0.3.0。

### 第二轮收尾验证

- 已将 VERSION/Node 包与候选 manifest 更新为 0.3.0；公开发布仍未执行，哈希待代码定稿生成。
- R2 四模式真实请求生成、首次 weekly 历史不足、正文/批次过期、先验证后发布等边界已修复；
  独立复审执行 89 项相关 Node 测试通过。
- Python 全量现为 145 项通过，包含 Node/Python 迁移判定一致性测试。
- R3 已补人工复核绑定、历史落盘、切换/回滚 CLI 与有效运行观察门禁，正在最终复审。
- GitHub 发布保护已只读核验：v* tag 禁止更新/删除，发布确认变量有效。
- R4 仍需最终完整性哈希、全量发布测试、精确归档安装与公开资产验证。

尚未纳入 v0.3.0（按冻结范围归入后续版本）：GitHub/HN/Reddit/Techmeme/arXiv（v0.4.0）、
YouTube/播客/Digg（v0.5.0）、X（v0.6.0）、小红书/微信公众号 Sidecar（v0.7.0）。中心
Feed 逐来源下线（Task 21）需各来源连续 14 天本地观察通过门禁后执行，属观测后运维动作，
已记录运行手册，不绑定固定版本号。

## 使用路径

1. 从 `v0.2.0` GitHub Release 下载归档、checksum 和 `release-manifest.json`。
2. 按项目 [中文 README](../README.zh-CN.md#安装-v020) 完成校验、安装和 `doctor` 检查。
3. 输入 `set up follow-up`，选择关注频道、daily 或 weekly 频率及投递目标并逐项授权。
4. 输入 `/follow-up` 请求一次按需 Digest；定时推送仅在 Onboarding、schedule 和确切
   destination 三项授权均有效时运行。

## 当前边界

`0.2.0` 发布版尚未实现本地采集、认证 Sidecar、长期反馈学习、行业报告、分页个人 Feed、
显式已读/未读操作、自动更新发现和自动回滚。`v0.3.0`（开发中）开始落地 RSS 与官网
Blog 两类本地采集 Adapter 及 shadow mode，但 GitHub/HN/Reddit/Techmeme/arXiv
（v0.4.0）、YouTube/播客（v0.5.0）、X（v0.6.0）与 Sidecar（v0.7.0）仍待后续版本。
官网 Blog 的 72 小时窗口用于采集恢复，并不是固定推送最近 72 小时内容；Digest 实际
从滚动历史里的合格未推送候选中选取。

## 后续方向

- `v0.3.0`（当前）：完成实现验收、实网观察与发布归档；逐来源切换仍须满足至少 3 次
  真实运行、14 天观察和门禁条件，中心 Feed 下线不绑定版本号。
- `v0.4.0`：GitHub、Hacker News、Reddit、Techmeme、arXiv Adapter；目标是统一社区与
  学术来源的限流、分页、去重和失败回退。
- `v0.5.0`：YouTube、播客、Digg，以及 managed local tools 的受控安装与兼容性诊断。
- `v0.6.0`：X Adapter，优先支持公开、免登录路径，凭据来源默认关闭并保留降级策略。
- `v0.7.0`：小红书/微信公众号 Sidecar；补充认证生命周期、权限提示和隔离故障处理。
- 后续产品能力：已推/看过/未推状态、按需加载更多、反馈学习、行业报告和自动更新，
  待 v0.4.0 之后按采集稳定性与用户反馈冻结版本号。

以上是路线图方向，不代表已交付能力；具体范围以对应版本的产品设计与开发计划为准。

## 验证与发布门禁

- 完整 Node 测试、Feed/candidate Feed、Schema、secret、provenance、license 和 release
  validator 是发布前必过项。
- 发布归档仅包含 Git tracked 内容，禁止包含 `.hermes/`、`docker/`、`.env`、
  `node_modules/`、`dist/` 和 `docs/wechat-integration.md`。
- 发布 workflow 匹配 `v*` tag，并校验 tag 与 `VERSION` 一致；外部保护配置本次未复核。公开资产发布后需
  再验证 checksum、tag target 和安装流程。
