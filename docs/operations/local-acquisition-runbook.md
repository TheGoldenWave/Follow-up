# Follow-up 本地采集切换运行手册

本文记录把公共来源从中心 Feed 逐步切换到用户本地采集（Signal Batch）的**切换顺序、
门禁、回滚与中心 Feed 下线步骤**。执行者是维护者；普通采集永不静默安装、永不自动切换，
每一步都按来源级观察结果推进。

## 1. 采集模式

`~/.follow-builders/config.json` 中 `acquisition.mode` 决定一次运行使用哪一路输入：

| 模式 | 行为 |
|---|---|
| `central` | 仅用中心 Feed（迁移安全的默认值，缺失即回退到此） |
| `shadow` | 中心 Feed 投递 + 本地采集仅记录指标（本地候选绝不进入 Digest） |
| `hybrid` | 本地 `ok`/`no-results`/`partial` 对该来源生效；失败状态回退中心 |
| `local` | 仅用本地 Signal Batch |

## 2. 切换顺序（cutover order）

按「先 RSS 后抽取、先免登录后需凭据」的顺序逐来源推进，每批完成门禁才进入下一批：

1. **newsletters** 与 **zh-tech**（`rss` Adapter，免登录、契约最稳）。
2. **blogs**（`web-publication` Adapter：RSS → sitemap → 索引页发现 + trafilatura 抽取）。
3. 后续版本：podcasts / academic / arXiv（v0.5.0、v0.4.0）、GitHub/HN/Reddit 等。

同一来源先 `shadow` 观察，再 `hybrid`，最后在门禁通过后置为该来源 `local`。

## 3. 切入门禁（cutover gates）

单来源从 shadow/hybrid 切到 local 前，必须**全部**满足：

- 契约与 Fixture 测试全绿（`python -m unittest` + `node --test`）。
- secret 扫描零命中（`scripts/release/scan-secrets.js`）。
- 本地候选**无重复**（`duplicate_rate == 0`）。
- 达到运行阈值：至少 **3 次真实运行** + 代表性 Fixture 重放（低频例外）。
- 人工复核的相关性（review relevance）≥ **80%**。

指标由 `src/follow_up_acquisition/migration.py` 计算，`npm --prefix scripts run report-shadow`
输出逐来源 overlap / duplicate / error 指标与切入门禁、回滚结论。

## 4. 回滚触发（rollback triggers）

以下任一命中，立即把该来源回退到中心 Feed 并记录 `rollback_reason`：

- 秘密泄漏（secret leak）。
- 连续两次未分类失败（`consecutive-failures`）。
- 本地重复率 > 5%（`duplicates`）。
- 复核相关性 < 80%（`relevance`）。

回滚不改写已投递内容，只切换输入路径；观察状态记录于
`~/.follow-builders/acquisition/migration.json`。

## 5. 中心 Feed 下线步骤（Task 21）

中心 Feed 的每个来源只有在**本地连续观察满 14 天**且门禁通过后才可下线，且一次提交只下线
一个来源（便于回滚）：

1. 确认该来源 14 天内所有运行 `ok`/`no-results`/`partial`，无 `error` 门禁命中。
2. 归档该来源的中心 Feed Fixture 到 `scripts/test/fixtures/`（保留历史样本）。
3. 从 `scripts/generate-feed.js` 的生成清单移除该来源，重新生成中心 Feed。
4. 移除该来源的定时采集任务引用；`collect-and-prepare.js` 继续作为唯一入口。
5. 更新 `config/sources.json` 的 `legacy.feed` 标记与 `docs/source-catalog.md`。
6. 提交并校验 checksum；中心 Feed 契约测试仍对未下线来源全绿。

> 中心 Feed 下线是**观测后**的运维动作，不绑定固定版本号；在任何来源完成 14 天观察前，
> 中心 Feed 仍是运行时现状，本地采集只以 shadow/hybrid 方式并行。
