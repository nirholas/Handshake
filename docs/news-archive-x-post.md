# X post: the three.ws crypto news archive

Copy for announcing that three.ws runs the largest open crypto-news archive and feeds it to the
3D agents as market memory.

**Verified numbers (pulled live from `GET /api/news/archive?stats=true` on 2026-08-16).** Re-pull
before posting; the hourly archiver appends and the count only goes up.

| Claim | Live value | Source |
|---|---|---|
| Archived articles | 740,889 | `stats.total_articles` |
| First article | 2017-09-23 (not 2016) | `stats.first_article_date` |
| Last article | today, refreshed hourly | `stats.last_article_date`, [api/cron/news-archive-append.js](../api/cron/news-archive-append.js) |
| Months covered | 103 | `months.count` |
| Languages | English + 中文 | `stats.languages` |
| Live publisher feeds | 197 | [api/_lib/news-sources.js](../api/_lib/news-sources.js) `NEWS_SOURCES` |
| Agent memory path | every read story lands in the durable `news_knowledge` corpus that grounds the 3D agents | [api/_lib/news-knowledge-store.js](../api/_lib/news-knowledge-store.js), `GET /api/news/knowledge` |

**Do not say "since 2016."** The corpus starts September 2017. Do not say "every article ever
published" either: 197 feeds is the live registry, and the archive is enriched (tickers,
sentiment, entities, market context at publish time), which is the actual differentiator.

Links that resolve: three.ws/markets/archive, three.ws/markets/news, three.ws/markets/digest.

---

## 1. Main post

> Did you know three.ws runs the largest open crypto news archive?
>
> 740,000+ articles from 197 crypto publishers, September 2017 to this hour, English and Chinese,
> every one enriched with tickers, sentiment, entities, and the BTC/ETH price at the moment it
> was published.
>
> We built it because our 3D AI agents needed memory. An agent that only sees today's headline
> has no idea it is the fourth time that narrative has run. Ours can look up every prior cycle,
> what was said, who said it, and what the market actually did next.
>
> Free to search: three.ws/markets/archive

---

## 2. Shorter variant (single-screen)

> Most AI agents read today's news. Ours read nine years of it.
>
> three.ws keeps the largest open crypto news archive: 740k+ articles, 197 publishers, Sept 2017
> to this hour, EN + 中文, each tagged with tickers, sentiment, and the market price at publish
> time. It is the memory layer behind our 3D agents.
>
> three.ws/markets/archive

---

## 3. Thread (4 posts)

> **1/** Did you know three.ws has the largest open crypto news archive?
>
> 740,000+ articles. 197 publishers. September 2017 to this hour. English and Chinese.
>
> It is not a scrape sitting in a bucket. Here is what it is for.

> **2/** Every article is enriched on the way in: tickers mentioned, sentiment, entities, and the
> BTC/ETH price and fear/greed reading at the exact moment it published.
>
> So you can ask what the market was actually doing when a story ran, not just that it ran.

> **3/** That corpus is the memory for our 3D AI agents.
>
> An agent with only today's feed treats every narrative as new. An agent with nine years of
> coverage knows this exact story ran in 2018, 2021, and 2024, and what followed each time.
> Same model, better context.

> **4/** All of it is searchable by keyword, ticker, source, sentiment, date, and language, and
> queryable through our API for your own agents.
>
> three.ws/markets/archive

---

## 4. Reply to have ready

If someone asks how it stays current: the archiver runs hourly against all 197 feeds, so the
newest month is always live and the corpus grows every hour. If someone asks about publisher
rights: the reader shows a bounded excerpt plus our own summary and sends readers to the
publisher, and the cap plus any takedown is enforced server side across the reader, the RSS
mirror, archive search, and the agent knowledge corpus. See [docs/news-rights.md](news-rights.md).
