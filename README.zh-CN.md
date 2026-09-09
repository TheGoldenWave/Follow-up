[English](README.md) | **中文**

# Follow-up

Follow-up 是一个 Skill-first 的个人 AI 信息信号摘要工具。`0.3.0`在 6 类中心化
公共 Feed 的基础上新增 RSS/官网 Blog 本地采集，从全部已启用信源中排序重要更新，并按 daily、weekly 或用户按需请求生成
Digest。项目基于 [follow-builders](https://github.com/zarazhangrui/follow-builders)
演进，兼容用户数据继续保存在 `~/.follow-builders/`。

当前稳定版本：`0.3.0`。查看 [项目进度](docs/project-progress.md)、[后续版本计划](docs/version-roadmap.md)、
[完整信源目录](docs/source-catalog.md) 和
[版本变更](CHANGELOG.md)。公开安装包以
[GitHub Releases](https://github.com/TheGoldenWave/Follow-up/releases) 为准。

`v0.3.0` 新增 RSS/Blog 本地采集、独立 Python 运行时、四模式摘要输入与来源迁移工具。
默认仍使用中心 Feed；最新公开版为 `v0.3.0`，已完成本地完整验收与公开资产下载校验。
公开发布不触发中心 Feed 下线，公开版本与安装包以 GitHub Releases 为准。

启用本地采集前，在已验证的安装目录运行 `node scripts/bootstrap-acquisition.js`。
需要 Python 3.12，安装器创建隔离环境并验证锁定依赖；日常采集不自动安装。
在用户配置设置 `"acquisition": {"mode": "shadow"}` 可先观察，使用
`node scripts/collect-and-prepare.js --request-out <绝对路径>` 准备摘要请求。
迁移和回滚操作见 [运行手册](docs/operations/local-acquisition-runbook.md)。

当前支持的用户入口是：

- 输入 `set up follow-up` 开始 Onboarding；
- 执行 `/follow-up` 完成 Onboarding 或请求一次按需 Digest。

旧产品名对应的调用方式只属于迁移背景，不再是 v0.2 支持的用户入口。

## 安装 v0.3.0

以下步骤安装已公开发布的不可变 `v0.3.0` 归档。

环境要求为 Node.js 20 或更高版本，以及未经修改、已经校验并解压的 GitHub Release
归档。

```text
curl -LO https://github.com/TheGoldenWave/Follow-up/releases/download/v0.3.0/Follow-up-v0.3.0.tar.gz
curl -LO https://github.com/TheGoldenWave/Follow-up/releases/download/v0.3.0/Follow-up-v0.3.0-checksums.txt
curl -LO https://github.com/TheGoldenWave/Follow-up/releases/download/v0.3.0/release-manifest.json
shasum -a 256 -c Follow-up-v0.3.0-checksums.txt
tar -xzf Follow-up-v0.3.0.tar.gz
cmp release-manifest.json Follow-up-v0.3.0/release-manifest.json
cd Follow-up-v0.3.0
node scripts/release/validate-release.js --archive-critical-only
cd scripts
npm ci
npm run validate-release:archive
npm run test:archive
cd ..
node scripts/install.js --platform <codex|claude-code|custom> [--skill-dir <绝对路径>] --register
node ~/.follow-builders/releases/0.3.0/scripts/doctor.js --json
```

安装并通过 `doctor` 后，输入 `set up follow-up`，依次选择关注频道、daily 或 weekly
频率和投递目标。完成 Onboarding、schedule 与确切 destination 授权后，定时推送才会
运行；随时输入 `/follow-up` 可以请求一次按需 Digest。

`--register` 表示明确授权创建 `follow-up` Skill 链接。安装器支持 Codex、Claude Code
以及用户指定的绝对 Skill 目录。重装同一个已验证版本时，安装器会逐字节保留
`~/.follow-builders/` 下的配置、自定义 Prompt、凭据、投递历史和候选状态。

从 v0.1 升级且检测到旧 `follow-builders` 注册时，需要增加
`--replace-follow-builders`。只有新链接创建成功且本地 `doctor` 检查通过后，安装器
才会移除旧链接；用户数据目录不会被重命名或删除。

`doctor` 会检查安装版本与 manifest、Node 运行时、依赖、配置、Skill 注册、候选 Feed
历史、未解决的投递 attempt 和网络新鲜度。只有网络告警时退出码为 2；本地完整性或
配置失败时退出码为 1。

无依赖的 `--archive-critical-only` 必须在 `npm ci` 前运行。单独发布的 checksum 在
既定 GitHub 信任边界内验证整个归档，归档验证再检查 manifest 声明的每一个关键文件。
tracked content digest 只能从匹配的 Git checkout 重新计算，因为解压归档没有 Git
object database。本版本没有经过验证的 ClawHub 首次安装路径，也没有自动更新器。

对发布维护者而言，只有管理员在外部确认已启用保护 `v*` tag 的规则（ruleset protects
`v*` tags）和 GitHub
immutable releases，并设置 `RELEASE_IMMUTABILITY_CONFIRMED=true` 后，发布 workflow
才可继续。这个变量只是门禁，不是证明。validator 检查自身哈希属于
self-verification，不能独立建立信任；受保护 tag、单独下载的 manifest 和完整归档
checksum 才是外部信任锚点。

## v0.3.0 已实现范围

当前共有 6 类中心化 live channel：

| 频道 | 当前信源路径 |
|---|---|
| X 建造者 | 精选建造者账号 |
| 播客 | RSS 与可用转录文本 |
| 官方 Blog | 17 个生产官网来源 |
| Newsletter | 已配置 Newsletter Feed |
| 学术研究 | 基于 arXiv 的研究 Feed |
| 中文科技 | 已配置中文科技 Feed |

行业报告仍是规划项，不是第 7 个 live Feed。包括
[Google Antigravity Blog](https://antigravity.google/blog) 在内的事实清单见
[信源目录](docs/source-catalog.md)。

## 发现、历史与推荐

官网 Blog 采集会检查最近 **72 小时**和每个来源最多 12 个发现链接，每次每个来源
最多接收 3 篇有效新文章。72 小时是发现失败后的恢复窗口，不是用户的推送时间窗。

滚动 candidate Feed 独立保留历史。daily 与 weekly Digest 使用历史中符合资格的
**未推**内容，而不是简单取最近 72 小时发布的全部文章。成功投递后，条目进入
**已推未读**状态，直到后续版本具备更丰富的显式已读交互；已推未读内容不会自动
重复发送。pending 或**投递不确定**的 attempt 同样阻止自动重复投递。

所有已启用来源进入同一个跨源排序。系统先按事件聚类，再按影响、用户相关性、来源
权威性、新颖性和交叉印证计算 100 分评分，重要性门槛为 **60 分**。每期目标为
**6-10** 条，并限制单一来源和频道占比；不会为了凑数降低门槛，只有 1-5 条达标时
就只发送这些内容。

## 推送结果

自动推送只有在 Onboarding、schedule approval 和确切 destination approval 都有效时
才运行。v0.2 只支持 daily 与 weekly，**不会在官网发布内容时即时提醒**。

- 完整检查且存在达标内容时，发送排序后的 Digest。
- 完整 daily 检查没有达标内容时发送“今日无重要更新”；完整 weekly 检查发送
  “本周无重要更新”。
- `partial` 表示一个或多个已启用来源未完整检查。可以发送已有达标内容，但不能声称
  没有重要更新。
- `incomplete-history` 表示请求区间没有完整历史。首次 weekly Digest 必须等到能够
  证明已积累 7 个完整历史日后才结束 bootstrap；此前只披露实际覆盖区间。
- `delivery-uncertain` 表示 provider handoff 可能已经发生但无法确认。attempt 会保持
  pending，等待用户明确处置，不会自动重试或自动 fallback。

若没有启用任何频道，结果是 `no-channels`，不会发送“无重要更新”。

## 配置

Onboarding 将配置写入 `~/.follow-builders/config.json`。6 个稳定的
`enabledChannels` 值是 `x`、`podcasts`、`blogs`、`newsletters`、`academic` 和
`zh-tech`。为兼容 v0.1，字段缺失时默认全部启用；空数组合法，但会暂停 Digest。

计划任务需要分别确认 Onboarding、schedule 和确切投递目标。手动 `/follow-up`
不要求 schedule approval；手动 Telegram 或邮件仍需要已有 destination approval，
或在本次发送前即时确认。

## 产品边界

`v0.3.0`已实现 RSS/官网 Blog 本地采集和来源级回滚；hybrid 回滚到中心输入，
local 回滚时隔离失败来源且不访问中心 Feed。认证 Sidecar、长期反馈学习、行业报告、
分页个人 Feed、显式已读/未读交互、自动更新发现及安装版本自动回滚仍属后续工作。
Signal 或成功投递的 Digest 不代表用户已阅读、理解或认可；Follow-up 不自动写入
Malow 或 GoldenWave 的权威状态。

## 许可证与授权

Follow-up 按 MIT 许可证分发，全文见 [LICENSE](LICENSE)。来自
`zarazhangrui/follow-builders` 的上游派生代码依据已确认的 MIT 授权纳入；该授权由
项目维护者于 2026-09-02 在本项目发布流程中作出证明。公开上游仓库在审查时没有
许可证文件，因此本项目不声称该公开仓库本身采用 MIT 许可证。详见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
