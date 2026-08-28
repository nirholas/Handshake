# The ship log: release notes joined to the code that shipped them

Every project keeps two records of the same work.

The **commit log** is complete and unreadable. The **changelog** is readable and incomplete. On three.ws both are published, both are pushed to the holder Telegram channel, and until now neither knew the other existed. The same afternoon's work reached the same channel twice, in two voices, with nothing saying it was the same work.

The ship log is the join. Live at **[three.ws/ship](https://three.ws/ship)**, served as data at **[/api/ship/feed](https://three.ws/api/ship/feed)**, and computed by an open-source package, **[@three-ws/shipfeed](../packages/shipfeed/README.md)**, that works on any repository.

It answers two questions no changelog and no `git log` can answer alone:

1. **Which commits produced this release note?**
2. **What shipped that nobody ever wrote up?**

---

## How it works

```
GitHub /repos/nirholas/three.ws/commits        public/changelog.json
   (through fetchUpstream: deadline,             (baked into the running
    retry, breaker, last-good)                    image by every deploy)
              │                                          │
              └──────────────┬───────────────────────────┘
                             ▼
                    @three-ws/shipfeed
       parse ──▶ classify ──▶ link ──▶ group ──▶ render
                             │
              ┌──────────────┼───────────────────────┐
              ▼              ▼                       ▼
        /api/ship/feed    /ship page        the holder Telegram lanes
       (JSON, MD, RSS)                   (provenance footer + noise filter)
```

### 1. Parse

Full Conventional Commits 1.0.0, plus revert subjects, GitHub's merge subjects, and git trailers. `feat(resilience): ...` becomes a headline a reader can parse ("Feature · resilience") instead of the raw type prefix the commit feed used to print. A subject that follows the older `Avatar Studio: 122 sliders` house style keeps that convention; a subject with no convention at all is reported honestly rather than mangled.

### 2. Classify

Each commit gets an **audience** and a **signal** score from 0 to 1, with a reason attached to every point:

| audience | who it is for |
| --- | --- |
| `holder` | someone who uses or owns a piece of the product |
| `developer` | someone who builds against it |
| `internal` | someone who works on it |

Merge commits, `chore(deps):` bumps, and lockfile-only changes come back `noise: true`.

### 3. Link

Provenance without metadata. A `Changelog: <slug>` trailer in the commit always wins, and almost no commit has one, so the fallback has to earn its answer from four signals:

1. **A time window.** A release note is written the day its work lands, so only commits within `windowDays` (default 4, plus one day of lead) are candidates.
2. **IDF-weighted term overlap.** Shared rare words ("meshopt", "settle", "fingerspelling") carry weight; shared common ones ("agent", "the", "fix") carry almost none. The similarity blends how much of the entry a commit covers with how much of the commit the entry contains, so a one-line commit can still explain a paragraph.
3. **Tag agreement.** An entry tagged `fix` prefers a `fix:` commit.
4. **Proximity.** Same-day work outranks work three days out.

A commit belongs to at most one entry; an entry may claim many. On this repository the default threshold (0.26) links roughly two thirds of visible commits, and the reasons behind every link are published with it.

### 4. Group

Everything unclaimed is clustered into **ships**: bursts of commits separated by 90 minutes of quiet, each headlined by its own strongest commit. That section is the interesting one. It is the work that shipped and was never announced.

---

## The page

**[three.ws/ship](https://three.ws/ship)** renders the whole feed:

- four live counters (commits read, release notes, percentage linked to code, unannounced work) and a daily-commit sparkline
- an audience filter: everything, developers, or product news only
- every release note with its commits folded underneath, each showing its short sha, headline, audience, and a `why 41%` control that expands the exact reasons the link was made
- an **Unannounced** section for the ships nothing claimed

---

## The API

### `GET /api/ship/feed`

Public, no auth, cached for 5 minutes.

| param | values | default |
| --- | --- | --- |
| `limit` | 1 to 500 commits | 200 |
| `audience` | `holder`, `developer`, `internal` | `internal` (everything) |
| `format` | `json`, `markdown`, `rss` | `json` |
| `explain` | a 7 to 40 character commit sha | none |

```bash
curl -s 'https://three.ws/api/ship/feed?limit=100&audience=holder' | jq '.stats'
```

```json
{
  "commits": 100,
  "hidden": 22,
  "releases": 24,
  "linked": 53,
  "orphans": 25,
  "coverage": 0.679,
  "byAudience": { "holder": 62, "developer": 27, "internal": 11 },
  "velocity": [{ "date": "2026-08-27", "count": 61 }]
}
```

Each release carries its commits, and each linked commit carries the receipt:

```json
{
  "shortSha": "2771f41",
  "headline": "Feature · forge",
  "summary": "three more independent concept-image rungs",
  "audience": "holder",
  "signal": 0.86,
  "confidence": 0.41,
  "why": ["shared terms: painter, concept, providers", "type \"feat\" matches tag", "before the entry by 0.4d"]
}
```

### `GET /api/ship/feed?explain=<sha>`

One commit's full reasoning: every scoring rule that fired, and the release note it was attached to (or a plain statement that nothing claimed it).

```bash
curl -s 'https://three.ws/api/ship/feed?explain=65f3fe5' | jq '.classification.reasons'
```

A heuristic nobody can interrogate is a heuristic nobody should trust, which is why this endpoint exists alongside the feed.

### Feed formats

```bash
curl -s 'https://three.ws/api/ship/feed?format=markdown' > RELEASES.md
curl -s 'https://three.ws/api/ship/feed?format=rss'      # a feed reader, with commits inline
```

---

## What changed in the Telegram channel

Two lanes post to the holders' channel, and they now share this one join.

**Release announcements** (`/api/cron/changelog-push`, every 20 minutes) carry a provenance footer:

```
Update: Text-to-3D now has five independent image sources behind it

Every text-to-3D generation starts by painting a concept image...

shipped in 4 commits          ← links to the GitHub compare view for the range

three.ws/changelog/2026-08-27-text-to-3d-... · 2026-08-27 · #fix #infra
```

The footer is best-effort by design: if GitHub cannot be read at that moment, the announcement goes out without it rather than not going out.

**The raw commit feed** (`/api/cron/commit-feed-push`, every 5 minutes) reads its headline from the same parser, so a scoped commit now says "Feature · resilience" rather than "feat(resilience)", and it skips commits the classifier calls noise: merges, `chore(deps):` bumps, and lockfile-only changes. A skipped commit still advances the lane's state, so nothing is ever re-read, and the tick reports `{ posted, skipped }` so the drop is visible in the logs rather than silent.

---

## Use it on your own repository

The package is standalone and dependency-free.

```bash
npx @three-ws/shipfeed --repo your/repo --changelog https://your.site/changelog.json
npx @three-ws/shipfeed explain <sha>
npx @three-ws/shipfeed stats
npx @three-ws/shipfeed --local --markdown > RELEASES.md
```

```js
import { shipfeed } from '@three-ws/shipfeed';

const feed = await shipfeed({
	repo: 'your/repo',
	changelogUrl: 'https://your.site/changelog.json',
	productScopes: ['checkout', 'search'],
});
```

The full reference, including the linking internals exported for tuning, is in the [package README](../packages/shipfeed/README.md).

---

## Where the code lives

| Piece | File |
| --- | --- |
| The package | [packages/shipfeed/](../packages/shipfeed/README.md) |
| Feed endpoint | [api/ship/feed.js](../api/ship/feed.js) |
| Provenance for the changelog lane | [api/_lib/ship-provenance.js](../api/_lib/ship-provenance.js) |
| The page | [public/ship/index.html](../public/ship/index.html) |
| Release announcements | [api/_lib/changelog-push.js](../api/_lib/changelog-push.js) |
| Raw commit feed | [api/_lib/commit-feed-push.js](../api/_lib/commit-feed-push.js) |

## Known limits

- **GitHub's unauthenticated rate limit is 60 requests an hour per IP.** Set `GITHUB_TOKEN` on the service to raise it. Without one, a busy hour can leave the feed serving its 5-minute cache and the Telegram footer absent.
- **Linking is a heuristic, and it publishes as one.** Every link carries a confidence and its reasons; a release note that legitimately found no code says so on the page rather than silently showing nothing.
- **A commit older than the window can never be linked**, however well it matches. That is deliberate: the alternative is a note claiming work from a month it had nothing to do with.
