# EV-08: Event closeout: freeze the standings, hand off the winners, recap

**How to run this:** paste this whole file into a fresh Claude Code chat opened in
`/workspaces/three.ws`, or say "execute `prompts/event/08-event-closeout.md`". Read
[00-CONTEXT.md](00-CONTEXT.md) and `CLAUDE.md` first. Run it AFTER the event window in
`public/event.json` has ended.

## Binding operating clause

1. Finish 100%. Never end with a question or an unexecuted plan. Delete this file when the
   definition of done is verified and log in [PROGRESS.md](PROGRESS.md); any remainder gets
   a follow-up file or an OWNER-ACTIONS row in
   [../production-100/OWNER-ACTIONS.md](../production-100/OWNER-ACTIONS.md) first.
2. **No prize is ever paid by code** (order 04's rule stands). Winner settlement is the
   owner's; your job is a frozen, durable, correct standings record and the recap.
3. Hard rules: no mocks, explicit-path commits, no em-dash characters.

## Why this order exists

The leaderboard is a Redis hash with a ONE-WEEK TTL and an in-memory fallback
(`api/_lib/event-leaderboard-store.js`). If nobody exports it, the authoritative record of
who won evaporates seven days after the event. And if the deploy never landed before the
window (the preflight's NO-GO scenario), the closeout must say so honestly rather than
report an empty event as "no participants".

## Step 0: re-derive the state

```bash
curl -s https://three.ws/api/version                       # did the event ever ship?
curl -s https://three.ws/event.json | head -c 600           # the window that actually ran
curl -s "https://three.ws/api/play/event-leaderboard" | head -c 3000
git log --oneline -5 -- public/event.json                   # was the window moved?
```

Decide which world you are in: (a) the event ran on production; (b) the deploy landed late
or never, and the event effectively did not happen for visitors. Both worlds get an honest
closeout; (b) also gets a one-line OWNER-ACTIONS note proposing a rescheduled window, since
every surface is date-driven from `public/event.json` and re-running it is config, not code.

## Tasks

1. **Freeze the standings durably.** Read the full leaderboard through the real API and
   persist it where event history already lives server-side (`app_settings` keyed by the
   event id, following the existing store's shapes). Only rank, display name, runs, and
   score cross; account keys never do. If a snapshot mechanism already exists in the store,
   use it; do not build a parallel one.
2. **Verify the ended states.** In a real browser: `/event` shows its designed ended state,
   the countdown surfaces are unmounted, the in-world event tab behaves per its ended
   contract (visible only while a standing exists), and no event job is acceptable
   (`pruneClosedEventRuns` did its job). Any violation is a defect: fix it now.
3. **Winner handoff.** Write the top standings, the souvenir grant count, and the peak
   population read into a short owner brief appended to [PROGRESS.md](PROGRESS.md), and add
   one OWNER-ACTIONS row: announce winners and settle prizes from the board.
4. **Recap the event for holders.** One `data/changelog.json` entry (plain language: what
   happened, how many joined, what was dropped). If the owner wants a longer recap doc it
   goes in `docs/`; the changelog entry is the mandatory piece.
5. **Retire the pack.** With the closeout done, verify each remaining numbered order in this
   pack against its deliverables (the retirement policy in [../README.md](../README.md)) and
   delete the ones that are verifiably shipped, logging each in [PROGRESS.md](PROGRESS.md).
   The pack's PROGRESS and context files stay until the whole pack retires.

## Definition of done

- [ ] Standings snapshot persisted server-side and readable after Redis TTL expiry (prove by
      reading through the persisted path, not the hash).
- [ ] Ended states verified in a browser; defects found are fixed, not filed.
- [ ] OWNER-ACTIONS row for winner settlement; recap changelog entry written and validated
      by `npm run build:pages`.
- [ ] Shipped orders in this pack retired per policy; outcomes logged; this file deleted.

## Never blocked

| Blocker | Resolution |
|---|---|
| The deploy never landed and the boards are empty | That IS the closeout: record world (b) honestly in PROGRESS, propose the reschedule row, verify the surfaces still fail closed, and retire what genuinely shipped. |
| Redis unreachable from here | The API read path is the contract; if production answers, snapshot from it. If production is down, that is a `gcp-triage` matter first. |
| TTL already expired before you ran | Say so plainly in the brief; check `app_settings` and the game server logs for any partial record; never reconstruct numbers you cannot source. |

## Report format

Which world (a/b), the frozen top standings, souvenir and population figures with their
sources, the changelog entry text, which pack files were retired, and the single owner ask.
