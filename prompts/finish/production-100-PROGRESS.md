# production-100 progress log

The only memory between chats for this pack. Append, never rewrite. Newest at the bottom.

Format:

```
## <date>: <order name, or "map">
Measured: <the numbers you read, with the command>
Did: <what shipped, with commit SHAs>
Left: <exactly what remains, who owns it, and which follow-up file or OWNER-ACTIONS row carries it>
```

Orders run from other packs log in THEIR pack's `production-100-PROGRESS.md`; this file carries only this
pack's four orders, ship-readiness runs, and map-level changes (rows added to
[OWNER-ACTIONS.md](production-100-OWNER-ACTIONS.md), orders retired from [00-INDEX.md](production-100-00-INDEX.md)).

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

## 2026-09-01: map (retirement sweep across every pack)

Measured: production `ad7b54c16` (2026-08-28 build, revision 00404) vs `main` `73c8ccbb7`,
107 commits behind (`git log ad7b54c16..main --oneline | wc -l`); `smoke:prod` exit 1 with
seven deploy-lag 404s; healthz `x402_settle` down (`cause: sponsor_floor`), `agent_index`
down, `helius` and `sniper` degraded; benchmark live from the database (40%, 2026-08-10);
`gcloud` auth dead; `npm run audit:docs` clean. Every open work order in the repo (58 numbered
files across the packs plus the 157 swarm files and the 8 briefs then under `docs/openai-pr/`)
was re-verified line by line against code, git history and the live site by eight read-only
verification passes.

Did: retired the verified-shipped orders (event 01/03/04/05/07 in `38812511e`, backlog
02/03/04/06 in `c50037d79`, the fable-audit index folded into RESIDUALS in `20c381d92`, the
OpenAI pack moved to `prompts/openai-pr/` with briefs 01 to 05 deleted in `09bfbb1b5`);
rewrote event 08 to its recoverable remainder; wrote backlog 11 for the `agent_index` outage
that nothing owned; rewrote the map in 00-INDEX from the measured verdicts; refreshed
OWNER-ACTIONS (deleted the self-expired row, corrected rows 3, 4, 9, 10, added 13 to 17).

Left: three verified-retirable files wait on the commit gate (row 14); everything else in
the map is open for the measured reason next to it. The "Definition of 100%" now excludes
`masters/` from line 1, since those prompts never retire by design.

Addendum, same day: the swarm-100 probe finished after the map was first rewritten. Section J
now carries its numbers (56 of 151 routes mechanically clean, 95 with a measured defect,
none retirable on mechanical evidence) and the state of the four sweeps and the roadmap
slice. Probe artifacts stayed in the session scratchpad; the reproducible method is in
`docs/ops/swarm-100-audit.md`.

## 2026-09-02: OWNER-ACTIONS re-measured, and the audit that would have lied about row 3

Measured, not carried over: production still `ad7b54c16` (2026-08-28, revision 00404-ph7)
against a `main` that has moved to **143 commits ahead** (`git rev-list --count
ad7b54c16..HEAD`); healthz `x402_settle` down at 5.9% (3 of 51 paid attempts, 3 hours,
`cause: sponsor_floor`, 329 `no_solana_accept`) with the sponsor wallet holding
**0.001568 SOL** read straight off mainnet `getBalance`; `gcloud run services list` still
refusing with "Reauthentication failed. cannot prompt during non-interactive execution";
the `three-ws` GitHub organization and its `examples` repository both 404; the x402
discovery endpoint live with 100 resources; the testnet deployer
`0x1C4918894dfA5eE11cfF9629B458b5169Cfa3871` present in `contracts/.env` at balance 0,
nonce 0.

Found and fixed a defect that would have made row 3 worse than unanswered. Running
`scripts/audit-custodial-key-health.mjs` here, where `.env.local` carries only
`DATABASE_URL`, produced a fully confident report: **725 of 725 wallets undecryptable,
8.57 SOL stranded, 7.29 SOL of it customer money**, followed by the escalation banner. Every
number was an artifact of the script having no decryption key at all, and it is off by more
than an order of magnitude from the real incident (8 wallets, 0.49 SOL). It is the same
class of false certainty the script already guards against for unread balances. The audit
now calls `secretBoxKeyCandidates()` before it touches the database and exits 3 with the
places to find the key when the list is empty, and when a key is configured but opens
nothing it says a fleet-wide 100% failure is one wrong key rather than a mass customer
incident (`3a8000267`). `scripts/gcp-triage.mjs` skips on the structured error code instead
of matching prose, and `docs/ops/wallet-key-migration.md` records the blind spot beside the
two it already documents (`7335810ec`).

Did: rewrote rows 1, 2, 3, 8, 9, 15 and 16 of OWNER-ACTIONS from those measurements, and
put row 18 back in numeric order. Three premises had rotted. Row 8 asked for a GitHub PAT
that nothing needs any more (the upstream pull request merged 2026-08-11) and was filed
against backlog 09, which needs nothing; it now asks for the origin registration that is
actually left, against backlog 10. Row 9 asked the owner to generate a deployer key that
already exists and named no address to fund; it now names the address, the measured gas
cost, and the retired address not to fund. Row 3 gained the finding above: the brief it
waits on cannot be written from this workspace at all, because the wallet list needs
`WALLET_ENCRYPTION_KEY` off the service env, which makes row 15 the gate on four rows.

Left: no row was cleared, because none of them is an agent's to clear. Row 15 is now the
highest-leverage one on the board.

## 2026-09-02: 02 stranded-wallet-reclaim (shipped; the decision is now the owner's)

Measured: task 1 (the lying dry run) was already fixed in `afd349790` and is pinned by
`tests/economy-reclaim-dryrun-key-gate.test.js` (48 tests green across the four sweepback
suites), so this run verified it and moved on. Production's own records carry the rest,
which is what let the brief be written without `gcloud` (row 15 is still dead):
`economy_master_ledger` holds 71,475 `inflow_failed` rows with reason
`secret_undecryptable`, all of them against exactly TWO platform wallets, Atlas #22
(`6FL9viFy2WrYMWPd3HAQA4Bxm5qxQWoQMn3T9GbcwxEB`, 0.078390963 SOL) and Echo #22
(`8u5raEaz7Qjm5hRzNxwzXiZtjTkdgQ3Co6G6S5WNxFTs`, 0.064484542 SOL), 35,736 and 35,739
attempts each, the most recent at 19:00 UTC today. `agent_custody_events` names 15 agents
that hit `wallet_key_retired` on the withdraw path in July, 14 platform bots and one
CUSTOMER: `My First Agent` (`5e05f68f-...`, `GemVS5fT958FKRe5fpgizohUYUKE8cUDueEdmB1bmXnm`,
0.250001 SOL on chain today). Fleet inventory: 725 custodial wallets, 112 platform / 613
customer.

Did: extracted the measurement into `api/_lib/custodial-key-health.js`, shared by
`scripts/audit-custodial-key-health.mjs` and a new `stranded_custody` panel on
`GET /api/ops/payment-outcomes` (snapshot-cached 6h, single-flight: 13.9s cold, 0.5s warm,
verified rendered in Chromium with no console errors). Fixed real drift in the process: the
audit carried its own ownership predicate with the house account spelled `agents@three.ws`
instead of the `three-ws@users.three.ws.local` the reclaim leg enforces in SQL, so 12
platform wallets were being filed as CUSTOMER ones in the very report that sizes the
customer obligation; `economy-sweepback.js` and the audit now share one definition. The
panel refuses to publish an unattributable total: a keyless or fleet-wide-failure reading
returns `status: unknown` with the SOL fields `null` rather than a number with a caveat.
Wrote the owner brief `docs/ops/stranded-wallets.md` (measurement, why recovery is
impossible, cost of credit vs contact vs write-off, exact commands for each), linked from
`docs/ops/README.md` and the payment-outcomes runbook. 17 new tests in
`tests/custodial-key-health.test.js`, 2 more in `tests/api/ops-endpoints.test.js`.
`npm run audit:docs` clean, `check:rules` clean on the touched paths.

Left: the DECISION, which is OWNER-ACTIONS row 3 (rewritten to point at the brief):
credit the customers (recommended), contact them first, or write the balance off. Naming
the second customer wallet needs one keyed `node scripts/audit-custodial-key-health.mjs
--json` run on a machine with `WALLET_ENCRYPTION_KEY` (row 15); the decision itself does
not wait on it. Order file deleted.
