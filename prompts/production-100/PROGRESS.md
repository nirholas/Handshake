# production-100 progress log

The only memory between chats for this pack. Append, never rewrite. Newest at the bottom.

Format:

```
## <date>: <order name, or "map">
Measured: <the numbers you read, with the command>
Did: <what shipped, with commit SHAs>
Left: <exactly what remains, who owns it, and which follow-up file or OWNER-ACTIONS row carries it>
```

Orders run from other packs log in THEIR pack's `PROGRESS.md`; this file carries only this
pack's four orders, ship-readiness runs, and map-level changes (rows added to
[OWNER-ACTIONS.md](OWNER-ACTIONS.md), orders retired from [00-INDEX.md](00-INDEX.md)).

---

## 2026-08-09: pack created

Measured: production at `c1e600a04` (2026-08-07 build) vs `main` at `e5ad85478`;
`/event` and `/event.json` 404 on the live site with the event window configured for
2026-08-09 17:00 UTC; the dry-run reclaim path in `api/_lib/economy-sweepback.js` still
returns its plan before key recovery; `/play/war` vite input now exists (that gap closed
since the event preflight noted it, so no order was written for it).

Did: authored the map (00-INDEX), the four pack orders (01 ship readiness, 02 stranded
wallets, 03 master key hygiene, 04 mixed verdicts), OWNER-ACTIONS with 13 rows, and the
event closeout order in the event pack. Existing packs were indexed, not duplicated: every
open order there was already sized for a single agent chat.

Left: everything; the map is the queue. The most time-critical row is OWNER-ACTIONS row 1
(the deploy) with the event window hours away.

## 2026-08-09: 01 ship-readiness (first run: shipped and verified)

Measured: prod was at c1e600a04 (2026-08-07) with every event surface 404; main
at a81f2701a and moving. Gate red on audit:docs (an unregistered recap draft)
and token drift (5 hardcoded hexes). Committed changelog feeds were stale
against data/changelog.json.

Did: fixed both gate reds, regenerated the eight feed outputs, stripped 17
banned dashes from data/pages.json, built clean at pinned 4a748fbde
(BUILD_EXIT 0, all 691 pages resolve), ran deploy-preflight (all PASS; its one
blocker, a deterministic /api/locale 404 in e2e, root-caused to the dev server
proxying /api to stale production, proven by running the handler standalone:
200 with the namespace), submitted Cloud Build 015cc079 (SUCCESS, 22m37s,
revision 00365), purged the CDN synchronously, and verified: a concurrent
agent's build superseded mine minutes later as revision 00366 at 2841ab5df,
which contains my commits (ancestry verified), so production is CURRENT.
/event 200, event.json serving, /api/locale 200, fact-check benchmark
ran:true source:database, smoke:prod all 691 pages green. Vitest 19027/19027
green; the only e2e failures were the stale-prod proxy artifact above.
Also cleared fix-queue 02 (lint) and retired its file.

Left: this order stands (it retires only at campaign end). OWNER-ACTIONS row 1
(the deploy) is satisfied for today; the event window 17:00-19:30 UTC is armed
on production ahead of time.
