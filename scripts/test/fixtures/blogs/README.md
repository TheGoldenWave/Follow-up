# Blog fixture provenance

Fixtures are sanitized reductions captured on 2026-09-04. Article prose is neutral test text; URLs, metadata mechanisms, framework markers, and body containers reflect the official pages observed at the URLs below.

| Source | Capture URL | Status / retained structure |
|---|---|---|
| Anthropic Engineering | `https://www.anthropic.com/engineering/building-effective-agents` | HTTP 200; canonical, Open Graph, `main#main-content`, `article`, Next-compatible legacy data |
| Claude Blog | `https://claude.com/blog/the-anatomy-of-effective-commerce-agents` | HTTP 200; Webflow `page_main` and `u-rich-text-blog` |
| Anthropic Interpretability | `https://www.anthropic.com/research/natural-language-autoencoders` | HTTP 200; canonical, Open Graph, `PostDetail` article |
| Anthropic Science | `https://www.anthropic.com/research/riemann-zeta` | HTTP 200; canonical, Open Graph, `PostDetail` article |
| OpenAI Alignment | `https://alignment.openai.com/beneficial-rl` | HTTP 200; Open Graph/citation metadata and `.content` layout |
| Google Antigravity | `https://antigravity.google/blog` | Timed out after 25 seconds; reduced semantic application-page structure from the approved official index contract |
| Google DeepMind | `https://deepmind.google/blog/piloting-the-worlds-first-double-blind-ai-evaluations/` | HTTP 200; canonical/meta and `main#page-content` |
| Google Research | `https://research.google/blog/` | Timed out after 25 seconds; reduced semantic Google blog structure from the approved official index contract |
| Microsoft Research | `https://www.microsoft.com/en-us/research/blog/gigapath-flash-and-gigatime-flash-toward-population-scale-discovery-with-efficient-pathology-foundation-models/` | HTTP 200; schema `BlogPosting` main and `single-post__content` |
| Amazon Science | `https://www.amazon.science/blog/developing-provably-correct-rust-code-with-verus` | HTTP 200; `ArticlePage-main`, `ArticlePage-mainContent`, and `RichTextArticleBody` |
| IBM Research | `https://research.ibm.com/blog/ponder-this-september-2026` | HTTP 200; Next-rendered `main[data-testid=blog-post]` |
| Perplexity Research | `https://research.perplexity.ai/articles` | Timed out after 25 seconds; reduced semantic research-article structure from the approved official index contract |
| Qwen Blog | `https://qwen.ai/blog?id=qwen3.8` | HTTP 200 application shell; script-assigned `/blog?id=qwen3.8` route retained |
| Kimi Blog | `https://www.kimi.ai/blog/kimi-k3` | HTTP 200; Next-rendered `report-content` and `.markdown` |
| ERNIE Blog | `https://ernie.baidu.com/blog/zh/posts/ernie-5.1-0508-release` | HTTP 200; canonical/meta and `post-single` / `post-content` |
| MiniMax Blog | `https://www.minimax.cn/blog/minimax-music-3-0-cn` | HTTP 200; canonical/meta, Tailwind article, and `.prose` |
| Apple ML Research | `https://machinelearning.apple.com/research/refactor-vla-motor-programs` | HTTP 200; Next metadata and `.postBody` inside `main.main-default` |
