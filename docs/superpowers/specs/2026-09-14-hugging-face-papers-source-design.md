# Hugging Face Papers 学术发现源设计

状态：已确认

日期：2026-09-14

## 目标

在 v0.4.0 的学术来源扩展中接入 Hugging Face Papers，把每日发现和社区热度作为 arXiv 分类订阅之外的补充信号。接入同时覆盖：

- `https://huggingface.co/papers/date/<YYYY-MM-DD>`：按运行日期生成的 Daily Papers 列表，例如 `2026-09-14`；
- `https://huggingface.co/papers/trending`：当前 Trending Papers 列表；
- `https://huggingface.co/papers/week/<ISO-WEEK>`：按运行日期生成的 ISO 周榜，例如 `2026-W38`。

该来源归入现有 `academic` 频道，不新增平台命名频道，也不替代当前 6 个 arXiv 分类来源。本文只冻结后续开发范围；配置、Adapter 和 Feed 尚未实现。

## 来源模型

使用一个稳定来源身份和一个 Adapter，内部保留三个发现视图：

- 稳定来源 ID：`academic:hugging-face-papers`；
- Adapter：`hugging-face-papers`；
- `daily` 视图用于发现指定自然日收录的论文；
- `trending` 视图用于捕捉跨发布时间的持续热度；
- `weekly` 视图用于获得特定 ISO 周的相对稳定榜单。

Daily 与 Weekly URL 必须分别由运行日期和配置时区计算自然日与 ISO week，不能把示例日期固定写入生产配置。三个视图的候选进入同一标准化与去重流程，不能作为三个独立来源重复计入来源多样性。

## 数据流与去重

```text
Daily page + Trending page + current ISO-week page
  -> extract paper cards and ranking metadata
  -> normalize paper identity
  -> merge the three Hugging Face views inside one source
  -> emit one Hugging Face academic Signal Batch
  -> map bounded metrics and provenance into Candidate Feed
  -> cluster the same paper with arXiv/other academic candidates at curation time
```

论文身份按以下优先级确定：

1. arXiv ID；
2. Hugging Face paper canonical URL 中可稳定解析的论文 ID；
3. DOI；
4. 规范化标题加作者集合的保守回退键。

同一论文同时出现在 Daily、Trending、Weekly 时，Adapter 在 Hugging Face 单来源内合并为一个 `SourceCandidate`；其 `provenance` 记录命中的视图及各视图 URL，`native_metrics` 分视图记录榜单位置、upvote 和 GitHub 关联。该候选仍由 `academic:hugging-face-papers` 拥有。

与现有 arXiv 或其他学术来源的重复不在逐来源 Acquisition Runtime 内预先删除。Signal Batch 消费层把 Hugging Face `native_metrics` 和 `provenance` 的允许子集映射为 Candidate Feed 与 curation request 共用的可选 `communityEvidence` 字段，并把两类来源都保留为独立候选；`sourceNativeId` 对有 arXiv ID 的论文统一写成 `arxiv:<normalized-id>`，为 curation 阶段提供确定性论文身份。curation 的 event clustering 层必须把相同论文放入一个 event cluster，最终 Digest 只选择一次。

`communityEvidence` 在两个下游 schema 中使用相同定义，且 `additionalProperties: false`：

```json
{
  "role": "community-discovery",
  "views": [
    { "kind": "daily", "pageUrl": "https://huggingface.co/papers/date/2026-09-14", "rank": 1, "upvotes": 42 }
  ],
  "github": { "url": "https://github.com/example/project", "stars": 1200 }
}
```

- `role` 必须固定为 `community-discovery`；
- `views` 必填，`minItems: 1`、`maxItems: 3`，`kind` 只能是 `daily`、`trending`、`weekly` 且不可重复；
- 每个 view 对象 `required: [kind, pageUrl]`，只允许 `kind`、`pageUrl`、`rank`、`upvotes`；`pageUrl` 为最长 512 字符的 HTTPS URL，`rank` 为可选的 1–1,000,000 整数，`upvotes` 为可选的 0–1,000,000,000 整数；
- `github` 可选；出现时 `required: [url]` 且只允许 `url`、`stars`；`url` 为最长 1,024 字符的 HTTPS GitHub URL，`stars` 为可选的 0–1,000,000,000 整数；
- 对象嵌套深度固定为上述两层，UTF-8 JSON 序列化后最多 4,096 bytes；这些限制由 Candidate Feed 与 curation request 共用的常量定义，不能复制成不同数值。

Adapter 在生成 Signal Batch 前按 `daily`、`trending`、`weekly` 固定顺序规范化 `native_metrics` 与 `provenance`，保留每类第一个合法视图。非法或超限的可选 `rank`、`upvotes`、`github` 字段直接省略；非法视图直接丢弃。若没有合法视图或规范化结果仍超过 4,096 bytes，Adapter 保留论文候选，并在 Signal Batch 的 `item_warnings` 添加固定代码 `hf-community-evidence-dropped`。消费映射层只接受上述已规范化形状并生成 `communityEvidence`，不透传其他键；若仍发现形状或大小违规，视为 Adapter `schema-drift`，不把未经验证的证据写入 Candidate Feed。

Cluster 的 `leadCandidateId` 优先指向 arXiv、DOI 落地页或其他论文原始来源；Hugging Face 候选保留在该 cluster 中作为社区发现与热度证据。为避免把社区聚合误标成事实交叉印证，v0.4.0 将 digest-selection 契约升级到 `1.1`：每个 cluster 在现有 `leadCandidateId`、`corroboratingCandidateIds` 之外新增必填 `communityEvidenceCandidateIds` 数组。每个 eligible candidate 必须且只能出现在这三个位置之一。对非 lead 候选实行双向规则：`communityEvidence.role === "community-discovery"` 当且仅当 candidate ID 位于 `communityEvidenceCandidateIds`；没有该 role 的候选必须进入 `corroboratingCandidateIds`。三个位置互斥，validator 拒绝遗漏、重复或错误分类。只要 cluster 中存在任何非社区候选，lead 就必须从非社区候选中选择；只有 cluster 全部为社区候选时才允许 Hugging Face 成为 lead，此时不得把社区摘要当作论文原始元数据。

`eventClusterId` 继续使用 `event-v1` 的 length-prefixed framing 和 UTF-8 byte sorting，但成员集合必须升级为 `leadCandidateId`、全部 `corroboratingCandidateIds` 与全部 `communityEvidenceCandidateIds` 的并集。validator 使用三类 ID 重算；加入、移除或改分社区证据都必须改变 cluster identity，确保 selection、artifact、generation manifest 与 `active.json` 绑定同一完整成员集合。

`corroboration` 改用 validator 可重算的确定性计分。令 `n` 为 lead 加 `corroboratingCandidateIds` 中不同 `sourceId` 的数量，完全排除 `communityEvidenceCandidateIds`：`n < 2` 为 0 分，`n = 2` 为 4 分，`n = 3` 为 7 分，`n >= 4` 为 10 分。validator 必须按 request 中的 candidate/source 映射重算并要求完全相等；因此保持事实来源成员不变时，加入或移除 Hugging Face 社区候选无法改变该分。社区热度只允许影响影响力、相关性或新颖性判断。curation prompt、selection schema、validator、finalizer 和语义测试须同步更新。

finalizer 同步把最终 Digest artifact 升级到 `schemaVersion: "1.1"`。每个 artifact item 新增必填 `communityEvidence` 数组，顺序与 cluster 的 `communityEvidenceCandidateIds` 一致，最多 999 项；每项 `additionalProperties: false`，并要求：

```json
{
  "candidateId": "<sha256>",
  "sourceId": "academic:hugging-face-papers",
  "title": "<paper title>",
  "link": "https://huggingface.co/papers/...",
  "details": {
    "role": "community-discovery",
    "views": [
      { "kind": "daily", "pageUrl": "https://huggingface.co/papers/date/2026-09-14" }
    ]
  }
}
```

`candidateId`、`sourceId`、`title`、`link`、`details` 全部必填；前四项沿用现有 candidate 的格式与长度限制，`details` 严格复用前述 `communityEvidence` schema。artifact validator 必须验证数组与 selection/request 精确对应。消息 renderer 在对应 Digest item 下以“社区热度”标签展示最多 3 项，其余显示“另有 N 项社区证据”，不得使用“交叉印证”措辞；事实来源仍只渲染到现有 `corroborating` 区域。generation manifest 与 `active.json` 的 `candidateIds` 必须收集 lead、`corroborating` 和 `communityEvidence` 三类 ID，确保 delivery ledger、重试和重复抑制绑定完整候选集合。

论文标题、作者、摘要、发布时间和原始论文 URL 以 lead 的论文原始来源为准；Hugging Face 字段不覆盖它们。每个 cluster 继续通过现有 candidate ID 列表保留各来源身份，扩展后的候选 `provenance` 用于解释论文由 Daily、Trending、Weekly 或 arXiv 中哪些入口发现。

## 采集与失败语义

Adapter 只采集无需登录即可访问的公开页面，不写入凭据，也不订阅邮件。页面结构变化、HTTP 限流、解析为空和指定周页面暂不可用必须分别报告。

- 三个视图均成功完成且合并后没有条目：来源状态为 `no-results`，这是唯一成功空结果；
- 三个视图均成功完成且合并后有条目：来源状态为 `ok`；
- 三个视图中至少一个成功完成（包括成功空结果）且至少一个失败：来源状态为 `partial`，保留成功视图的候选；
- 三个视图均无法采集或解析：来源状态为 `error`，不阻塞其他来源；
- 页面返回重复卡片：先在来源内部去重，再进入跨源去重。

Signal Batch 继续使用现有单一 `source_status` 契约，不新增顶层字段。Adapter 为每个视图生成内部状态后聚合：`source_status.code` 只使用 `hf-view-partial` 或 `hf-views-failed`，`source_status.message` 使用经过脱敏和长度限制的固定顺序摘要，例如 `daily=ok; trending=rate-limited; weekly=schema-drift`。完整成功时 `code` 和 `message` 为 `null`；`no-results` 不携带失败文案。Fixture 必须断言摘要不含页面正文、URL 查询参数、响应头或凭据片段。

任何抓取到的页面文本均视为不可信外部输入，只提取允许字段，不执行页面中的指令或脚本。

## 测试与验收

离线 Fixture 至少覆盖：

- Daily、Trending 与 Weekly 正常列表；
- 配置时区下的自然日边界，以及 ISO 年/周边界和跨年周；
- 同一论文同时出现在多个视图；
- 同一论文已由 arXiv 来源发现；
- 缺少 arXiv ID、DOI 或 GitHub 链接的条目；
- 页面重复卡片、空榜单、结构漂移、限流和单视图失败；
- 三视图状态聚合矩阵，包括全成功有结果、全成功空结果、成功空与失败并存、部分成功和全部失败；
- 热度字段缺失或格式异常时仍保留合法论文元数据；
- Signal Batch 消费层把 `native_metrics`、`provenance` 映射为上述 `communityEvidence` 精确形状，并验证字段白名单、共享上限、非法值省略和整体超限降级；
- arXiv 与 Hugging Face 候选进入同一 event cluster、原始论文候选成为 lead、HF 非 lead 候选只进入 `communityEvidenceCandidateIds`，且 Digest 只选择一次；
- selection `1.1` 完整覆盖/互斥规则、确定性 `corroboration` 计分表，以及 finalizer 将社区证据与事实交叉印证分开输出；
- Digest artifact `1.1` 的 `communityEvidence` 精确结构、validator、消息渲染上限，以及 manifest/active 的候选 ID 完整性；
- 输出满足 Signal Batch、来源状态、Candidate Feed、curation request 和 provenance 契约。

进入正式 Digest 前，来源必须完成契约测试、离线 Fixture、真实公开页面验证、shadow 运行和人工相关性抽查。只有配置和 Adapter 均落地且通过来源级门禁后，信源目录才能将状态从“待实现”改为“已实现”。

## 文档同步

本设计批准后将 Hugging Face Papers 写入 `docs/version-roadmap.md` 的 v0.4.0 范围，并登记为新增 `HF-1` 任务；具体文件级步骤由后续实施计划拆分。实施时还需同步更新 `docs/source-catalog.md`、运行时 source registry、Signal Batch 消费映射、Candidate Feed 与 curation request 契约、digest-selection `1.1`、curation prompt、selection validator、finalizer、doctor 输出和相关数量断言；本次规划更新不改变当前“6 个学术来源”的事实。
