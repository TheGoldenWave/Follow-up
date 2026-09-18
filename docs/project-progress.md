# Follow-up 项目进度

更新日期：2026-09-17

## 当前状态

最新正式版本 [v0.3.1](https://github.com/TheGoldenWave/Follow-up/releases/tag/v0.3.1)
已于 2026-09-09 发布，Release 为 immutable。标签提交为
`e7d04a8b470cbca12ffe4b11e1e6f6e5f1210413`。修复 validator 与 finalize 输出文件名
契约不一致，Skill 明确验证后文件使用独立目录和同一 digestId 文件名。

当前开发分支准备发布 `v0.4.0-beta.5` prerelease，用于本机验证。beta 不替代稳定版
`v0.3.1`，不表示六来源真实 smoke、人工相关性、shadow 或 live/cutover 门禁已通过。

`v0.4.0-beta.1`–`v0.4.0-beta.4` 的 build 作业均在
`Verify Python acquisition and isolated installation` 失败，未产出任何公开资产；
beta.4 的失败记录为 GitHub run `35306338974`。失败原因是
`tests/acquisition/test_state_store_posix.py` 的两项 inode 替换用例在 Linux 上未抛出
`PosixBackendError`：发布身份校验只比较 `(st_dev, st_ino)`，而 state 与 temp 的描述符在
校验前已关闭，Linux 会把刚释放的 inode 号复用给替换文件，macOS 不复用，因此本地始终通过。
本次让两个描述符跨越发布边界保持打开，使被替换的 inode 无法被回收，并补充直接断言该不变量
的回归用例。beta.1–beta.4 的标签与提交保持不变，修复只进入 `v0.4.0-beta.5`。

由于此前每次 build 都在 Python 步骤快速失败，后续门禁从未真正执行，本次全量本地回归又暴露出
三处只在 CI 才触发的既有缺陷，一并修复：

- `scripts/bootstrap-acquisition.js` 用常量预测构建 wheel 的文件名。该名字实际是
  `pyproject.toml` 版本的 PEP 440 归一化结果（`0.4.0-beta.5` 构建出
  `follow_up_acquisition-0.4.0b5-py3-none-any.whl`），常量在版本变化后必然失配，使
  v0.4 的本地隔离安装完全不可用。现改为读取构建目录中实际产出的 wheel。
- `scripts/test/collect-and-prepare.test.js` 硬编码 `.venv/bin/python`，与 CI 的
  `/tmp/follow-up-python-tests` 不一致。现由 `FOLLOW_UP_TEST_PYTHON` 覆盖，工作流设置该变量，
  本地仍回退到文档化的 `.venv`。
- `scripts/test/runtime-install.integration.test.js` 沿用 v0.3.0 夹具：对 `rss` 来源传入
  v0.4 已不再接受的 `discovery` 字段，且使用 `http://127.0.0.1`。v0.4 只接受公开 HTTPS 来源，
  因此改为在 loopback 上以临时自签证书提供 HTTPS 夹具，并通过 `SSL_CERT_FILE` 让子进程信任
  该一次性 CA；证书在运行时生成到临时目录，不进入版本库。覆盖范围不变，仍验证隔离安装后
  RSS 采集与 Blog 正文抽取均成功。

v0.3.1 历史发布验收：Node 24 全量 648 项通过、1 项安装 smoke 单独通过；Python 145 项通过；
精确归档 81 项通过、2 项 Git-only 跳过；交接 2 项及全新隔离 RSS/Blog 安装通过。
原失败请求在隔离输出目录生成成功，状态仍为 partial，未改变实际投递历史。

GitHub run `34334305647` 在 Node 20 因既有测试的 `Object.groupBy` 不兼容失败，
未产出公开资产；本次发布的是同一受保护标签的本地验收归档。公开下载 checksum、
manifest、归档字节比对通过。测试兼容修正在发布后提交，不修改 tag 或不可变资产。

首位用户本机已升级 0.3.1，doctor 9 项健康、0 警告、0 错误；16 个配置和历史文件
逐字节未变。未启用本地采集，无需迁移 Python 用户运行时。安装器拒绝覆盖旧版本
Skill 链接，已备份旧链接后由安装器重新注册；自动跨版本链接替换仍需后续改进。

上一公开版本为 [v0.3.0](https://github.com/TheGoldenWave/Follow-up/releases/tag/v0.3.0)，
于 2026-09-09 发布。R1–R4 已完成。发布 tag 指向 `8d90eaccf7db751064ccc2e2140d420321470a4f`，
公开归档与本地通过验收的精确归档逐字节一致，Release 为 immutable。

## 已有产品基线

- 用户入口为 `set up follow-up` 和 `/follow-up`，兼容 `~/.follow-builders/` 用户数据。
- 6 类中心公共 Feed、70 个稳定信源（含 17 个官网 Blog）；完整清单见 [信源目录](source-catalog.md)。
- 滚动候选历史、跨源事件聚类与重要性排序，门槛 60 分，每期目标 6–10 条，不为凑数降门槛。
- daily、weekly 与按需 Digest；投递 ledger/outbox 阻止重复自动发送，不确定投递需人工处置。
- Onboarding、schedule 与确切 destination 授权门禁，以及 Codex/Claude Code/custom 安装和 doctor。

## v0.3.0 已完成

| 范围 | 当前实现 |
|---|---|
| 采集基础 | Python 3.12 Runtime、版本化 Signal Batch 契约、source registry、受控 vendoring、RSS/官网 Blog Adapter |
| R1 安装 | 显式 bootstrap 创建隔离环境，安装哈希锁定依赖与 wheel；登记绝对解释器，日常以 `-I` 运行，不静默安装 |
| R2 统一入口 | collect-and-prepare 串起采集、批次原子发布和 Digest 准备；四模式验证，保留授权与失败披露，正文/元数据按 7/90 天留存 |
| R3 迁移 | 保存来源运行历史及真实批次人工复核；inspect/review/cutover/reset CLI；14 天、3 次通过检查的真实运行及 ≥80% 相关性门禁 |
| 来源回滚 | hybrid 回退中心输入；local 隔离该来源并报告错误，不访问中心 Feed；不改写已投递内容 |

central 仍为默认值；shadow 不将本地候选混入 Digest。功能实现不代表所有来源已完成
真实观察，也不代表中心 Feed 已下线。配置、切换和回滚见 [运行手册](operations/local-acquisition-runbook.md)。

## v0.4.0 开发进度（2026-09-17）

v0.4.0 Foundation Task 1–5 已完成，为后续社区与学术 Adapter 提供以下基础：

- 受限公共 HTTP client 仅允许固定 allowlist 上的 HTTPS，将已验证公网地址 pinned 到 TLS 连接，
  并对重定向、路径、timeout、body 上限和安全错误分类逐跳执行门禁。
- macOS/Linux 提供逐来源、逐 stream 的本地状态与 CAS；安全 POSIX I/O、并发锁、目录/文件
  身份复核和 durability uncertainty 均失败关闭。其他平台的本地状态明确失败关闭，不使用路径
  fallback。
- canonical Registry 保留原有 82 个不可变 source ID，新增后共有 89 个来源；其中
  `central-live` 70 个、`local-enabled` 54 个，各消费者必须显式选择 scope。
- Runtime 以内部 immutable `CheckpointUpdate` 携带待提交更新，严格验证 stream、前置时间、
  checkpoint 字段、大小和凭据；更新不进入公开 Signal Batch。
- Node 是唯一原子 run publisher：完整 batches、immutable checkpoint intent 和 `run.json` 经
  校验、hash 绑定、fsync 与同目录 rename 后才公开；不可伪造的 immutable publication receipt
  绑定 run manifest、intent 与 batch hash，latest pointer 再绑定 receipt 证据。全部 pointer 发布后
  才调用 Python 对 intent 重算 hash 并逐 stream CAS；冲突或 durability uncertainty 保留已发布 run，
  以 partial/uncertain 报告，不自动重试。

基础完成后，GitHub、Hacker News、Reddit、Techmeme、arXiv 和 Hugging Face Papers 六类
Adapter 均已提交实现并接入采集入口；arXiv/Hugging Face 的逐 stream checkpoint 会在原子 run
发布后才提交。社区来源按候选正文与 query provenance 逐条路由，无法分类的候选写入独立的
review queue，不进入 Candidate Feed 或 Digest。Community evidence 已进入 curation、selection
和最终摘要，且不会充当事实交叉印证。

没有任何 v0.4 新来源完成真实 smoke、shadow 门禁或 live/cutover。central Feed 仍是默认输入，
也没有任何中心来源下线。Windows 本地来源状态仍不受支持，但 central 模式继续可用。

隔离真实 smoke 已验证 Hacker News（10 条）和 arXiv `cs.LG`（3 条）为 `ok`；它们尚未完成
人工相关性记录，且 GitHub、Techmeme、Reddit 和 Hugging Face 仍未通过，因此不构成六来源
smoke 或 shadow 门禁通过。

最新回归为 Python 全量 523/523 通过。Node 功能回归通过，但完整套件中的 5 项发布/归档
用例仍按预期拒绝旧 `v0.3.1` immutable manifest 与 v0.4 源码不一致；在真实来源门禁完成前
不得刷新为 `0.4.0`。上述测试不替代真实来源 smoke、人工相关性和来源级观察证据。

## v0.3.1 历史发布验证与既有观察项

本节结果属于 2026-09-09 的 v0.3.1 正式发布对象，不是当前 v0.4.0 开发分支结果；
完整测试与归档计数见上文“历史发布验收”。

- 精确归档全新 Python 安装及 RSS/Blog 抽取通过；三平台注册、安装/重装与投递 fixture 通过。
- manifest、Feed、secret、license、provenance、公开下载 checksum 与 tag target 验证通过。
- GitHub 自动流程因 Python 对照测试先于 Node 依赖安装而失败，未生成资产；本次将同一受保护
  tag 的本地完整验收归档发布，未改写 tag。工作流依赖顺序修复提交为 `26affbb`，用于后续版本。
- 远端中心采集任务发现缺少 `POD2TXT_API_KEY` 的问题；本地 Feed 校验通过不能证明远端
  所有来源采集正常，也不能把中心采集失败解释为没有更新。
- R5 是逐来源真实观察，不是 v0.3.0 发布前置条件。17 个官网 Blog 的完整本地观察验收
  尚未完成；至少 14 天从首个有效真实运行起算，不能用 fixture 或提交日期替代。
- Task 21 中心来源下线尚未执行；必须逐来源积累观察证据、通过门禁后单独操作。

## 当前 v0.4.0 剩余工作

- 执行六类真实来源 smoke，并记录人工相关性、secret 检查和回滚证据。
- 完成来源级 shadow/观察门禁；通过前不启用 live/cutover。
- 统一版本元数据、更新公开文档与 release manifest，重新执行全量回归、精确归档安装/升级和正式发布门禁。
- 通过来源级观察门禁前不启用 live/cutover，也不下线任何中心来源。

## 已确认的后续版本调整

- `v0.5.0`：多个预设领域、关键词和来源可调；首批为 AI 前沿、软件开发与开源、教育与学习。
- `v0.6.0`：YouTube、播客、长内容与按需 managed local tools。
- `v0.7.0`：X 来源。
- `v0.8.0`：小红书与微信公众号认证 Sidecar，分别验收。
- `v0.9.0`：local-first Onboarding、跨平台诊断、迁移和回滚闭环。
- `v0.10.0`：配置与运行契约冻结，作为 v1 候选。

v0.5.0 的已确认范围见
[`预设领域与可调来源设计`](superpowers/specs/2026-09-17-v0.5.0-domain-presets-design.md)。

## 使用路径与边界

公开安装请使用最新正式版 [v0.3.1 Release](https://github.com/TheGoldenWave/Follow-up/releases/tag/v0.3.1)
中的归档、checksum 和 manifest；仓库 README 包含对应安装步骤。

v0.3.0 仅新增 RSS/官网 Blog 本地采集。GitHub/HN/Reddit/Techmeme/arXiv/HF Papers 属
v0.4.0；预设领域与可调关键词/来源属 v0.5.0；视频、播客与受控工具属 v0.6.0；X 属
v0.7.0；小红书/微信公众号 Sidecar 属 v0.8.0。反馈学习、行业报告、分页个人 Feed、
显式阅读状态和任意自建领域仍待单独冻结。

后续任务与验收见 [版本开发计划](version-roadmap.md)；原始范围与历史任务见
[v0.3.0 实施计划](superpowers/plans/2026-09-08-v0.3.0-acquisition-runtime.md)。
