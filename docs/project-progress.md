# Follow-up 项目进度

更新日期：2026-09-09

## 当前状态

最新公开版本仍为 `v0.2.0`，以 [GitHub Releases](https://github.com/TheGoldenWave/Follow-up/releases)
为准。`feature/v0.3.0-acquisition-runtime` 分支的候选版本为 `0.3.0`；R1–R3 已实现并
通过复审，R4 最终发布验收正在进行，尚未公开发布。

## 已有产品基线

- 用户入口为 `set up follow-up` 和 `/follow-up`，兼容 `~/.follow-builders/` 用户数据。
- 6 类中心公共 Feed、70 个稳定信源（含 17 个官网 Blog）；完整清单见 [信源目录](source-catalog.md)。
- 滚动候选历史、跨源事件聚类与重要性排序，门槛 60 分，每期目标 6–10 条，不为凑数降门槛。
- daily、weekly 与按需 Digest；投递 ledger/outbox 阻止重复自动发送，不确定投递需人工处置。
- Onboarding、schedule 与确切 destination 授权门禁，以及 Codex/Claude Code/custom 安装和 doctor。

## v0.3.0 候选版已完成

| 范围 | 当前实现 |
|---|---|
| 采集基础 | Python 3.12 Runtime、版本化 Signal Batch 契约、source registry、受控 vendoring、RSS/官网 Blog Adapter |
| R1 安装 | 显式 bootstrap 创建隔离环境，安装哈希锁定依赖与 wheel；登记绝对解释器，日常以 `-I` 运行，不静默安装 |
| R2 统一入口 | collect-and-prepare 串起采集、批次原子发布和 Digest 准备；四模式验证，保留授权与失败披露，正文/元数据按 7/90 天留存 |
| R3 迁移 | 保存来源运行历史及真实批次人工复核；inspect/review/cutover/reset CLI；14 天、3 次通过检查的真实运行及 ≥80% 相关性门禁 |
| 来源回滚 | hybrid 回退中心输入；local 隔离该来源并报告错误，不访问中心 Feed；不改写已投递内容 |

central 仍为默认值；shadow 不将本地候选混入 Digest。功能实现不代表所有来源已完成
真实观察，也不代表中心 Feed 已下线。配置、切换和回滚见 [运行手册](operations/local-acquisition-runbook.md)。

## 验证与剩余工作

- Python 全量 145 项通过，R1–R3 定向与广泛 Node 回归已通过；这些结果不替代最终发布测试。
- R4 待完成最终 manifest 哈希、全量发布检查、精确归档干净安装与升级、tag 和公开资产验证。
  完整发布测试正在运行，当前不宣称发布门禁全绿。
- GitHub `v*` tag 更新/删除保护及发布确认变量已只读核验；公开发布尚未执行。
- 远端中心采集任务发现缺少 `POD2TXT_API_KEY` 的问题；本地 Feed 校验通过不能证明远端
  所有来源采集正常，也不能把中心采集失败解释为没有更新。
- R5 是逐来源真实观察，不是 v0.3.0 发布前置条件。17 个官网 Blog 的完整本地观察验收
  尚未完成；至少 14 天从首个有效真实运行起算，不能用 fixture 或提交日期替代。
- Task 21 中心来源下线尚未执行；必须逐来源积累观察证据、通过门禁后单独操作。

## 使用路径与边界

目前公开安装请使用 [v0.2.0 安装说明](https://github.com/TheGoldenWave/Follow-up/blob/v0.2.0/README.zh-CN.md)。
仓库 README 中的 v0.3.0 下载步骤供发布完成后使用，不能据此认为资产已经可用。

v0.3.0 仅新增 RSS/官网 Blog 本地采集。GitHub/HN/Reddit/Techmeme/arXiv 属 v0.4.0，
YouTube/播客/Digg 与 managed local tools 属 v0.5.0，X 属 v0.6.0，小红书/微信公众号
Sidecar 属 v0.7.0。反馈学习、行业报告、分页个人 Feed、显式阅读状态和自动更新仍待规划。

后续任务与验收见 [版本开发计划](version-roadmap.md)；原始范围与历史任务见
[v0.3.0 实施计划](superpowers/plans/2026-09-08-v0.3.0-acquisition-runtime.md)。
