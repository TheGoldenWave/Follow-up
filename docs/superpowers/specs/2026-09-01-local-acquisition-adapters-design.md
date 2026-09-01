# Follow-up 用户本地采集与 Adapter 复刻方向

状态：方向已确认，具体实现边界待设计

日期：2026-09-01

## 背景

Follow-up 当前通过 GitHub Actions 集中抓取来源并发布公共 Feed。该模式降低了终端用户的配置成本，但把来源 API 费用、平台凭据、配额、限流和 Adapter 运维集中到了 Follow-up 维护者一侧。

本轮讨论确认：Follow-up 维护者不承担来源访问费用，也不托管用户共用的来源凭据。下一阶段应去掉维护者运行的中心采集层，改为在用户环境中运行采集能力。

本文记录已经确认的产品与架构方向。当前代码仍使用中心 Feed；在本地采集链路完成并验证前，不得把目标架构描述为当前能力。

## 已确认决策

### 1. 成本与凭据归属

- 来源 API Key、Cookie、扫码会话、调用费用和平台账号风险归使用该来源的用户。
- Follow-up 维护者不提供共享来源凭据，不代付来源 API 或转录费用。
- 所有来源凭据只保存在用户本地，不提交到仓库，不进入公共 Feed。
- 来源凭据与 Telegram、Email 等投递凭据分开管理。
- 读取浏览器 Cookie、发起扫码登录或写入凭据前，必须获得用户明确授权。

### 2. Follow-up 自带采集能力

Follow-up 不把核心可用性建立在用户另行安装 `last30days` 等完整产品之上。项目应拥有自己的 Acquisition / Adapter 层，并与 Signal 策展、Digest、反馈、投递和 Handoff 保持清晰边界。

目标数据流：

```text
User / Local Scheduler
  -> Follow-up Acquisition
  -> Source Adapters
  -> Versioned Signal Batch
  -> Follow-up Core
  -> Curate / Digest / Feedback / Delivery / Handoff
```

去掉的是维护者运行的中心采集服务，不是采集本身的必要成本。

### 3. 从成熟项目复刻 Adapter

- 优先从成熟、许可兼容且有测试的项目复刻 Adapter，不从零实现平台协议。
- `mvanhorn/last30days-skill` 是主要参考来源；其 MIT 许可证允许复制、修改和再发布，但必须保留版权与许可证声明。
- 微信公众号可参考 `rachelos/we-mp-rss`；其仓库许可证文本为 MIT，同样需要保留版权与许可证声明。
- 不应只复制单个请求函数。应连同必要的共享底座一起评估，包括统一 Schema、认证、超时、重试、限流、标准化、去重、来源状态、健康检查和测试。
- 所有引入代码必须记录上游仓库、版本或提交号、本地修改和后续同步策略。
- 不自动追随上游更新。安全修复和平台协议变化经审查后再同步。

`last30days` 的部分来源并非完全内置：Digg AI 1000、Techmeme 和 arXiv Adapter 会调用外部 CLI；小红书依赖已登录的本地 MCP 服务。复刻时必须逐项决定是继续使用本地运行组件，还是把许可兼容的实现一并纳入 Follow-up，不能把外部运行时依赖误写成内置能力。

### 4. 登录态平台采用本地 Sidecar

小红书和微信公众号采用用户本地 Sidecar 运行模式：

- 小红书通过已登录的本地 MCP 服务提供只读采集能力；
- 微信公众号通过本地 `we-mp-rss` 或经审查复刻的等价服务维护扫码登录态和指定账号订阅；
- Sidecar、浏览器会话、Cookie、扫码凭据和缓存全部留在用户机器；
- Follow-up 负责安装引导、启动/停止、健康检查、来源状态转换和统一 Signal Batch，不读取或复制 Sidecar 内部的原始登录凭据；
- Sidecar 不得成为维护者托管的共享服务，也不得把用户内容或凭据上传到 Follow-up 维护者控制的基础设施；
- Sidecar 不可用、授权过期或接口漂移时必须降级为明确的来源状态，不能阻塞其他来源。

采用 Sidecar 是为了隔离长期登录态、浏览器自动化和扫码授权，避免把高风险会话管理直接混入 Follow-up 主进程。

Sidecar 必须遵守以下本机信任边界：

- 只监听 Unix Domain Socket 或 `127.0.0.1`，禁止监听公网地址；
- Follow-up 与 Sidecar 之间使用每次安装生成的随机本地令牌，令牌文件权限为仅当前用户可读；
- API 只暴露只读采集、健康检查和授权状态，不提供 Cookie、Token、二维码会话数据或浏览器存储导出接口；
- 响应和日志必须清除 Cookie、Authorization Header、扫码票据、手机号和其他登录标识；
- Sidecar 使用独立数据目录和最小进程权限，不读取 Follow-up 无关的用户文件；
- Follow-up 维护 Adapter wrapper、兼容版本和生命周期控制；用户拥有登录会话，并明确批准需要重新授权或迁移本地数据的升级；
- Sidecar 协议必须版本化。协议不兼容时返回 `schema-drift`，不得尝试读取未知响应或回退为未受控的浏览器抓取。

## 组件边界

`Feed Pipeline` 是采集子系统的产品级总称。目标架构下，它由本地 Acquisition Runtime 和 Source Adapters 组成，不再表示维护者运行的中心 Feed 服务。

| 组件 | 负责 | 不负责 |
|---|---|---|
| Local Scheduler | 触发按需、每日、每周或每月采集 | 来源登录、内容解析、外部投递 |
| Acquisition Runtime | 调度 Adapter、控制并发/超时、标准化、跨源去重、短期缓存、汇总来源健康 | Signal 策展、长期用户状态、消息投递 |
| Source Adapter / Sidecar Wrapper | 单一来源的授权状态、抓取、解析、原生 ID 和来源级错误 | 跨源排序、Digest、知识晋升 |
| Follow-up Core | 接收版本化 Signal Batch，执行主题归类、策展、排序、反馈和 Handoff 语义 | 平台登录、Cookie 管理、原始抓取 |
| Delivery Runtime | Digest 的调度投递、重试和投递回执 | 来源采集与来源凭据 |

Adapter 先产生来源候选；Acquisition Runtime 负责统一标准化、跨源去重、缓存和健康汇总；Follow-up Core 只消费通过契约验证的 Signal Batch。

## 信息源体系

保留现有 7 类用户可见信息体系。平台是内部来源或证据层，不为每个平台新增一个用户频道。

### 1. AI 建造者

- X / Twitter：建造者表达、发布和即时反应。
- GitHub：Release、Commit、PR、Issue 和 Discussion，作为建造者实际行动证据。

### 2. 播客与视频

- 现有播客 RSS 和转录。
- YouTube 主题搜索、字幕和高价值评论，不再局限于固定播客列表。

### 3. 官方博客与技术社区

- 现有公司官方博客。
- Hacker News：技术社区讨论和开发者共识。
- Techmeme：科技事件聚合与媒体交叉验证。

### 4. Newsletter

- 保留现有 Newsletter RSS 和其他用户本地授权的 Newsletter 来源。

### 5. 学术研究

- arXiv 分类订阅与主题搜索。
- Hacker News、Reddit 等对论文的讨论只能作为辅助 Signal，不替代论文原文。

### 6. 中文科技生态

- 现有中文科技媒体与 RSS。
- 小红书：用于中国 AI 产品、创作者工具和真实用户反馈，默认应为可选来源。
- 微信公众号：只追踪用户明确维护的公众号关注列表，不在首版提供全网公众号关键词搜索。

微信公众号的扫码授权、会话续期和抓取运行在用户环境。授权失效必须显式报告，不得将抓取失败解释为公众号没有更新。

### 7. 行业报告

- 保留现有行业报告来源规划。

### 跨频道发现与讨论层

- Reddit：补充用户痛点、真实使用反馈、产品比较和社区讨论。
- Digg AI 1000：补充高信号 AI 账号形成的话题聚类和趋势发现。

Reddit 和 Digg 产生的结果应按照主题归入相应频道，不作为独立的用户可见频道。

## 第一阶段目标来源

在现有来源基础上，第一阶段新增或升级以下来源：

```text
GitHub
Hacker News
Reddit
YouTube
Techmeme
Digg AI 1000
小红书
微信公众号指定账号订阅
```

现有 X 和 arXiv Adapter 也应评估是否使用成熟实现升级：X 从固定账号轮询扩展为作者动态与相关讨论；arXiv 从分类 RSS 关键词过滤扩展为主题与时间窗检索。

## 数据与错误语义

所有 Adapter 结果由 Acquisition Runtime 封装为统一、版本化的 Signal Batch。批次 Envelope 至少包含：

- `schema_version`：契约版本；
- `batch_id`：本次采集的唯一 ID；
- `generated_at`：批次生成时间；
- `adapter_id` 和 `adapter_version`：实际运行的 Adapter 及版本；
- `source`：来源标识；
- `request`：采集模式、主题或订阅目标、时间窗和深度，不含凭据；
- `source_status`：批次级来源结果，包含 `status`、脱敏 `code`、脱敏 `message` 和 `retryable`；
- `items`：候选 Signal 数组，允许为空。

`source_status` 属于批次而不是单个候选，因此零结果、授权失败和超时在 `items` 为空时仍可表达。单个候选至少包含：

- 稳定候选 ID；
- 来源和来源类型；
- 原始 URL；
- 作者或发布主体；
- 发布时间与日期可信度；
- 标题、正文片段或摘要输入；
- 原生互动指标；
- 查询或订阅来源；
- 抓取时间。

候选本身不重复批次级来源状态；仅在单项 enrichment 部分失败时记录脱敏的 `item_warnings`。

来源状态至少区分：

```text
ok
no-results
partial
rate-limited
auth-failed
unreachable
timeout
schema-drift
skipped-unconfigured
error
```

只有 `no-results` 表示来源成功运行但没有结果。其他失败状态不得被表述为“该平台无人讨论”或“该来源没有更新”。

## 迁移原则

- 当前中心 Feed 在本地采集链路通过验收前继续被视为现状，不立即删除。
- 迁移按来源切换，不进行一次性全局替换。未通过验收的来源继续使用当前 Feed；新增来源在通过验收前不进入正式 Digest。
- 本地 Adapter 首先以 shadow 模式运行：输出写入隔离的本地验证目录，不参与投递，也不修改中心 Feed 状态。
- shadow 对比时按平台原生 ID 优先、canonical URL 次之进行去重；同一记录同时出现时保留本地 Adapter 的完整候选，并记录中心 Feed 命中作为迁移诊断信息。
- 每个来源切换前必须满足：契约测试和离线 Fixture 测试通过；缺少/失效凭据能够映射为正确状态；日志和产物秘密扫描无命中；输出内不存在重复原生 ID 或 canonical URL；至少 7 次连续计划运行无未分类错误；人工抽查最近至少 20 条候选时，主题或订阅相关率不低于 80%。低频来源可以用不少于 3 次真实运行加覆盖不同结果形态的 Fixture 回放替代 7 次计划运行。
- 通过门槛后，以来源级开关将 Digest 输入切到本地 Adapter。切换后保留至少 14 天观察期。
- 观察期内出现凭据泄漏、连续 2 次未分类失败、重复率超过 5% 或相关率低于 80% 时，立即通过来源级开关回滚到中心 Feed；新增来源则暂停进入 Digest。
- 所有现有来源完成观察期后，删除维护者运行的 GitHub Actions 中心抓取任务和公共 Feed 依赖。
- 旧 Feed 文件可作为测试 Fixture 或迁移样本保留，但不再作为运行时内容服务。
- README、SKILL 和 Onboarding 只有在实现切换后，才从“中心 Feed”改为“用户本地采集与用户自有凭据”。

## 尚待确认

以下问题尚未在本轮讨论中最终确认：

1. `last30days` 代码采用 Git subtree、受控 Vendor 目录还是人工选择性移植。
2. Digg AI 1000、Techmeme 和 arXiv 的外部 CLI 是否继续作为本地依赖，还是复刻其底层实现。
3. 各来源的默认启用策略、抓取频率、调用预算和用户配置 Schema。
4. YouTube 字幕、播客转录、付费 Newsletter 和平台内容的本地保存期限与版权边界。

这些问题需要在实施计划前完成设计确认。
