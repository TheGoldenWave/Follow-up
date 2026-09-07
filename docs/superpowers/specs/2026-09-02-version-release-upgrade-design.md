# Follow-up 版本发布与升级设计

状态：方向已批准，并按 `v0.2.0` 产品闭环版本修订

日期：2026-09-07

Release freeze date: 2026-09-07

## 目的

本文定义 Follow-up 的版本身份、可信发布、安装布局和后续升级方向。`v0.1.0` 建立了
可复现的中心化 Feed 基线；`v0.2.0` 在该基线上完成可验证安装、`doctor`、统一
`follow-up` 入口、滚动候选池、跨源 Digest 选择与投递去重。

本文凡涉及本地采集、认证 Sidecar、自动更新和自动回滚的内容，均为后续版本设计，
不是 `v0.2.0` 的能力声明。

## v0.2.0 发布身份

- 产品版本：`0.2.0`
- 发布冻结日期：`2026-09-07`
- 发布渠道：Stable
- 规范入口：`set up follow-up` 与 `/follow-up`
- 用户数据目录：继续使用 `~/.follow-builders/`
- 上游归属：保留 `zarazhangrui/follow-builders` attribution 与 provenance
- 运行时：Node.js 20 或更高版本
- 采集模式：6 类中心化公共 Feed

`VERSION`、`release-manifest.json`、`scripts/package.json`、
`scripts/package-lock.json` 与 `CHANGELOG.md` 必须对版本号和日期保持一致。

## 当前能力边界

`v0.2.0` 已实现：

- 17 个官网 Blog 的生产采集与来源级完整性状态；
- `enabledChannels` 对 6 个 live channel 的真实过滤；
- 有界滚动 candidate Feed 与 candidate history；
- 100 分跨源事件评分、60 分门槛和 6-10 条目标组合；
- daily、weekly 和按需 Digest；
- append-only delivery ledger、pending outbox 与自动投递去重；
- Codex、Claude Code 和 custom Skill 目录的 verified installer；
- `doctor` 本地完整性、配置、注册、历史和网络诊断。

`v0.2.0` 未实现：本地采集、认证 Sidecar、长期反馈学习、行业报告正式 Feed、分页
个人 Feed、显式已读/未读操作、自动更新发现和自动回滚。release manifest 对这些能力
必须为 `false` 或不声明，文档不得将路线图描述为已交付事实。

## Digest 时间与状态语义

官网 Blog 采集检查最近 **72 小时**，每个来源最多发现 12 个链接、每次最多接收 3 篇
有效新文章。72 小时是发现恢复窗口，不是用户投递窗口。

daily 和 weekly 从滚动 candidate history 中选取符合资格的**未推**候选。成功投递后，
候选进入**已推未读**状态；在显式已读能力尚未实现时，该状态只表达“已成功推送但没有
阅读证据”，不会被普通自动任务重复发送。pending 或 `delivery-uncertain` attempt 也
阻止自动重复投递。

所有启用来源共同参与跨源排序。候选按影响、用户相关性、来源权威性、新颖性和独立
印证计算 100 分，达到 **60 分**才合格。组合目标是 **6-10** 条，并限制单一来源和
频道占比；只有 1-5 条合格时不凑数。

完整检查没有合格内容时，daily 发送“今日无重要更新”，weekly 发送“本周无重要更新”。
`partial` 表示当前来源检查不完整，不能声称没有重要更新。`incomplete-history` 表示请求
区间缺少可证明的连续候选历史；首次 weekly 在积累 7 个完整历史日以前保持 bootstrap，
并披露实际覆盖范围。自动运行仅支持 daily 与 weekly，不提供官网发布即时 alert。

## 版本模型

用户只看到一个遵循 Semantic Versioning 的产品版本：

- Patch：兼容修复、来源协议修复和安全更新；
- Minor：兼容的新产品能力、来源或配置；
- Major：可能需要明确产品选择或移除兼容性。

在 `1.0` 前，Minor 仍可能包含较大变更，但必须迁移旧行为，或在行为不兼容时取得用户
明确同意。内部组件版本只用于 manifest、兼容检查和 `doctor`，不作为 Onboarding 中的
独立产品选择。

## 稳定发布 Manifest

每个发布包含 `release-manifest.json`，记录产品版本、日期、渠道、运行时、中心 Feed、
能力边界及完整性信息。`v0.2.0` 继续使用 `github-tag-sha256` 信任模式：

1. 受保护的 Git tag 指向待发布 commit；
2. manifest 保存排除自身后的 non-circular tracked-content digest；
3. manifest 保存完整关键文件集的 SHA-256；
4. Release 另行发布完整归档 checksum；
5. 归档在 `npm ci` 前运行 dependency-free `--archive-critical-only` 检查。

tracked-content digest 基于 byte-order sorted `git ls-tree -r -z --full-tree` 的原始
NUL 结尾记录，excluding `release-manifest.json` 以避免自引用。源码归档没有 `.git`
object database，因此只能依靠完整归档 checksum 和 critical-file SHA-256 hashes
验证；checkout/tag 验证才会重新计算 tracked digest。该模式能在既定 GitHub 信任边界
内发现内容损坏或意外替换，但不能抵抗仓库或
所有者账号本身被攻破。分发托管 executable 或 Sidecar 前必须引入更强的签名与证明。
Archive verification combines critical file hashes with complete-archive checksums;
任何单独一层都不能替代外部信任锚点。

关键文件集合必须至少包含既有 release、license、Prompt 与 Feed contract，以及
`v0.2.0` 的配置 contract、candidate contract、Digest selection、delivery transaction、
schedule gate、registration、diagnostics、installer 和 `scripts/lib/install-worker.js`。
缺失任一必需文件或任一哈希漂移都阻止发布。

## v0.2.0 安装与激活

用户从精确 GitHub Release 获取并验证归档，然后执行：

```text
node scripts/release/validate-release.js --archive-critical-only
cd scripts && npm ci && cd ..
node scripts/install.js --platform <codex|claude-code|custom> [--skill-dir <绝对路径>] --register
node ~/.follow-builders/releases/0.2.0/scripts/doctor.js --json
```

安装器先验证 archive-critical 文件，再进行任何 copy、npm lifecycle 或 registration
写入。验证后的发布对象以随机不可变目录保存，`releases/0.2.0` 是指向它的不可变版本
指针。只有用户提供 `--register` 时才创建 `follow-up` Skill 链接。

重装同一版本必须保留 `~/.follow-builders/` 下所有 mutable 文件。若从 `v0.1.0`
升级且存在旧 `follow-builders` 注册，必须显式提供 `--replace-follow-builders`；只有
新链接创建成功且 `doctor` 没有本地失败后，才移除旧链接。`doctor` 退出码 0 表示健康，
2 表示只有网络告警，1 表示本地失败；退出码 1 时不得激活。

`v0.2.0` 不自动发现更新、不自动迁移到未来版本，也不自动回滚。后续升级仍需用户
取得并验证精确版本，然后明确执行安装。

## 发布流水线

Stable 发布必须来自干净、已审查的 commit：

1. 运行完整测试、syntax、JSON/Schema、Feed 与 Blog 验证；
2. 运行 secret、license、provenance 与 release validator；
3. 在内容完全冻结后一次性更新 critical-file hashes 和 tracked-content digest；
4. 只从 tracked files 构建归档并生成独立 checksum；
5. 从归档执行 clean install、reinstall、v0.1 upgrade、`doctor`、Digest 与 delivery smoke；
6. 在受保护 tag 与 immutable GitHub Release 设置已被外部确认后创建 `v0.2.0` tag；
7. 下载公开资产，复核 checksum、tag target 与最小安装流程。

`.hermes/`、`docker/`、`docs/wechat-integration.md`、凭据、登录态和临时文件不得进入
发布 commit 或归档。已有 tag 和 Release 资产不得替换；缺陷通过新的 patch 发布修复。

## 后续安装布局方向

后续本地采集版本将继续分离不可变程序和可变用户数据：

```text
~/.follow-builders/
  active.json
  releases/<product-version>/
  runtime/<version>/
  adapters/<version>/
  tools/<tool>/<version>/
  sidecars/<name>/<version>/
  config/generations/<id>/
  state/
  credentials/
  sidecar-data/<name>/
  backups/
```

上述 runtime、adapter、sidecar、配置 generation 与自动 rollback 机制属于后续设计。
未来升级应采用 staging、校验、`doctor` 和原子 active pointer，并保证 mutable state、
credential 与登录数据不进入 release 目录。授权必须按来源拆分，普通升级确认不得解释为
Cookie、二维码登录、权限扩大或敏感数据迁移授权。

## 路线图

| 版本 | 范围 |
|---|---|
| `v0.1.0` | 可复现的中心化 Feed 基线与发布元数据 |
| `v0.2.0` | 17 个官网 Blog、channel switch、candidate pool、Digest/delivery transaction、verified installer、`doctor` 与 `/follow-up` |
| `v0.3.0` | Acquisition Runtime、Signal Batch、source registry、受控 vendoring 与 RSS/Blog shadow mode |
| `v0.4.0` | GitHub、Hacker News、Reddit、Techmeme、arXiv 与来源级混合迁移 |
| `v0.5.0` | YouTube、播客、Digg 与 managed local tools |
| `v0.6.0` | 获得授权的 X Adapter 与来源级 fallback |
| `v0.7.0` | 小红书和微信公众号本地认证 Sidecar |
| `v0.8.0` | local-first Onboarding、跨平台诊断、rollback 与迁移闭环 |
| `v0.9.0` | 配置、Signal Batch、Sidecar 与升级 contract 冻结 |
| `v1.0.0` | 稳定 local-first 产品与兼容承诺 |

中心化采集下线由质量门禁决定，不由固定版本号决定。路线图表达计划，不是已实现能力。

## v0.2.0 验收标准

- 所有 version authority 为 `0.2.0`，日期为 `2026-09-07`；
- manifest 只把当前能力标记为 true，后续能力保持 false；
- 完整 critical set 和 tracked digest 与冻结 commit 匹配；
- clean install、reinstall 和 v0.1 upgrade 保留 mutable 用户数据；
- 新注册名为 `follow-up`，`set up follow-up` 与 `/follow-up` 是唯一用户入口；
- 72 小时 Blog 发现窗口与 candidate history、daily/weekly 投递窗口明确区分；
- 60 分门槛、6-10 条目标、跨源排序、不凑数和去重语义有文档与测试；
- no-update、`partial`、`incomplete-history`、weekly bootstrap、已推未读和
  `delivery-uncertain` 文案不互相冒充；
- 不宣称即时 alert、本地采集、Sidecar、长期反馈、reports、分页、显式已读或自动回滚；
- release archive 不包含未跟踪开发文件、凭据或临时状态。
