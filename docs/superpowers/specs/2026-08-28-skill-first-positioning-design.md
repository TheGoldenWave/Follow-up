# Follow-up Skill-first 产品定位设计

状态：已确认

日期：2026-08-28

## 目标

将 Follow-up 从容易引发误解的“个人知识策展系统”校准为 **Skill-first、plugin-enhanced 的个人 AI Signal / Attention 策展系统**。

Skill 是跨 Agent 可移植的安装、配置、调用和反馈入口；DeepSeek Harness 插件是可选的富交互信息工作台；Feed 抓取、定时调度、消息投递和用户状态由独立的确定性组件承担。Follow-up 产出的默认语义是 Signal，不是用户已经理解或认可的 Knowledge。

## 一句话定位

> Follow-up 是一个 Skill-first、plugin-enhanced 的个人 AI 信息信号与注意力策展系统：持续聚合外部高价值来源，将信息压缩为可行动 Signal，通过 IM 主动送达，并可在 DeepSeek Harness 信息中心中进行深度浏览与反馈；只有经过用户选择和后续治理的内容，才进入 Malow 或 GoldenWave。

## 产品结构

| 组件 | 职责 | 不负责 |
|---|---|---|
| Follow-up Skill | 跨 Agent Onboarding、偏好配置、按需摘要、自然语言反馈和 Handoff 交互 | 稳定后台运行、复杂信息浏览、正式知识写入 |
| DeepSeek Harness Plugin | 高度个性化的信息中心、主题聚合、推荐解释、阅读状态和批量反馈 | 重新实现抓取、维护平行用户状态、正式知识写入 |
| Follow-up Core / Contract | 统一 Signal、Topic、Digest、Feedback、Delivery 和 Handoff 语义 | 绑定单一 Agent 宿主或 IM 平台 |
| Feed Pipeline | 抓取、解析、去重、缓存、来源健康 | 判断用户是否理解内容 |
| Delivery Runtime | 定时、IM/邮件投递、重试、投递回执 | 长期知识治理 |
| Local User State | 打开、忽略、稍后读以及 `learn_requested`、`matter_handoff_requested`、`candidate_proposed` 等用户动作事件 | 公共 Feed、正式知识状态和实践验证状态 |

## 多入口产品形态

Follow-up 不是只能通过聊天使用的 Skill。Skill 是兼容性最广、成本最低的通用入口；DeepSeek Harness 插件提供 Skill 和 IM 不适合承载的高信息密度工作面。

```text
                      ┌─ Follow-up Skill：配置、查询、自然语言反馈
Feed Pipeline
  → Follow-up Core ───┼─ DSH Plugin：信息中心、主题聚合、阅读与批量操作
  → Local State       └─ IM / Email：主动提醒、摘要和异常通知
                      ↓
              Malow / GoldenWave Handoff
```

所有入口必须读写同一 Contract 和用户状态。插件不是第二套产品内核，Skill 也不能维护一份与插件分叉的偏好或阅读记录。

### DeepSeek Harness 信息中心

独立页建议围绕以下工作面组织：

- **Today / Inbox**：今日最值得关注的 Signal，而不是完整抓取列表；
- **Topics**：跨 X、播客、博客、论文、Newsletter 和中文媒体聚合同一主题；
- **Why this matters**：展示推荐理由、关联目标、来源质量和不确定性；
- **Reading depth**：Follow-up 只记录 surfaced、opened、selected 和请求动作；understood、applied 需要下游学习或实践证据；
- **Actions**：忽略、稍后读、进入学习、用于 Project / Matter、提出长期保留候选；
- **Source trace**：保留原始 URL、来源、发布时间和摘要生成信息；
- **Feedback**：让推荐策略学习价值信号，但不将点击静默晋升为长期偏好。

插件首版应优先做只读 Signal 浏览和显式反馈，不提前建设社交信息流、评论系统、通用浏览器或自动知识写入。

## 与个人 AI 系统的关系

| 系统 | 权威或职责 |
|---|---|
| LifeSub | Evidence：现实中真实发生过什么 |
| Follow-up | Signal / Attention：外部世界有什么值得注意 |
| Malow | Work：哪些 Signal 要进入 Project / Matter、行动或决策 |
| GoldenWave | Memory：什么值得成为长期、可审计、可跨 Agent 使用的个人上下文 |

Follow-up 不是第四种长期知识权威。外部原文仍是事实来源，Follow-up 只拥有来源配置、抓取记录、策展结果、Digest 和投递/反馈状态。

## 数据语义

必须明确区分：

```text
抓取到 ≠ 可信
摘要完成 ≠ 用户看过
推送成功 ≠ 用户理解
用户收藏 ≠ 经实践验证
```

默认链路：

```text
External Sources
  → Feed Item
  → Curated Signal / Digest
  → IM Delivery
  ├─ ignore / expire
  ├─ read later
  ├─ learn
  ├─ use in Project / Matter → Malow
  └─ propose long-term retention → GoldenWave Candidate
```

Follow-up 永远不直接或自动写入 Malow / GoldenWave 的权威状态。未来 Contract 实现后，显式用户动作也只能产生带来源、幂等键和审计信息的 Handoff / Candidate proposal；是否接纳、写入或晋升仍由下游系统决定。

### `learn_requested` 的下游边界

Capability Alignment 的状态与治理归 GoldenWave，学习任务、实践和 Outcome Review 由 Malow 执行。Follow-up 对学习链路只负责：

- 保存用户针对某个 Signal 发起的 `learn_requested` 事件；
- 携带 Signal Ref、Source Ref、选择理由、请求时间和幂等信息提交 Learning Handoff；
- 展示下游是否已接收、拒绝或需要补充信息的回执。

Follow-up 不生成正式 `human_state` / `agent_state`，不因打开、收藏、阅读时长或完成摘要而标记 `understood`、`practiced` 或 `validated`。教学材料可以通过外部 Tutor Capability 生成，但学习状态由 GoldenWave 治理，实践证据由 Malow 产生。

## 知识膨胀护栏

1. Digest、Feed Item 和普通摘要默认不进入个人知识库。
2. 只有显式用户动作才能创建 GoldenWave Candidate 或 Malow Handoff。
3. 同一主题优先聚合为趋势变化，不逐篇建 Wiki 页；是否更新既有页面只能由 GoldenWave Govern 决定。
4. 未处理 Signal 和阅读候选必须有 TTL，不永久堆积。
5. 用知识预算限制每日推送和每周候选数量。
6. 正式知识状态只能由 GoldenWave Govern 决定；`understood` 和 `applied` 只能由对应学习或实践流程提供证据，Follow-up 不自行标记。

## 当前能力与后续能力

### 当前已具备

- 7 类来源 taxonomy，其中 X、播客、官方博客、Newsletter、学术论文和中文科技 6 类已生成中心化 Feed；行业报告仍是低频来源规划，未形成实时 Feed；
- GitHub Actions 定时抓取和去重；
- Skill 驱动的摘要混编；
- stdout、Telegram、Email 等投递入口；
- 用户级频率、语言、投递和摘要 Prompt 配置。

### 尚未实现

- 稳定的阅读和反馈状态模型；
- 被配置 Schema 和 `prepare-digest.js` 真正执行的用户级频道开关；
- 行业报告的稳定抓取与 Feed；
- IM 内的忽略、稍后读、学习、用于项目、长期保留动作；
- DeepSeek Harness 信息中心插件与统一 Follow-up Core / Contract；
- Malow Handoff Contract；
- GoldenWave Candidate Contract；
- Learning Handoff 与 Capability Alignment 回执 Contract；
- 基于真实反馈的排序学习；
- 知识预算和专题聚合。

未实现能力只能写为方向或边界，不能出现在当前能力承诺中。

## Skill 边界

- `SKILL.md` 保留产品目的、模式路由、关键安全边界和当前工作流。
- DeepSeek Harness 插件作为可选增强界面，不改变 Skill 在其他 Agent 中的可用性。
- Skill、插件和 IM 必须通过统一 Core/Contract 共享偏好、Signal 和反馈状态。
- 复杂 Onboarding、投递、Handoff 和状态 Schema 后续迁移到 `references/`，按需加载。
- 确定性抓取、去重、准备数据和投递逻辑继续放在 `scripts/`。
- 用户状态放在 `~/.follow-up/`，不与公共 Feed、Prompt 或代码一起提交。
- 创建 Cron、写密钥、发送外部消息和跨项目写入前必须分别获得授权。

## 成功指标

不以抓取量、摘要量或知识库新增页面数为北极星。优先观察：

- Useful Signal Rate：用户认为值得注意的推送占比；
- Action Rate：进入阅读、学习、Matter 或 Candidate 的比例；
- Noise Rate：忽略、重复和明显不相关内容比例；
- Attention Cost：用户每日处理 Digest 的时间和打扰感；
- Promotion Quality：进入 GoldenWave 的 Candidate 最终被接受和复用的比例。

## 本轮文档变更

- 新增本产品定位基线；
- 更新中英文 README 顶部定位、产品架构和系统关系；
- 更新 `SKILL.md` 的发现描述、核心身份、数据语义和知识写入边界；
- 记录 DeepSeek Harness 信息中心作为 plugin-enhanced 的目标形态，但不宣称当前已实现；
- 不修改 Feed 抓取逻辑、来源配置、生成数据和投递实现。
