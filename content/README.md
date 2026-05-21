# Content Schedule

Outbound social schedule for the three.ws @ X account. Two feature announcements per day, with big-news posts overriding feature slots when news drops.

## Files

| File                  | Purpose                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| `x-schedule.json`     | Source of truth. Structured calendar of posts (id, date, slot, kind, topic, link, post, status).         |
| `x-schedule.md`       | Human-readable calendar view of the same data. Edit either; keep them in sync.                           |
| `README.md`           | This file. Voice rules, slot conventions, big-news override flow.                                        |

## Cadence

- **2 posts / day**: morning slot (`AM`, ~09:00 PT) and afternoon slot (`PM`, ~17:00 PT).
- **30-day rolling window**: the schedule covers 60 feature slots (one per shipped feature). When the queue is exhausted, refill from `x-schedule.json` with newly shipped features.
- **Big news overrides**: when news lands (marketplace listing, partnership, major release), bump that day's `AM` feature into the next open slot and post the news entry from the `big_news_queue` instead. Update statuses in the JSON.

## Voice rules

These are non-negotiable — match the existing blog posts and README tone.

- **No emojis.** Ever. Same rule as `CLAUDE.md`.
- **No hashtag spam.** At most one (and usually zero). Project hashtags only when they materially help discovery.
- **Lead with the feature or fact, not the hype.** First line carries the whole post if the reader bounces.
- **Concrete > abstract.** Name the route (`three.ws/x402`), the spec (`EIP-7710`), the version (`three.js r176`). Specifics beat adjectives.
- **No mocks, no fake data, no "coming soon".** Every post links to a feature that is live in production. If it's not live, it's not in the schedule — move it to the backlog.
- **Under 280 characters.** Aim for ~250 to leave room for link preview rendering.
- **Always include a real link.** Posts without links get scrolled past.

## Big-news override flow

1. News lands (e.g. new marketplace listing approved).
2. Find the relevant entry in `big_news_queue` in `x-schedule.json`. If none exists, draft one inline.
3. Pick the next open `AM` slot (or `PM` if the news is urgent).
4. Shift the displaced feature post one slot forward.
5. Update `status` fields on both entries.
6. Mirror the change to `x-schedule.md`.

## Posting checklist

Before posting any entry:

- [ ] Link still resolves (run a HEAD request or open it).
- [ ] Text fits within 280 characters in the X composer (paste it, check the counter).
- [ ] No typos. Read it aloud once.
- [ ] If the post claims a feature is live, the feature is live right now — not "almost ready".
- [ ] After posting, set `status: "posted"` and add `posted_at` in `x-schedule.json`.

## Backlog

Newly shipped features that need a slot should be appended to `x-schedule.json` under `backlog[]`. Move them into the dated calendar when slots open up.
