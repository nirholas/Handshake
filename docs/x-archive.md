# The X post archive

Every post our own X accounts publish, kept and measured, so "what actually
lands with our audience" is a query instead of an opinion.

This is internal marketing infrastructure. It is not a product surface, it does
not touch a user's account, and nothing here posts anything: it only reads what
was already published.

---

## Why it exists separately from `x_posts`

The platform already has an `x_posts` table, but it holds what a **three.ws
user** published *through* the platform (`POST /api/x/post`), keyed to their
account. The @trythreews timeline is a different corpus: it predates that
feature, most of it was written by hand, and it is the only body of evidence we
have about what our audience responds to. Mixing the two would mean answering a
marketing question by scanning somebody else's agent's posts.

## What is stored

Three tables, created by
[api/\_lib/migrations/20260814120000_x_account_archive.sql](../api/_lib/migrations/20260814120000_x_account_archive.sql):

| Table | One row per | Why |
|---|---|---|
| `x_account_imports` | snapshot file ingested | Hashed, so the same file cannot be counted twice. |
| `x_account_posts` | post | The post and its latest observed metrics. |
| `x_account_post_snapshots` | post, per import | Engagement is a time series. "40 likes on day one, 187 by day three" is two measurements, not a correction. |

The raw snapshot files in [data/x-archive/](../data/x-archive)
are the durable copy. The database is a queryable index over them, and can be
rebuilt from them at any time.

## The commands

```bash
npm run x:archive:import     # snapshot files -> Postgres, idempotent
npm run x:archive:refresh    # exact metrics from the X API -> a new snapshot file
npm run x:archive:analyze    # rebuild the engagement report
```

Typical loop after a fresh scrape lands in `data/x-archive/`:

```bash
npm run db:status            # confirm the archive migration is applied
npm run x:archive:import
npm run x:archive:analyze
```

`analyze` reads the database when `DATABASE_URL` is set and falls back to the
archive files when it is not, so the report can always be regenerated from a
clean checkout.

## The report

[docs/x-archive/trythreews-engagement.md](../docs/x-archive/trythreews-engagement.md)
is generated, never hand-edited. It carries:

- headline totals and the engagement **distribution** (median, p75/p90/p99, and
  the share of all engagement earned by the top decile),
- the top posts by raw engagement, by **engagement rate** (which normalizes for
  reach, so it ranks writing rather than luck), and by replies,
- **lift tables**: for each measurable signal (image, video, link card, mention,
  question, length band, subject), the group's median engagement divided by the
  corpus median, shown against the posts without that signal,
- timing by hour and weekday, cadence by month, and who we amplify.

Lift is computed against the **median**, not the mean, on purpose: with the top
10% of posts earning roughly half of all engagement, a mean is a report about
one viral post.

## Two measurement rules worth knowing

**Reposts are not our posts.** A profile scrape returns the whole timeline, and
a repost or quote keeps the original author's permalink and engagement. The
scraper's own `isRetweet` flag was `false` on all 145 reposts in the first
archive, so authorship is read from the permalink instead. Only self-authored
posts are measured; who we amplify is reported separately.

**A scraped zero is not always a zero.** X renders like counts lazily, so a
scroll-based scrape captures real posts at "0 likes": 56 of the first 214 own
posts, including one with 172K views and 92 replies. Those are archived, named
in the report, and excluded from every median rather than dragging it down.
`npm run x:archive:refresh` replaces them with exact `public_metrics` from the
X API (`X_API_BEARER`), after which nothing is excluded.

View counts past 999 are abbreviated by X itself (`6.3K`), so scraped view
numbers carry two significant figures. Both the label and the parsed integer are
stored, with `views_exact` recording which is which; the API refresh returns
exact impressions.

## Adding another account

Nothing is hardcoded to one handle. Drop `<handle>-<date>.json` into
`data/x-archive/` in the same shape (`profile`, `scrapedAt`, `tweets[]`) and run
the three commands; the report is written per handle.

Code: [scripts/x-archive-lib.mjs](../scripts/x-archive-lib.mjs)
(normalization + analysis, covered by
[tests/x-archive.test.js](../tests/x-archive.test.js)),
[scripts/x-archive-import.mjs](../scripts/x-archive-import.mjs),
[scripts/x-archive-refresh.mjs](../scripts/x-archive-refresh.mjs),
[scripts/x-archive-analyze.mjs](../scripts/x-archive-analyze.mjs).
