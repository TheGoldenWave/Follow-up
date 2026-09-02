[English](README.md) | **中文**

# Follow-up：AI 信息信号与注意力策展

> 追踪建造者，而非网红——并超越于此。

一个 **Skill-first、plugin-enhanced** 的个人 AI 信息策展系统，从全球 AI 与科技领域的 **7 类精选来源** 聚合内容，将信息压缩为可行动 Signal，并通过 IM、邮件或 Agent 对话送达。
基于 [follow-builders](https://github.com/zarazhangrui/follow-builders) 架构构建，
扩展覆盖学术研究、Newsletter、中文科技媒体和行业报告。

**核心理念：** 追踪那些真正在做产品、写原创研究、有独立见解的人，而非只会搬运信息的网红。
融合中西视角，构建统一、低噪声的个人注意力信息流。

## 产品定位

> Follow-up 是一个 Skill-first、plugin-enhanced 的个人 AI Signal / Attention 策展系统。Skill 是跨 Agent 的通用入口；DeepSeek Harness 插件是规划中的富交互信息中心；抓取、状态、调度和投递由独立组件承担。

Follow-up 默认产出的是 **Signal，不是 Knowledge**：

```text
抓取到 ≠ 可信
摘要完成 ≠ 你看过
推送成功 ≠ 你理解
收藏内容 ≠ 经实践验证
```

### 产品结构

| 组件 | 职责 |
|---|---|
| Follow-up Skill | 安装、Onboarding、配置、按需摘要和自然语言反馈 |
| DeepSeek Harness Plugin（规划中） | 高度个性化的多平台信息中心、主题聚合、推荐解释和批量反馈 |
| Follow-up Core / Contract（规划中） | 统一 Signal、Topic、Digest、Feedback、Delivery 和 Handoff 语义 |
| Feed Pipeline | 抓取、解析、去重、缓存和来源健康 |
| Delivery Runtime | 定时、IM/邮件投递、重试和投递回执 |
| Local User State（规划中） | 打开、忽略、稍后读以及学习/项目/知识候选请求事件 |

DeepSeek Harness 插件只投影共享的 Follow-up Core / State，不重新抓取 Feed、不维护平行阅读状态，也不成为新的 Knowledge Authority。

### 与个人 AI 系统的关系

| 系统 | 职责 |
|---|---|
| LifeSub | Evidence：现实中真实发生过什么 |
| Follow-up | Signal / Attention：外部世界有什么值得注意 |
| Malow | Work：哪些 Signal 要进入 Project / Matter、行动或决策 |
| GoldenWave | Memory：什么值得成为长期、可审计的个人上下文 |

Follow-up 永远不直接或自动写入 Malow / GoldenWave 的权威状态。未来集成也只提交可审计 proposal，由下游系统决定是否接纳和晋升。完整边界见[产品定位设计](docs/superpowers/specs/2026-08-28-skill-first-positioning-design.md)。

### 当前状态与目标方向

当前版本仍然消费由维护者集中生成的公共 Feed。在各来源通过 shadow 验收前，
这仍是项目对外描述的真实运行方式。

下一阶段将信息采集迁移到每位用户的本地环境：

```text
本地调度器 -> Acquisition Runtime -> Source Adapter / Sidecar
           -> 版本化 Signal Batch -> Follow-up Core -> Digest / 投递
```

- 来源 API Key、Cookie、登录会话、配额和平台账号风险由用户自行拥有与承担。
- Follow-up 维护者不托管共享来源凭据，也不承担来源 API 费用。
- 优先通过经过审计的 Vendor 快照复用许可兼容的成熟实现，不无谓重写平台协议。
- GitHub、Hacker News、Reddit、RSS、YouTube、Techmeme、Digg AI 1000 和 arXiv
  通过本地 Adapter 或由 Follow-up 管理的本地工具运行。
- 小红书和微信公众号使用仅在本机运行的 Sidecar 维护长期登录态，不依赖
  Follow-up 维护者运营的服务。

详细设计见[本地采集架构](docs/superpowers/specs/2026-09-01-local-acquisition-adapters-design.md)，
实施顺序见[开发计划](docs/superpowers/plans/2026-09-02-local-acquisition-adapters.md)。

## 7 类来源策略

当前已经生成 6 类实时 Feed：X、播客、官方博客、Newsletter、学术论文和中文科技。行业报告属于低频来源规划，尚未形成稳定实时 Feed。

```
┌──────────────────────────────────────────────────────────────────┐
│                   Follow-up 信息信号摘要                            │
├──────────────────────────────────────────────────────────────────┤
│ 频道 1 │ AI 建造者 & 思想领袖（X/Twitter）                          │
│ 频道 2 │ 顶级 AI 播客 & 视频                                       │
│ 频道 3 │ 公司官方博客                                               │
│ 频道 4 │ 高质量 Newsletter                                         │
│ 频道 5 │ 学术论文 & 前沿研究                                        │
│ 频道 6 │ 中文科技生态                                               │
│ 频道 7 │ 行业报告 & 深度分析                                        │
└──────────────────────────────────────────────────────────────────┘
```

### 频道 1：AI 建造者 & 思想领袖（X/Twitter）

追踪那些真正在创造未来的人——一线 AI 实验室和创业公司的研究员、创始人、产品经理和工程师。
他们的推文是即将到来的趋势的最早信号。

**30+ 位精选建造者**，包括：

| 类别 | 人物 |
|------|------|
| AI 实验室领导者 | Sam Altman (OpenAI), Dario Amodei (Anthropic), Demis Hassabis (DeepMind) |
| 研究员-建造者 | Andrej Karpathy, Amanda Askell, Boris Cherny, Swyx |
| 产品领导者 | Josh Woodward (Google Labs), Thariq (Claude Code), Thibault Sottiaux (OpenAI) |
| 创始人/投资人 | Amjad Masad (Replit), Guillermo Rauch (Vercel), Garry Tan (YC), Matt Turck (FirstMark) |
| 独立声音 | Dan Shipper (Every), Zara Zhang, Peter Steinberger, Aaron Levie (Box) |

### 频道 2：顶级 AI 播客 & 视频

与 AI 建造者的深度对话。每期节目文稿被提炼为关键洞察——无需观看完整 2 小时视频。

**10+ 播客**，包括：

- **Latent Space** — AI 工程师必听播客
- **Training Data**（Sequoia）— 创始人视角
- **No Priors**（Elad Gil & Sarah Guo）— VC 视角看 AI
- **Unsupervised Learning**（Redpoint）— AI 创业深度分析
- **The MAD Podcast**（Matt Turck）— 数据与 AI 生态
- **AI & I**（Dan Shipper / Every）— AI 如何改变工作
- **Lex Fridman Podcast** — 与 AI 领袖的长篇对话
- **The Cognitive Revolution**（Nathan Labenz）— AI 建造者与研究者
- **Lightcone**（YC）— 创业建设建议
- **Acquired** — 伟大科技公司深度剖析

### 频道 3：公司官方博客

来自 AI 实验室和科技公司的一手信息源。无中间商，无滤镜——只有技术细节和产品公告。

**8+ 官方博客：**

| 公司 | 博客 | 关注点 |
|------|------|--------|
| OpenAI | openai.com/research | 研究、产品、安全 |
| Anthropic | anthropic.com/engineering | 工程深度文章 |
| Anthropic | claude.com/blog | Claude 产品更新 |
| Google DeepMind | deepmind.google/blog | 研究突破 |
| Google AI | ai.googleblog.com | 应用 AI 研究 |
| Meta AI | ai.meta.com/blog | 开源 AI、Llama |
| Microsoft Research | microsoft.com/research | 系统与应用 AI |
| NVIDIA | blogs.nvidia.com | 硬件、CUDA、AI 基础设施 |
| Mistral AI | mistral.ai/news | 开源模型 |

### 频道 4：高质量 Newsletter

由领域专家撰写的精选通讯，将 AI 新闻洪流提炼为结构化、可操作的简报。
这些人替你读了所有东西。

| Newsletter | 作者 | 频率 | 关注点 |
|------------|------|------|--------|
| **The Batch** | Andrew Ng / DeepLearning.AI | 每周 | AI 新闻 + 专家点评 |
| **Ben's Bites** | Ben Tossell | 每日 | 5 分钟读完最新 AI 工具 |
| **TLDR AI** | TLDR 团队 | 每日 | 结构化 AI 新闻简报 |
| **Import AI** | Jack Clark (Anthropic) | 每周 | AI 政策、研究、产业 |
| **The Algorithmic Bridge** | Alberto Romero | 每周 | 批判性 AI 分析 |
| **AI Snake Oil** | Arvind Narayanan & Sayash Kapoor | 每月 | AI 炒作揭秘 |
| **Stratechery** | Ben Thompson | 每日 | 科技战略分析 |
| **The Gradient** | The Gradient 团队 | 每周 | AI 研究综述 |

### 频道 5：学术论文 & 前沿研究

追踪 AI 研究的最前沿——从 arXiv 预印本和顶级会议论文到重大奖项公告。

**数据源：**

- **arXiv** — cs.AI, cs.CL, cs.CV, cs.LG, cs.MA（多智能体）, stat.ML
- **Papers With Code** — 热门论文 + SOTA 基准
- **Semantic Scholar** — 高引用最新论文、作者提醒
- **会议论文** — NeurIPS, ICML, ICLR, CVPR, ACL, EMNLP, AAAI, SIGGRAPH
- **重大奖项** — 图灵奖、NeurIPS 最佳论文、ICML 杰出论文

**筛选策略：** 仅推送符合以下条件的论文：
1. 高引用或热门（下载/提及量前 5%）
2. 来自顶级会议（NeurIPS/ICML/ICLR/CVPR/ACL）
3. 来自主要实验室（OpenAI, Anthropic, DeepMind, Meta FAIR 等）
4. 与 AI 产品管理、智能体、LLM 或多模态 AI 直接相关

### 频道 6：中文科技生态

中国 AI 生态以不同的节奏和方向演进。通过官方媒体、独立博客和微信公众号追踪中文视角。

**数据源：**

| 类型 | 来源 | 关注点 |
|------|------|--------|
| 科技媒体 | 机器之心 (jiqizhixin) | AI 新闻 + 技术分析 |
| 科技媒体 | 量子位 (QbitAI) | AI 行业新闻 |
| 科技媒体 | 少数派 (sspai) | 生产力与工具 |
| 深度分析 | 36氪 (36Kr) | 创业与科技产业 |
| 学术媒体 | 新智元 (AI Era) | AI 研究与产业 |
| 微信公众号 | 李开复、陆奇等 | 个人思想领袖 |
| 微信公众号 | 各 AI 公司官方号 | 公司公告 |
| 学术机构 | 清北 AI 实验室、中科院自动化所 | 中国学术研究 |

### 频道 7：行业报告 & 深度分析

来自投行、咨询公司和研究机构的深度报告，提供宏观层面的背景分析。

**数据源：**

- VC 年度报告：a16z, Sequoia, FirstMark, Bessemer
- State of AI Report（Nathan Benaich / Air Street Capital）
- McKinsey / BCG / Gartner AI 报告
- CB Insights AI 趋势
- Stanford HAI AI Index Report
- 亿欧智库 / 艾瑞咨询（中国行业报告）

## 你会得到什么

每日或每周推送到你常用通讯工具的可行动 Signal 摘要，包含：

- **AI 建造者脉搏** — 顶级建造者在 X 上的最新动态（每人 1-2 句）
- **播客深度解析** — 最新节目的核心要点（200-400 字）
- **官方博客更新** — 新产品发布、研究发现、政策变化
- **Newsletter 汇总** — 所有追踪 Newsletter 的交叉引用亮点
- **论文聚焦** — 1-2 篇值得关注的论文，附通俗解释
- **中文科技简报** — 中文 AI 媒体精选亮点
- **报告提醒（规划中）** — 重大行业报告发布通知

所有内容均附原始链接。支持英文、中文或双语版本。Digest 默认不会写入 GoldenWave，也不代表你已经阅读、理解或认可其中内容。

## 快速开始

1. 在你的 AI agent 中安装此 skill（Hermes、OpenClaw 或 Claude Code）
2. 输入 "set up follow builders" 或执行 `/follow-builders`
3. Agent 会以对话方式引导你完成设置

Agent 会询问你：
- 推送频率（每日或每周）和时间
- 语言偏好（英文、中文或双语）
- 推送方式（聊天中显示、Telegram、邮件）

不需要用户提供来源抓取 API key，内容由中心化服务统一抓取。Telegram 或邮件等外部投递仍需要用户自己的投递凭据。

> 当前版本会读取全部 6 类实时 Feed。按用户配置真正执行频道开关仍在规划中；配置界面不应宣称已完成筛选。

## 自定义摘要

Skill 使用纯文本 prompt 文件来控制每个频道的摘要方式。
你可以通过对话或直接编辑来定制。

### Prompt 文件

| 文件 | 控制内容 |
|------|----------|
| `prompts/digest-intro.md` | 整体摘要格式和语气 |
| `prompts/summarize-tweets.md` | X/Twitter 帖子摘要方式 |
| `prompts/summarize-podcast.md` | 播客节目摘要方式 |
| `prompts/summarize-blogs.md` | 博客文章摘要方式 |
| `prompts/summarize-newsletter.md` | Newsletter 摘要方式 |
| `prompts/summarize-paper.md` | 学术论文摘要方式 |
| `prompts/summarize-zh-sources.md` | 中文源摘要方式 |
| `prompts/translate.md` | 英文内容翻译为中文的方式 |

### 频道节奏（目标策略）

目标上，不同来源应采用不同节奏：
- **每日：** 建造者 + Newsletter + 博客（快速信号）
- **每周：** 播客 + 论文 + 中文科技（深度内容）
- **每月：** 行业报告 + 会议综述（宏观背景）

## 默认信息源

### X 上的 AI 建造者（30+ 位）
[Andrej Karpathy](https://x.com/karpathy), [Swyx](https://x.com/swyx), [Josh Woodward](https://x.com/joshwoodward), [Boris Cherny](https://x.com/bcherny), [Thibault Sottiaux](https://x.com/thsottiaux), [Peter Yang](https://x.com/petergyang), [Nan Yu](https://x.com/thenanyu), [Madhu Guru](https://x.com/realmadhuguru), [Amanda Askell](https://x.com/AmandaAskell), [Cat Wu](https://x.com/_catwu), [Thariq](https://x.com/trq212), [Google Labs](https://x.com/GoogleLabs), [Amjad Masad](https://x.com/amasad), [Guillermo Rauch](https://x.com/rauchg), [Alex Albert](https://x.com/alexalbert__), [Aaron Levie](https://x.com/levie), [Ryo Lu](https://x.com/ryolu_), [Garry Tan](https://x.com/garrytan), [Matt Turck](https://x.com/mattturck), [Zara Zhang](https://x.com/zarazhangrui), [Nikunj Kothari](https://x.com/nikunj), [Peter Steinberger](https://x.com/steipete), [Dan Shipper](https://x.com/danshipper), [Aditya Agarwal](https://x.com/adityaag), [Sam Altman](https://x.com/sama), [Claude](https://x.com/claudeai), [Dario Amodei](https://x.com/dario_amodei_h), [Nathan Labenz](https://x.com/nathanlabenz), [Jack Clark](https://x.com/jackclarksf), [Ben Tossell](https://x.com/bentossell)

### 播客（10+）
- [Latent Space](https://www.youtube.com/@LatentSpacePod)
- [Training Data](https://www.youtube.com/playlist?list=PLOhHNjZItNnMm5tdW61JpnyxeYH5NDDx8)
- [No Priors](https://www.youtube.com/@NoPriorsPodcast)
- [Unsupervised Learning](https://www.youtube.com/@RedpointAI)
- [The MAD Podcast with Matt Turck](https://www.youtube.com/@DataDrivenNYC)
- [AI & I by Every](https://www.youtube.com/playlist?list=PLuMcoKK9mKgHtW_o9h5sGO2vXrffKHwJL)
- [Lex Fridman Podcast](https://www.youtube.com/@lexfridman)
- [The Cognitive Revolution](https://www.youtube.com/@CognitiveRevolutionPodcast)
- [Lightcone (YC)](https://www.youtube.com/@ycombinator)
- [Acquired](https://www.youtube.com/@AcquiredFM)

### 官方博客（8+）
- [OpenAI Research](https://openai.com/research)
- [Anthropic Engineering](https://www.anthropic.com/engineering)
- [Claude Blog](https://claude.com/blog)
- [Google DeepMind](https://deepmind.google/blog)
- [Meta AI](https://ai.meta.com/blog)
- [Microsoft Research](https://www.microsoft.com/en-us/research/blog)
- [NVIDIA Blog](https://blogs.nvidia.com)
- [Mistral AI News](https://mistral.ai/news)

### Newsletter（8 个）
- [The Batch by Andrew Ng](https://www.deeplearning.ai/the-batch)
- [Ben's Bites](https://bensbites.beehiiv.com)
- [TLDR AI](https://tldr.tech/ai)
- [Import AI by Jack Clark](https://importai.substack.com)
- [The Algorithmic Bridge](https://www.thealgorithmicbridge.com)
- [AI Snake Oil](https://www.aisnakeoil.com)
- [Stratechery by Ben Thompson](https://stratechery.com)
- [The Gradient](https://thegradient.pub)

### 学术源
- [arXiv cs.AI / cs.CL / cs.LG / cs.CV](https://arxiv.org)
- [Papers With Code](https://paperswithcode.com)
- [Semantic Scholar](https://www.semanticscholar.org)
- [NeurIPS Proceedings](https://proceedings.neurips.cc)
- [ICML Proceedings](https://proceedings.mlr.press)
- [ICLR Papers](https://openreview.net/group?id=ICLR.cc)
- [CVPR / ACL / EMNLP / AAAI](https://openaccess.thecvf.com)

### 中文科技生态
- [机器之心 (jiqizhixin.com)](https://www.jiqizhixin.com)
- [量子位 (QbitAI)](https://www.qbitai.com)
- [少数派 (sspai.com)](https://sspai.com)
- [36氪 (36kr.com)](https://36kr.com)
- [新智元 (AI Era)](https://www.aiera.com.cn)

### 行业报告
- [State of AI Report](https://www.stateof.ai)
- [Stanford HAI AI Index](https://hai.stanford.edu/ai-index)
- [a16z AI Canon](https://a16z.com/ai-canon)
- [CB Insights AI Research](https://www.cbinsights.com/research/artificial-intelligence)

## 工作原理

### 当前版本

1. **中心化 Feed 生成：** GitHub Actions 每日运行，从 6 类实时来源抓取内容
   （X/Twitter API、YouTube 字幕通过 Pod2Text、博客和 Newsletter 的 RSS、
   arXiv API、中文源的网页抓取）
2. **你的 Agent 获取 Feed：** 一次 HTTP 请求，无需 API key
3. **AI 混编 Signal：** Agent 使用 prompt 文件将原始内容重组为结构化、
   可扫描的摘要，根据你的偏好定制
4. **摘要推送：** 到通讯工具或直接在聊天中显示
5. **反馈与 Handoff（规划中）：** DeepSeek Harness 信息中心承载深度浏览与显式操作，再向 Malow 或 GoldenWave 提交 proposal

### 后续开发路线

1. **运行底座：** 建立 Python Acquisition Runtime、版本化 Signal Batch、来源健康状态、
   本地配置和上游来源追踪机制。
2. **免登录来源：** 将 RSS、GitHub、Hacker News 和免密 Reddit 接入 shadow 模式。
3. **本地工具来源：** 通过 `yt-dlp` 接入 YouTube，通过固定版本 Printing Press CLI
   接入 Digg、Techmeme 和 arXiv。
4. **授权来源：** 在用户明确授权后接入 X、小红书和微信公众号，并隔离 Sidecar 登录态。
5. **逐来源切换：** 每个来源独立通过质量、安全和稳定性门槛，再进入正式 Digest，
   切换后保留 14 天回滚窗口。
6. **中心层下线：** 现有来源全部完成本地迁移与观察后，才删除公共 Feed 运行时。

## 安装

Follow-up `v0.1.0` 需要 Node.js 20 或更高版本。请安装精确标签，并使用
`npm ci` 按发布锁文件安装依赖。该版本继续读取 6 类中心化公共 Feed，在准备
Digest 前验证 Feed Schema；除非用户存在本地覆盖，否则使用安装标签内的 Prompt。
`v0.1.0` 不提供自动发现更新或自动升级。

### 验证发布归档

```bash
curl -LO https://github.com/TheGoldenWave/Follow-up/releases/download/v0.1.0/Follow-up-v0.1.0.tar.gz
curl -LO https://github.com/TheGoldenWave/Follow-up/releases/download/v0.1.0/Follow-up-v0.1.0-checksums.txt
curl -LO https://github.com/TheGoldenWave/Follow-up/releases/download/v0.1.0/release-manifest.json
shasum -a 256 -c Follow-up-v0.1.0-checksums.txt
tar -xzf Follow-up-v0.1.0.tar.gz
cmp release-manifest.json Follow-up-v0.1.0/release-manifest.json
cd Follow-up-v0.1.0/scripts
node release/validate-release.js --archive-critical-only
npm ci
npm run validate-release:archive
npm run test:archive
```

checksums 资产验证完整归档在既定 GitHub 信任边界内未被替换。标签内的 manifest
则独立记录无自引用的 Git 跟踪内容摘要，以及关键发布文件的 SHA-256。具体来说，
`git-ls-tree-sha256-v1` 对 `git ls-tree -r -z --full-tree` 输出的原始 NUL 结尾记录
做哈希，保留每个路径的 Git mode、type、blob object ID 和字节顺序位置，只排除
`release-manifest.json` 以避免自引用。

归档模式会验证 Schema、版本、package lock、运行时、changelog、Feed 与 Prompt
契约，以及每个关键文件的 SHA-256。跟踪内容摘要（tracked content digest）只能在
标签或 checkout 中重新计算，因为精确源码归档按设计不包含 `.git` object database；
请在对应标签 checkout 中运行 `npm run validate-release` 完成这项验证。
无依赖的关键文件预检会在 `npm ci` 前运行，但它检查 validator 自身哈希时必然已经
执行了 validator，因此这种 self-verification 不能独立建立信任；单独下载的 manifest
资产、checksum 与解析后的受保护标签才是外部信任锚点。

### 发布维护者前置条件

标签 workflow 本身不能让 GitHub 资产或标签变得不可变。Task 6 发布前，仓库管理员
必须启用保护 `v*` 的 tag ruleset（protected `v*` tags），并启用 GitHub immutable
releases；在外部核实两项设置后，再把仓库变量 `RELEASE_IMMUTABILITY_CONFIRMED`
设为 `true`。未确认时 workflow 会拒绝发布，同时仍会拒绝覆盖已有 Release，作为
纵深防御。Task 6 必须重新核实外部设置，不能把该变量本身当成证明。

### Hermes Agent
```bash
git clone --branch v0.1.0 --depth 1 https://github.com/TheGoldenWave/Follow-up.git ~/Documents/MyProject/Follow-up
cd ~/Documents/MyProject/Follow-up/scripts && npm ci
```

### OpenClaw
```bash
clawhub install follow-builders
```

### Claude Code
```bash
git clone --branch v0.1.0 --depth 1 https://github.com/TheGoldenWave/Follow-up.git ~/.claude/skills/follow-builders
cd ~/.claude/skills/follow-builders/scripts && npm ci
```

升级到后续版本时，需要手动验证并安装该版本的精确标签。`v0.1.0` 不会自动替换
程序文件，也不会自动修改 `~/.follow-builders`。

## 配置

所有设置存储在 `~/.follow-builders/config.json`：

```json
{
  "platform": "other",
  "language": "bilingual",
  "timezone": "Asia/Shanghai",
  "frequency": "daily",
  "deliveryTime": "08:00",
  "delivery": {
    "method": "stdout"
  }
}
```

## 隐私

- 当前版本：公开内容由中心服务获取，因此不需要向 Skill 提供来源 API Key
- 目标本地采集：来源凭据和调用成本归用户，凭据只保留在用户机器上
- Follow-up 不运营共享登录会话、共享来源凭据或采集 Sidecar
- 小红书和微信公众号 Sidecar 只监听本机，不提供凭据导出接口
- 如果你使用 Telegram/邮件推送，相关 key 仅存储在本地 `~/.follow-builders/.env`
- Skill 只读取公开内容
- 你的配置和自定义 Prompt 保留在自己的设备上
- 阅读与反馈状态尚未正式实现；未来必须使用本地用户状态，不与公共 Feed 或代码一起提交

## 许可证

MIT

---

*原始项目：[follow-builders](https://github.com/zarazhangrui/follow-builders) by Zara Zhang*
*由 GoldenWave 扩展为多来源 Signal / Attention 策展策略*
