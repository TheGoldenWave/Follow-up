# Follow-up 后续版本开发计划

更新日期：2026-09-17。当前开发目标：`v0.4.0`。

本文是当前版本范围与顺序的权威入口。2026-09-17 已确认把“多个预设领域、关键词和来源
可调”定义为独立的 `v0.5.0`，原 `v0.5.0` 及其后的计划整体顺延一个次版本。旧设计和母计划
中的原版本号仅作为历史定位；发生冲突时以本文为准。版本顺序尚无人员和工期承诺；
v0.3.0 及修复版 v0.3.1 已公开发布，其余按下列状态推进。
当前事实见 [项目进度](project-progress.md)。

## v0.3.0：先完成可安装、可运行、可验证的闭环

依赖顺序：R1 → R2 → R3 → R4。R5 可并行积累且不是发布前置条件，但来源切换和
中心来源下线不能跳过观察天数。

| 任务 | 工作范围 | 验收标准 |
|---|---|---|
| R1 运行时安装 | bootstrap-acquisition.js、run-acquisition.js、Python 依赖锁定与 wheel；衔接现有安装/doctor | 干净目录安装可运行 RSS/Blog；使用登记的绝对解释器；缺依赖可诊断；普通采集不静默安装 |
| R2 统一执行入口 | collect-and-prepare.js、prepare-digest.js、SKILL.md；串起采集、批次消费与 Digest 准备 | 四模式端到端 fixture 验证；central 不采集，shadow 不混入本地候选，hybrid 正确回退，local 不访问中心；不绕过投递授权 |
| R3 迁移闭环 | migration.py、report-shadow.js、来源级 migration.json；历史统计、抽样证据、门禁、回滚执行 | 缺复核不得通过；至少 3 次真实运行；Node/Python 判定一致；来源级切换持久化、可恢复；陈旧批次不得冒充新运行 |
| R4 发布工程 | VERSION、manifest、Node/Python 版本、release workflow、安装文档 | Python/Node/Feed/secret/provenance/license/release 校验通过；源码归档包含所需采集资产；精确归档干净安装与升级通过 |
| R5 来源观察 | newsletters/zh-tech → 17 个 Blog，逐来源补 fixture 和真实运行记录 | 保存运行时间、状态、去重率、人工相关性和回滚证据；至少 14 天观察后才讨论中心来源下线 |

- [x] R1：运行时安装与解释器消费闭环（实现、真实 RSS/Blog 安装测试和两阶段审查通过；精确发布归档另由 R4 验证）。
- [x] R2：四模式端到端准备流程、授权门禁和历史留存验证通过；独立复审 89 项回归通过。
- [x] R3：完整门禁、历史状态、人工复核与来源级切换/回滚，已通过复审。
- [x] R4：完整测试、归档安装与升级、公开发布及下载验证通过；自动工作流失败与修复记录见项目进度。
- [ ] R5：逐来源观察报告；Task 21 单独执行、单独可回退。

发布 v0.3.0 可以保留 central 默认值及 shadow 试用；发布完成不等于中心 Feed 已下线。
2026-09-09 用户已授权推进 v0.3.0 收尾与发布。继续保留现有用户运行模式；
中心 Feed 下线仍须独立观察证据，不能由发布动作隐式触发。

## v0.4.0：社区与学术来源

前置条件：v0.3.0 的 R1–R4 通过，来源级失败不会影响其他来源。

`v0.4.0-beta.3` 可作为明确标注的 prerelease 发布，用于安装验证；稳定版 `v0.4.0` 仍须满足
本节完整 smoke、人工相关性与来源级观察门禁。
对应采集母计划 Task 9/10/13（Task 13 在本版只包含 Techmeme/arXiv）以及新增 HF-1；
HF-1 的设计见 `superpowers/specs/2026-09-14-hugging-face-papers-source-design.md`，具体实施步骤待后续计划拆分。

1. 先实现 GitHub/Hacker News：固定来源身份、分页与增量窗口、原生指标、限流/超时分类。
2. 接入 Techmeme/arXiv：列表与条目身份标准化、更新时间语义、来源去重与频道映射。
3. 执行 HF-1，接入 Hugging Face Papers：一个 `academic:hugging-face-papers` 来源同时覆盖按运行日期生成的 Daily、Trending 与 ISO Weekly 页面；来源内合并三视图，curation 阶段再按 arXiv ID 优先与现有学术候选聚为同一 event cluster。保留榜单位置、upvote 和 GitHub 关联作为独立的社区热度/发现证据，不替代论文原始元数据，也不混入事实交叉印证成员或 `corroboration` 计分。
4. 接入 Reddit：免 Key 路径优先，可选增强默认关闭；主题路由沿用现有频道与 review 队列。
5. 每类加入契约、正常/空结果/限流/部分失败 fixture；Hugging Face Papers 还需覆盖时区日期边界、跨年 ISO 周、多视图重复、三视图状态聚合、与 arXiv 的 event clustering、原始论文 lead 选择、独立社区证据成员及确定性 `corroboration` 计分，再走 shadow → 来源级门禁。

验收：6 类 Adapter 可独立运行、失败状态明确，native ID/URL 去重稳定；Hugging Face
Daily、Trending 与 Weekly 作为同一来源，部分视图失败时来源状态为 `partial`，三个视图
均失败时为 `error`；不新增平台命名
频道，不因 Adapter 就绪自动下线中心来源。不包含 X、视频转录和认证 Sidecar。

### v0.4.0 交付清单（2026-09-15）

基础检查点与四类社区 Adapter 已完成，但 v0.4.0 尚未完成：

- [x] Foundation Task 1：受限、固定 allowlist 且将已验证公网地址 pinned 到 TLS 连接的
  HTTPS client；redirect/public-IP/path、timeout、body 与安全错误分类失败关闭。
- [x] Foundation Task 2：macOS/Linux 逐来源、逐 stream 状态与 CAS；其他平台本地状态失败关闭。
- [x] Foundation Task 3：内部 immutable checkpoint update 契约；pending update 不进入 Signal Batch。
- [x] Foundation Task 4：canonical Registry 89/all、70 `central-live`、54 `local-enabled`；
  原有 82 个 source ID 保持不变。
- [x] Foundation Task 5：Node 独占原子 run 发布；immutable intent/receipt/pointer hash chain；
  全部发布完成后才逐 stream CAS。
- [x] Community Adapter：GitHub、Hacker News、Reddit、Techmeme 已实现并接入本地采集；
  core-topic 按候选内容与 query provenance 路由，未分类候选仅进入独立 review queue。
- [x] Academic Adapter：arXiv 与 Hugging Face Papers 三视图均已实现并接入采集，含逐 stream
  checkpoint 和状态聚合。
- [x] Community evidence：GitHub/HN/Reddit/Hugging Face 的独立社区发现与热度证据已进入
  curation、selection 和 artifact；事件聚类和 `corroboration` 只使用事实来源。
- [ ] Smoke 与 cutover 门禁：六类真实来源逐一 smoke，记录 machine-verifiable 结果、人工相关率、
  secret 检查和回滚证据；通过 shadow 与来源级门禁前不得 live/cutover。
- [ ] Release：更新最终版本源与 release manifest，完成 Node/Python/Feed、secret、license、
  provenance、精确归档安装/升级及公开资产验证，再发布 v0.4.0。

当前没有任何新增来源 live/cutover，central Feed 仍为默认输入且未下线任何中心来源。
Windows 本地来源状态不受支持，但 central 模式继续可用。Foundation 的已记录基线为
Python 364/364、Node Task 5/durable 70/70、Registry 107/107 与 59/59、HTTP client 38/38、
state 94/94；最新 Python 全量 523/523 通过。Hacker News 与 arXiv `cs.LG` 的隔离 smoke
已为 `ok`，但尚缺人工相关性记录且其余来源未通过。Node 功能回归通过，但完整套件的 5 项
release/归档用例仍拒绝旧 `v0.3.1` manifest；真实来源 smoke、人工相关性、来源级观察和最终
release manifest 仍未完成，因此此处不标记 v0.4.0 完成。

## v0.5.0：预设领域与可调来源闭环

目标：用户不再只能使用固定 AI 频道，而是选择一个关注领域，并在同一领域内调整关键词和
来源。首批提供三个预设：AI 前沿 `ai-frontier`、软件开发与开源
`software-engineering`、教育与学习 `education-learning`。
版本级设计见
[`2026-09-17-v0.5.0-domain-presets-design.md`](superpowers/specs/2026-09-17-v0.5.0-domain-presets-design.md)。

1. 建立版本化 `DomainPreset` 目录，统一声明默认关注词、排除词、来源、重要性样例和能力要求。
2. 用户可在 Onboarding 或配置中选择领域，添加关注词/排除词，开启、关闭和添加公开来源；
   旧用户确定性迁移到 AI 前沿，保留频道、语言、日程、投递授权和历史。
3. 统一中心与本地来源身份及有效来源集合，使采集、候选校验、路由、完整性、doctor 和摘要
   使用同一领域配置快照，修复“已登记但无法进入摘要”的目录不一致。
4. 支持公开 RSS/Atom 与已支持网页来源的校验和内容预览，展示“为何相关”、来源可用状态及
   覆盖缺口；不承诺任意网页都能持续订阅。
5. 领域上下文贯穿采集、过滤、排序和 Digest；教育等非 AI 内容不得被 AI 关键词前置过滤。
6. 评估并试接入 AIHOT 等聚合发现源：先以 RSS/API 在 `shadow` 中验证独有发现率、重复率、
   原文链接和人工相关性；聚合结果标记为 `community-discovery`，不得作为独立事实印证。
   AIHOT 公开内置或面向外部用户持续再分发前，必须取得与实际用途匹配的书面授权。

验收：三个模板均有真实公共来源和正反例；每个新模板先以 3–5 个互补来源起步，至少两个
发布主体且至少一个一手入口；添加、关闭、切换和失败披露可操作；切换领域不重复投递既有
候选；`central` 无法覆盖非 AI 领域时必须明确提示，不得伪装“今日无重要更新”。任意自建领域、
多领域独立日报和自动长期学习不在本版。AIHOT 试点评估通过不等于默认启用；正式内置还需
完成授权确认、契约 Fixture、增量/撤选同步、来源级健康检查和回滚验收。

## v0.6.0：视频、播客与受控工具

前置条件：v0.5.0 的领域、来源覆盖和预算契约稳定。对应历史母计划 Task 6/11/12。

1. 建立 managed local tools 清单、固定版本、完整性校验、显式 bootstrap 与 doctor。
2. YouTube 先做固定频道/Feed 发现，再分层提供字幕或转录；搜索配额单独预算。
3. 播客复用 RSS 发现，公开 transcript 或用户配置的转录路径作为可选增强。
4. 增加长内容预算、文本/转录 7 天清理验证与工具升级回归样本；Digg 重新核验独有价值后
   再决定是否纳入，不作为本版默认承诺。

验收：无转录仍保留合法来源元数据；不静默安装工具；缺凭据来源默认关闭；不持久化付费
全文；工具失败不阻塞其他来源。每类先 shadow 观察，播客 RSS fixture 不等同完整能力交付。

## v0.7.0：X 来源

前置条件：工具治理、凭据引用和来源级降级稳定。对应历史母计划 Task 14。

1. 明确公开免登录与可选认证路径的可用性、预算和失败分类，冻结可支持的采集范围。
2. 完成账号/查询身份映射、日期可信度、分页去重与限流测试。
3. 验证认证失效、来源不可达及路径切换时不会重推，也不会输出凭据。

验收：账号稳定映射，凭据仅使用引用，日志与批次脱敏；不承诺无限量抓取或持续实时可用。

## v0.8.0：小红书与微信公众号 Sidecar

前置条件：共用凭据、预算、健康和撤销协议稳定。对应历史母计划 Task 15/16，但两个来源
分别验收、互不等待，也不以 X 成功作为串行前置。

1. 冻结 Sidecar 版本、部署边界、健康协议与用户显式启用流程。
2. 分别完成小红书和微信公众号指定来源的认证、采集、过期与撤销闭环。
3. 补充登录失效、Sidecar 离线、协议漂移、升级与凭据清理测试。

验收：默认关闭；用户拥有认证；Cookie/扫码会话不进入仓库、批次或摘要；失效给出可执行
提示且不影响公共来源。接入可用不意味着授权自动扩展到全部账号和内容。

## v0.9.0：local-first 产品闭环

统一 local-first Onboarding、跨平台诊断、来源迁移和回滚体验。允许不同来源处于 central、
shadow、hybrid 或 local，但用户能看到每个来源的状态、最近成功时间、覆盖和恢复动作。

## v0.10.0：契约冻结与 v1 候选

冻结配置、DomainPreset、Signal Batch、community evidence、Sidecar 和升级契约；完成兼容矩阵、
数据迁移、恢复演练和弃用策略。只有稳定性与兼容承诺满足后才进入 v1.0.0。

## v1.0.0：稳定 local-first 产品

对已冻结契约提供正式兼容承诺；公开来源、本地来源和可选认证来源均遵守统一的证据、预算、
健康、隐私与回滚边界。

## 产品能力储备（版本号待冻结）

| 顺序 | 能力 | 进入开发前需要明确 |
|---|---|---|
| 1 | 看过/未看与加载更多 | 区分阅读状态和已有投递 ledger；分页游标、留存窗口、重复展示策略 |
| 2 | 显式反馈与排序学习 | 反馈入口、冷启动、撤销与清除；不破坏重要性门槛 |
| 3 | 行业报告与 PDF 深读 | 数据源授权、版本识别、引用可追溯与生成成本；不把低频报告套入 Blog 时间窗 |
| 4 | OPML 与来源迁移 | 导入先预览，不携带凭据，不自动启用付费或认证来源 |
| 5 | 任意自建领域与多领域日报 | 领域隔离、预算、调度、去重和冷启动需要单独设计 |
| 6 | 更新发现与恢复 | 可信版本发现、兼容性与用户数据保护；沿用不可变安装对象 |

这些能力先形成中文产品设计与验收场景，再拆实施任务；不以本路线图替代需求冻结。

## 计划维护

每次版本收尾更新项目进度、对应实施计划和 Changelog；只在验收证据齐全时勾选完成。
开发完成、fixture 验证、真实运行、公开发布分别记录。任何具体日程从范围和资源确认后
计算；14 天观察从首个有效真实运行起算，不从代码提交日或本文日期起算。
