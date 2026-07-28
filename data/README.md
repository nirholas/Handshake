# data/

The data files that drive the site. Most of them are hand-edited JSON that build scripts turn into public pages, feeds, and manifests. A few are machine-written ledgers and results that scripts append to. Nothing in here is served raw to users except through the consumers listed below.

Two files matter most:

- `pages.json` is the manifest of every public page. It feeds the sitemap, `llms.txt`, `features.json`, the human `/sitemap` page, and the changelog (a page's `added` date auto-generates its launch entry).
- `changelog.json` is the curated changelog. `npm run build:pages` merges both files into `CHANGELOG.md`, `public/changelog.json`, and `public/changelog.xml`, and fails the build on a malformed entry.

## Top-level files

| File | Purpose | Read by | Written by | Regenerate / validate |
|---|---|---|---|---|
| `pages.json` | Manifest of every public page (site metadata plus 10 sections of page entries: path, title, description, priority, changefreq, `added` date). Source of truth for the sitemap, `llms.txt`, `llms-full.txt`, `features.json`, and page-launch changelog entries. | `scripts/build-page-index.mjs`, `api/sitemap/[type].js` (dynamic sitemap), `api/page-og.js`, `scripts/check-pages.mjs`, `scripts/audit-page-index.mjs`, `npm run smoke:prod` | Hand-edited | `npm run build:pages` regenerates all outputs; `node scripts/audit-page-index.mjs --strict` fails on public routes missing from the manifest (runs in `prebuild`) |
| `changelog.json` | Curated changelog entries, newest first: everything holders care about that is not a new page launch. The editorial layer merged with page `added` dates. | `scripts/build-page-index.mjs`, `scripts/changelog-telegram.mjs`, `scripts/changelog-x.mjs`, `api/_lib/changelog-push.js` (via the baked `public/changelog.json`) | Hand-edited (append) | `npm run build:pages` validates every entry (date format, title, summary, allowed tags) and rebuilds `CHANGELOG.md`, `public/changelog.json`, `public/changelog.xml`. `npm run changelog:gaps` finds shipped work that never got an entry |
| `changelog-telegram-state.json` | Posted-state for the manual Telegram push script (a `posted` array of `date:title` keys). The production cron keeps its own state in Postgres (`app_settings`); it seeds from this file on first run. | `scripts/changelog-telegram.mjs`, `api/_lib/changelog-push.js` (seed only) | `scripts/changelog-telegram.mjs` | Do not run `npm run changelog:push` for routine releases: delivery is automatic via `/api/cron/changelog-push` (Cloud Scheduler) and a manual push can double-post. Use `node scripts/changelog-telegram.mjs --dry-run` for previews and owner-directed backfills only |
| `changelog-x-state.json` | Same as above for the X (@trythreews) release thread. | `scripts/changelog-x.mjs`, `api/_lib/changelog-push.js` (seed only) | `scripts/changelog-x.mjs` | Same rule: cron-delivered in production; `node scripts/changelog-x.mjs --dry-run` for previews only |
| `agent-identities.json` | Agent Identity Studio demo identities behind `/agent-identities`. Each entry is a real run of the production identity pipeline: inputs plus pipeline outputs (PFP renders, full-body renders, backend used). | `src/agent-identities.js` | `scripts/okx-identity-demo.mjs` writes results back; never edited by hand | `node scripts/okx-identity-demo.mjs` |
| `timeline.json` | Events for the interactive 3D history timeline at `/timeline`: 63 chronological milestones with category, importance (1 to 5, drives visual scale), and source URLs. | `src/timeline.js` | Hand-edited | None (edit and reload `/timeline`) |
| `walk-social.json` | Quote cards for the Walk landing page social strip. | `pages/walk-landing.html` | Hand-edited | None |
| `robinhood-stock-tokens.json` | Registry of the 95 Robinhood Chain Stock Tokens (chain 4663): address, symbol, name, decimals, price feed. Generated on-chain during the Wave-1 SDK build (shared beacon slot, per-token multicall, feed `latestRoundData`). | `api/_lib/robinhood.js` (`stockRegistry()`, loaded once at module init) | Generated from chain; the refresh logic lives in `robinhood/robinhood-chain-sdk/scripts/refresh-registry.mjs` (writes the SDK copy; sync this file from it) | `node robinhood/robinhood-chain-sdk/scripts/refresh-registry.mjs` |
| `erc8004-bsc-mint-ledger.json` | Append-only ledger of ERC-8004 agent identity mints on BSC (chain 56): agentId, owner, agentURI, txHash, gas cost, timestamp. | Audit trail; read by hand when reconciling mints | `scripts/erc8004-mint-bsc.mjs` | `node scripts/erc8004-mint-bsc.mjs` |
| `x402-directory-registrations.json` | Per-directory state of our x402 service listings (402index and friends): last response, status, timestamp per endpoint URL. Re-run until every listing reports ok. | `scripts/x402-register-directories.mjs` (as its resume state) | `scripts/x402-register-directories.mjs` | `node scripts/x402-register-directories.mjs` |

## Subdirectories

| Directory | Purpose | Read by | Written by | Regenerate / validate |
|---|---|---|---|---|
| `rss/` | Curated news items. `items.json` (107 items) controls the RSS feed at `/rss/announcements.xml` AND one permalink page per item at `/news/<slug>`. `SCHEMA.md` documents every field; read it before editing. | `api/_lib/rss-feed.js`, `api/rss/announcements.js`, `scripts/build-news.mjs` | Hand-edited (`items.json`) | `node scripts/build-news.mjs` regenerates `public/news/` and `data/_generated/news-routes.json` (also runs in `prebuild`) |
| `skills/` | Skill content for the skills marketplace. `seed.json` (115 skills, each with category and full SKILL.md content) seeds the `marketplace_skills` table. The category directories (`analysis/`, `community/`, `defi/`, `development/`, `general/`, `news/`, `portfolio/`, `protocol/`, `security/`, `trading/`) hold the source `SKILL.md` packs, one per skill. `metamask-agent-wallet/` and `metamask-agent-workflows/` are vendored partner skill packs (real directories, not symlinks: `scripts/audit-deploy-artifacts.mjs` fails the build on committed symlinks here). | `scripts/seed-skills.js`; runtime skill feeds read `data/_generated/skill-metadata.json` and `data/_generated/local-skill-packs.json` instead (see below) | Hand-edited | `npm run seed:skills` ingests `seed.json` into the database |
| `archives/` | Scraped X post archives (`nichxbt_tweets_2026-05-10.json`, `trythreews_tweets_2026-05-16.json`, `trythreews_tweets_2026-06-03.json`) plus `tweet-metrics.json`, an archived launch-week metrics snapshot. The RSS feed uses the archives as fallback and mirror source; `rss/items.json` was last merged from the 2026-06-03 archive. | `api/_lib/rss-feed.js` (archive mode) | `scripts/refresh-tweet-metrics.mjs` produced the metrics snapshot; tweet archives are one-time imports | None (append new archive files; then merge into `rss/items.json` by hand) |
| `quality-bench/` | The forge realism benchmark: `prompts.json` (fixed 23-prompt set; never edit an existing id, add new ones), `refs/` (3 CC0 reference photos for image-to-3D cases, sources in `refs/SOURCES.md`), and `runs/` (one committed JSON per bench run, append-only, created on first run). Full docs in [quality-bench/README.md](quality-bench/README.md). | `api/quality-bench.js` (dashboard), `api/cron/quality-bench.js` (weekly regression smoke test, diffs against the latest committed run) | `scripts/quality-bench.mjs` writes run files | `node scripts/quality-bench.mjs` (see `--dry-run`, `--lane`, `--compare=latest,previous`) |
| `_generated/` | Prebuild artifacts, gitignored except one file. `news-routes.json` (from `scripts/build-news.mjs`), `skill-metadata.json` (from `scripts/build-skill-metadata.mjs`), and `local-skill-packs.json` (from `scripts/build-local-skill-packs.mjs`) keep heavy imports out of the deployed functions (`api/chat-skills.js`, `api/skills-manifest.js`, `src/skills/local-packs.js` read them). `fact-check-benchmark.json` is the exception: a committed, manually-run accuracy report that `/fact-check` renders via `api/fact-check-benchmark.js`. | `scripts/build-page-index.mjs`, `api/chat-skills.js`, `api/skills-manifest.js`, `src/skills/local-packs.js`, `api/fact-check-benchmark.js` | The three build scripts above (automatic in `prebuild`); `scripts/fact-check-benchmark.mjs` for the committed report (real chain, real cost per run) | `npm run build` regenerates the prebuild trio; `node scripts/fact-check-benchmark.mjs` re-runs the accuracy report |

## Adding a page

1. Build the page and wire its route.
2. Add an entry to the right section of `pages.json`:

```json
{
	"path": "/my-page",
	"title": "My Page",
	"description": "One sentence a stranger could act on.",
	"priority": 0.7,
	"changefreq": "weekly",
	"added": "2026-07-28"
}
```

Required: `path`, `title`, `description`, `added` (YYYY-MM-DD). `scripts/audit-page-index.mjs --strict` (part of `prebuild`) fails the build if a public route is missing from the manifest. Optional fields used elsewhere in the file: `priority` and `changefreq` (sitemap), `showcase`, `auth: "required"`, `indexable: false`, `tags`.

3. Run `npm run build:pages`. The `added` date auto-generates the page's changelog launch entry; no `changelog.json` entry is needed for a new page.

## Adding a changelog entry

For everything users would notice that is not a new page (features, improvements, fixes, SDK releases, security work), append to the top of `entries` in `changelog.json`:

```json
{
	"date": "2026-07-28",
	"title": "Holder-readable headline",
	"summary": "Plain-language explanation of what changed and why it matters. No commit jargon.",
	"tags": ["improvement"],
	"link": "/some-live-path"
}
```

Required: `date` (must match `YYYY-MM-DD`), `title`, `summary`, and `tags` (non-empty array). Allowed tags, enforced by the validator in `scripts/build-page-index.mjs`: `feature`, `improvement`, `fix`, `sdk`, `infra`, `docs`, `security`. `link` is optional and must be a live three.ws path.

Then run `npm run build:pages`. It validates the entry (a malformed one fails the build) and regenerates `CHANGELOG.md`, `public/changelog.json`, and `public/changelog.xml`.

Delivery to holders is automatic. `/api/cron/changelog-push` (Cloud Scheduler, every 20 minutes) reads the feed baked into the running image, diffs it against database state in `app_settings`, and posts anything new to the holders' Telegram channel (@three_ws) and the @trythreews X release thread. An entry can only be announced after the deploy that ships it is live. Do not run `npm run changelog:push` or `npm run changelog:push:x` for routine releases: their file state (`changelog-telegram-state.json`, `changelog-x-state.json`) is separate from the cron's database state, so a manual push double-posts. Those scripts are for `--dry-run` previews and owner-directed backfills only.
