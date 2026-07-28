# blog/

The three.ws editorial blog. Hand-authored static HTML posts, served live at [https://three.ws/blog](https://three.ws/blog), plus the data files and syndication companions that ship alongside certain posts.

There is no static site generator here. Each post is a complete, self-styled HTML page. Build tooling handles SEO metadata, sitemap registration, and copying into `dist/`, but the content itself is written by hand.

## What is in this directory

| File pattern | What it is |
|---|---|
| `index.html` | The blog index page, served at `/blog`. The post list (`li.bl-item` cards) and the press section are maintained by hand, newest post first. |
| `<slug>.html` | One published post per file. The filename minus `.html` is the URL slug: `first-autonomous-trade.html` is served at `/blog/first-autonomous-trade`. Slugs must match `[a-z0-9-]+`. |
| `<slug>.json` | A published dataset that accompanies a post. `autonomous-trading-experiment.json` is the full graded trade ledger (keys: `generated`, `source`, `fleet`, `arms`, `trades`, `counterfactual`, `paperhands`) linked from the post as a download. |
| `<slug>-series.json` | Time-series data a post fetches at runtime. `autonomous-trading-experiment.html` calls `fetch('/blog/autonomous-trading-experiment-series.json')` to render its charts in the browser. Renaming or removing it breaks the live post. |
| `<slug>-x.md` | X.com (Twitter) versions of a post: a long-form post and a thread, formatted for X constraints, linking back to the canonical blog URL. Posted manually by the owner. |
| `<slug>-x-article.md` | A ready-to-paste X Article version, with step-by-step publish instructions at the top and `[IMAGE: file]` markers pointing into `x-article-assets/`. |
| `x-article-assets/` | PNG images (`00-cover.png` through `09-waterfall.png`) uploaded by hand when publishing the X Article. |
| `external-*-draft.md` | Drafts prepared for external syndication (HackerNoon, AWS Builder Center, dev.to). The comment block at the top of each carries the routing plan and the canonical URL to set on the external platform. Owner action required to publish. |
| Other `.md` essays (`we-are-the-provider.md`, `internets-second-species.md`, `decision-optimization-3d-ai-crypto.md`, `x402-stripe-for-agent-payments.md`) | Long-form source text and syndication copies. Some have an HTML counterpart (`x402-stripe-for-agent-payments.html`); the `.md` is the version used for external channels. |

Everything in this directory is copied to `dist/blog/` verbatim at build time, so the `.json` and `.md` companions are publicly downloadable at `/blog/<name>` in production. Do not put private notes here.

## Anatomy of a post

Every post HTML file is self-contained and follows the same structure. Copy an existing post (for example `blog/three-ws-quicknode-startup-program.html`) rather than starting from scratch.

Head:

- `<title>` and `<meta name="description">`: these are load-bearing. The SEO injector (below) reads them to build JSON-LD and the `data/pages.json` entry.
- `<link rel="canonical" href="https://three.ws/blog/<slug>">`.
- Open Graph and Twitter card tags.
- `<link rel="stylesheet" href="/nav.css">` and `/footer.css`, plus an inline `<style>` block with the shared dark post styles (`.post-wrap`, `.post-meta`, `.post-tag`, and so on).
- `BlogPosting` and `BreadcrumbList` JSON-LD blocks. You do not write these by hand; the injector adds them.

Body:

- `<div id="nav-container">` at the top, `<div id="footer-container">` at the bottom, hydrated by `/nav.js` and `/footer.js`.
- `<main class="post-wrap">` containing a back link to `/blog`, then `.post-meta` with a `.post-date` span (`YYYY-MM-DD`) and `.post-tag` chips, then the `<h1>` and the article content.

The `.post-date` chip is load-bearing: `scripts/inject-blog-seo.mjs` reads it to derive `datePublished` for the JSON-LD and the `lastmod` in `data/pages.json`.

## Build and SEO automation

`scripts/inject-blog-seo.mjs` scans every `blog/*.html` except `index.html` and:

1. Fills any missing `og:image` / `twitter:image` tags (default `https://three.ws/og-image.png`).
2. Injects `BlogPosting` and `BreadcrumbList` JSON-LD built from the post's own title, description, keywords, and date.
3. Upserts each discovered post into the `blog` section of `data/pages.json` (priority 0.6, changefreq monthly, `lastmod` from the post date), sorted newest first.

It is idempotent: it only fills gaps and never overwrites metadata a post already has. It runs automatically in `prebuild` (so every `npm run build` picks up new posts), in `scripts/build-vercel.mjs`, and on demand via:

```bash
node scripts/inject-blog-seo.mjs           # dry-run report
node scripts/inject-blog-seo.mjs --write   # apply
# or the combined pass:
npm run seo:meta
```

The `data/pages.json` blog section is the single source of truth downstream: the sitemap, `llms.txt`, `features.json`, and the human sitemap all read from it. Once the injector has upserted your post, no second manual registration is needed for crawl discovery.

## Serving and routing

- **Dev**: `npm run dev`, then open `http://localhost:3000/blog/<slug>`. Middleware in `vite.config.js` maps `/blog` to `blog/index.html` and `/blog/<slug>` to `blog/<slug>.html` on disk.
- **Build**: the `copy-blog` plugin in `vite.config.js` copies the whole `blog/` directory into `dist/blog/` recursively.
- **Production** (Cloud Run, one container serving `dist/` plus the `vercel.json` route table): `vercel.json` routes `/blog` and `/blog/` to `/blog/index.html`, and the generic rule `/blog/([a-z0-9-]+)/?` to `/blog/$1.html`. A new post needs no route change; the slug rule covers it. Legacy redirects (like `/blog/all-90-trades` to `/blog/autonomous-trading-experiment`) are added there when a post is renamed.

## Syndication surfaces

- **RSS**: `/rss/announcements.xml`, served by `api/rss/announcements.js` from the curated file `data/rss/items.json`. Blog announcements do not flow in automatically. To put a post in the feed, add an item there with `id`, `title`, `date` (ISO 8601), `body_html`, and a `link` to the canonical post URL. Newest first by date, capped at 80 items. HackerNoon and other readers consume this feed.
- **Changelog**: a user-visible post gets an entry in `data/changelog.json` with `"link": "/blog/<slug>"`. After the deploy that ships it, the changelog cron posts it to the holders' Telegram channel and the X release thread automatically. See the Changelog section of `CLAUDE.md`.
- **X and external platforms**: manual, owner-gated. The `-x.md`, `-x-article.md`, and `external-*-draft.md` companions exist so publishing is copy-paste. Always set the canonical URL on the external platform to the three.ws post.

## Adding a new post, end to end

1. Create the post from an existing one:

   ```bash
   cp blog/three-ws-quicknode-startup-program.html blog/my-new-post.html
   ```

   Rewrite the `<title>`, description, keywords, canonical URL, OG and Twitter tags, the `.post-date` (today, `YYYY-MM-DD`), the `.post-tag` chips, the `<h1>`, and the article body. Delete the copied JSON-LD `<script type="application/ld+json">` blocks; the injector regenerates them from your new head.

2. Add a card for the post at the top of the `bl-list` in `blog/index.html` (copy an existing `li.bl-item`, keep date, tags, title, and summary consistent with the post head).

3. Run the SEO injector so the JSON-LD lands and `data/pages.json` registers the post:

   ```bash
   node scripts/inject-blog-seo.mjs --write
   ```

4. Add an entry to `data/changelog.json` (holder-readable title and summary, `"link": "/blog/my-new-post"`), then validate and regenerate the changelog outputs:

   ```bash
   npm run build:pages
   ```

5. Verify locally:

   ```bash
   npm run dev
   # open http://localhost:3000/blog/my-new-post and http://localhost:3000/blog
   ```

   Check the nav and footer hydrate, all links resolve, and the index card points at the right slug.

6. Optionally add the post to `data/rss/items.json` if it should reach RSS subscribers.

7. Ship: commit, then deploy per the runbook (`npm run deploy:gcp:full` from a clean worktree; deploys are owner-approved). No `vercel.json` change is needed.

If the post ships with data, publish the dataset as `blog/<slug>.json` and link it from the article; if it charts a series at runtime, fetch it with a root-relative path (`/blog/<slug>-series.json`) so it works in dev and production alike.

## Related

- `STRUCTURE.md`: maps this and every other product surface.
- `data/pages.json`: the registered page list this directory feeds.
- `scripts/inject-blog-seo.mjs`: the automation described above.
- `api/rss/announcements.js` and `data/rss/items.json`: the RSS pipeline.
- `docs/ops/gcp-production.md`: the deploy runbook.
