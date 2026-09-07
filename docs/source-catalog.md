# Follow-up 信源目录

更新时间：2026-09-07

本文记录 Follow-up 的信源分类、当前真实实现和候选扩展范围。它回答“系统现在实际采集什么”和“后续准备接入什么”，不以 README 中的概括性名单代替运行时事实。

## 1. 分类原则

Follow-up 同时使用三个维度描述一个信源：

1. **用户频道**：内容最终进入哪一类 Signal。
2. **内容层级**：该入口发布的是研究、产品、代码还是开发文档。
3. **实现状态**：当前运行时是否已经能够采集并进入 Feed。

同一机构可以有多个入口。例如 Google DeepMind 的 Research、Publications 和 Blog 是三个不同信源；不能只写成“Google Blog”。GitHub、Hugging Face、ModelScope 和 API 文档也不能与 Research Hub 混为同一层。

### 内容层级

| 代码 | 层级 | 主要内容 |
|---|---|---|
| R0 | Research Root / Index | 研究项目、研究方向和研究索引 |
| R1 | Publications / Technical Reports | 论文、技术报告、Model Card 和实验结果 |
| R2 | 专题 Research Blog | Alignment、Interpretability、Safety、Science 等专题研究 |
| P | Product / News / Engineering Blog | 产品发布、工程实践、公司新闻和开发者案例 |
| D | Developer / API Docs | API、SDK、部署和开发文档 |
| C | Code / Model Hub | GitHub、Hugging Face、ModelScope、数据集和模型权重 |
| M | Media / Community | 科技媒体、论坛、社交平台和社区讨论 |

### 实现状态

| 状态 | 定义 |
|---|---|
| 已实现 | 已存在有效配置和采集路径，可进入当前中心化 Feed |
| 已配置未接入 | 已存在机器可读配置，但当前运行时不会采集；README 中的概括性名单不算配置 |
| 待实现 | 已进入明确路线图，但尚无正式采集路径 |
| 候选 | 值得评估，尚未确认接入优先级或采集方案 |

“本次 Feed 中没有新内容”不等于“未实现”；Feed 文件只是一次时间窗内的运行结果。

## 2. v0.2 Digest 与信源时间窗

用户通过 `set up follow-up` 完成 Onboarding，之后可使用 `/follow-up` 请求按需 Digest；
兼容用户数据继续存放在 `~/.follow-builders/`。自动运行只有 daily 和 weekly，本版本
**不会在官网发布内容时即时提醒**。

官网 Blog 的 **72 小时**规则是中心采集的发现恢复窗口：每个来源最多检查 12 个发现
链接并接收 3 篇有效新文章。它不是“只推最近 72 小时”的用户投递规则。投递使用滚动
candidate Feed 的历史，daily 与 weekly 都只选择符合资格的**未推**候选；成功投递后，
候选成为**已推未读**，不会在普通自动任务中重复发送。pending 或**投递不确定**同样
阻止自动重复投递。

所有启用来源进入同一个跨源事件排序，按影响、用户相关性、来源权威性、新颖性和交叉
印证计分。重要性门槛为 **60 分**，每期目标 **6-10** 条；不足时不凑数，可以只发
1-5 条。完整检查无达标内容时，daily 发送“今日无重要更新”，weekly 发送“本周无
重要更新”。`partial` 表示当前来源检查不完整，`incomplete-history` 表示候选历史覆盖
不足；首次 weekly 在积累并证明 7 个完整历史日之前处于 bootstrap，二者都不能冒充
完整的无更新结论。

## 3. 七类用户信源现状

| 频道 | 当前有效信源 | 已配置未接入 | 待实现 | 候选 |
|---|---|---|---|---|
| AI 建造者 | X 上 30 个固定账号；X API 中心采集 | 无 | 本地 X Adapter；GitHub 行动证据 | 无 |
| 播客与视频 | 10 个播客 RSS；Pod2Text 转录；YouTube 链接匹配 | 无 | YouTube 主题搜索、字幕和评论；本地 `yt-dlp` Adapter | 无 |
| 官方博客与技术社区 | 17 个正式来源；见下方“生产 Blog 来源” | 无 | Hacker News、Techmeme 讨论层 | 本文第 3、4 节中仍标为候选的官方一手源 |
| Newsletter | Stratechery、One Useful Thing、The Algorithmic Bridge、AI Snake Oil | The Batch、Ben's Bites、TLDR AI、Import AI、The Gradient | 用户本地授权的 Newsletter | 其他 Newsletter |
| 学术研究 | arXiv `cs.AI`、`cs.CL`、`cs.CV`、`cs.LG`、`cs.RO`、`cs.CR`；RSS 和标题关键词过滤 | 无 | arXiv 主题与时间窗检索 | Papers With Code、Semantic Scholar、会议论文入口 |
| 中文科技生态 | 36氪、少数派、量子位 | 机器之心、新智元 | 小红书、微信公众号指定账号订阅 | 其他中文一手源和媒体 |
| 行业报告 | 无 | State of AI、Stanford AI Index、a16z AI Canon、CB Insights、FirstMark MAD | 报告发现、版本识别、PDF 解析和月度 Digest | 其他投行、咨询和研究机构报告 |

### 当前配置差异

- `config/default-sources.json` 中保留了 8 个 Newsletter，但运行时会由 `config/feed-newsletters.json` 覆盖，因此当前有效数量是 4 个。
- `config/default-sources.json` 中保留了 5 个中文科技源，但运行时会由 `config/feed-zh-tech.json` 覆盖，因此当前有效数量是 3 个。
- README 与 `config/feed-blogs.json` 均以 17 个正式官网 Blog 来源为准。
- 本目录将 Papers With Code、Semantic Scholar 和多个会议论文入口列为候选；当前学术采集实际只有 arXiv RSS。
- 行业报告虽有默认名单，但不会生成实时 Feed。

### 生产 Blog 来源

以下 17 个来源均已进入 `config/feed-blogs.json`，并具备当前采集路径。离线来源 Fixture 与配置契约已全部通过。验证方式用于说明联网证据差异，不改变“已实现”状态。

| ID | 来源 | 发现方式 | 状态 | 联网验证 |
|---|---|---|---|---|
| `blog:anthropic-engineering` | Anthropic Engineering | Sitemap + HTML | 已实现 | Node-live |
| `blog:claude-blog` | Claude Blog | HTML | 已实现 | Node-live |
| `blog:anthropic-interpretability` | Anthropic Interpretability | HTML | 已实现 | Node-live |
| `blog:anthropic-science` | Anthropic Science | HTML | 已实现 | Node-live |
| `blog:openai-alignment` | OpenAI Alignment Research Blog | RSS + HTML | 已实现 | Node-live |
| `blog:google-antigravity` | Google Antigravity Blog | RSS + HTML | 已实现 | Browser-live；本地 Node 网络路由受阻 |
| `blog:google-deepmind` | Google DeepMind Blog | Sitemap + HTML | 已实现 | Node-live |
| `blog:google-research` | Google Research Blog | RSS + HTML | 已实现 | Browser-live；本地 Node 网络路由受阻 |
| `blog:microsoft-research` | Microsoft Research Blog | HTML + RSS | 已实现 | Node-live |
| `blog:amazon-science` | Amazon Science Blog | RSS + HTML | 已实现 | Node-live |
| `blog:ibm-research` | IBM Research Blog | RSS + HTML | 已实现 | Node-live；12 个候选、3 篇有效文章，另有 1 个非致命禁止重定向 |
| `blog:perplexity-research` | Perplexity Research Articles | 根索引 HTML + Sitemap | 已实现 | Browser-live；本地 Node 网络路由受阻 |
| `blog:qwen-blog` | Qwen Blog | JSON + HTML | 已实现 | Node-live；12 个候选、3 篇有效文章 |
| `blog:kimi-blog` | Kimi Research & Tech Blog | HTML + Sitemap | 已实现 | Node-live；9 个候选、3 篇有效文章 |
| `blog:ernie-blog` | ERNIE Blog | RSS + HTML | 已实现 | Node-live |
| `blog:minimax-blog` | MiniMax Blog | Sitemap + HTML | 已实现 | Node-live |
| `blog:apple-ml-research` | Apple Machine Learning Research | RSS + Sitemap | 已实现 | Node-live |

汇总：14 个来源通过本地 Node live validator；Google Antigravity、Google Research 和 Perplexity Research 通过浏览器验证了公开索引与真实文章内容，但本地 Node 路径受 DNS/连接路由限制。这里不声称 17 个来源均通过本地 Node live validator。

## 4. 官方一手信源候选池

下表把机构与具体入口拆开。状态描述 Follow-up 的接入情况，不评价网站本身是否仍在更新。候选 URL 在接入前仍需完成可访问性、RSS/Atom、Sitemap、结构化数据、许可和稳定性核验。

### 全球核心研究入口

| 机构 | 入口 | 层级 | Follow-up 状态 |
|---|---|---|---|
| OpenAI | [Research](https://openai.com/research/) | R0 | 候选 |
| OpenAI | [Research Index](https://openai.com/research/index/) | R0 | 候选 |
| OpenAI | [Alignment Research Blog](https://alignment.openai.com/) | R2 | 已实现 |
| Anthropic | [Research](https://www.anthropic.com/research) | R0 | 候选 |
| Anthropic | [Interpretability](https://www.anthropic.com/research/team/interpretability) | R2 | 已实现 |
| Anthropic | [Science](https://www.anthropic.com/science) | R2 | 已实现 |
| Anthropic | [Engineering](https://www.anthropic.com/engineering) | P | 已实现 |
| Anthropic | [Claude Blog](https://claude.com/blog) | P | 已实现 |
| Google DeepMind | [Research](https://deepmind.google/research/) | R0 | 候选 |
| Google DeepMind | [Publications](https://deepmind.google/research/publications/) | R1 | 候选 |
| Google DeepMind | [Blog](https://deepmind.google/blog/) | R2/P | 已实现；单站混发，按文章分类 |
| Google Research | [Google AI Research](https://ai.google/research/) | R0 | 候选 |
| Google Research | [Research Blog](https://research.google/blog/) | R2 | 已实现 |
| Meta AI | [Research](https://ai.meta.com/research/) | R0 | 候选 |
| Meta AI | [Publications](https://ai.meta.com/results/?content_types%5B0%5D=publication) | R1 | 候选 |
| Microsoft Research | [AI Research](https://www.microsoft.com/en-us/research/research-area/artificial-intelligence/) | R0 | 候选 |
| Microsoft Research | [Research Blog](https://www.microsoft.com/en-us/research/blog/) | R2 | 已实现 |
| NVIDIA | [Research](https://research.nvidia.com/) | R0 | 候选 |
| NVIDIA | [Publications](https://research.nvidia.com/publications) | R1 | 候选 |
| Apple | [Machine Learning Research](https://machinelearning.apple.com/) | R0/R2 | 已实现；单站同时承担研究索引和文章发布 |
| Apple | [Publications](https://machinelearning.apple.com/research/) | R1 | 候选 |
| Amazon | [Amazon Science Blog](https://www.amazon.science/blog/) | R2 | 已实现 |
| IBM | [IBM Research](https://research.ibm.com/) | R0 | 候选 |
| IBM | [Research Blog](https://research.ibm.com/blog) | R2 | 已实现 |
| Cohere | [Cohere Research](https://cohere.com/research) | R0 | 候选 |
| Perplexity | [Perplexity Research Articles](https://research.perplexity.ai/) | R2 | 已实现；使用公开根索引，不使用旧 `/articles` 索引 |

第二批机构候选：Adobe Research、Salesforce AI Research、ServiceNow AI Research、Scale Labs、Allen AI / AI2、Hugging Face Research、Databricks / Mosaic AI。每个机构仍需按具体 URL 拆分 R0、R1、R2、P、D 和 C 入口。

### 中国核心研究入口

| 机构 | 入口 | 层级 | Follow-up 状态 |
|---|---|---|---|
| Alibaba / Qwen | [Qwen Research](https://qwen.ai/research) | R0/R1 | 候选；单站包含研究索引和论文入口 |
| Alibaba / Qwen | [Qwen Blog](https://qwen.ai/blog/) | R2/P | 已实现；按文章分类 |
| DeepSeek | [Transparency Center](https://www.deepseek.com/en/transparency/) | R0/R1 | 候选；重点发现 Model Card 和 Technical Report |
| ByteDance Seed | [Research](https://seed.bytedance.com/en/research) | R0 | 候选 |
| ByteDance Seed | [Publications](https://seed.bytedance.com/en/public_papers) | R1 | 候选 |
| Moonshot / Kimi | [Research & Tech Blog](https://www.kimi.ai/blog/) | R2/P | 已实现；按文章分类 |
| Zhipu / Z.ai | [Z.ai Research](https://www.zhipuai.cn/en/research) | R0/R1 | 候选；单站包含研究分类和技术文章 |
| Baidu / ERNIE | [ERNIE Blog](https://ernie.baidu.com/blog/zh/) | R2/P | 已实现；按文章分类 |
| MiniMax | [Research / Blog](https://www.minimax.cn/blog) | R2/P | 已实现；按文章分类 |
| PixVerse | [PixVerse Research](https://pixverse.ai/en/research) | R0/R1 | 候选；视频与 World Model 专项 |

第二批机构候选：Tencent Hunyuan、StepFun、Meituan LongCat、SenseTime、Huawei Noah's Ark Lab、Xiaomi MiMo、ModelBest / OpenBMB。其 Technical Report、GitHub、Hugging Face 和 ModelScope 入口应分别登记为 R1 或 C，不以开发者平台首页代替研究根信源。

### 开发与复现辅助入口

这些入口用于确认 API 变化、代码发布、模型权重和可复现材料，不作为研究发现的主信源。

| 机构 | 入口 | 层级 | Follow-up 状态 |
|---|---|---|---|
| OpenAI | [Developer Documentation](https://platform.openai.com/docs/) | D | 候选，辅助产品与 API 变更 |
| Anthropic | [Developer Documentation](https://docs.anthropic.com/) | D | 候选，辅助产品与 API 变更 |
| DeepSeek | [API Documentation](https://api-docs.deepseek.com/) | D | 候选，不替代 Technical Report |
| Qwen | [QwenLM GitHub](https://github.com/QwenLM) | C | 候选，代码与版本证据 |
| Qwen | [Hugging Face](https://huggingface.co/Qwen) | C | 候选，模型与 Model Card |
| DeepSeek | [deepseek-ai GitHub](https://github.com/deepseek-ai) | C | 候选，代码与版本证据 |
| Xiaomi MiMo | [XiaomiMiMo GitHub](https://github.com/XiaomiMiMo) | C | 候选，代码与版本证据 |
| ModelBest / OpenBMB | [OpenBMB GitHub](https://github.com/OpenBMB) | C | 候选，代码与版本证据 |

## 5. Google Antigravity Blog

| 字段 | 结论 |
|---|---|
| URL | [https://antigravity.google/blog](https://antigravity.google/blog) |
| 归属 | Google Antigravity |
| 内容层级 | P：产品 / 开发者 Blog |
| 用户频道 | 官方博客与技术社区 |
| 当前状态 | 已实现；已进入 `feed-blogs.json`，通过官方 RSS 发现并保留 HTML 回退 |
| 联网验证 | Browser-live；本地 Node 网络路由受阻 |

Antigravity Blog 不应替代 Google Research 或 Google DeepMind Research。它适合提供 Agentic Development、产品能力、工程实践和开发者生态信号；涉及底层方法、论文或评测时，应继续关联对应的 R0/R1 原始来源。

## 6. 跨频道发现与证据源

这些平台不新增用户可见频道，而是按内容语义归入七类频道。

| 来源 | 层级 | 作用 | 状态 |
|---|---|---|---|
| GitHub | C | Release、代码、Issue 和 Discussion，验证“实际做了什么” | 待实现 |
| Hacker News | M | 技术社区讨论、异常反馈和开发者共识 | 待实现 |
| Reddit | M | 用户痛点、产品比较、使用反馈和论文讨论 | 待实现 |
| YouTube | M | 视频发现、字幕和评论 | 待实现 |
| Techmeme | M | 科技事件聚合和媒体交叉验证 | 待实现 |
| Digg AI 1000 | M | 高信号账号的话题聚类和趋势发现 | 待实现 |
| 小红书 | M | 中国 AI 产品、创作者工具和用户反馈 | 待实现，可选授权源 |
| 微信公众号 | M/R2/P | 指定账号的公司公告、研究解读和行业观察；按账号与文章分类 | 待实现，可选授权源 |

## 7. 推荐接入顺序

1. **继续核验候选入口**：按具体 URL 区分研究、论文、产品、开发文档和代码入口。
2. **扩展讨论与证据层**：接入 Hacker News、Techmeme、GitHub 等跨频道发现源。
3. **论文和报告关联**：把 Research Blog 条目关联到论文、Technical Report、Model Card、代码和模型仓库，而不是重复生成互不相干的 Signal。
4. **第二批扩展**：Meta、NVIDIA、Cohere、DeepSeek、Seed、Z.ai 及候选池中的专业研究机构。

每个新来源仍须经过 shadow 模式、契约测试、离线 Fixture、来源健康检查和人工相关性抽查，达标后才能进入正式 Digest。

## 8. 当前事实依据

- 有效来源加载：`scripts/generate-feed.js` 的 `loadSources()`。
- 官网 Blog 生产配置：`config/feed-blogs.json`。
- 官网 Blog 采集编排：`scripts/blog-collector.js` 的 `fetchBlogContent()`；`scripts/generate-feed.js` 负责加载配置与写入 Feed。
- Newsletter：`config/feed-newsletters.json`。
- 学术研究：`config/feed-academic.json`。
- 中文科技：`config/feed-zh-tech.json`。
- 本地 Adapter 路线：`docs/superpowers/specs/2026-09-01-local-acquisition-adapters-design.md`。

后续变更信源时，应同时更新本目录和实际配置；只有配置与采集路径都落地后，才能把状态改为“已实现”。
