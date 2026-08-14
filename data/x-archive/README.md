# X post archive

Every post the platform's own X accounts have published, kept as raw snapshot
files so the corpus survives a database reset, an account lockout, or X changing
its API terms again.

## What is in here

| File | What it is |
|---|---|
| `<handle>-<YYYY-MM-DD>.json` | A timeline scrape: the whole profile as rendered on the web, including reposts of other accounts. |
| `<handle>-api-<YYYY-MM-DD>.json` | A metrics refresh written by `npm run x:archive:refresh`: the same shape, with exact counters from the X API v2. Carries `"source": "x-api-v2"`. |
| `analysis/<handle>-engagement.json` | The computed analysis behind the readable report in [docs/x-archive/](../../docs/x-archive/). Generated, not hand-edited. (Named `analysis/`, not `reports/`, because the repo's `.gitignore` drops any directory called `reports/`.) |

Snapshots are additive. Never overwrite an old one to "update" a post: the
whole point of keeping them separate is that engagement is a time series, so a
post measured at 40 likes on day one and 187 on day three is two facts, not one
correction.

## The three commands

```bash
npm run x:archive:import     # every new snapshot file -> Postgres (idempotent)
npm run x:archive:refresh    # pull exact metrics from the X API into a new snapshot
npm run x:archive:analyze    # rebuild docs/x-archive/<handle>-engagement.md
```

`import` hashes each file and records it in `x_account_imports`, so running it
twice is a no-op. `analyze` reads the database when `DATABASE_URL` is set and
falls back to these files when it is not, which is what makes the archive the
durable copy rather than the cache.

## Two things the scraper gets wrong, and how the tooling handles them

1. **A profile scrape returns the whole timeline, reposts included.** Those
   arrive with the original author's permalink and the original author's
   engagement, and the scraper's own `isRetweet` flag was `false` on all 145 of
   them in the first archive. Authorship is therefore read from the permalink
   (`authorOf` in [scripts/x-archive-lib.mjs](../../scripts/x-archive-lib.mjs)),
   and only self-authored posts are measured.
2. **Like counts render late, so real posts get captured at "0 likes."** 56 of
   the first 214 own posts came back that way, one of them with 172K views and
   92 replies. Those rows are archived and named in the report, but excluded
   from every median, because treating them as real zeros would understate the
   account's best work. `npm run x:archive:refresh` replaces them with exact
   API counters and the exclusions disappear.

View counts past 999 are abbreviated by X itself (`6.3K`), so a scraped view
number carries two significant figures. The raw label is stored next to the
parsed integer and `views_exact` records which is which.

## Adding a new account

Drop its scrape file in here as `<handle>-<date>.json` with the same shape
(`profile`, `scrapedAt`, `tweets[]`) and run the three commands. Nothing is
hardcoded to a single handle.

Schema: [api/_lib/migrations/20260814120000_x_account_archive.sql](../../api/_lib/migrations/20260814120000_x_account_archive.sql).
Docs: [docs/x-archive.md](../../docs/x-archive.md).
