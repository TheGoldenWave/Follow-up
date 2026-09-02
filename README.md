**English** | [中文](README.zh-CN.md)

# Follow-up: AI Signal & Attention Curation

> Follow Builders, Not Influencers — and beyond.

A **Skill-first, plugin-enhanced** personal AI curation system that aggregates content from
**7 source categories** across the global AI & tech landscape, compresses it into actionable Signals, and delivers it through IM, email, or agent conversations. Built on the
[follow-builders](https://github.com/zarazhangrui/follow-builders) architecture,
extended with comprehensive coverage of academic research, newsletters, Chinese tech
media, and industry reports.

**Philosophy:** Follow people who build products, write original research, and have
independent opinions — not influencers who regurgitate information. Combine Western
and Chinese perspectives into a unified, low-noise attention feed.

## Product Positioning

> Follow-up is a Skill-first, plugin-enhanced Signal / Attention curation system. The Skill is the portable interface across agents; a DeepSeek Harness plugin is the planned rich information workspace; fetching, state, scheduling, and delivery remain separate runtime responsibilities.

Follow-up outputs **Signals, not Knowledge** by default:

```text
fetched ≠ trusted
summarized ≠ read
delivered ≠ understood
saved ≠ practice-verified
```

### Product Structure

| Component | Responsibility |
|---|---|
| Follow-up Skill | Installation, onboarding, configuration, on-demand digests, and conversational feedback |
| DeepSeek Harness Plugin (planned) | Personalized multi-platform information center, topic clustering, recommendation explanations, and batch feedback |
| Follow-up Core / Contract (planned) | Shared Signal, Topic, Digest, Feedback, Delivery, and Handoff semantics |
| Feed Pipeline | Fetching, parsing, deduplication, caching, and source health |
| Delivery Runtime | Scheduling, IM/email delivery, retries, and receipts |
| Local User State (planned) | Open, ignore, read-later, and learning/project/memory proposal events |

The DeepSeek Harness plugin only projects shared Follow-up Core / State. It does not refetch Feeds, maintain parallel reading state, or become another Knowledge authority.

### Personal AI System Boundary

| System | Responsibility |
|---|---|
| LifeSub | Evidence: what actually happened |
| Follow-up | Signal / Attention: what in the outside world may deserve attention |
| Malow | Work: which Signals enter a Project / Matter, action, or decision |
| GoldenWave | Memory: what becomes long-term, governed personal context |

Follow-up never directly or automatically writes authoritative Malow or GoldenWave state. Future integrations may only submit auditable proposals for downstream acceptance and promotion. See the [positioning design](docs/superpowers/specs/2026-08-28-skill-first-positioning-design.md).

### Current Status and Target Direction

The current release still consumes centrally generated public Feeds. This remains the
documented runtime truth until each replacement source passes shadow-mode acceptance.

The next architecture moves acquisition into each user's local environment:

```text
Local Scheduler -> Acquisition Runtime -> Source Adapters / Sidecars
                -> Versioned Signal Batch -> Follow-up Core -> Digest / Delivery
```

- Users own source API keys, cookies, login sessions, quotas, and related platform risk.
- Follow-up maintainers do not host shared source credentials or pay source API costs.
- Mature, license-compatible implementations are reused through audited vendor snapshots;
  Follow-up does not reimplement platform protocols without a concrete need.
- GitHub, Hacker News, Reddit, RSS, YouTube, Techmeme, Digg AI 1000, and arXiv run
  through local Adapters or managed local tools.
- Xiaohongshu and WeChat Official Accounts use local-only Sidecars for persistent login
  state. They never rely on a Follow-up-operated service.

See the [local acquisition design](docs/superpowers/specs/2026-09-01-local-acquisition-adapters-design.md)
and [implementation plan](docs/superpowers/plans/2026-09-02-local-acquisition-adapters.md).

## The 7-Category Source Strategy

Six live Feed categories are currently generated: X, podcasts, official blogs, newsletters, academic papers, and Chinese tech. Industry reports remain a low-frequency source plan and do not yet have a stable live Feed.

```
┌──────────────────────────────────────────────────────────────────┐
│                   Follow-up Signal Digest                           │
├──────────────────────────────────────────────────────────────────┤
│ Channel 1 │ AI Builders & Thought Leaders (X/Twitter)             │
│ Channel 2 │ Top AI Podcasts & Videos                              │
│ Channel 3 │ Company Official Blogs                                │
│ Channel 4 │ High-Quality Newsletters                              │
│ Channel 5 │ Academic Papers & Frontier Research                   │
│ Channel 6 │ Chinese Tech Ecosystem                                │
│ Channel 7 │ Industry Reports & Deep Analysis                      │
└──────────────────────────────────────────────────────────────────┘
```

### Channel 1: AI Builders & Thought Leaders (X/Twitter)

Track the people actually building the future — researchers, founders, PMs, and
engineers at leading AI labs and startups. Their tweets are the earliest signal of
what's coming.

**30+ curated builders** including:

| Category | People |
|----------|--------|
| AI Lab Leaders | Sam Altman (OpenAI), Dario Amodei (Anthropic), Demis Hassabis (DeepMind) |
| Researcher-Builders | Andrej Karpathy, Amanda Askell, Boris Cherny, Swyx |
| Product Leaders | Josh Woodward (Google Labs), Thariq (Claude Code), Thibault Sottiaux (OpenAI) |
| Founder-VCs | Amjad Masad (Replit), Guillermo Rauch (Vercel), Garry Tan (YC), Matt Turck (FirstMark) |
| Independent Voices | Dan Shipper (Every), Zara Zhang, Peter Steinberger, Aaron Levie (Box) |

### Channel 2: Top AI Podcasts & Videos

Deep-dive conversations with the people building AI. Each episode transcript is
summarized into key insights — no need to watch the full 2-hour video.

**10+ podcasts** including:

- **Latent Space** — the AI engineer's podcast
- **Training Data** (Sequoia) — founder perspectives
- **No Priors** (Elad Gil & Sarah Guo) — VC lens on AI
- **Unsupervised Learning** (Redpoint) — AI startup deep dives
- **The MAD Podcast** (Matt Turck) — data & AI ecosystem
- **AI & I** (Dan Shipper / Every) — how AI changes work
- **Lex Fridman Podcast** — long-form conversations with AI leaders
- **The Cognitive Revolution** (Nathan Labenz) — AI builders & researchers
- **Lightcone** (YC) — startup building advice
- **Acquired** — deep dives into great tech companies

### Channel 3: Company Official Blogs

Primary sources directly from the labs and companies building AI. No middleman, no
spin — just the technical details and product announcements.

**8+ official blogs:**

| Company | Blog | Focus |
|---------|------|-------|
| OpenAI | [openai.com/research](https://openai.com/research) | Research, product, safety |
| Anthropic | [anthropic.com/engineering](https://www.anthropic.com/engineering) | Engineering deep-dives |
| Anthropic | [claude.com/blog](https://claude.com/blog) | Claude product updates |
| Google DeepMind | [deepmind.google/blog](https://deepmind.google/blog) | Research breakthroughs |
| Google AI | [ai.googleblog.com](https://ai.googleblog.com) | Applied AI research |
| Meta AI | [ai.meta.com/blog](https://ai.meta.com/blog) | Open-source AI, Llama |
| Microsoft Research | [microsoft.com/research](https://www.microsoft.com/en-us/research/blog) | Systems & applied AI |
| NVIDIA | [blogs.nvidia.com](https://blogs.nvidia.com) | Hardware, CUDA, AI infra |
| Mistral AI | [mistral.ai/news](https://mistral.ai/news) | Open-weight models |

### Channel 4: High-Quality Newsletters

Curated newsletters that distill the firehose of AI news into structured, actionable
briefs. These are written by domain experts who read everything so you don't have to.

| Newsletter | Author | Cadence | Focus |
|------------|--------|---------|-------|
| **The Batch** | Andrew Ng / DeepLearning.AI | Weekly | AI news + expert commentary |
| **Ben's Bites** | Ben Tossell | Daily | AI tools & products in 5 min |
| **TLDR AI** | TLDR team | Daily | Structured AI news brief |
| **Import AI** | Jack Clark (Anthropic) | Weekly | AI policy, research, industry |
| **The Algorithmic Bridge** | Alberto Romero | Weekly | Critical AI analysis |
| **AI Snake Oil** | Arvind Narayanan & Sayash Kapoor | Monthly | AI hype debunking |
| **Stratechery** | Ben Thompson | Daily | Tech strategy analysis |
| **The Gradient** | The Gradient team | Weekly | AI research overview |

### Channel 5: Academic Papers & Frontier Research

Track the bleeding edge of AI research — from arXiv preprints and top conference
proceedings to major award announcements.

**Sources:**

- **arXiv** — cs.AI, cs.CL, cs.CV, cs.LG, cs.MA (multi-agent), stat.ML
- **Papers With Code** — trending papers + state-of-the-art benchmarks
- **Semantic Scholar** — highly-cited recent papers, author alerts
- **Conference Proceedings** — NeurIPS, ICML, ICLR, CVPR, ACL, EMNLP, AAAI, SIGGRAPH
- **Major Awards** — Turing Award, NeurIPS Best Paper, ICML Outstanding Paper

**Filtering strategy:** Only surface papers that are:
1. Highly cited or trending (top 5% in downloads/mentions)
2. From top-tier venues (NeurIPS/ICML/ICLR/CVPR/ACL)
3. From major labs (OpenAI, Anthropic, DeepMind, Meta FAIR, etc.)
4. Directly relevant to AI product management, agents, LLMs, or multimodal AI

### Channel 6: Chinese Tech Ecosystem

The Chinese AI landscape moves at a different pace and often in different directions.
Track the Chinese perspective through official media, independent blogs, and WeChat
accounts.

**Sources:**

| Type | Source | Focus |
|------|--------|-------|
| 科技媒体 | 机器之心 (jiqizhixin) | AI news + technical analysis |
| 科技媒体 | 量子位 (QbitAI) | AI industry news |
| 科技媒体 | 少数派 (sspai) | Productivity & tools |
| 深度分析 | 36氪 (36Kr) | Startup & tech industry |
| 学术媒体 | 新智元 (AI Era) | AI research & industry |
| 微信公众号 | 李开复、张一鸣、陆奇等 | Individual thought leaders |
| 微信公众号 | 各AI公司官方号 | Company announcements |
| 学术机构 | 清北AI实验室、中科院自动化所 | Chinese academic research |

### Channel 7: Industry Reports & Deep Analysis

Occasional deep-dive reports from investment banks, consulting firms, and research
institutes that provide macro-level context.

**Sources:**

- VC annual reports: a16z, Sequoia, FirstMark, Bessemer
- State of AI Report (Nathan Benaich / Air Street Capital)
- McKinsey / BCG / Gartner AI reports
- CB Insights AI trends
- Stanford HAI AI Index Report
- 亿欧智库 / 艾瑞咨询 (Chinese industry reports)

## What You Get

A daily or weekly actionable Signal digest delivered to your preferred messaging app with:

- **AI Builders Pulse** — What top builders are saying on X (1-2 sentences each)
- **Podcast Deep Dives** — Key takeaways from latest episodes (200-400 words)
- **Official Blog Updates** — New product launches, research findings, policy changes
- **Newsletter Roundup** — Cross-referenced highlights from all tracked newsletters
- **Paper Spotlight** — 1-2 notable papers with plain-English explanations
- **Chinese Tech Brief** — Curated highlights from Chinese AI media
- **Report Alerts (planned)** — When major industry reports drop

All with links to original content. Available in English, Chinese, or bilingual. A Digest is not automatically written to GoldenWave and does not imply that you have read, understood, or endorsed it.

## Quick Start

1. Install the skill in your AI agent (Hermes, OpenClaw, or Claude Code)
2. Say "set up follow builders" or invoke `/follow-builders`
3. The agent walks you through setup conversationally

The agent will ask you:
- How often you want your digest (daily or weekly) and what time
- What language you prefer (English, Chinese, or bilingual)
- How you want it delivered (in-chat, Telegram, email)

No source-fetching API keys are required from users because content is fetched centrally. Telegram or email delivery still requires the user's own delivery credentials.

> The current release consumes all six live Feeds. Enforced per-user channel switches are planned and should not be presented as implemented filtering.

## Customizing Your Digest

The skill uses plain-English prompt files to control how each channel is summarized.
You can customize them through conversation or by editing directly.

### Prompt Files

| File | Controls |
|------|----------|
| `prompts/digest-intro.md` | Overall digest format and tone |
| `prompts/summarize-tweets.md` | How X/Twitter posts are summarized |
| `prompts/summarize-podcast.md` | How podcast episodes are summarized |
| `prompts/summarize-blogs.md` | How blog posts are summarized |
| `prompts/summarize-newsletter.md` | How newsletters are summarized |
| `prompts/summarize-paper.md` | How academic papers are summarized |
| `prompts/summarize-zh-sources.md` | How Chinese sources are summarized |
| `prompts/translate.md` | How English content is translated to Chinese |

### Channel Cadence (Target Strategy)

The target cadence differs by source category:
- **Daily:** Builders + Newsletters + Blogs (fast signals)
- **Weekly:** Podcasts + Papers + Chinese Tech (deep dives)
- **Monthly:** Industry Reports + Conference Roundups (macro context)

## Default Sources

### AI Builders on X (30+)
[Andrej Karpathy](https://x.com/karpathy), [Swyx](https://x.com/swyx), [Josh Woodward](https://x.com/joshwoodward), [Boris Cherny](https://x.com/bcherny), [Thibault Sottiaux](https://x.com/thsottiaux), [Peter Yang](https://x.com/petergyang), [Nan Yu](https://x.com/thenanyu), [Madhu Guru](https://x.com/realmadhuguru), [Amanda Askell](https://x.com/AmandaAskell), [Cat Wu](https://x.com/_catwu), [Thariq](https://x.com/trq212), [Google Labs](https://x.com/GoogleLabs), [Amjad Masad](https://x.com/amasad), [Guillermo Rauch](https://x.com/rauchg), [Alex Albert](https://x.com/alexalbert__), [Aaron Levie](https://x.com/levie), [Ryo Lu](https://x.com/ryolu_), [Garry Tan](https://x.com/garrytan), [Matt Turck](https://x.com/mattturck), [Zara Zhang](https://x.com/zarazhangrui), [Nikunj Kothari](https://x.com/nikunj), [Peter Steinberger](https://x.com/steipete), [Dan Shipper](https://x.com/danshipper), [Aditya Agarwal](https://x.com/adityaag), [Sam Altman](https://x.com/sama), [Claude](https://x.com/claudeai), [Dario Amodei](https://x.com/dario_amodei_h), [Nathan Labenz](https://x.com/nathanlabenz), [Jack Clark](https://x.com/jackclarksf), [Ben Tossell](https://x.com/bentossell)

### Podcasts (10+)
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

### Official Blogs (8+)
- [OpenAI Research](https://openai.com/research)
- [Anthropic Engineering](https://www.anthropic.com/engineering)
- [Claude Blog](https://claude.com/blog)
- [Google DeepMind](https://deepmind.google/blog)
- [Meta AI](https://ai.meta.com/blog)
- [Microsoft Research](https://www.microsoft.com/en-us/research/blog)
- [NVIDIA Blog](https://blogs.nvidia.com)
- [Mistral AI News](https://mistral.ai/news)

### Newsletters (8)
- [The Batch by Andrew Ng](https://www.deeplearning.ai/the-batch)
- [Ben's Bites](https://bensbites.beehiiv.com)
- [TLDR AI](https://tldr.tech/ai)
- [Import AI by Jack Clark](https://importai.substack.com)
- [The Algorithmic Bridge](https://www.thealgorithmicbridge.com)
- [AI Snake Oil](https://www.aisnakeoil.com)
- [Stratechery by Ben Thompson](https://stratechery.com)
- [The Gradient](https://thegradient.pub)

### Academic Sources
- [arXiv cs.AI / cs.CL / cs.LG / cs.CV](https://arxiv.org)
- [Papers With Code](https://paperswithcode.com)
- [Semantic Scholar](https://www.semanticscholar.org)
- [NeurIPS Proceedings](https://proceedings.neurips.cc)
- [ICML Proceedings](https://proceedings.mlr.press)
- [ICLR Papers](https://openreview.net/group?id=ICLR.cc)
- [CVPR / ACL / EMNLP / AAAI](https://openaccess.thecvf.com)

### Chinese Tech Ecosystem
- [机器之心 (jiqizhixin.com)](https://www.jiqizhixin.com)
- [量子位 (QbitAI)](https://www.qbitai.com)
- [少数派 (sspai.com)](https://sspai.com)
- [36氪 (36kr.com)](https://36kr.com)
- [新智元 (AI Era)](https://www.aiera.com.cn)

### Industry Reports
- [State of AI Report](https://www.stateof.ai)
- [Stanford HAI AI Index](https://hai.stanford.edu/ai-index)
- [a16z AI Canon](https://a16z.com/ai-canon)
- [CB Insights AI Research](https://www.cbinsights.com/research/artificial-intelligence)

## How It Works

### Current release

1. **Central Feed generation:** GitHub Actions run daily to fetch content from six
   live categories (X/Twitter API, YouTube transcripts via Pod2Text, RSS feeds for
   blogs and newsletters, arXiv API for papers, web scraping for Chinese sources)
2. **Your agent fetches the feed:** One HTTP request, no API keys needed
3. **AI remixes Signals:** Your agent uses the prompt files to remix raw content
   into a structured, scannable digest tailored to your preferences
4. **Digest delivered:** To your messaging app or directly in chat
5. **Feedback and handoff (planned):** A DeepSeek Harness information center supports deeper review and explicit actions, then submits proposals to Malow or GoldenWave

### Development roadmap

1. **Foundation:** introduce the Python Acquisition Runtime, versioned Signal Batch,
   health taxonomy, local configuration, and audited upstream provenance.
2. **Keyless sources:** migrate RSS, GitHub, Hacker News, and keyless Reddit into shadow mode.
3. **Managed local tools:** add YouTube via `yt-dlp` and Digg, Techmeme, and arXiv via
   pinned Printing Press CLIs.
4. **Authorized sources:** add X, Xiaohongshu, and WeChat Official Accounts with explicit
   user authorization and local Sidecar isolation.
5. **Per-source cutover:** switch sources independently after quality, security, and
   stability gates; retain a 14-day rollback window.
6. **Central retirement:** remove the public Feed runtime only after all existing sources
   complete local migration and observation.

## Installation

### Hermes Agent
```bash
git clone https://github.com/TheGoldenWave/Follow-up.git ~/Documents/MyProject/Follow-up
cd ~/Documents/MyProject/Follow-up/scripts && npm install
```

### OpenClaw
```bash
clawhub install follow-builders
```

### Claude Code
```bash
git clone https://github.com/TheGoldenWave/Follow-up.git ~/.claude/skills/follow-builders
cd ~/.claude/skills/follow-builders/scripts && npm install
```

## Configuration

All settings are stored in `~/.follow-builders/config.json`:

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

## Privacy

- Current release: no source-fetching API keys are provided to the Skill because public content is fetched centrally
- Target local acquisition: source credentials and costs belong to the user and remain on the user's machine
- Follow-up will not operate shared login sessions, source credentials, or acquisition Sidecars
- Xiaohongshu and WeChat Sidecars bind only to the local machine and expose no credential-export API
- If you use Telegram/email delivery, those keys are stored locally in `~/.follow-builders/.env`
- The skill only reads public content
- Your configuration and custom prompts stay on your machine
- Reading and feedback state is not implemented yet; future state must remain local and separate from public Feeds and product code

## License

MIT

---

*Original project: [follow-builders](https://github.com/zarazhangrui/follow-builders) by Zara Zhang*
*Extended by GoldenWave with multi-source Signal / Attention curation*
