# Agent Spotlight

[**`/spotlight`**](https://three.ws/spotlight) is the three.ws community
showcase. [`/agents`](https://three.ws/agents) is the directory: every agent
anyone ever registered, which is thousands of rows and most of them still wearing
the onboarding default name. The spotlight is the other half of that, the curated
layer where a person says what an agent is for and the community votes on whether
they were right.

An entry is a **pitch attached to a live agent**, never a copy of it. The entry
stores a headline, a one-liner, an optional write-up, a category, up to six tags
and an optional demo link. Everything else on the card (the agent's name,
description, skills, avatar, on-chain identity, conversation count and builder)
is read from `agent_identities` on every request. Rename your agent, swap its
avatar, register it on-chain: the card updates with it, and there is no stale
copy to go wrong.

## Submitting

1. Make the agent public. Private agents are excluded: the showcase links
   straight to `/agents/<id>` and an entry a visitor cannot open is worse than
   no entry.
2. Open `/spotlight`, click **Showcase your agent**, and pick it from the
   dropdown. Only your own public agents that are not already showcased appear.
3. Write the headline (3 to 90 characters) and the one-liner (10 to 160). The
   one-liner is pre-filled from the agent's own description so you are editing
   rather than starting from nothing.
4. Optional: a write-up of up to 4,000 characters, a demo link, and tags.

**One entry per agent.** Submitting again for the same agent edits the entry you
already have; it never creates a second card. You can remove your own entry at
any time, and so can the agent's owner if someone else wrote it up.

## Ranking

Three sorts share one page.

| Sort | What it orders by |
| --- | --- |
| **Trending** (default) | Upvotes with time decay, so new work is visible |
| **Newest** | Publication time |
| **Most upvoted** | Raw upvote count, all time |

Trending decays with age:

```
score = (upvotes + 1) / (age_in_days + 1) ^ 1.2
```

Two things about that formula are deliberate.

The `+ 1` in the numerator means an entry published five minutes ago with no
votes still scores `1.0` and lands on the first page, so the newest submission is
seen at all rather than buried under whatever was already popular.

The clock runs in **days**, not hours. The hour-scaled version of this curve that
every ranked feed copies from Hacker News assumes enough vote volume that a good
post gains score faster than it loses it inside a day. At this surface's volume
it does not: that curve puts a 24-hour-old entry at about 2% of a fresh one, so
any brand-new empty entry outranks a week-old entry everybody liked, and
"trending" quietly becomes "newest". On the day scale a day-old entry still
carries a bit under half the weight of a fresh one, a week-old entry with twenty
upvotes stays above a fresh empty one, and a month-old entry finally rotates off
the front page. That is the behaviour a showcase wants: durable good work near
the top, always room for the newest.

The formula lives in one place,
[`trendingScore()` in `api/_lib/showcase-store.js`](../api/_lib/showcase-store.js),
and the SQL `ORDER BY` computes the identical expression so the server never
disagrees with its own documentation.

One upvote per account per entry, and voting again removes it. Votes are counted
on read rather than stored as a running total, so a lost write can never leave a
counter permanently wrong.

## Curated entries

Some entries carry a **Curated** badge. Those were written by three.ws about
someone else's public agent, and the badge exists so a visitor is never told a
builder said something they did not write. The builder is still credited from the
agent record, and the moment they submit their own write-up for that agent it
replaces the curated one and the badge goes away.

Curated entries are seeded by
[`scripts/seed-showcase.mjs`](../scripts/seed-showcase.mjs), which refuses to
attach a write-up to an agent that has since been renamed, made private, or
deleted:

```bash
node scripts/seed-showcase.mjs           # dry run, reports what would land
node scripts/seed-showcase.mjs --apply   # write the entries
```

## Categories

`trading`, `research`, `creative`, `productivity`, `developer`, `social`,
`gaming`, `commerce`, `education`, `other`. The filter rail hides empty
categories, so it shows what the community actually built rather than an
aspirational taxonomy.

## API

Public reads, no key. Writes need a session cookie and a CSRF token, exactly like
every other authenticated three.ws endpoint.

### `GET /api/showcase/list`

| Param | Default | Notes |
| --- | --- | --- |
| `sort` | `trending` | `trending`, `new`, `top` |
| `category` | none | One of the category slugs above |
| `tag` | none | Single tag |
| `q` | none | Full-text over headline, one-liner, write-up, agent name and description |
| `limit` | `24` | Max 48 |
| `offset` | `0` | Offset pagination |
| `featured` | off | `1` returns only the editor's picks |

```bash
curl -s 'https://three.ws/api/showcase/list?sort=top&limit=3' | jq '.entries[].title'
```

```json
{
  "entries": [
    {
      "id": "…",
      "title": "A sniper with no language model anywhere in the loop",
      "tagline": "It trades the conviction oracle on a fixed stake…",
      "category": "trading",
      "tags": ["solana", "autonomous", "oracle"],
      "source": "curated",
      "vote_count": 0,
      "voted_by_me": false,
      "trending_score": 1.0,
      "agent": {
        "id": "…",
        "name": "Crosshair",
        "url": "/agents/…",
        "thumbnail": "https://…/thumb/….png",
        "glb_url": "https://…/….glb",
        "chat_count": 2,
        "is_registered": true
      },
      "builder": { "name": "…", "profile_url": null }
    }
  ],
  "total": 14,
  "has_more": false
}
```

A signed-in read is personalised (`voted_by_me`) and returns
`Cache-Control: private, no-store`; an anonymous read is identical for everyone
and is CDN-cached for 30 seconds.

### `GET /api/showcase/get?id=<uuid>`

One entry, in the same shape, plus a view count bump.

### `GET /api/showcase/categories`

Per-category counts plus the headline totals the hero renders
(`{ entries, builders, votes }`).

### `GET /api/showcase/eligible`

Session required. The caller's public agents that are not already showcased,
plus the category list, which is what the submission form is built from.

### `POST /api/showcase/submit`

Session + CSRF. Body:

```json
{
  "agentId": "uuid of an agent you own",
  "title": "3 to 90 characters",
  "tagline": "10 to 160 characters",
  "story": "up to 4000 characters, optional",
  "demoUrl": "https://… (http or https only, optional)",
  "category": "trading",
  "tags": ["solana", "autonomous"]
}
```

Returns the created or updated entry. `403` if the agent is not yours, `409` if
it is not public.

### `POST /api/showcase/vote`

Session + CSRF. Body `{ "id": "<entry uuid>" }`. Toggles, and returns the
server-confirmed state so the button never settles on an optimistic guess:

```json
{ "voted": true, "vote_count": 12 }
```

### `POST /api/showcase/remove`

Session + CSRF. Body `{ "id": "<entry uuid>" }`. Soft-deletes the entry. Allowed
for the submitter and for the agent's owner.

## Where the code lives

| Piece | File |
| --- | --- |
| Page shell | [`pages/spotlight.html`](../pages/spotlight.html) |
| Controller | [`src/spotlight.js`](../src/spotlight.js) |
| Styles | [`src/spotlight.css`](../src/spotlight.css) |
| HTTP boundary | [`api/showcase/[action].js`](../api/showcase/[action].js) |
| Queries + ranking | [`api/_lib/showcase-store.js`](../api/_lib/showcase-store.js) |
| Schema | `api/_lib/migrations/20260901160000_agent_showcase.sql` |
| Curated seed | [`scripts/seed-showcase.mjs`](../scripts/seed-showcase.mjs) |

## Related

- [Agents Index](https://three.ws/agents), the full directory
- [Marketplace](https://three.ws/marketplace), where agents are bought and forked
- [Agent Studio](agent-studio.md), for building the agent you are about to showcase
