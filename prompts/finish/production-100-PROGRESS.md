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

## 2026-09-04 (later pass) · OWNER-ACTIONS re-measurement: one row cleared, two freed, one premise inverted

`gcloud` answered every call in this session with no re-auth, which is the third
consecutive observation that row 15 is intermittent rather than standing. The
backlog it had been holding was drained rather than re-reported.

**Row 18 is cleared and deleted.** `MULTIPLAYER_INTERNAL_URL` was genuinely unset
(`read-service-env.mjs '^MULTIPLAYER'` matched nothing on `three-ws-api`), and the
world server answered `/population` with `ok:true` on the same query the proxy was
failing. Before setting it, the shared-secret half was checked rather than assumed:
both services resolve the HMAC through the same `HOLDER_PASS_SECRET` fallback and
their values hash identically, so turning the URL on also turns on correctly-signed
live DM and stage-tip delivery (`presence-store.js`, `stage-bridge.js`) instead of
converting those from `unconfigured` into silent 401s. Applied as a config-only
`--update-env-vars` (pre-approved in CLAUDE.md, and it merges rather than replacing
the other 60 vars). Revision `three-ws-api-00413-gbp`, same image commit
`c2148462e`, so this is not a code deploy. Verified live:
`/api/play/population` → `{"ok":true,...}`, `?by=coin` → `byCoin` present, and the
`$THREE` mint query the `/event` LIVE panel makes → `ok:true`.

**Row 3 is freed: both stranded customer wallets are now named.** The keyed audit
(`scripts/audit-custodial-key-health.mjs --json`, read-only by construction, key
pulled from Secret Manager inline and never written to disk) swept 735 custodial
wallets. Nine are sealed: two platform bots at 0.142875505 SOL and seven customer
wallets, of which only two hold anything. `GemVS5fT958FKRe5fpgizohUYUKE8cUDueEdmB1bmXnm`
(0.250001) was already known from its `wallet_key_retired` withdraw failure; the
second is `HPL1LfuTdYDwtzJDzsnrmR2ngrrQwLTQyxJszCC4DHsN`, agent
`a20829e1-6dd7-4495-9141-8f5d69be86a9`, owner `sol-4ac625e9b4d3ff8e@wallet.local`,
0.100001 SOL. Total 0.350002 SOL over exactly two accounts, matching the 2026-08-09
figure the brief carried on trust. `stranded_unread` is empty, so nothing is
unaccounted for. `docs/ops/stranded-wallets.md` now carries the completed table and
no longer tells the reader to run the audit to fill it in. The decision is
unchanged and fully informed.

**Event closeout: the log read finally ran, and it corroborates the zero-grant
finding.** `gcloud logging read` over `three-ws-multiplayer` for
`textPayload:"souvenir laurel-meetup"` at `--freshness=30d` (a window that still
reaches back past the 2026-08-09 event) returned **nothing**, against a control
query proving the service's log stream is intact and current. That is independent
of the code argument in the 2026-09-02 entry and agrees with it. The durable
Upstash `player:*` scan, which would have been the stronger source, cannot be run
from here for a reason that is not `gcloud`: the store sits behind a private VPC
SRH proxy (`10.128.15.228`) on both services, so it needs in-VPC execution, and
creating the read-only Cloud Run job to do that was refused by this environment's
tool policy. It is confirmation, not the finding.

**Row 9 was re-verified this pass, and it is accurate**, including that the
address it names is the one the key in the gitignored `contracts/.env` actually
derives to. The evidence names a third-party chain, so it falls under CLAUDE.md's
commit gate and OWNER-ACTIONS row 11, which is still open: it is reported to the
owner rather than written here. No change to what row 9 asks for.

**Rows re-confirmed unchanged.** Row 2: the settle sponsor holds 0.001507661 SOL,
down again. Row 16: `three-ws` (org) and `three-ws/examples` both still 404.

**A finding the sweep produced that was not on anyone's list.** All 794 routes
declared in `data/pages.json` were swept against production. Zero 404s, which
retires row 1's old "seven declared routes 404" phrasing outright, but six answer
**HTTP 500**: `/api/mcp` and five `.well-known/*` endpoints. Cloud Run stderr gives
the cause in one line, `ERR_MODULE_NOT_FOUND` on
`/app/services/home-relay/src/token.js`, and `/api/healthz` is 500 for the same
reason. The request log shows real traffic taking it: a `Cursor/3.9.16` MCP client
POSTing `/api/mcp` and getting 500s in a loop. A concurrent agent root-caused the
same defect independently and committed the fix (`d668ceece`, re-including
`services/` in the `.gcloudignore` allowlist, the identical failure shape as the
`agents/` and `.agents/` entries above it in that file). The fix is committed and
**not** in production, so only a deploy clears it. That is now the strongest
argument in row 1, and row 1 already carries it.

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

## 2026-09-02: the `mixed` class was unreachable by construction, not by threshold

P100-04 assumed the `mixed` verdict needed a threshold nudge. It did not. The verdict
taxonomy has four classes and the stance vocabulary had three (`supports`, `contradicts`,
`neutral`), and the stance rubric told the model outright that when content "affirms one
[assertion] while refuting another", it must "choose the stance for the assertion the
content speaks to most directly". Every mixed fixture is a partial truth ("Napoleon was
unusually short", "carrots give significantly better night vision") whose sources AGREE
with each other that the claim is half right. Collapsed onto one side, they produce a
near-unanimous `contradicts` distribution, which `computeVerdict` read correctly as
`contradicted`. Both published runs show it: mixed to contradicted, 7 of 10, twice. The
`mixed` branch was defined as inter-source DISAGREEMENT while the class it had to predict
is intra-source QUALIFICATION, so no threshold reaches it.

Fixed by adding `partial` as a fourth stance and making `computeVerdict` count its weight
as stance-bearing evidence that takes neither side. With zero `partial` sources the
function's output is identical to the old one, which is the anti-seesaw guarantee, pinned
by `tests/api/fact-check-verdict.test.js`.

Found a second defect while measuring, and it is the one that matters for trust in the
number. Two live free-lane checks on 2026-09-02 came back `insufficient` with every stance
`neutral`, every excerpt the raw search snippet, real LLM tokens spent, and nothing marked
degraded: "A tomato is a vegetable." resolved as unengaged evidence while holding
*Nix v. Hedden*, the Supreme Court case that settles it. Both LLM stages extracted their
JSON with a NON-GREEDY `/\[[\s\S]*?\]/`, so they stopped at the first `]` in the response.
A reasoning block, a code fence, or a `[1]` citation truncated the match, the stage fell
back to all-neutral, and it said nothing. That fabricated verdict was scored by the
accuracy benchmark as real, was invisible to the degraded-run guard that exists precisely
to catch this, and was written into the 7-day cache. The same fault collapsed the three
search angles to one on every check. `extractJsonArray` now scans for a balanced,
string-literal-aware array of the shape the caller asked for, and an unreadable answer
reports `stance extraction unreadable` / `query generation unreadable` instead of a silent
`insufficient`.

Did: the stance vocabulary, the verdict weighting, the response reader, the degradation
contract, `docs/fact-check.md`, `agents/fact-checker/README.md`, and two changelog
entries. 70 tests green across the four fact-check suites, `check:rules` clean on the
touched paths. The full `npx vitest run` is 26,965 passing with 17 failures in 13 files,
none of them fact-check (3d-studio, branding, cron-scheduler-sync, x402-discovery-parity,
glb-quality, oracle-calibrate-cron, rate-limit-buckets, asset-host-liveness,
deploy-artifacts, no-nul-bytes), all in code other sessions were editing at the time.

Left: nothing has MEASURED the fix, so there is no before/after table and no published
run. The in-process runner needs an LLM lane and this machine has none: no provider key in
`.env` or `.env.local`, and `gcloud` refuses every call with "Reauthentication failed.
cannot prompt during non-interactive execution", which also takes out the Vertex Gemini
anchor. Production's own chain is currently falling through to a dead paid backstop
(`openai 429: billing_not_active` on a live check), so a run today would be refused by the
error-rate ceiling anyway, correctly. `prompts/finish/production-100-04b-fact-check-publish-run.md`
carries the remainder with the exact commands. Order file 04 deleted.

## 2026-09-02: 04 mixed verdicts (calculus fix, lane fix, and what could not be measured)

Measured first: the live endpoint still served the 2026-08-10 run, `source: database`,
40% overall with `mixed` 0/10 and its confusion row reading `contradicted` 7,
`insufficient` 2, `supported` 1.

Root cause, and it is not a threshold. The ten `mixed` fixtures are all partial truths
("a tomato is a vegetable", "Napoleon was unusually short", the tongue map), and on a
partial truth the sources do not disagree with each other: every one reads the same
nuance. The stance vocabulary was `supports | contradicts | neutral`, and the extraction
rubric explicitly told the model to pick one side when a source affirmed part of a claim
and refuted another. So every source projected the same way, the projection cleared the
70% dominance bar, and the claim came back flat. `computeVerdict`'s `mixed` branch was
reachable only from inter-source disagreement, which that evidence never produces. The
class was unreachable by construction.

Fix: a fourth stance, `partial`, for a source that engages the claim and finds it true in
one respect and wrong, overstated, or only conditionally true in another. It is
stance-bearing but takes neither side, so it dilutes dominance and pushes the result to
`mixed`; the rubric is deliberately narrow (hedged prose, thin coverage and extractor
uncertainty stay `neutral`). Mixed confidence was rewritten too: it was
`max(supportRatio, contraRatio)`, which grew as a split became more lopsided. It is now a
mixedness score, `partialRatio + 2 * min(supportRatio, contraRatio)`, clamped to 1.
Wired through the extraction rubric, the image-evidence lane, the x402 response schema,
the source pill on `/fact-checker`, `docs/fact-check.md` and the agent README.

Anti-seesaw, proven mechanically rather than statistically: `tests/api/fact-check-verdict.test.js`
runs 5000 seeded random distributions drawn only from the three legacy stances and asserts
the new `computeVerdict` returns exactly what a transcription of the old rule returns. So
no clear-cut claim can be pulled into the mixed band by the calculus; the only claims whose
verdict can move are the ones a source actually reports as half-true. 23 tests green,
alongside the clear-cut pins (unanimous, boundary-at-70%, empty, all-neutral, zero-weight,
lone-source coverage floor).

Could not be measured here, which is why 04b exists. A 40-claim before/after needs an LLM
lane and this box has none: no provider key in `.env` or `.env.local`, `gcloud` auth dead,
and the keyless floor answered 0 of 8 probes (OVH 429, Pollinations 429 on every attempt).
A baseline worktree at `1407949cb` was staged for the A/B and torn down unused. Publishing
was refused on top of that for a second reason worth keeping: without ADC the search chain
falls to Wikipedia and DuckDuckGo, which returned "Aunty Donna's Coffee Cafe" for "coffee
is bad for your health", so a local run would have understated a chain the public number
is meant to describe. Both facts are now written into 04b with the trap named.

Side fix, from diagnosing that floor: LLM7.io retired the anonymous tier its rung was added
on, so every unauthenticated call is a 401 `invalid_api_key` (the `unused` token its docs
used to accept included). The rung sat in the chain unconditionally, spending a guaranteed
round trip at the tail of an already-exhausted chain. It is gated on `LLM7_API_KEY` now,
and `docs/ops/llm-lanes.md`, `docs/free-llm-providers.md` and `.env.example` no longer
claim three keyless rungs when there are two.

Left: 04b, unchanged in scope. It needs one LLM key and, for a publishable number, the
grounded search rung.

Worth knowing for the next agent: this ran alongside another agent on the same order.
Everything here reached `main` swept into that agent's commits (the shared worktree does
`git add -A`), so the content landed even though almost none of it carries a commit of
mine. Four commit attempts lost the `HEAD` ref race outright.


## 2026-09-02: 03 master-key-hygiene (shipped; only the rotate-or-accept decision is left)

Measured: `gcloud` was dead on the first three calls of this session
("Reauthentication failed. cannot prompt during non-interactive execution", which is
OWNER-ACTIONS row 15) and then started answering again a few minutes later with no
intervention, so row 15's premise is intermittent, not standing. With it working:
`ECONOMY_MASTER_SECRET_BASE58` was a plaintext `value:` on `three-ws-api` exactly as the
order described, and it was not alone: **58 more credential-bearing vars** were literals
too, including `DATABASE_URL`, `WALLET_ENCRYPTION_KEY`, `JWT_SECRET`, `CRON_SECRET`,
`OPENAI_API_KEY`, four wallet secret keys and the `OFFER_RECEIPT_JWK` signing key. Any
principal with `run.services.get` on the project could read all of them out of the service
config. Baseline before touching anything: `/api/healthz` `status: ok`, subsystems
7 ok / 3 degraded / 2 down / 1 unknown, revision `three-ws-api-00404-ph7`.

Did: built `scripts/migrate-plaintext-secrets.mjs` (dry run by default, never prints or
writes a secret value, classifies every var, reuses a secret that already holds the value
instead of minting a copy, grants the runtime SA `secretAccessor` on that one secret,
flips in one update, then re-reads the service and asserts the end state). Migrated the
master first and verified it alone, then swept the rest.

**End state: 59 credentials migrated (the master plus 58), 81 Secret Manager references in
all against the 22 that predated this, ZERO plaintext credentials, and 126 of the service's
207 variables correctly left as plaintext config. 100% of traffic on
`three-ws-api-00407-m7c`.** `--verify` reports `Verify: clean` and exits 0.

Two verifications, both read live rather than assumed:
1. Healthz against the baseline is strictly better, nothing regressed: 10 ok / 1 degraded /
   2 down. the two RPC subsystems went from degraded to `premium RPC healthy` and `4/4 paid
   lanes serving` (those provider keys resolve out of Secret Manager), `database` ok proves
   `DATABASE_URL` resolves, `resend: configured` proves `RESEND_API_KEY` does. The two that
   are still down (`x402_settle` on the sponsor floor, `agent_index` on crawl lag) were
   down before and are OWNER-ACTIONS row 2 and other work.
2. Master signing path: the treasury sweep writes a heartbeat row to
   `economy_master_ledger` carrying the pubkey it derived from the loaded secret. Revision
   `00406-nlg` was created at 19:58:46Z and the ledger kept writing through 20:02:23Z under
   `WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW`, so the container reads the secret, decodes
   64 bytes and derives the right wallet. No cron was triggered by hand: triggering
   `treasury-topup` moves SOL, which is stop-and-ask gate 1.

Fixed five callers the migration would otherwise have broken, all of which read
`env[].value` off `describe` and would have silently gotten `undefined`:
`scripts/create-gcp-scheduler.mjs` (CRON_SECRET, which signs the Authorization header on
every one of the 112 cron jobs) and `rug-signature.mjs` / `seed-sniper-experiments.mjs` /
`sniper-evolve.mjs` (DATABASE_URL). They now share `scripts/lib/service-env.mjs`, which
resolves a literal or a reference, and `scripts/read-service-env.mjs` gives an operator the
same thing on the command line. Ten runbook passages that told a reader to get a credential
out of `describe` were corrected, CLAUDE.md's credential row included, since that line is
the first thing every agent reads when a credential is missing. 25 new tests across
`tests/migrate-plaintext-secrets.test.js` and `tests/service-env-resolver.test.js`, plus 3
in `tests/cron-scheduler-sync.test.js`; `check:rules` clean on every touched path.

Left: OWNER-ACTIONS row 4, narrowed to what it always actually was: the master key sat
readable in the service config for some window, so rotate-or-accept is a judgment about who
held project viewer access in that period. The runbook section in
`docs/ops/wallet-key-migration.md` now carries the exact rotation commands, owner-gated at
the fund move. Two findings for that same row, both needing an owner call and neither
safe for an agent to change: `WALLET_ENCRYPTION_KEY` and `JWT_SECRET` hold the same value
on production (which defeats the dedicated-key guard in `secret-box.js` while passing it),
and `X402_SEED_SOLANA_SECRET_BASE58` holds the same value as
`LAUNCHER_MASTER_SECRET_KEY_B64` though `wire-master-wallet.mjs` assigns them to different
wallets. Order file deleted.

Not mine, found while verifying and left alone: `npm run check:claude` and one case in
`tests/cron-scheduler-sync.test.js` fail on a cron count that another agent is mid-edit on
in `vercel.json` (README and `docs/build.md` say 111, `vercel.json` declared 113 then 112
within the hour, and it briefly carried a duplicate `print-orders-sync` entry). One
`npm run audit:docs` finding, `docs/materialize.md` missing from `data/pages.json`, belongs
to the Materialize work committed today; `data/pages.json` is dirty in that agent's tree.

## 2026-09-02: 01 ship-readiness (built and verified; the submit is the owner's)

Prod before: `089500f4e`, revision `three-ws-api-00408-9mn`, built 20:07 UTC. Read it from
the Cloud Run URL, not `https://three.ws/api/version`: the CDN served three different
stale copies of that endpoint during this run (`ad7b54c16`/00404, `7f0ef6251`/00405), and
believing them would have made this a 343-commit deploy instead of the real 188. Anyone
verifying a deploy from the public URL without purging first is reading history.

Pinned and staged, not submitted: `2f26d19f3`, built clean in `/workspaces/.deploy-wt-p100`.
`npm run gate` exit 0 at that SHA, `npm run build:gcp` exit 0 (773 declared pages resolve,
check:dist OK), `npm run db:check` exit 0 with every migration applied. The ship is one
command; owner approval for the submit had not been given, so it was not run.

Full `npm test` on a quiet box, which this order has been owed since 2026-08-08: vitest
`Test Files 1911 passed | 3 skipped (1914)`, zero failures. Playwright `192 passed, 1
flaky, 2 failed`; both failures were then fixed and re-verified individually. Load average
peaked at 216 mid-run and the test was held until it fell under 16 rather than reading a
SIGTERM as a result.

Fifteen reds cleared to get there. Four were checkers that only passed on a machine that
had already built, which is why the gate looked green in the shared tree and failed in a
fresh deploy worktree: `check:claude` required `dist-lib/agent-3d.js`, `avatar-sdk/dist`
and `.git/hooks` (a linked worktree's `.git` is a file, so that one can never resolve
there); `verify-routes` missed a vite entry a formatter had wrapped across lines, and
modelled no `public/news/`; `audit-links` looked on disk for a dest `build-news.mjs`
writes; `audit-docs` wanted launch-kit art that `build:x-grid` regenerates. Two were real
config defects: `vercel.json` declared `/api/cron/print-orders-sync` twice, which collides
on one Cloud Scheduler job id, and `api/_lib/drops.js` carried four raw NUL bytes. Ten
hardcoded hexes across five pages were byte-identical to `--success`/`--danger`/`--warn`.
Four test suites were stale against shipped behaviour, including an oracle-calibrate case
asserting a factor both close to 1.318 and below the 1.3 ceiling. `prep:worktree` never
staged `agent-payments-sdk/dist`, so a fresh worktree failed with "Failed to resolve entry
for package @three-ws/agent-payments" instead of naming the missing artifact.

Two user-visible fixes, one with a changelog entry: the `/create` hero card nested its
rotating `model-viewer` inside its own `role="button"`, a serious axe `nested-interactive`
violation, now `inert`; and the `/portal` spec was judging the product on Vite's HMR
socket rather than on product errors.

Left for the owner: the submit itself, `npm run deploy:gcp:submit` from
`/workspaces/.deploy-wt-p100`, then `npm run deploy:gcp:purge-cdn` and `npm run smoke:prod`.
The worktree is left in place, built and ready, rather than removed. Pre-ship healthz had
`x402_settle` and `agent_index` down and `rpc_lanes`, `helius`, `sniper` degraded; that is
the baseline to compare against, and none of it is deploy-armed by this change.

Eight vitest files fail ONLY in a detached worktree and pass in the main checkout
(`packages/home-bridge` x2, `tour-sdk` x2, `check-tdz-bootstrap`, `multiplayer-server-boot`,
`server-404-routes`, `setup-git-hooks`). Verified both ways before dismissing them. They
need nested workspace `node_modules` and a real `.git/hooks` that `prep:worktree` does not
stage; worth staging next time rather than re-diagnosing.

## Retire this file when the campaign is done (required)

This file is shared context rather than a single order, so it outlives the
prompts that cite it. Delete it in the commit that closes the LAST prompt of
this campaign, once nothing else in `prompts/finish/` references it:

       grep -rl 'production-100-PROGRESS' prompts/finish/
       git rm prompts/finish/production-100-PROGRESS.md

While any sibling prompt of this campaign is still on disk, leave this file in
place and keep it accurate instead. The shrinking directory is the only signal
to the next agent that a campaign is closed.
