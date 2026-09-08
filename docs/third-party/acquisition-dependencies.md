# Follow-up 本地采集受控 Vendoring 依赖溯源

本文记录 v0.3.0 起本地采集层采用「受控 Vendor 快照」方式复刻上游 Adapter 时的依赖
溯源政策与已审计的上游版本锁定。真正下载、校验哈希并导入代码的动作由
`scripts/vendor/sync-last30days.sh` 在联网环境下执行；本文记录的 commit / 版本 /
哈希是**待同步时核验的锁定值**，不是已落地事实。

## 1. 政策

- 优先从成熟、许可兼容且有测试的项目复刻 Adapter，不从零实现平台协议。
- 采用受控 Vendor 快照，而非 Git subtree 或零散复制。`vendor/manifest.json` 记录
  上游仓库、版本或 commit、许可证、导入文件、本地补丁与同步历史。
- 仅导入获批来源所需的共享模块（HTTP、日期、健康、超时/重试、查询、相关性、
  标准化、去重、schema 助手与 Adapter 依赖），并带入对应上游 Fixture 测试。
- 不自动追随上游更新；安全修复与平台协议变化经审查后再同步。
- 所有引入代码必须保留上游版权与许可证声明（MIT 需保留版权与许可证文本；
  Apache-2.0 另需履行 NOTICE 义务）。

## 2. 已审计的上游锁定

| 依赖 | 版本 / commit | 许可证 | 用途 | 锁定依据 |
|---|---|---|---|---|
| `mvanhorn/last30days-skill` | release `3.22.0`，commit `fcebe321c22e5e97e3ef5712e4bc00f2b33bba37` | MIT | 共享底座 + GitHub/HN/Reddit/YouTube/X 等 Adapter | 主参考实现 |
| `@mvanhorn/printing-press-library` | `0.1.16`，npm integrity `sha512-2CSe85z5RVp92vI8Wca/v9n33KmRSa7V1TVOM4nZFsK6U+wjAImBe+SHzAZsozWuKUEsbVoTVMwi4sPfTyHvzg==` | MIT | Digg/Techmeme/arXiv Printing Press CLI 运行时 | CLI 宿主 |
| `rachelos/we-mp-rss` | commit `f54aba50cbf349ed7e4ee1dae8bfe9990d0c5894`（容器按 digest 固定，不用 `latest`） | MIT | 微信公众号本地 Sidecar | 扫码登录态 |
| `xpzouying/xiaohongshu-mcp` | commit `332d196854a9eac0d2b8c2c0e3d0cc43139d724c` | Apache-2.0 | 小红书本地 MCP Sidecar | 只读采集 |
| `yt-dlp` | `2026.8.19` | Unlicense | YouTube 搜索/字幕/评论 | managed local tool |
| `feedparser` | `6.0.14` | BSD-2-Clause | RSS/Atom 解析 | RSS Adapter |
| `trafilatura` | `2.2.0` | Apache-2.0 | 网页正文抽取 | Blog Adapter |

所有版本、commit、哈希在 Adapter 编码前必须记录在
`vendor/manifest.json` 与 `config/tool-manifest.json`；此门禁之后禁止任何浮动
branch、image tag、npm range 或 Python range。

## 3. 运行时边界

- Acquisition Runtime 与 Adapter 使用 Python 3.12，复用 `last30days` 与 `we-mp-rss`
  的实现及测试。
- `yt-dlp`、`digg-pp-cli`、`techmeme-pp-cli`、`arxiv-pp-cli` 由本地安装器托管固定
  版本；普通采集永不静默安装。
- 小红书与微信公众号采用用户本地 Sidecar，Follow-up 只维护 wrapper、兼容版本与
  生命周期，不读取或复制 Sidecar 内部原始登录凭据。

## 4. 同步历史

尚未执行首次同步（受当前环境外网限制）。首次 `sync-last30days.sh` 运行后，此处
记录每次同步的上游 commit、本地 diff、审查结论与签名。
