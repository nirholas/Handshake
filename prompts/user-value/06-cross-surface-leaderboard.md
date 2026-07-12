# 06 — Cross-surface leaderboard + streaks

Read `prompts/user-value/_shared.md` first. It is binding. Can run concurrently with
`05-discovery-search.md`. Benefits from wave 1's creation aggregation and wave 2's activity feed
as data sources.

## Why this matters

`pages/leaderboard.html` and `pages/walk-leaderboard.html` are the only leaderboards on a
platform with dozens of competitive/economic surfaces: Agora, `/play` combat/quests, remix
royalties, pump launches. No cross-surface leaderboard, badges, or streaks exist to drive return
visits.

## Mission

Ship a cross-surface leaderboard/achievement system that gives users a reason to check rank and
come back to protect a streak.

## Tasks

1. **Audit `pages/leaderboard.html` and `pages/walk-leaderboard.html`** fully — what do they
   rank, on what data, updated how often. Determine if either can be generalized or if a new
   page is warranted.
2. **Pick real, meaningful metrics** across surfaces already producing real data: creations
   count (wave 1), remix count/royalties earned, launches, follower count (wave 2 if shipped),
   `/play`/`/walk` activity (existing `walk-leaderboard` data). Don't invent a vanity metric with
   no underlying data — every leaderboard column must be backed by a real query.
3. **Streaks.** A daily-activity streak counter (any qualifying action: creation, login,
   `/play` session — define "qualifying" precisely and document it) stored per user, displayed
   on their profile (`01-creator-profile.md`) and visible platform-wide (e.g. in nav or on
   login).
4. **Badges/achievements.** A small, real set (not padded) tied to genuine milestones: first
   creation, first remix received, 7-day streak, top-10 leaderboard placement. Store as
   real earned records, not computed-on-the-fly fake trophies. Display on the profile.
5. **UI.** A unified leaderboard page with tabs per metric/surface, real-time-ish rank, and the
   user's own rank highlighted even if off-screen ("you're #142").
6. **Update cadence.** Match whatever refresh pattern is realistic given the data source (some
   metrics may only need daily rollups — say so and implement a real scheduled rollup only if
   the codebase already has a cron/worker pattern to hook into; don't invent new infra for this
   pack, reuse what exists).

## Done checklist

- [ ] Leaderboard shows real users ranked by a real, verifiable metric.
- [ ] A test account performing a qualifying action visibly moves rank or extends a streak.
- [ ] At least one badge is genuinely earnable and displayed on the profile.
- [ ] Report which metrics were included and which were considered but rejected for lacking
      real data.
