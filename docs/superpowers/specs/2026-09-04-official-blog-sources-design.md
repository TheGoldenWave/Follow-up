# Follow-up 官方 Blog 批量接入设计

状态：已确认

日期：2026-09-04

## 目标

在不改变 `feed-blogs.json` 对外契约的前提下，把信源目录中明确属于 R2/P 的官方文章入口接入现有中心 Feed。接入必须能够真实发现近期文章、提取正文、按 URL 去重，并在单一站点失败时继续处理其他来源。

本次目标来源：

1. Anthropic Engineering（已有）
2. Claude Blog（已有）
3. Anthropic Interpretability
4. Anthropic Science
5. OpenAI Alignment Research Blog
6. Google Antigravity Blog
7. Google DeepMind Blog
8. Google Research Blog
9. Microsoft Research Blog
10. Amazon Science Blog
11. IBM Research Blog
12. Perplexity Research Articles
13. Qwen Blog
14. Kimi Research & Tech Blog
15. ERNIE Blog
16. MiniMax Blog
17. Apple Machine Learning Research

Research Root、Publications、API 文档、GitHub 和模型仓库不属于本次范围。

## 方案

采用配置驱动的混合采集器。每个来源按配置声明一个有序的 `discovery` 数组，运行时依次尝试：

1. RSS/Atom：直接读取文章 URL、标题和发布时间。
2. Sitemap：筛选属于该来源的文章 URL，并使用 sitemap 的更新时间辅助排序。
3. Index HTML：从官网列表页的链接和结构化数据发现文章。
4. JSON：仅用于官网公开页面由同源 JSON 接口提供文章索引或正文的站点；候选必须同时保留公开文章 URL，API URL 不得作为 Feed canonical URL。

前一种方式请求失败或没有产生合规候选时才进入下一种方式；已经产生候选后不混用后续入口，避免同一篇文章重复发现。RSS 不提供全文时，四种发现方式最终都进入相同的文章抓取与正文提取流程。现有 Anthropic Engineering 和 Claude Blog 的专用解析器继续保留；其他来源优先使用 JSON-LD、Open Graph 和语义化 `article`/`main` 正文提取。只有通用提取无法满足离线 Fixture 时才增加站点级规则。

## 逐站采集矩阵

| 来源 | 首选发现入口 | 兜底 | 文章 URL 约束 | 当前核验 |
|---|---|---|---|---|
| Anthropic Engineering | `https://www.anthropic.com/sitemap.xml` | `https://www.anthropic.com/engineering` HTML | `^https://www\\.anthropic\\.com/engineering/[^/?#]+/?$` | 2026-09-04 Sitemap HTTP 200；现有解析器可用 |
| Claude Blog | `https://claude.com/blog` HTML | 无 | `^https://claude\\.com/blog/[^/?#]+/?$` | 现有解析器可用 |
| Anthropic Interpretability | `https://www.anthropic.com/research/team/interpretability` HTML | 无 | 只接受该索引页直接列出的 `^https://www\\.anthropic\\.com/research/[^/?#]+/?$` | 2026-09-04 HTTP 200，含 `/research/natural-language-autoencoders` 等链接 |
| Anthropic Science | `https://www.anthropic.com/science` HTML | 无 | 只接受该索引页直接列出的 `^https://www\\.anthropic\\.com/research/[^/?#]+/?$` | 2026-09-04 HTTP 200，含 `/research/riemann-zeta` 等链接 |
| OpenAI Alignment | `https://alignment.openai.com/rss.xml` | `https://alignment.openai.com/` HTML | `^https://alignment\\.openai\\.com/[^/?#]+/?$` | 2026-09-04 RSS HTTP 200 |
| Google Antigravity | `https://antigravity.google/blog` HTML | `https://antigravity.google/sitemap.xml` | `^https://antigravity\\.google/blog/[^/?#]+/?$` | 2026-09-04 当前网络超时，实施时重试并准备 Fixture |
| Google DeepMind | `https://deepmind.google/sitemap.xml` | `https://deepmind.google/blog/` HTML | `^https://deepmind\\.google/blog/[^/?#]+/?$` | 2026-09-04 Blog HTTP 200；Sitemap 请求出现 SSL 失败 |
| Google Research | `https://research.google/blog/` HTML | `https://research.google/sitemap.xml` | `^https://research\\.google/blog/[^/?#]+/?$` | 2026-09-04 当前网络超时，实施时重试并准备 Fixture |
| Microsoft Research | `https://www.microsoft.com/en-us/research/blog/` HTML | `https://www.microsoft.com/en-us/research/feed/` RSS | `^https://www\\.microsoft\\.com/en-us/research/blog/[^/?#]+/?$` | 2026-09-04 两入口均返回 HTTP 403，实施时重试并准备 Fixture |
| Amazon Science | `https://www.amazon.science/index.rss` | `https://www.amazon.science/blog/` HTML | `^https://www\\.amazon\\.science/blog/[^/?#]+/?$` | 2026-09-04 RSS HTTP 200 且含正文 |
| IBM Research | `https://research.ibm.com/rss` | `https://research.ibm.com/blog` HTML | `^https://research\\.ibm\\.com/blog/[^/?#]+/?$` | 2026-09-04 RSS HTTP 200；链接含追踪参数 |
| Perplexity Research | `https://research.perplexity.ai/articles` HTML | `https://research.perplexity.ai/sitemap.xml` | `^https://research\\.perplexity\\.ai/articles/[^/?#]+/?$` | 2026-09-04 当前网络超时，实施时重试并准备 Fixture |
| Qwen Blog | `https://qwen.ai/api/v2/article/retrieval?type=qwen_ai&language=en-US` JSON | `https://qwen.ai/blog/` HTML | 公开 URL 为 `^https://qwen\\.ai/blog\\?id=[A-Za-z0-9._-]+$`；抓取 URL 限同源 `/api/v2/article/` | 2026-09-04 HTML HTTP 200 但仅为应用壳；同源 JSON 接口可发现并返回正文 |
| Kimi Blog | `https://www.kimi.ai/blog/` HTML | `https://www.kimi.ai/sitemap.xml` | `^https://www\\.kimi\\.ai/blog/[^/?#]+/?$` | 2026-09-04 HTTP 200，HTML 含 `/blog/kimi-k3` 等文章及日期 |
| ERNIE Blog | `https://ernie.baidu.com/blog/zh/index.xml` | `https://ernie.baidu.com/blog/zh/` HTML | `^https://ernie\\.baidu\\.com/blog/zh/posts/[^/?#]+/?$` | 2026-09-04 RSS HTTP 200；链接为相对 URL |
| MiniMax Blog | `https://www.minimax.cn/sitemap.xml` | `https://minimaxi.com/blog` HTML | `^https://www\\.minimax\\.cn/blog/[^/?#]+/?$`；默认使用中文 canonical URL | 2026-09-04 Sitemap HTTP 200，含 `/blog/minimax-music-3-0-cn` |
| Apple ML Research | `https://machinelearning.apple.com/rss.xml` | `https://machinelearning.apple.com/sitemap.xml` | `^https://machinelearning\\.apple\\.com/research/[^/?#]+/?$` | 2026-09-04 RSS 与 Sitemap 均 HTTP 200 |

上表的“当前核验”是设计阶段的可用性记录，不等于生产验收。实现时每个来源仍必须通过离线 Fixture 和 shadow 抓取。对 DeepMind、Qwen、Kimi、ERNIE、MiniMax 和 Apple 这类混合入口，分类只用于纳入文章型内容和排除 R0 索引、R1 列表、分类页及产品静态页；当前 Feed schema 不新增分类字段。

## 配置边界

新增 `config/feed-blogs.json` 作为 Blog 的独立运行时配置，避免继续扩大 `config/default-sources.json`。每个来源包含：

- `id`：稳定、不可变的机器标识；
- `name`：Feed 中显示的官网名称；
- `url`：用户访问的来源主页；
- `discovery`：有序数组；每项包含 `type`（`rss`、`sitemap`、`html` 或经逐站验证的 `json`）和对应 `url`；JSON 策略还包含同源 `detailUrl` 模板和 `publicUrl` 模板，二者都使用 `{path}` 占位符；
- `articleUrlPatterns`：针对 canonical absolute URL 的 JavaScript 正则字符串；任一匹配即允许进入抓取流程；
- 可选 `fetchUrlPatterns`：只约束与公开 URL 不同的同源抓取 URL；任何 discovery 可能产生 `fetchUrl` 时，该数组必填且非空；抓取 URL 不得进入 Feed 或作为 state canonical key；
- `excludeUrlPatterns`：同样针对 absolute URL 的 JavaScript 正则字符串；任一匹配即拒绝，优先级高于允许规则；
- `language`：来源主要语言；
- 可选 `parser`：确有必要时选择已实现的站点规则；
- 可选 `contentSelectors`：通用语义提取失败时使用的有限 CSS 选择器集合。
- 可选 `contentSelectorPriority`：默认 `false`；必须是布尔值；设为 `true` 时必须同时提供非空且有效的 `contentSelectors`，使该来源的选择器先于语义正文。

`loadSources()` 使用该文件覆盖旧配置中的 `blogs`。发布配置中只允许 HTTPS 官网地址和采集器已支持的 discovery/parser 值。

## 数据流

```text
feed-blogs.json config
  -> discoverBlogArticles(source)
     -> RSS | Sitemap | Index HTML | JSON
  -> normalize and filter URLs
  -> lookback and seenArticles filtering
  -> fetchBlogArticle(url)
  -> source parser | generic structured extraction
  -> current blog feed item
  -> feed-blogs.json
```

发现阶段最多扫描每个来源最近 12 个 URL；正文阶段仍最多输出每个来源 3 篇文章。并发抓取上限为 4。正文至少包含 200 个去除空白后的字符。去重键使用 canonical URL，兼容现有以原始文章 URL 保存的状态。

核心函数契约：

- 所有异步函数共享 `BlogFetchOptions`：`{ fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 15000, errors = [], shadow = false }`。`errors` 是调用方拥有的可变字符串数组；函数只追加脱敏错误。
- `discoverBlogArticles(source, options) -> Promise<Candidate[]>`：输入已验证的来源配置和完整 `BlogFetchOptions`；输出 `{ title, url, publishedAt, description }`，内部可带非枚举 `fetchUrl`。JSON 发现把响应中的 `path` 分别填入经验证的 `publicUrl` 和 `detailUrl` 模板；`url` 必须是公开文章 URL，`fetchUrl` 只用于同源官方资源抓取。某个发现入口失败时向 `options.errors` 追加阶段错误并尝试下一入口；所有入口失败时返回空数组。
- `canonicalizeArticleUrl(url, baseUrl) -> string | null`：解析相对 URL、强制 HTTP(S)、删除 fragment 和 `utm_*`、`ref`、`source` 等追踪参数、保留其他业务参数、标准化默认端口与非根路径尾斜杠。
- `extractBlogArticle(html, articleUrl, source) -> ArticleExtraction`：输出 `{ title, canonicalUrl, publishedAt, author, description, content }`，不负责网络请求或 state 写入。
- `fetchBlogArticle(candidate, source, options) -> Promise<BlogItem | null>`：存在 `candidate.fetchUrl` 时请求它，否则请求 `candidate.url`；公开身份、state 查询和缺省 canonical 始终使用 `candidate.url`。跟随安全重定向后运行提取器并校验必填字段；返回现有 Blog Feed item 或 `null`，失败写入 `options.errors`。
- `fetchBlogContent(sources, state, options) -> Promise<BlogItem[]>`：编排来源、时间窗、去重和上限；只有成功生成 Blog item 后才更新 state。现有 `errors` 参数迁入 `options.errors`，调用方继续把同一数组写入 Feed envelope。

`Candidate.publishedAt` 和 `ArticleExtraction.publishedAt` 均为可解析的原始日期或 `null`；写入 Feed 前统一转为 ISO 8601。错误继续使用现有 `errors: string[]`，格式为 `Blog: <source>: <stage>: <message>`。

## 提取规则

文章元数据按以下顺序解析：

1. JSON-LD `BlogPosting`、`Article`、`NewsArticle` 或 `TechArticle`，包括数组和 `@graph`；
2. Open Graph 和标准 meta；
3. HTML 的 `h1`、`time` 等语义标签；
4. 发现阶段提供的标题和日期。

正文按以下顺序解析：

1. JSON-LD `articleBody`；
2. 站点专用解析器；
3. 当该来源显式设置 `contentSelectorPriority` 时，使用配置的正文选择器；
4. `article` 或 `main` 内的正文段落、标题和列表；
5. 默认优先级下的配置正文选择器。

不得把导航、页脚、Cookie 文案或整页脚本内容当作正文。没有标题、URL 或有效正文的候选不进入 Feed。

## 时间、去重与失败语义

- 保持 72 小时默认时间窗和每来源最多 3 篇文章。
- 已知发布时间的文章必须在时间窗内；无可靠日期的文章只允许来自发现结果顶部，并限制扫描数量。
- canonical URL 优先使用文章页 `<link rel="canonical">`，其次使用最终重定向 URL，最后使用发现 URL；随后执行统一 URL 规范化。
- 最终 canonical URL 必须再次通过来源允许 host、`articleUrlPatterns` 和 `excludeUrlPatterns` 校验；跨站 canonical 或重定向不能进入 Feed 或 state。
- JSON `detailUrl`/`publicUrl` 模板必须包含 `{path}`；`detailUrl` 和解析后的非枚举 `fetchUrl` 必须为 HTTPS、与来源同源并匹配必填的 `fetchUrlPatterns`；`publicUrl` 解析结果和正文提取产生的 canonical URL 必须匹配公开 `articleUrlPatterns`。
- state 查询同时检查 canonical URL、最终 URL 和旧的原始 URL；新写入只保存 canonical URL。
- 同一 canonical URL 在单次运行和跨运行状态中只出现一次，即使它被不同发现入口或不同来源重复列出。
- RSS、Sitemap、索引页和文章页错误均带来源名、阶段和 HTTP 状态。
- 单个来源失败是非致命错误；其他来源继续采集。
- 来源发现成功但没有近期内容不是错误。
- 网络抓取使用统一浏览器 User-Agent、15 秒超时和最多 4 个并发请求，不增加凭据或第三方付费依赖。

## 测试与验收

离线测试覆盖：

- RSS 与 Atom 发现；
- Sitemap 与 Sitemap Index URL 筛选、`lastmod` 排序和 XML 命名空间；
- HTML 索引发现；
- JSON-LD 单对象、数组和 `@graph`，Open Graph、语义正文提取；
- Atom alternate link、相对 URL、重定向和 malformed date；
- canonical URL 与去重；
- 时间窗、无日期候选和每来源上限；
- 仅含导航/页脚等 boilerplate 的页面被拒绝；
- 同一文章被两个来源发现时只输出一次；
- 单源错误隔离；
- 配置中的唯一 ID、HTTPS 入口、正则语法、必填策略字段、parser 与 selector 均通过验证；
- JSON 模板、公私 URL 模式、`contentSelectorPriority` 类型及其与非空 selector 的依赖关系均通过验证；
- Blog item 精确保持 `{ source, name, title, url, publishedAt, author, description, content }`，错误保持 Feed envelope 的字符串数组。

新增命令 `node scripts/generate-feed.js --blogs-only --shadow`。Shadow 模式在内存中使用空 state，禁止调用 `saveState()` 和任何 Feed `writeFile()`，仅向标准输出写完整候选 JSON，诊断写向标准错误。真实 shadow 验收对每个来源执行：

- 官网入口可访问；
- 能发现至少一个文章候选；
- 能抓取候选文章并提取非空标题、canonical URL 和有效正文；
- 输出满足现有 Blog Feed schema；
- robots.txt 未禁止目标文章路径，来源条款未明确禁止该类公开抓取；
- 网络暂时不可达或被官方 WAF 阻止时，该来源不得进入生产 `config/feed-blogs.json`，继续保留为候选并使本项目验收保持未完成，除非用户明确批准缩小范围。

只有通过真实 shadow 验收的来源，才在 `docs/source-catalog.md` 中改为“已实现”。

## 文档同步

完成接入后同步更新：

- `docs/source-catalog.md`：逐来源记录真实状态与使用的发现方式；
- README 中涉及当前 Blog 数量和名单的事实描述；
- 测试中的运行时来源清单与数量断言。

候选 URL 不因写入文档或测试 Fixture 自动成为已实现来源。
