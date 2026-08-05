# News-feed syndication

three.ws announcements syndicate outward through the public RSS feed.
News items live in [`data/rss/items.json`](../data/rss/items.json)
(edited in the repo and shipped with a deploy), and
[`api/rss/announcements.js`](../api/rss/announcements.js) serves them at
`https://three.ws/rss/announcements.xml`. Anything that can read RSS can
mirror the feed; no per-target credentials or push integrations are
involved.

The former in-app publishing panel and its push lanes (Dev.to, Medium,
WebSub pings) were removed along with the admin surface. Historical
items in `data/rss/items.json` may still carry a `syndication` field
recording where they were mirrored at publish time; it is inert
metadata.

## HackerNoon

HackerNoon is one of the world's largest independent tech publications.
Their importer auto-pulls from `https://three.ws/rss/announcements.xml`,
so any item added to the feed is picked up on their next crawl with a
canonical URL pointing back to `three.ws/news/<slug>`. Nothing to
configure on our side beyond keeping the feed valid.

See also: [Partners](./partners.md), [Listings and
distribution](./listings.md).
