# News-feed syndication

Every news post saved through `/admin/news` can mirror to multiple
external publishers automatically. Targets that need credentials are
silently skipped until you set their env var.

| Target | Needs key | Behavior |
|---|---|---|
| **WebSub** (PubSubHubbub) | No | Pinged on every save. RSS subscribers using a WebSub-aware reader get instant updates. |
| **Dev.to** | `DEV_TO_API_KEY` | Creates a new article on first save, updates on later saves (Dev.to tracks the article ID). Canonical URL points back to `three.ws/news/<slug>` so Google attributes the rank to three.ws. |
| **Medium** | `MEDIUM_INTEGRATION_TOKEN` | Creates a new post on first save. **Medium's API is create-only** — later edits do not propagate. Canonical URL points back to three.ws. |
| **CoinMarketCap** | No (manual) | The admin's "Copy for CMC…" button generates a markdown block for paste into CMC's manual publishing flow. |
| **HackerNoon** | No | Auto-imports from `https://three.ws/rss/announcements.xml` — see [HackerNoon setup](#hackernoon) below. |

## Setup

### Dev.to

1. Sign in to [dev.to](https://dev.to).
2. Open **Settings → Extensions** (`https://dev.to/settings/extensions`).
3. Scroll to **DEV Community API Keys** and click **Generate API Key**.
4. Copy the key and set `DEV_TO_API_KEY=<key>` in your env.
5. Save a news post in `/admin/news` — the **Syndication** panel should
   flip from `skipped` to `published` with a link to the live article.

### Medium

1. Sign in to [Medium](https://medium.com).
2. Open **Settings → Security and apps** (`https://medium.com/me/settings/security`).
3. Scroll to **Integration tokens**, enter a description, click **Get integration token**.
4. Set `MEDIUM_INTEGRATION_TOKEN=<token>` in your env.
5. (Optional) Set `MEDIUM_AUTHOR_ID=<id>` if you want to skip the
   auto-discovery `/v1/me` call. Otherwise the syndicator fetches your
   author ID on first use and caches it for the running server's warm lifetime.

> **Note:** Medium's API has been deprecated for *new* accounts since
> 2024. If your integration-token request returns "Access denied", the
> Medium target stays skipped — there's nothing to fix on the three.ws
> side. Older accounts with API access enabled continue to work.

### CoinMarketCap

CMC has no public publish API. The admin gives you a one-click handoff:

1. Open the post in `/admin/news`.
2. Click **Copy for CMC…** in the Syndication panel.
3. Paste into CMC's manual publish form.

The generated block is plain markdown: title, summary blockquote, body
(with `**bold**`, links, lists), and a "Originally published at
three.ws/news/<slug>" footer for canonical attribution.

### HackerNoon

HackerNoon's RSS auto-import is the cleanest path — no per-post action
needed.

1. Sign in to [hackernoon.com](https://hackernoon.com) and reach **Edit Profile** (top-right avatar menu).
2. Open **Settings → Auto Import**.
3. Paste `https://three.ws/rss/announcements.xml` as your feed URL.
4. HackerNoon polls the feed roughly every hour and pulls every new
   item into your drafts. You can edit / promote each draft before it
   publishes.
5. To claim the author profile that auto-imports create under, follow
   HackerNoon's "Author Profile Claim" flow (Settings → Profile →
   Verify Author).

### WebSub (no setup)

The RSS channel already advertises `<atom:link rel="hub" href="https://pubsubhubbub.appspot.com"/>`.
Compatible readers subscribe via the hub instead of polling, so they
get push notifications when items.json changes.

The admin pings the hub on every save. No env var needed.

## Resyndicate / one-off

The Syndication panel in `/admin/news` exposes a **Re-syndicate now**
button per post. It re-runs every target (skipping Medium for
already-published posts since there's no update endpoint).

The same endpoint is exposed as `POST /api/admin/news/resyndicate`
with body `{ "id": "<post-id>" }` — useful for scripting or one-off
batch runs.

## What gets stored

After a syndication run, the resulting URLs and IDs are written back
into `data/rss/items.json` under a `syndication` field on the item:

```json
{
  "id": "live-on-alibaba-cloud-marketplace",
  "title": "…",
  "syndication": {
    "websub":  { "status": "pinged",    "published_at": "2026-05-17T02:31:36.889Z" },
    "devto":   { "status": "published", "id": 1234567, "url": "https://dev.to/…", "published_at": "…" },
    "medium":  { "status": "skipped",   "reason": "MEDIUM_INTEGRATION_TOKEN not set" }
  }
}
```

Dev.to uses the `id` on the next save to update the same post in
place. Medium has no update endpoint — once published it stays
published; re-saves on three.ws do not re-publish.

## Local-only

`/admin/news` only runs on `localhost` or when `NODE_ENV !== 'production'`.
In production — three.ws runs on Google Cloud Run (see
[the ops runbook](./ops/gcp-production.md)) — it refuses outright, because
the container filesystem is ephemeral, so writes would never persist. Saves
write to `data/rss/items.json` on disk; to publish, commit + push and let the
next production deploy (`npm run build && npm run deploy:gcp`) serve the
updated feed.
