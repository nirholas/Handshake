---
title: Publisher rights in the news reader
description: What three.ws may and may not show from a publisher's article, how withdrawn stories are removed, and how to file a takedown.
---

# Publisher rights in the news reader

three.ws aggregates every feed in its news source registry ([`api/_lib/news-sources.js`](../api/_lib/news-sources.js), just under 200 of them today) into [/markets/news](https://three.ws/markets/news), gives every story a permalink, and layers its own analysis on top (summary, key points, detected tickers with live prices, market context at publication, sentiment, related coverage).

Aggregating headlines and linking out is lawful. Reproducing a publisher's article body under our own URL is not, however the text arrives — a scraped page, a reader proxy, or an RSS feed that ships the whole article in `content:encoded`. This page documents where that line sits and how it is enforced in code.

## What a story page shows

| Element | Source | Shown |
|---|---|---|
| Headline, byline, publish date, image | The publisher's feed | Yes, with attribution |
| Lead excerpt of the article | The publisher's article | Yes, **capped at 400 characters / 2 paragraphs** |
| Summary, key points, entities, topics | Our analysis of the article | Yes, this is our own work |
| Tickers, live prices, market context | Our market data | Yes |
| The rest of the article body | The publisher's article | **Never.** The reader links out |

The cap is not a UI preference. It is enforced server-side in [`api/_lib/news-rights.js`](../api/_lib/news-rights.js) and applied at every boundary where publisher text can leave the platform:

- `api/news/article.js` — the reader's detail endpoint, via `publicView()`
- `api/news/story-page.js` — the crawler-visible body, the JSON-LD block, and the JSON seed embedded in the HTML
- `api/news/knowledge.js` — the public, CORS-open grounding corpus
- `api/news/archive.js` — the paid archive search, capped at read time
- `api/_lib/news.js` — `getNews()`, which every list payload, the RSS mirror, and the coin rails flow through
- `api/cron/news-archive-append.js` — capped at capture, so new archive rows never hold a body

The extraction ladder still fetches the full text internally: the LLM needs the whole article to summarize it accurately, and the agents' grounding corpus reasons over it server-side. What changes is that the full text never reaches a response.

## Withdrawn stories and publishers

`news-rights.js` holds two lists:

- **`TAKEDOWN_IDS`** — individual stories removed at a rightsholder's demand, keyed by the 16-hex story id that appears in `/markets/news/<month>/<id>`.
- **`RESTRICTED_SOURCE_KEYS` / `RESTRICTED_HOSTS`** — publishers withdrawn entirely, matched by source key and by link hostname so archived records are caught even when their schema predates the key.

A suppressed story:

- answers **410 Gone** at its permalink, with `x-robots-tag: noindex, nofollow` and a `noindex` meta tag. 410 rather than 404 is deliberate: it tells search engines the removal is permanent, so the URL drops out of the index on the next crawl instead of being retried for weeks.
- is dropped from the feed, RSS, related coverage, archive search, the knowledge corpus, and the sitemap.
- is refused by `/api/news/article` and `/api/news/knowledge` with a 410.
- cannot be re-ingested: the publisher is removed from the feed registry, and `getNews()` filters it at the fan-out choke point, so the hourly archiver cannot re-add it.

Suppression happens on **read**, so it takes effect the moment the code deploys, before any data is touched. Deleting the underlying rows is a separate step:

```bash
node scripts/news-takedown-purge.mjs            # dry run: report what would be deleted
node scripts/news-takedown-purge.mjs --apply    # rewrite the GCS month files, delete the DB rows
```

The script rewrites each affected `gs://three-ws-news-archive/articles/<month>.jsonl` guarded with `if-generation-match`, so it cannot clobber a concurrent append from the hourly cron, and deletes the matching `news_knowledge` rows.

## Editorial curation: what appears in the feed

Rights govern how *much* of a story we may show. Curation governs *which* stories appear at all. They are separate filters and live in separate files ([`api/_lib/news-curation.js`](../api/_lib/news-curation.js) is the curation one).

Every registry feed is ingested. Some are crypto-native: every article is on topic. Others are broad outlets (WSJ, CNBC, Seeking Alpha, the SEC, the Fed, world-news desks) that run crypto coverage *and* a great deal that isn't. We keep pulling the broad ones on purpose: their crypto reporting is high-value, and the macro and regulatory context enriches the archive and the agents' knowledge corpus. But a world-politics headline or a general-markets note should never land in a crypto feed.

So the human-facing feeds apply a display gate with two conditions:

1. **Relevance**: a crypto-native source always shows. A broad source's article shows only if the article itself is about crypto (a detected ticker, or a term from the crypto lexicon). Both are matched as whole words: the lexicon test is a `\b`-anchored regex (`CRYPTO_TERM_RE`), so "defied" no longer fires on `defi` and "tether" is in the list explicitly instead of matching through `ether`, and coins whose bare name is an ordinary word (NEAR, OP, MKR) are tagged only from a qualifying phrase ("NEAR Protocol", "Optimism mainnet", "MakerDAO") or a cashtag. This is what keeps "Ryanair broken window", "3M stock jumps", and "8 defied the selloff" out while letting the same source's Bitcoin coverage through.
2. **Quality** — a credibility floor (default 0.6, override with `NEWS_MIN_CREDIBILITY`). Scored sources must clear it; unscored registry sources are presumed acceptable; legacy archive rows with no registry entry are never dropped on quality grounds.

The gate is **display-only**. It runs on `/api/news/feed`, the RSS mirror, the daily digest, and related coverage — never on ingestion. The archive cron and the agent-signal callers still receive the full firehose. `GET /api/news/feed?raw=1` bypasses the gate for debugging or parity checks. An explicit single-source request (`?source=`) is also exempt: you asked for that outlet by name.

## Removal history

**The Merkle, LLC (NullTX, nulltx.com)** — notice received 2026-07-19 through the Google Search Console legal channel; Lumen notice 15710816. 24 story pages reproduced the titles and substantially the full body text of the corresponding nulltx.com articles. The claim was correct: the reader rendered the extracted body under our own canonical URL. All 24 ids are in `TAKEDOWN_IDS`, `nulltx` was removed from the feed registry, and the excerpt cap above was added so the same defect cannot recur with any other publisher.

## If you are a publisher

If three.ws is showing more of your work than you want it to, you do not need to file anything formal first. Email **[dmca@three.ws](mailto:dmca@three.ws)** with the URLs and we will remove them, and we will honour a request to drop your publication from the aggregator entirely.

If you would rather file a formal DMCA notice, the process and the information required by 17 U.S.C. § 512(c)(3) are in the [Terms of Service](https://three.ws/legal/tos); it reaches the same place. Every policy is listed at [three.ws/legal](https://three.ws/legal).

## For contributors

Three rules, in order of importance:

1. **Never widen the excerpt.** `EXCERPT_MAX_CHARS` and `EXCERPT_MAX_PARAGRAPHS` are a legal boundary, not a design knob. [`tests/news-rights.test.js`](../tests/news-rights.test.js) asserts them directly; if a test there fails, the site is republishing copyrighted text again — fix the code, not the test.
2. **Any new surface that emits article text goes through `news-rights.js`.** A new endpoint, MCP tool, feed, or export that reads `paragraphs` or `description` must call `excerptParagraphs()` / `excerptText()` and filter with `isSuppressed()`. The lists are worthless if a new door bypasses them.
3. **Never re-add a withdrawn publisher** without written permission from the rightsholder.

## Related

- [`api/_lib/news-rights.js`](../api/_lib/news-rights.js) — the implementation
- [`scripts/news-takedown-purge.mjs`](../scripts/news-takedown-purge.mjs) — the purge tool
- [Market Data API](./market-data-api.md) — the paid market endpoints, including archive search
