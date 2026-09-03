# home/: cross-chat handoff log

The only memory between sessions for the three.ws Home campaign. Every agent that finishes an
order appends to it, in the same commit that deletes the order file. Read
[00-CONTEXT.md](home-00-CONTEXT.md) for the campaign's shared facts; this file is history, not
architecture.

**Append, never rewrite.** Someone else's entry is their evidence, not your draft.

---

## Format

One section per finished order, newest at the bottom:

```
## <order number>. <title> (<UTC date>)

**Shipped:** what now exists that did not before, in one paragraph.
**Measured:** the numbers, with how they were read.
**Deviations:** anything in the order file that was wrong, and what it was changed to.
**Left open:** anything not done, who owns it, and why. "Nothing" is a valid answer.
**Commits:** the SHAs.
```

---

## Campaign state

| Order | State | Finished |
|---|---|---|
| 00 CONTEXT | shared facts | n/a |
| 01 connection store | open | |
| 02 bridge runtime | open | |
| 03 API surface | open | |
| 04 agent tools | open | |
| 05 connect flow | open | |
| 06 3D home scene | open | |
| 07 floorplan editor | open | |
| 08 voice loop | open | |
| 09 Wyoming satellite | open | |
| 10 add-on relay | open | |
| 11 security | open | |
| 12 households and RBAC | open | |
| 13 observability | open | |
| 14 reliability and scale | open | |
| 15 privacy and retention | open | |
| 16 test program | open | |
| 17 a11y, i18n, mobile | open | |
| 18 docs and SDK | open | |
| 19 plans and entitlements | open | |
| 20 launch readiness | standing | |
| 21 Matter direct | horizon | |

Update the row in the same commit that retires the order. The directory shrinking is the real
ledger; this table is the readable one.

---

## Before the campaign

**2026-09-02.** The investigation and the client library landed ahead of the campaign, in commits
`480d8d7db` and `f54b124df`:

- [`docs/smart-home.md`](../../docs/smart-home.md): the open-source landscape measured from the
  GitHub API, the decision to write zero device code, the reachability constraint, and the
  verification table.
- [`packages/home-bridge/`](../../packages/home-bridge): the client library, 36 tests, verified
  against a real Home Assistant (docker `stable`, demo integration, 122 entities).
- The finding that shapes the whole campaign: Home Assistant's `intent__HassTurnOff` performs an
  **unlock** on a lock, confirmed live with a lock exposed to Assist. The gate exists because of
  it.

Nothing of that is wired into the product. Order 01 is the first order that changes that.

---

## 20. Launch readiness, run 1 (2026-09-03)

**Verdict: NO-GO.** Nineteen of the campaign's twenty build orders are still open, and the lane
was being actively built by concurrent agents *during* this run: seven lane commits landed between
the first and last command below (`c2b663cfb` through `e71b1fe1f`). Order 20 is defined to run
after the campaign is retired, so this is a baseline, not a gate result.

**What the lane actually has, measured today:** a real backend that is landing fast. Store, roles,
privacy retention and the confirmation gate under `api/_lib/home/`; endpoints under `api/home/`
(auto-mounted by `server/index.mjs` filesystem routing, so they need no `vercel.json` entry); the
`@three-ws/home-bridge` client; a new `packages/home-mcp` and `services/home-relay`; five schema
tables live on Neon; three test files (`tests/home-store.test.js`, `tests/home-roles.test.js`,
`tests/api/home-stats.test.js`).

**What it does not have:** any user-reachable surface. Zero `/home*` paths in `data/pages.json`,
zero home rows in `STRUCTURE.md`, zero e2e specs under `tests/e2e/`, no `home` block in
`/api/healthz`, no `docs/home-operations.md`. Orders 05 through 08 (connect flow, 3D scene,
floorplan, voice loop) have shipped no page, so the product-completeness, a11y, responsive and
authed-sweep criteria have nothing to run against.

**Measured:**

- Confirmation-integrity invariant: `select count(*) from home_action_log where guarded = true and
  confirmed_by is null and outcome = 'ok'` returns **0**. Vacuous: the table holds 0 rows total.
- No home tool schema exposes a confirm field. All five `HOME_TOOL_DEFS` property lists walked
  recursively: zero `confirm*` keys. The three `/confirm/i` hits are description prose.
- `npm run check:rules --base f088cf33c --head HEAD`: clean, 119 changed files.
- `node scripts/check-secrets.mjs --base f088cf33c --head HEAD`: clean, 166 changed files.
- `npm run audit:docs`: clean, 1484 markdown files.
- Production is `19906ce52`, revision `three-ws-api-00410-rkf`. Rollback target verified live:
  `three-ws-api-00409-jrz`.

**Blocking findings this run:**

1. **Two duplicate `home_connections` migrations were both applied to production Neon**
   (`20260903030000` and `20260903120000`), leaving three pairs of byte-identical indexes on the
   live database: `home_action_log_home_idx`/`_home_recent_idx`, `home_connections_user_idx`/
   `_user_live_idx`, and two UNIQUE indexes on `home_entity_grants (home_id, entity_id)`. Every
   write to those tables pays double index maintenance forever until one of each pair is dropped.
   Not fixed here on purpose: a corrective migration would race the order-01 agent still choosing
   which of the two files survives. **Owner: order 01.**
2. **`npm run gate` fails at `check:claude`:** `packages/home-mcp` and `services/home-relay` have
   no README, breaking the 100% coverage standard. **Owner: orders 04/10/18.**

**Fixed here (all pre-existing, all outside the lane, all blocking a stated go criterion):**

- `f7a97880f` The tour atlas guard shipped without unit coverage and its fixture had rotted against
  the two checks added in `f76bf58b3`, so three tests were red on correct code. Fixture repaired,
  both new guards covered.
- `6107a08bc` Five banned em-dashes in `scripts/copy-voice-models.mjs`, committed in `d2b8da8d8`.
  These would have failed the pre-push hook on the owner's next push.
- `c1eb31023` `npm run audit:tour-atlas` was failing on real committed data: 203 stops carried
  indexes from an older curriculum and the summary claimed 264 stops above a grid of 263, so
  `/tour/atlas` has been rendering duplicate and skipped stop badges in production. Renumbered with
  the exact transform the capture script uses on a partial merge. No stop was re-measured.
- `4b6a7b5c6` Changelog entry for the atlas fix.

**Not fixed, not lane-owned, reported:**

- `npm run i18n:lint`: 43432 missing keys across 80 locales. Zero are home-lane keys.
- `npm run check:cron-drift`: 4 declared crons live in production with no Cloud Scheduler job, so
  they have never fired. The lane added none of them.

**Unverifiable this run, explicitly not marked green:** every criterion that needs a shipped
surface (order 11's eleven security checks, order 14 chaos, order 16 journeys, p95 latency, heap,
alerts, axe, `audit:web`, 320/768/1440, account-deletion sweep, log scrub).

**Left open:** the campaign. Re-run this order when orders 01 to 19 are retired.
**Commits:** `f7a97880f`, `6107a08bc`, `c1eb31023`, `4b6a7b5c6`.
