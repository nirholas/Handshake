# `api/news/` - native crypto news aggregation endpoints

The crypto-news backend behind /markets/news, /markets/digest, /markets/archive, and the story permalinks. Each file is its own HTTP route (`api/news/feed.js` serves `GET /api/news/feed`, see [`api/README.md`](../README.md) for the routing rules). Aggregation is first-party: every article comes from the source registry in [`../_lib/news-sources.js`](../_lib/news-sources.js), 191 live publisher feeds across 27 categories (33 international feeds in 17 languages), each one fetched and parsed before it was listed. There is no third-party news API anywhere in the path.

Why this layer exists instead of buying a news API:

- **Ownership of the pipeline.** The registry was ported from the cryptocurrency.cv aggregator (same team) and revalidated feed by feed. Fetching, parsing, ticker detection, sentiment, curation, and clustering all run in [`../_lib/news.js`](../_lib/news.js) and this directory, so the feed cannot be rate-limited, repriced, or discontinued by a vendor.
- **The agents read from it.** Every fully extracted story lands in the durable knowledge corpus ([`../_lib/news-knowledge-store.js`](../_lib/news-knowledge-store.js)), the grounding surface the platform's 3D agents use to answer market questions with sourced, recent context instead of a hallucination.
- **Rights are enforced in one place.** [`../_lib/news-rights.js`](../_lib/news-rights.js) is the single boundary: the reader serves a bounded lead excerpt plus our own analysis and links out to the publisher; withdrawn stories answer 410 Gone everywhere (feed, knowledge, permalinks, sitemap).
- **Editorial curation without losing coverage.** [`../_lib/news-curation.js`](../_lib/news-curation.js) is a display filter, not an ingestion filter: broad outlets (CNBC, world desks, regulators) stay in the pipeline for the archive and the agents, but only their crypto-relevant articles reach a human feed.

All endpoints are `GET`, CORS-open, and rate-limited per client IP via [`../_lib/rate-limit.js`](../_lib/rate-limit.js). Errors follow the platform shape from [`../_lib/http.js`](../_lib/http.js).

## Endpoints

| Route | Powers | What it does |
| --- | --- | --- |
| `GET /api/news/feed?category&source&lang&q&featured=1&limit&offset&meta=1` | /markets/news, the /markets hub strip | Live aggregated headlines across the registry. `lang` defaults to `en` (international feeds are opt-in), `featured=1` narrows to the majors, `meta=1` returns the source/category/language lists, `raw=1` bypasses curation for parity checks. Per-source results cached 5 min in [`../_lib/news.js`](../_lib/news.js), CDN 120s. |
| `GET /api/news/digest?hours=24&limit=8` | /markets/digest, the /markets/news digest rail | The window's coverage clustered into narratives, each with a title, plain-language summary, stance, tickers, and every citing article. LLM clustering via the platform chain ([`../_lib/llm.js`](../_lib/llm.js)) when configured, agglomerative ticker+token overlap clustering otherwise; `engine` in the response says which ran. Nothing is fabricated: a narrative with no real cited articles cannot exist. |
| `GET /api/news/article?url=<link>` | /markets/news/article reader | Full extraction ladder ([`../_lib/article-extract.js`](../_lib/article-extract.js)) plus analysis: bounded lead excerpt, summary, key points, entities, sentiment, tickers with live prices ([`../_lib/news-coins.js`](../_lib/news-coins.js)), related coverage. Records every analyzed story to the knowledge corpus. Works keyless with extractive analysis, labelled via `analysis_provider`. |
| `GET /api/news/archive?q&ticker&source&category&sentiment&lang&start_date&end_date&limit&offset` | /markets/archive | Historical corpus: 662,047 enriched articles from September 2017 onward on the platform's own GCS bucket, extended hourly by [`api/cron/news-archive-append.js`](../cron/news-archive-append.js). `?stats=true`, `?months=true`, and `?trending=true` are always free; searches carry a free per-IP daily quota, then an x402 challenge ($0.001 USDC, env `X402_PRICE_NEWS_ARCHIVE`). |
| `GET /api/news/knowledge?id\|ticker\|q&full=1` | Agent grounding, /markets/news story context | Read side of the knowledge corpus: one full record by 16-hex id, recent stories mentioning a ticker, free-text search, or latest records plus corpus stats. Same rights boundary as the reader on the way out. |
| `GET /api/news/rss?category&limit` | RSS readers, downstream aggregators | RSS 2.0 mirror of the curated feed, linked as `rel="alternate"` from /markets/news. The source count in the channel description is derived from the registry, never hardcoded. |
| `GET /api/news/image?url=<link>` | /markets/news card images | Preview-image resolver for the ~20% of feeds that ship text-only RSS. Only resolves links the aggregator actually served (not an open resolver), extracts og:image with an SSRF-hardened fetcher, and 302s to the same-origin `/api/img` proxy. Both hits and misses are cached. |
| `GET /markets/news/<YYYY-MM>/<id16>[-slug]` | Story permalinks, crawlers, link previews | Server-rendered by `story-page.js` (routed in `vercel.json`): real title/canonical/OpenGraph tags, NewsArticle JSON-LD, and a crawler-visible body in the same shell the client reader hydrates. The query-param reader stays noindex; this page is the indexable one. |

Frontend consumers live in `src/`: [`markets-news.js`](../../src/markets-news.js), [`news-digest.js`](../../src/news-digest.js), [`news-article.js`](../../src/news-article.js), [`news-archive.js`](../../src/news-archive.js), with shared link helpers in [`src/shared/news-links.js`](../../src/shared/news-links.js). The public pages are declared in [`data/pages.json`](../../data/pages.json) (/markets/news, /markets/news/article).

## The source registry

[`../_lib/news-sources.js`](../_lib/news-sources.js) is the single source of truth for what gets aggregated. Its exports:

- `NEWS_SOURCES` - the registry object, keyed by `source_key` (keys match the cryptocurrency.cv archive so historical and live records line up). Each entry: `name`, `url`, `category`, optional `kind` (`'json'` for adapter-shaped sources), `tier` + `credibility` (drives refresh priority and the quality floor), `language` + `region` (international feeds).
- `NEWS_CATEGORIES` - the 27 canonical categories (`general`, `bitcoin`, `defi`, `security`, `etf`, ...).
- `NEWS_LANGUAGES` - the 17 tagged languages; English feeds carry no `language` field.
- `sourcesForCategory(category)` / `sourcesForLanguage(lang)` - key filters (`'all'` returns everything; `'en'` means the untagged English feeds).
- `sourcePriority(key)` - refresh ordering for the aggregator's bounded worker pool (lower refreshes first, so a deadline-truncated cold start still returns the highest-credibility outlets).
- `isFeaturedSource(key)` - the Featured bar gate: tier1/tier2 upstream or credibility at or above 0.85.

The registry changes as feeds live and die. Re-validate it with [`scripts/news-sources-probe.mjs`](../../scripts/news-sources-probe.mjs), which fetches every listed feed and exits non-zero when one has died. Derive counts from the registry at runtime (as `rss.js` does); never hardcode them.

## Shared internals

- [`../_lib/news.js`](../_lib/news.js) - the aggregation engine. `getNews({ category, source, lang, q, limit, offset, featured, curated })` fans out across the registry with per-source 5-minute caching; also exports `parseFeed`, `findArticle`, `searchNews`, `articleId`, `extractTickers`, `lexiconSentiment`, `extractOgImage`, and the text utilities the endpoints share.
- [`../_lib/news-rights.js`](../_lib/news-rights.js) - `suppression`, `isSuppressed`, `excerptParagraphs`, `excerptText`: takedown enforcement and the standing excerpt bound.
- [`../_lib/news-knowledge-store.js`](../_lib/news-knowledge-store.js) - `recordExtraction`, `getExtraction`, `queryKnowledge`, `knowledgeStats` over the durable `news_knowledge` table.
- [`../_lib/news-archive-store.js`](../_lib/news-archive-store.js) - `getStats`, `getMonths`, `loadMonth`: month-file access to the GCS archive (`articles/YYYY-MM.jsonl`, `meta/stats.json`, indexes), shared with the story pages and the news sitemap.
- [`../_lib/news-story.js`](../_lib/news-story.js) - `resolveStory`, `validStoryKey`: resolves a `<month>/<id16>` permalink against the live feed and the archive.

## Usage

No install step: these deploy with the rest of `api/` and run locally under the dev server (`npm run dev`, port 3000, Vite proxies `/api`). The feed, digest heuristic engine, image resolver, RSS, and knowledge endpoints work with zero configuration. Optional env:

- LLM provider keys (see [`../_lib/llm.js`](../_lib/llm.js)) upgrade the digest to semantic clustering and the reader to generated summaries; without them both fall back to real heuristic/extractive analysis, never fabrication.
- `NEWS_MIN_CREDIBILITY` tunes the curation quality floor at runtime.
- `X402_PRICE_NEWS_ARCHIVE` overrides the archive's per-search price.

Example, straight from the route contract at the top of [`feed.js`](./feed.js) (`GET /api/news/feed` with a category filter):

```sh
curl -s 'https://three.ws/api/news/feed?category=defi&limit=5' | head -c 600
```

Returns `{ "articles": [ { id, title, link, source, pub_date, tickers, sentiment, image, ... } ], "total": ..., "limit": 5, "offset": 0, "lang": "en", "sources_ok": ..., "sources_total": ..., "fetched_at": "..." }`. Add `&meta=1` for the full source/category/language lists, `&featured=1` for the majors only, or `&lang=ja` for one of the 17 international languages.

## Related

- [`api/README.md`](../README.md), how routing, `_lib/`, and crons work across the whole API surface.
- [`api/coin/README.md`](../coin/README.md), the market-data endpoints the reader's live coin prices come from.
- [`STRUCTURE.md`](../../STRUCTURE.md), the map of every product surface.
