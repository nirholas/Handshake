# 07 — Guided onboarding chaining all silos

Read `prompts/user-value/_shared.md` first. It is binding. Run last, alone — this prompt ties
together everything waves 1–3 shipped (profile, feed, follow, notifications, discovery,
leaderboard), so it needs them landed to link to real destinations.

## Why this matters

`/start`, `/create`, `/create-agent`, `/create/selfie` are disconnected entry points. A new user
lands on one of them with no guided path to avatar → world → markets → launch. three.ws already
owns `tour-sdk` — a package that does exactly this kind of guided narration/tour, but only for
*other* sites. It has never been pointed at three.ws itself.

## Mission

Build a self-referential onboarding tour of three.ws using `tour-sdk`, chaining a new user
through: create an avatar → place it in/build a world → discover the markets → (optionally)
launch a coin — ending at their own new profile page (`01-creator-profile.md`) showing what they
just made.

## Tasks

1. **Audit `tour-sdk` fully.** Read its README, `curriculum.schema.json`, `examples/`, and `bin/`
   to understand its actual API: how a curriculum is authored, how a tour is invoked/embedded,
   what step types it supports (highlight, modal, wait-for-action, etc.).
2. **Audit current entry points.** Read `/start`, `/create`, `/create-agent`, `/create/selfie`
   fully. Determine what each currently does end-to-end and where a first-time user is dropped
   after each step (do they know what to do next, or are they left staring at a result page?).
3. **Author a real curriculum** using `tour-sdk`'s actual schema — not a bespoke onboarding
   flow reinventing what the SDK already does. Steps: land on `/start` → generate first avatar
   (existing forge flow) → place it in a starter world/diorama (existing Scene Studio flow) →
   visit `/markets` and see it's tied to `$THREE`/real market data → visit their new profile
   (wave 1) and see their first creation listed → (optional branch) try a coin launch flow with
   a clear "skip" if the user isn't ready for that step.
4. **Wire tour triggers.** Auto-start for genuinely new accounts (first login, zero creations —
   check via wave 1's aggregation endpoint), with a persistent, easy-to-find "replay tour" entry
   point for returning users (don't force it on every visit — that's the fastest way to make
   users hate it).
5. **Connect the dots visually.** At each handoff point (avatar done → now build a world), the
   tour should explicitly state what was just accomplished and why the next step matters —
   this is the "why" that's currently missing between the platform's siloed pages.
6. **Track completion.** Record tour progress/completion per user (reuse wave 1/2's storage
   patterns, don't invent a new table if an existing "user state" table can hold a column).

## Done checklist

- [ ] A genuinely new test account, on first login, is offered the tour (not force-started
      inescapably) and can complete avatar → world → markets → profile end to end.
- [ ] Each step uses the platform's real existing flows — no simplified/fake versions built
      just for the tour.
- [ ] "Replay tour" is reachable from a real nav location for existing users.
- [ ] `tour-sdk`'s actual curriculum format was used, not a parallel bespoke implementation —
      report confirms this or explains why the SDK genuinely couldn't fit.
- [ ] Report the drop-off points found in task 2 and how each was addressed.
