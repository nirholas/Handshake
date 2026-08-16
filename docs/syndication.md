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

## Feed URLs and sources

`https://three.ws/rss/announcements.xml` and the shorter
`https://three.ws/rss.xml` serve the same feed. Both accept one optional
query parameter, `source`, which selects what the feed is built from:

| `?source=` | Feed contents |
| --- | --- |
| omitted, or `curated` | The hand-edited items in `data/rss/items.json`. This is what HackerNoon and every public subscriber reads. |
| `trythreews` | Announcements archived from [@trythreews](https://x.com/trythreews). |
| `nichxbt` | Announcements archived from [@nichxbt](https://x.com/nichxbt). |
| `archive` | Both archived accounts, merged and de-duplicated, newest first. |

The value is case-insensitive. Anything else is a `400` with
`{"error":"unknown_source"}` rather than a silent fall-back to the
curated feed, so a subscriber who mistypes a source finds out instead of
quietly receiving a different feed forever. Responses are cached for ten
minutes at the edge and are `application/rss+xml`; the endpoint is
read-only and answers `GET`, `HEAD`, and `OPTIONS` only.

Fetch it from anywhere:

```bash
curl -s 'https://three.ws/rss/announcements.xml' | xmllint --noout - && echo 'valid feed'
```

### Why feed validity is load-bearing

XML has no partial failure: one illegal byte anywhere in the document
makes the *whole* feed unreadable, so a single bad post takes every
subscriber offline rather than dropping one item. The builder in
[`api/_lib/rss-feed.js`](../api/_lib/rss-feed.js) therefore neutralizes
the three inputs that can do that, and
[`tests/rss-announcements.test.js`](../tests/rss-announcements.test.js)
pins each one:

- **A `]]>` inside an item body**, which would close the `CDATA` section
  early. It is re-emitted across two sections so it survives as text.
- **Characters XML 1.0 forbids** (control bytes other than tab, newline
  and carriage return; unpaired surrogates). Escaping cannot rescue
  these, so they are dropped. Real astral characters and emoji are kept.
- **Prose that spells the linkifier's internal URL placeholder.** The
  placeholder is a form escaped text cannot contain, so a post can never
  be mistaken for a link the builder set aside.

Editing `data/rss/items.json` by hand is safe against all three, but run
the `curl | xmllint` check above after a deploy that touches the feed.

## HackerNoon

HackerNoon is one of the world's largest independent tech publications.
Their importer auto-pulls from `https://three.ws/rss/announcements.xml`,
so any item added to the feed is picked up on their next crawl with a
canonical URL pointing back to `three.ws/news/<slug>`. Nothing to
configure on our side beyond keeping the feed valid.

See also: [Partners](./partners.md), [Listings and
distribution](./listings.md).
