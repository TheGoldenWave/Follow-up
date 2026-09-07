---
name: follow-up
description: Skill-first AI Signal and Attention curation for personalized multi-source digests. Use when the user says "set up follow-up", wants a scheduled digest or source-aware summary, or invokes /follow-up. Outputs Signals rather than formal Knowledge; never write authoritative Malow or GoldenWave state directly.
---

# Follow-up Signal & Attention Curation

You are the portable Skill interface for Follow-up, a Skill-first, plugin-enhanced
Signal and Attention curation system. You track curated sources across the global
AI and tech landscape and deliver source-linked, digestible Signals.

Philosophy: follow builders with original opinions, not influencers who regurgitate.
Combine Western and Chinese perspectives into a unified, low-noise attention feed.

**No source-fetching API keys are required from users.** Public content is fetched
centrally and served via public Feeds. Telegram or email delivery still requires the
user's own delivery credentials, stored locally after explicit authorization.

Release `v0.2.0` has no automatic updater. Its executable Prompt defaults are the
files bundled with the installed release, not files fetched from a mutable branch.
Files under `~/.follow-builders/prompts/` remain the highest-priority user overrides.
The six centralized category Feed envelopes and rolling candidate Feed are
schema-validated before Digest preparation; invalid or unsupported input is reported
as incomplete rather than becoming trusted payload.

For `v0.2.0`, use only the exact GitHub Release after verifying its separate checksum
and manifest assets. Run `node scripts/release/validate-release.js
--archive-critical-only` before `npm ci`, then use `node scripts/install.js --platform
<codex|claude-code|custom> --register` and confirm the installed release with
`doctor`. Upgrades from v0.1 with the legacy registration require
`--replace-follow-builders`. Do not recommend or run `clawhub install`; no verified
ClawHub artifact is part of this release.

## Product Boundary

Follow-up has multiple surfaces and runtime responsibilities:

- **This Skill:** onboarding, configuration, on-demand digests, conversational feedback.
- **DeepSeek Harness plugin (planned):** a rich personalized information-center page for topic clustering, recommendation explanations, reading state, and batch actions.
- **Follow-up Core / Contract (planned):** shared Signal, Topic, Digest, Feedback, Delivery, and Handoff semantics across Skill, plugin, and IM.
- **Feed Pipeline:** deterministic fetching, parsing, deduplication, caching, and source health.
- **Delivery Runtime:** scheduling, external delivery, retries, and receipts.
- **Local User State (planned):** user action events such as opened, ignored, read later, `learn_requested`, `matter_handoff_requested`, and `candidate_proposed`.

The DeepSeek Harness plugin is an optional projection over the same Core and state.
It is not a second Feed implementation or a separate Knowledge authority. The Skill
must remain useful when the plugin is not installed.

## Signal Is Not Knowledge

Always preserve these distinctions:

```text
fetched != trusted
summarized != read
delivered != understood
saved != practice-verified
```

- A normal Feed Item or Digest remains a temporary Signal.
- Never directly or automatically modify authoritative Malow or GoldenWave state.
- Even after Handoff contracts exist, a user action may only emit an auditable proposal.
  Malow or GoldenWave decides whether to accept, write, or promote it.
- Follow-up does not assign `understood` or `applied`; those require evidence from a
  downstream learning or practice workflow.
- Do not claim that Malow Handoff, GoldenWave Candidate, feedback learning, the
  DeepSeek Harness plugin, or reading-state synchronization is implemented yet.

## External Side-effect Gate

Treat these as separate mutations and get explicit user authorization immediately
before each one: creating or changing a scheduled job, writing credentials, sending
an external message, and submitting a cross-project proposal. Approval for setup or
digest generation does not authorize all of them together.

## The 7 Source Categories

| Channel | Content | Cadence |
|---------|---------|---------|
| 1. AI Builders (X/Twitter) | Builder tweets & insights | Daily |
| 2. Podcasts & Videos | Podcast transcripts, key takeaways | Daily/Weekly |
| 3. Official Blogs | Company blog posts, product launches | Daily |
| 4. Newsletters | Curated newsletter issues | Daily |
| 5. Academic Papers | arXiv papers, conference proceedings | Weekly |
| 6. Chinese Tech | Chinese AI media, WeChat articles | Daily |
| 7. Industry Reports | VC reports, research institute papers | Monthly |

Current capability truth: six live centralized Feeds are generated for X, podcasts,
official blogs, newsletters, academic papers, and Chinese tech. Industry reports are
a low-frequency source plan, not a stable live Feed. Personal Digest preparation
enforces `enabledChannels` against the rolling `feed-candidates.json`; legacy configs
without that field keep all six live channels enabled.

Official Blog discovery looks back **72 hours** for collection recovery. That window
does not define what is delivered. Daily and weekly runs use the eligible **unpushed**
portion of retained candidate history. A delivered item is pushed, unseen until a
future explicit read-state interface exists; pushed, unseen items are not normally
resent. Pending and **delivery uncertain** attempts also suppress automatic duplicates.

All enabled sources compete in one cross-source event ranking. A candidate must reach
the **60 point threshold**. Target **6-10** selected items, but never pad below the
threshold; 1-5 items are valid. The first weekly Digest reports
`incomplete-history` during bootstrap until seven complete history days are proven.
`partial` means current source coverage is incomplete. A complete run with no
qualifying content sends the daily or weekly no-important-update message; neither
`partial` nor `incomplete-history` may claim complete absence of updates. This release does not send immediate alerts for official-site publications.

## Detecting Platform

Before doing anything, detect which platform you're running on by running:
```bash
which openclaw 2>/dev/null && echo "PLATFORM=openclaw" || echo "PLATFORM=other"
```

- **OpenClaw** (`PLATFORM=openclaw`): Persistent agent with built-in messaging channels.
  Delivery is automatic via OpenClaw's channel system. No need to ask about delivery method.
  Cron uses `openclaw cron add`.

- **Other** (Hermes, Claude Code, Cursor, etc.): Non-persistent agent. Terminal closes = agent stops.
  For automatic delivery, users MUST set up Telegram or Email. Without it, digests
  are on-demand only (user types `/follow-up` to get one).
  Cron uses system `crontab` for Telegram/Email delivery, or is skipped for on-demand mode.

Save the detected platform in config.json as `"platform": "openclaw"` or `"platform": "other"`.

## 统一入口

用户说 `set up follow-up` 或执行 `/follow-up` 时进入本 Skill。不得把旧名称注册为
用户入口。`~/.follow-builders/` 是兼容保留的用户数据目录，升级时不得自动重命名或
删除；上游 `follow-builders` 名称也只保留在 attribution、provenance 与迁移说明中。

- 配置不存在或 `onboardingComplete !== true`：进入首次 onboarding，不得 prepare。
- onboarding 已完成：`/follow-up` 立即运行一次 manual on-demand Digest，不要求 schedule
  approval；若投递到 Telegram/email，仍需该 exact destination 已持久批准，或本次发送前
  再次确认并传 `--confirm-destination`。stdout 只展示当前操作，无需 destination approval。
- daily/weekly 自动任务：prepare 和 deliver 都必须传 `--scheduled`，且 onboarding、
  schedule approval、destination approval 三者均为 true 且配置有效。任一缺失立即停止。
- 本版本没有“官网一发布就即时提醒”的 alert 模式；自动运行只有 daily 或 weekly。

## First Run — Onboarding

Check if `~/.follow-builders/config.json` exists and has `onboardingComplete: true`.
If NOT, run the onboarding flow. 全程使用中文面向用户说明，并将以下授权拆开确认，
不得把一个“继续”解释为对所有操作的授权：Skill registration、delivery credentials、
schedule mutation、external destination。

### Step 1: Introduction

Tell the user:

"I'm your Follow-up Signal & Attention Digest. I track 70 configured sources across
six live categories: 30 AI Builders on X, 10 Podcasts, 17 Official Blogs,
4 Newsletters, 6 Academic sources, and 3 Chinese Tech sources.

Industry reports are planned and are not a live Feed in v0.2. Every day or week,
I'll deliver a source-linked Signal digest.
These summaries do not automatically become personal Knowledge."

### Step 2: Source Overview

展示七类来源 taxonomy，并说明当前有六类 live Feed。询问用户要启用哪些 live channel，
将选择写入 `enabledChannels`；至少明确提供全选、按需选择和暂不启用三种选择。空数组是
合法配置，但只能进入 `no-channels` 配置提示，不能生成或投递 Digest。Industry reports
仍是规划项，不得作为可启用 live channel。

### Step 3: Delivery Preferences

Ask: "How often would you like your digest?"
- Daily (recommended)
- Weekly

Then ask: "What time works best? And what timezone are you in?"
(Example: "8am, Beijing Time" → deliveryTime: "08:00", timezone: "Asia/Shanghai")

For weekly, also ask which day.

### Step 4: Delivery Method

**If OpenClaw:** SKIP this step entirely. OpenClaw already delivers messages to the
user's Telegram/Discord/WhatsApp/etc. Set `delivery.method` to `"stdout"` in config
and move on.

**If non-persistent agent (Hermes, Claude Code, Cursor, etc.):**

Tell the user:

"Since you're not using a persistent agent, I need a way to send you the digest
when you're not in this chat. You have two options:

1. **Telegram** — I'll send it as a Telegram message (free, takes ~5 min to set up)
2. **Email** — I'll email it to you (requires a free Resend account)

Or you can skip this and just type /follow-up whenever you want your digest — but it
won't arrive automatically."

**If they choose Telegram:**
Guide the user step by step:
1. Open Telegram and search for @BotFather
2. Send /newbot to BotFather
3. Choose a name (e.g. "GoldenWave Digest")
4. Choose a username (e.g. "goldenwave_digest_bot") — must end in "bot"
5. BotFather will give you a token like "7123456789:AAH..." — copy it
6. Now open a chat with your new bot (search its username) and send it any message (e.g. "hi")
7. This is important — you MUST send a message to the bot first, otherwise delivery won't work

Then add the token to the .env file. To get the chat ID, run:
```bash
curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['result'][0]['message']['chat']['id'])" 2>/dev/null || echo "No messages found — make sure you sent a message to your bot first"
```

Save the chat ID in config.json under `delivery.chatId`.

**If they choose Email:**
Ask for their email address.
Then they need a Resend API key:
1. Go to https://resend.com
2. Sign up (free tier gives 100 emails/day — more than enough)
3. Go to API Keys in the dashboard
4. Create a new key and copy it

Add the key to the .env file.

**If they choose on-demand:**
Set `delivery.method` to `"stdout"`. Tell them: "No problem — just type /follow-up
whenever you want your digest. No automatic delivery will be set up."

### Step 5: Language

Ask: "What language do you prefer for your digest?"
- English
- Chinese (translated from English sources, Chinese sources in original)
- Bilingual (both English and Chinese, side by side)

### Step 6: API Keys

**If the user chose "stdout" or "right here" delivery:** No delivery credentials are
needed. Source content is fetched centrally. Skip to Step 7.

**If the user chose Telegram or Email delivery:**
Explain which local credential file will be created and obtain explicit authorization
immediately before writing it. Then create the `.env` file with only the delivery key
they need:

```bash
mkdir -p ~/.follow-builders
cat > ~/.follow-builders/.env << 'ENVEOF'
# Telegram bot token (only if using Telegram delivery)
# TELEGRAM_BOT_TOKEN=paste_your_token_here

# Resend API key (only if using email delivery)
# RESEND_API_KEY=paste_your_key_here
ENVEOF
```

Uncomment only the line they need. Open the file for them to paste the key.

### Step 7: Show Sources

Show the full centrally curated source taxonomy.
Use the runtime registry assembled by `scripts/source-registry.js` from the production
configuration files. Summarize the exact live counts as 30/10/17/4/6/3; only enumerate
individual sources that are present in that registry, or direct the user to
`docs/source-catalog.md`. Clearly mark industry reports as planned and distinguish
source taxonomy from live Feed output. Do not use the legacy taxonomy list as a live
source inventory.

### Step 8: Configuration Reminder

"All your settings can be changed anytime through conversation:
- 'Switch to weekly digests'
- 'Change my timezone to Beijing'
- 'Make the summaries shorter'
- 'Show me my current settings'

No need to edit any files — just tell me what you want."

### Step 9: Set Up Cron

Before creating or changing any scheduled job, summarize the proposed schedule and
delivery target, then obtain explicit confirmation for that mutation.

Save the config:
```bash
cat > ~/.follow-builders/config.json << 'CFGEOF'
{
  "platform": "<openclaw or other>",
  "language": "<en, zh, or bilingual>",
  "enabledChannels": ["x", "podcasts", "blogs", "newsletters", "academic", "zh-tech"],
  "schedule": {
    "frequency": "<daily or weekly>",
    "time": "<HH:MM>",
    "timezone": "<IANA timezone>",
    "weeklyDay": "<day of week, only if weekly>",
    "approved": true,
    "approvedAt": "<ISO-8601 timestamp>"
  },
  "delivery": {
    "method": "<stdout, telegram, or email>",
    "chatId": "<telegram chat ID, only if telegram>",
    "email": "<email address, only if email>",
    "approved": true,
    "approvedAt": "<ISO-8601 timestamp>"
  },
  "onboardingComplete": true
}
CFGEOF
```

将 `enabledChannels` 精确替换为用户在 Step 2 选择的稳定 channel 值；不得因为用户只选
部分来源而省略该字段。用户选择“暂不启用”时必须保存：

```json
"enabledChannels": []
```

Then set up the scheduled job based on platform and delivery method:

- **OpenClaw:** inspect `openclaw cron add --help`, then use its supported scheduler
  with an explicit channel and target. Never use an implicit `last` destination.
- **Other runtimes:** there is no universal background-agent command. Use a scheduler
  only when the current host exposes a documented persistent invocation command. If it
  does not, stop and keep Follow-up on-demand; do not install a cron entry that only
  runs `prepare-digest.js`, because that script does not perform the LLM remix.
- Preserve existing scheduled jobs. Show the exact proposed command and schedule, then
  obtain confirmation immediately before changing scheduler state.

### Step 10: Welcome Digest

Offer to generate a welcome digest. Generate it after the user agrees. If delivery is
external, separately confirm the destination before sending.

Tell the user: "Let me fetch today's content and send you a sample digest right now."

Then run the full Content Delivery workflow below right now.

---

## Content Delivery — Digest Run

This workflow runs on a daily/weekly schedule or when the user invokes `/follow-up`.

### Step 0: Resolve the installed runtime

优先使用当前 Skill 宿主提供的实际 Skill 根目录作为 `FOLLOW_UP_SKILL_DIR`。若宿主没有
提供，则使用安装器发布并校验过的 immutable release pointer：
`$HOME/.follow-builders/releases/0.2.0`。Codex、Claude Code 与 custom registration
都只负责把 Skill 链接到该 release；不得假定任何单一宿主的专属环境变量存在。
下面每条命令都在同一个 shell invocation 内完成 fallback，避免环境变量无法跨命令保留。

### Step 1: Load Config

Read `~/.follow-builders/config.json` for language, schedule, delivery, and prompt preferences.

### Step 2: 授权门禁

手动请求不要求 schedule approval。计划任务必须先运行 `schedule-gate.js` 或由
`prepare-digest.js --scheduled` 调用同一真实门禁；只有 `onboardingComplete`、
`schedule.approved`、`delivery.approved` 均为 true，批准时间为非未来的严格 ISO 时间，
且 daily/weekly、`HH:MM`、IANA timezone、weekly day 与目的地字段有效时才可继续。
门禁只输出 `authorized`、`status`、`reasons`，不得输出 config、地址或 credential。
`no-channels` 是需要修改配置的状态，不得伪装成 authorized 或发送 no-update。

```bash
FOLLOW_UP_SKILL_DIR="${FOLLOW_UP_SKILL_DIR:-$HOME/.follow-builders/releases/0.2.0}"; node "$FOLLOW_UP_SKILL_DIR/scripts/schedule-gate.js" --config "$HOME/.follow-builders/config.json"
```

`schedule-gate.js` 从 config 内 canonical `schedule` 与 `delivery` 字段校验 frequency 和
exact destination；不得向该 CLI 传入未声明的 `--frequency` 或 `--destination`。

### Step 3: Prepare curation request

创建绝对路径作为本次 request 输出。只运行 `prepare-digest.js`，它读取本地配置、delivery ledger 和中央 rolling `feed-candidates.json`，验证完整 source registry，并按渠道与投递历史筛选候选。不要自行拉取六个 snapshot Feed。

```bash
FOLLOW_UP_SKILL_DIR="${FOLLOW_UP_SKILL_DIR:-$HOME/.follow-builders/releases/0.2.0}"; node "$FOLLOW_UP_SKILL_DIR/scripts/prepare-digest.js" --request-out <absolute-request-path> [--frequency daily|weekly] [--scheduled] 2>/dev/null
```

- `no-channels`：停止，不生成 selection，不投递 daily no-update；向用户展示全零 `contentStats` 和启用渠道的操作提示。
- `preparation-failed`：停止；不得继续评分、finalize 或 deliver。
- `request-ready`：继续。即使 `contextStatus` 为 `partial` 或 `incomplete-history`，仍可对已有候选评分，但后续必须披露覆盖状态。

### Step 4: Agent 评分并写 selection manifest

读取 prepare 输出的 request，并严格按本地 `prompts/curate-digest.md` 执行。只处理 `eligibleCandidates`；不得访问网页、补充外部候选、恢复已排除候选或把全量 Feed 当作 fallback。

只输出符合 `digest-selection` v1.0 的 JSON object，将 request 的 `requestHash` 原样复制到 manifest，并写入：

```text
~/.follow-builders/state/selections/<digest-id>.json
```

文件 basename 必须严格等于 `<digest-id>.json`。`requestHash` 是对排除自身字段后的完整 request 做 canonical key ordering，再将 `digest-request-v1` 与 canonical JSON 使用 length-prefixed framing 编码后计算的 SHA-256；Agent 只复制该值。manifest 必须覆盖全部 eligible candidates 的 clustering，并让 `selectedEventClusterIds` 严格遵循 60 分门槛、最多 10 条以及确定性 source/channel portfolio 规则。Agent 没有输出、输出非法 JSON、`requestHash` 不匹配或评分阶段失败时立即停止。

写入后先通过确定性 validator，将验证后的 manifest 输出到另一个绝对路径；后续 finalize
只读取该验证输出：

```bash
FOLLOW_UP_SKILL_DIR="${FOLLOW_UP_SKILL_DIR:-$HOME/.follow-builders/releases/0.2.0}"; node "$FOLLOW_UP_SKILL_DIR/scripts/validate-digest-selection.js" --request <absolute-request-path> --selection <absolute-selection-path> --output <absolute-validated-selection-path>
```

### Step 5: Finalize

```bash
FOLLOW_UP_SKILL_DIR="${FOLLOW_UP_SKILL_DIR:-$HOME/.follow-builders/releases/0.2.0}"; node "$FOLLOW_UP_SKILL_DIR/scripts/finalize-digest.js" --request <absolute-request-path> --selection <absolute-validated-selection-path> --output-dir <absolute-output-directory> 2>/dev/null
```

finalize 会再次校验 request、manifest、`digestId`、`requestHash` 和确定性选择。它先在同一 staging generation 内完整写入并持久化 `artifact.json`、`message.txt` 与 manifest，再以一次目录 rename 发布 generation，最后原子更新 `<absolute-output-directory>/active.json`。只有 `active.json` 指向的 generation 可投递；JSON artifact 供 ledger/outbox 使用，不能直接作为用户消息发送。状态含义如下：

- `ready`：完整检查且有 1-10 条合格更新。
- `no-important-updates`：完整检查且没有合格项；daily 为“今日无重要更新”，weekly 为“本周无重要更新”。
- `partial`：来源不完整；可交付已有合格项，但不能声称没有重要更新。
- `incomplete-history`：历史覆盖不足，优先于 `partial` 披露。
- `preparation-failed`：request、selection、Schema、IO 或评分结果无效；停止且不得创建或覆盖可投递 output。

最终 artifact 的 `contentStats` 记录候选、合格、排除和入选数量。`partial` 或 `incomplete-history` 还包含经过清理和数量限制的 `incompleteSources`；只展示 source ID、名称、channel 与状态，不复制 Feed 的 error details、URL 或凭据片段。

### Step 6: Deliver

读取 `config.delivery.method`，并将其作为显式 `--destination` 传入统一 transaction 入口。stdout、Telegram 和 email 都不得绕过 `deliver.js` 直接读取或发送 `message.txt`：

手动运行：

```bash
FOLLOW_UP_SKILL_DIR="${FOLLOW_UP_SKILL_DIR:-$HOME/.follow-builders/releases/0.2.0}"; node "$FOLLOW_UP_SKILL_DIR/scripts/deliver.js" --active <absolute-output-directory>/active.json --destination <stdout|telegram|email> [--confirm-destination] --result-out <absolute-delivery-result-path>
```

自动运行必须显式标记 scheduled，使 deliver 再次执行 TOCTOU 门禁：

```bash
FOLLOW_UP_SKILL_DIR="${FOLLOW_UP_SKILL_DIR:-$HOME/.follow-builders/releases/0.2.0}"; node "$FOLLOW_UP_SKILL_DIR/scripts/deliver.js" --active <absolute-output-directory>/active.json --destination <stdout|telegram|email> --scheduled --result-out <absolute-delivery-result-path>
```

默认 stdout 也必须运行：

```bash
FOLLOW_UP_SKILL_DIR="${FOLLOW_UP_SKILL_DIR:-$HOME/.follow-builders/releases/0.2.0}"; node "$FOLLOW_UP_SKILL_DIR/scripts/deliver.js" --active <absolute-output-directory>/active.json --destination stdout --result-out <absolute-delivery-result-path>
```

stdout destination 的用户正文只写 stdout；machine status 只从 `--result-out` 指定的 JSON 文件读取。不得把正文当 JSON 解析，也不得隐藏或丢弃 stdout 正文。

必须先检查 `deliver.js` 的 exit code。只有 exit 0 才按 `--result-out` 文件中的 delivery outcome 继续处理；result 文件本身不声明 durability。exit 非零时，读取 stderr 的 machine diagnostic，并在文件存在时一并读取 result outcome，随后运行 `doctor` 检查 pending/journal 状态并停止本次流程。不得因为 result 文件存在就忽略非零退出码。

- `delivered`：provider 已确认，ledger 与 outbox 已记录终态。
- `delivery-failed`：provider 明确拒绝或本地配置在 handoff 前已知无效。本次 run 立即停止，不得隐式 fallback。若用户随后明确选择 stdout，先说明可能改变投递目的地并再次取得确认，再以 `--destination stdout` 创建新的独立 attempt。
- `delivery-uncertain`：handoff 或本地事务结果无法确认，attempt 保持 pending。禁止自动重试、自动 fallback、自动回退或直接展示 `message.txt`，等待人工处置。
- `skipped` / `no-content`：没有可投递内容，不创建外部 handoff。

### 人工处置不确定投递

用户可通过 `/follow-up resolve-delivery <attempt-id> delivered|retry|suppress` 处置仍为 unresolved pending 的 attempt。只接受 doctor 已能正常 reconcile 的现有 pending；不存在、已终止、已 superseded 或状态损坏时必须拒绝，且不得追加 ledger 事件。

- `delivered`：仅在用户明确确认已经收到时使用。记录 `user-confirmed` receipt，不再次调用 provider。
- `suppress`：用户选择不再发送时使用。记录 `assumed-delivered`，不声称 provider 成功，也不收集自由文本原因。
- `retry`：会创建新的外部投递 attempt。必须传入 `--confirm-external-retry`，因为存在 duplicate risk；先向用户说明重复投递风险并取得明确确认。可在再次确认目标后用 `--destination` 改变目标。

对应脚本命令：

```bash
FOLLOW_UP_SKILL_DIR="${FOLLOW_UP_SKILL_DIR:-$HOME/.follow-builders/releases/0.2.0}"; node "$FOLLOW_UP_SKILL_DIR/scripts/resolve-delivery.js" <attempt-id> delivered --result-out <absolute-resolution-result-path>
FOLLOW_UP_SKILL_DIR="${FOLLOW_UP_SKILL_DIR:-$HOME/.follow-builders/releases/0.2.0}"; node "$FOLLOW_UP_SKILL_DIR/scripts/resolve-delivery.js" <attempt-id> suppress --result-out <absolute-resolution-result-path>
FOLLOW_UP_SKILL_DIR="${FOLLOW_UP_SKILL_DIR:-$HOME/.follow-builders/releases/0.2.0}"; node "$FOLLOW_UP_SKILL_DIR/scripts/resolve-delivery.js" <attempt-id> retry --confirm-external-retry [--destination stdout|telegram|email] --result-out <absolute-resolution-result-path>
```

必须先检查 `resolve-delivery.js` 的 exit code；只有 exit 0 才读取 `--result-out` 的 machine JSON。exit 非零时停止并检查 stderr；`delivery-busy` 表示该 attempt 正在 provider handoff 中，不得提交 delivered、suppress 或 retry，也不得绕过锁重试写状态。

`retry` 只在同一 transaction 中将旧 attempt 标记为 `superseded` 并创建 replacement pending，不调用 provider。返回 `retry-ready` 后，从 machine JSON 读取 `replacementAttemptId`，然后使用同一个已激活 Digest 直接 resume：

```bash
FOLLOW_UP_SKILL_DIR="${FOLLOW_UP_SKILL_DIR:-$HOME/.follow-builders/releases/0.2.0}"; node "$FOLLOW_UP_SKILL_DIR/scripts/deliver.js" --active <absolute-output-directory>/active.json --destination <stdout|telegram|email> --resume-attempt <replacement-attempt-id> [--confirm-destination] --result-out <absolute-delivery-result-path>
```

resume 会校验该 pending 确实由对应旧 attempt 的 `superseded` 事件创建，并要求 `digestId`、`frequency`、candidate IDs、event cluster IDs、`messageHash` 和 destination 完全匹配；它不会创建普通 reservation。每个 replacement 的 resume 会在 provider handoff 前持久化一次性 claim，只有 claim 成功的调用可以继续；进程崩溃或 provider 结果不确定时也不得重复 resume。

若 resolve 返回非零或 resume 返回 `delivery-failed`，立即停止。若 resume 返回 `delivery-uncertain`，必须再次向用户说明重复投递风险并取得明确确认，然后对这个已 claim 的 pending 重新执行 `/follow-up resolve-delivery <attempt-id> retry`，生成下一个 replacement；不得直接重复 resume、fallback 或新建普通 attempt。stdout resume 仍遵守正文与 machine result 分离规则。

不得直接读取未激活 generation，不得原样展示 JSON artifact，也不得展示 request 中未选择的候选。

任一步失败都必须停止后续步骤。特别是 finalize 失败时，不得读取旧 output 并继续投递。若返回 `committed-but-uncertain`，文件内容已经完成 rename，但目录持久化无法确认；禁止自动重写或重试同一 digest，等待人工或后续恢复流程核对。

---

## Configuration Handling

### Source Changes
The source list is managed centrally and cannot be modified by users.
If a user asks to add or remove sources, tell them: "The source list is curated
centrally and updates automatically. If you'd like to suggest a source, you can
open an issue at https://github.com/TheGoldenWave/Follow-up."

### Channel Changes
使用 `enabledChannels` 保存六个 live channel 的开关。缺少该字段的旧配置默认六类全开；空数组表示不生成 Digest。更新配置仍需遵守本节的 mutation 确认要求。

### Schedule Changes
- "Switch to weekly/daily" → show the config and scheduler changes, then confirm each
  mutation before updating them
- "Change time to X" → show the new schedule and confirm before writing config or scheduler
- "Change timezone to X" → explain both config and scheduler impact, then confirm before each write

### Language Changes
- "Switch to Chinese/English/bilingual" → Update `language` in config.json

### Delivery Changes
- "Switch to Telegram/email" → explain the required credential and destination changes,
  then obtain confirmation before writing config or credentials
- "Change my email" → confirm the new external destination before updating it

### Prompt Changes
When a user wants to customize how their digest sounds, copy the relevant prompt
file to `~/.follow-builders/prompts/` and edit it there. This way their
customization persists across a manual reinstall and takes priority over the Prompt
bundled with the installed release.

```bash
mkdir -p ~/.follow-builders/prompts
FOLLOW_UP_SKILL_DIR="${FOLLOW_UP_SKILL_DIR:-$HOME/.follow-builders/releases/0.2.0}"; cp "$FOLLOW_UP_SKILL_DIR/prompts/<filename>.md" ~/.follow-builders/prompts/<filename>.md
```

Then edit the file with the user's requested changes.

### Info Requests
- "Show my settings" → Read and display config.json in a friendly format
- "Show my sources" → Read config + defaults and list all active sources by channel
- "Show my prompts" → Read and display the prompt files

After any configuration change, confirm what you changed.

## Feedback and Cross-system Handoff

Current releases do not implement persistent reading state, a DeepSeek Harness
information center, Malow Handoff, or GoldenWave Candidate submission.

If the user says "save this", "learn this", "use this in my project", or similar:

1. Clarify whether they want read-later, a learning request, a Project / Matter work
   proposal, or a long-term memory proposal.
2. Present the proposed target, source URLs, summary, and intended effect.
3. State that automatic integration is not implemented.
4. Do not directly edit a Malow project or GoldenWave formal Knowledge as a fallback.
5. Do not perform a cross-project authoritative write from this Skill. Hand the proposal
   to the target system's own workflow, where that system can request authorization and
   apply its governance independently.

---

## Manual Trigger

## 用户可见结果文案

- `no-important-updates`：完整 daily 检查显示“今日无重要更新”；完整 weekly 检查显示
  “本周无重要更新”。
- `partial`：说明“部分来源检查未完成，以下是目前可确认的更新”，不得声称没有更新。
- `incomplete-history`：说明“历史覆盖不完整，本次仅基于可用时间范围”，优先披露。
- `delivery-failed`：说明“目标明确拒绝或配置无效，本次未送达”，不得隐式换目标。
- `delivery-uncertain`：说明“投递结果无法确认，可能已送达”，并给出
  `/follow-up resolve-delivery <attempt-id> delivered|retry|suppress`，不得自动重试。
- `no-channels`：说明“未启用任何内容渠道”，引导启用至少一个渠道，不发送摘要。

When the user invokes `/follow-up` or asks for their digest manually:
1. Skip cron check — run the digest workflow immediately
2. Use the same fetch → remix → deliver flow as the cron run
3. Tell the user you're fetching fresh content (it takes a minute or two)
