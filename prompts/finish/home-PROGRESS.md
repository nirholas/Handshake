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
| 01 connection store | done | 2026-09-03 |
| 02 bridge runtime | done | 2026-09-03 |
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

**Addendum, same session, after the verdict above was written.** The lane kept moving during and
after this run, so two lines above are already stale and one is not:

- Resolved by their owning agents: the duplicate `20260903120000_home_connections.sql` file is
  gone, `packages/home-mcp/README.md` landed, and `api/_lib/ops/home-health.js` now reports a
  `home` subsystem through `/api/healthz`.
- **Not resolved, still live on production:** all six duplicate indexes. The
  `20260903130000_home_schema_reconcile.sql` that landed adds the two CHECK constraints the losing
  `create table if not exists` never created, which is a different (real) bug. It drops no index.
  Verified against Neon after it applied: all six names still present. Order 01 still owns it.
- New since the verdict: `services/home-satellite` has no README either, so `npm run check:claude`
  still fails on two directories rather than the two named above.
- Fixed here after the verdict: `scripts/audit-home-credential-health.mjs` landed with no npm
  script and no registry entry, failing `npm run audit:guards`, `npm run gate` and
  `tests/audit-guards.test.js`. Registered beside its custodial-wallet twin (manual stage, needs
  credentials, live proof) in `d00748f1d`.
- The full suite cannot be certified green while the campaign is in flight. Three failures in one
  run (`tests/home-privacy.test.js`, `tests/home-runtime.test.js`, `tests/audit-guards.test.js`)
  and one in another; the first two pass in isolation. They read `api/_lib/migrations/` and the
  guard registry from disk, and peers mutate both mid-run. Re-run the suite when the lane is quiet.


## 01. Connection store: schema, encrypted credentials, lifecycle (2026-09-03)

**Shipped:** `home_connections`, `home_entity_grants` and `home_action_log` exist and are
applied (`20260903030000_home_connections.sql`). A house is one row: the normalized base URL,
the Home Assistant long-lived token sealed with the same AES-256-GCM primitive as a custodial
wallet key, a sha256 fingerprint so a re-connect is idempotent and a rotation is detectable
without decrypting, and capabilities MEASURED at connect. Grants are per entity with no
`granted_domain` column, and the migration header records why: letting the agent open the
office door is not letting it open the front door. `api/_lib/home/store.js` is the only module
that reads the credential column and `getDecryptedToken` is the only function that returns
plaintext. `api/_lib/home/verify.js` opens a real bridge and measures the instance.
`tests/home-store.test.js` covers all of it in three tiers. Two schema constraints beyond the
order's table caught real bugs in review: `home_connections_relay_chk` (a relay row must carry
a relay id) and `home_action_log_risk_chk`. Connected homes are now named in the key-rotation
runbook alongside custodial wallets, with `scripts/audit-home-credential-health.mjs` as their
own reading, because a sealed home has no on-chain balance to notice it by.

**Measured:**

- `npm run db:status`: 1 pending before, `All migrations already applied` after. No other
  agent's migration was pending at the time it ran.
- `npx vitest run tests/home-store.test.js packages/home-bridge` against a real Neon database
  and the lane's seeded Home Assistant (`node scripts/home-test-instance.mjs --up --onboard
  --seed --name lane`, HA 2026.9.0, 120 entities, 3 areas, 1 floor): **65 passed, 0 skipped.**
  Without live env: 37 passed, 28 skipped.
- Credential round trip, live: created a connection from a typed URL with a trailing slash,
  read the row back with no credential field on it and no token anywhere in its JSON, confirmed
  the stored ciphertext starts `v2:`, decrypted it and opened a real `HomeBridge` that connected
  and built a room graph.
- Isolation: `listConnections(B)` returned `[]` against A's live home, `getConnection(A.home, B)`
  and `getDecryptedToken(A.home, B)` both returned null, and B's revoke of A's home reported
  `alreadyRevoked: false` rather than acting.
- Grant scoping: with only `lock.kitchen_door` granted, a live bridge unlocked it with no prompt
  and refused `lock.front_door` with `code: 'needs_confirmation'` in the same session;
  `lock.front_door` read back `locked`.
- Expiry: a grant with `expires_at` an hour in the past sits in the table and never appears in
  `listGrants`, proved by counting both.
- Revoke: twice in a row, `{revoked:true}` then `{revoked:false, alreadyRevoked:true}`,
  `access_token_enc = ''`, `status = 'revoked'`, action log intact, and the same house
  connectable again as a new row.
- `grep -rn "access_token_enc" api/ --include=*.js`: the only READS are in
  `api/_lib/home/store.js`. `grep -rn "getDecryptedToken" api/ --include=*.js`: the definition
  plus `api/_lib/home/runtime.js`, which is order 02's pool.
- `npm run check:rules` clean on every file touched. `npm run audit:docs`: one finding, and it
  is `packages/home-mcp` missing a README (order 18's directory, not this one's).

**Deviations:**

- The order's `verifyConnection` sketch left the HA version to be read off entity attributes.
  Measured against a real instance that returns an integration's `installed_version`, not the
  core version. It reads `/api/config` instead, and the test asserts equality with what that
  endpoint returns rather than merely that a version is present.
- The order's index sketch was `(user_id) where revoked_at is null`. Shipped as
  `(user_id, created_at desc) where revoked_at is null`, a superset, because the list view's only
  read shape is one user's homes newest first.
- The order's live round trip used `<base>/lovelace/` as a "messy" input. It is not messy:
  `normalizeBaseUrl` deliberately KEEPS a path so an instance behind a reverse proxy prefix
  works, so that input stores a different house. The package's own doc comment claimed the
  opposite and has been corrected (`packages/home-bridge/src/url.js`).
- Task 5's "credential inventory" does not exist as a list of ciphertext columns. What exists is
  the rotation runbook plus a wallet-specific health module whose numbers are SOL totals, which
  home tokens have none of. Wired as a new section in `docs/ops/wallet-key-migration.md` and a
  real read-only audit rather than a row in a table that was not there.
- The order's "Never blocked" row says `secret-box.js` falls back to `JWT_SECRET` locally. In
  this workspace `.env.local` carries only `DATABASE_URL`, so neither key is set and
  `encryptSecret` throws. Local runs need a `WALLET_ENCRYPTION_KEY` in the environment; nothing
  in the code changed for it.

**Left open:** nothing in this order. Two observations for whoever owns them: `api/_lib/home/relay.js`
writes `access_token_enc` as an intentional empty string when it creates a pending relay row, which
is correct but means the audit had to learn that a relay home awaiting pairing is not a sealed one;
and there are leftover `home_connections` rows in the production database from other agents' local
test runs, sealed under their local keys, which the audit reports honestly.

**Commits:** the schema, store, verify, tests and audit script were swept into concurrent agents'
`git add -A` commits as they landed (`c3132956a`, `858a2f86b` among them); this entry and the
retirement of the order file are the final commit.

---

## 02. Bridge runtime: the multi-tenant connection manager (2026-09-03)

**Shipped:** `api/_lib/home/runtime.js` holds one per-instance, lazily-opened, reference-counted,
idle-evicted pool of live Home Assistant sockets, and every consumer above it (SSE, a chat tool
call, an MCP call) checks a bridge out and back in through `withHome` rather than constructing
one. `acquire`, `withHome`, `snapshot`, `subscribe`, `evictIdle`, `stats` and `closeAll` are the
contract; `createHomeRuntime` builds one over injectable dependencies so the refcount, the cap,
the breaker and the eviction boundary are testable without a network. The socket is a cache and
never the source of truth: a request landing on an instance holding no connection opens one, and
that cold path is normal rather than an error. The behaviour worth naming on its own is that the
graph is never emptied on disconnect, only marked stale, so a person watching their 3D home sees
it go grey instead of watching their house vanish. `tests/home-runtime.test.js` (27 pure) and
`tests/home-runtime-live.test.js` (5 live, self-skipping on `HOME_ASSISTANT_URL`) cover it.

**Measured:**

- Socket reuse, host side: two sequential `withHome` calls against a real Home Assistant 2026.9.0
  (125 entities, 4 rooms) left `ss -tn state established` at **1** socket after each call, with
  **1** bridge constructed. `closeAll()` took it back to 0.
- Breaker, at the production 15 s connect timeout: failures 1 to 5 cost 15009, 15005, 15005,
  15004 and 15002 ms; attempt 6 failed in **0 ms** with `home_breaker_open` and a message naming
  the 300 second cooldown. The store is written with `status: unreachable` and a `status_detail`
  ending "paused retries for five minutes", so the connect screen explains it without a socket.
- Kill and restart, mid-subscription: `docker stop` left the subscriber's last event at
  `stale=true connected=false status=unreachable` with all four rooms (Bedroom, Front Door,
  Kitchen, Living Room) still readable. `docker start` restored `stale=false connected=true`
  about 6 s later with no client action and 2 events delivered.
- Eviction at its boundary: 89,999 ms after the last release evicts 0; 90,000 ms evicts 1 and
  `stats().open` drops to 0.
- `npx vitest run tests/home-runtime.test.js packages/home-bridge`: 57 passed, 7 skipped.
- `npm run check:rules --paths <the files>`: clean.

**Deviations:**

- The order says order 01 must have landed first. It had not when this session started
  (`api/_lib/home/` did not exist), and several sessions were running the campaign in parallel,
  so the schema and `store.js` were written here and then converged with the peer session that
  owned order 01. Two `create table if not exists` migrations for the same tables raced, which
  makes the loser a silent no-op that skips the CHECK constraints declared inside its CREATE
  TABLE: the duplicate was withdrawn and `20260903130000_home_schema_reconcile.sql` adds
  `home_connections_relay_chk` and `home_action_log_risk_chk` by name, so a raced database ends
  up matching what `20260903030000_home_connections.sql` says it guarantees. It is a no-op on a
  cleanly provisioned one.
- A real concurrency defect in the pool, found by the test that two simultaneous `acquire` calls
  share one open: the pool slot was claimed AFTER the credential read, so two callers that both
  cleared the map check during that database round trip each opened a socket and the second
  `entries.set` orphaned the first, which was then never pooled, never evicted and never closed.
  A page load and an SSE stream starting together is exactly that race. The slot is now reserved
  synchronously before the first await and the credential is read inside `entry.ready`.
- `HomeBridge` gained `haVersion` and `registries` getters. The capability record has to state
  the version the instance actually reported rather than one inferred from a state attribute.

**Left open:** nothing in this order. The `admission` ladder that now rides along in `stats()`
belongs to order 14 and landed alongside this work in the same worktree.

**Commits:** this entry, the tests, the reconcile migration and the pool fix.

**Deploy preflight, same session.** Run read-only against HEAD, which moved five times during it.
Passing: the `build:gcp` chain matches CLAUDE.md byte for byte, `publish:lib` correctly follows the
`emptyOutDir` frontend build, all 31 `cloudbuild*.yaml` carry a service-account pin (the one
deviation, `workers/avatar-reconstruction`, pins its own dedicated SA and is safe), the CDN purge
is still synchronous, and `npm run check:gcloudignore` is clean. Three findings, all verified
independently before being recorded here:

1. **`data/pages.json` is committed promising three routes whose files are not.** `/voice/home`,
   `/docs/home-households` and `/docs/home-privacy` are declared, while `pages/voice-home.html`,
   `docs/home-households.md` and `docs/home-privacy.md` are untracked. A deploy worktree is created
   at HEAD, so it would not contain them and `check:pages` would fail the build at its last step.
   `check:dist` would not catch it: it only validates the `criticalStaticPages` subset.
2. **Two migrations are applied to the production database but untracked in git**
   (`20260903160000_home_plan_overrides.sql`, `20260903200000_home_satellites.sql`). This is the
   inverse of what `db:check` was built to catch, so it reports clean: the schema is ahead of
   committed source, and rebuilding the database from git would not reproduce production.
3. **Disk is at 90 percent with 13 GB free and nothing reclaimable.** `npm run clean:worktrees`
   keeps all 8 worktrees because 7 hold uncommitted files. The 2026-08-04 failure mode (a
   `git worktree add` dying mid-checkout on a full disk) is close enough to plan around.

Corrected from the preflight report: `public/models/` is NOT a git-hygiene risk. The gitignore
committed in `c2b663cfb` covers it, and a `git add -A` sweeps 0 files from it (measured with a
throwaway index). Only `true/` is exposed, and only 2 files: it is shell-redirect debris in the
repo root (`clips/`, `rejected/`, `checkpoint.json`) that its owning agent should delete.

Also corrected: the `tests/api/healthz*.test.js` collection failures are not a production
cold-start break. `api/_lib/db.js` exports `sql` as a Proxy whose tagged-template form returns a
lazy fragment and never touches Neon, so `store.js`'s top-level `SAFE_COLUMNS` fragment is the
house idiom. Those tests mock `db.js` with a `sql` that throws on any call, and the lane newly
pulled `api/_lib/home/*` into the healthz import graph. Broken tests, working handler.
