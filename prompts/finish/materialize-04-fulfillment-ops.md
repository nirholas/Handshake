# Work order 04: fulfillment adapters and the operator console

**How to run:** paste this whole file into a fresh Claude Code chat in this
repo, or name its path. Read `prompts/finish/materialize-00-CONTEXT.md` first; its
decisions bind this order.

**Binding operating clause:** finish 100%. Never end with a question or an
unexecuted plan. CLAUDE.md hard rules apply: no mocks, no fake data, no
unfinished markers, no em-dash, explicit-path commits. Signing a partner,
sending funds, deploys: owner-gated. Building every rail so those are
one-step owner actions: this order.

## Why this order exists

Orders that reach `screening` must reach `delivered`. The lane that makes
that true on day one is a human operator with a first-class console,
because that is a real fulfillment operation (it is how every print
marketplace launched), and it is the honest alternative to blocking the
product on an uncontracted partner API. The adapter layer means the day a
partner contract lands, their API becomes a config change, not a rebuild.

## Step 0: re-derive current state

```
ls api/print/ops/ api/_lib/print/adapters/ 2>/dev/null
grep -rn "provider" api/_lib/print-store.js 2>/dev/null | head
grep -rln "admin" api/ | head   # find the existing admin-auth pattern
psql "$DATABASE_URL" -c "select status, count(*) from print_orders group by 1" 2>/dev/null
```

Order 02's store and state machine must exist (verify). Re-derive how this
repo authenticates admin/operator endpoints (the KOL `import-gmgn` route
is one known admin surface; find the shared helper it uses and reuse it).

## Tasks

### 1. Adapter contract (`api/_lib/print/adapters/`)

One interface, adapters as data + module pairs, mirroring the forge engine
registry philosophy: each adapter declares capabilities (materials it can
run, max bbox, ships-from country, lead-time) and implements
`submit(order, assets)`, `status(providerOrderId)`, `cancel()`, plus a
webhook verifier. The store's `submitted → printing → quality_check →
shipped` transitions are driven only through adapter events; no handler
writes those states directly.

### 2. The `manual` adapter (launch lane, fully real)

`submit` assigns the order to the operator queue and notifies the operator
channel (re-derive the existing Telegram ops-notification helper; the
changelog cron proves one exists). `status` reads what the operator
recorded. The operator console (task 3) is this adapter's API. No part of
this simulates anything: it is a workflow tool for a human running real
print jobs through a real bureau.

### 3. Operator console (`/materialize/ops`, session + operator allowlist)

A working queue over `api/print/ops/*` endpoints (list by status, order
detail with the prepared asset download links + shipping label data,
transition actions with notes, tracking-number entry, refund marking).
Server-side authorization on every endpoint via the repo's admin pattern;
the page is never the security boundary. Ship it with the platform's
design system; an internal tool with dead-end states breeds exactly the
operational mistakes the state machine exists to prevent.

### 4. The `partner-cn` adapter skeleton, wired behind env

Per 00-CONTEXT, the Chinese partner is uncontracted: build the adapter
module fully structured (auth header slot, submit/status/webhook mapping
to the store's vocabulary) but registered only when its env vars exist
(`PRINT_PARTNER_CN_URL`, `PRINT_PARTNER_CN_KEY`), exactly how the forge
treats BYOK lanes. Every code path that can run without credentials has a
real test; the report lists the env vars as the single missing input. No
fabricated endpoints: the mapping uses the store's own vocabulary and a
documented request shape in the module header, marked as the contract to
reconcile against the partner's real API docs when they arrive.

### 5. Webhooks + reconciliation

`POST /api/print/webhook/:provider` with per-adapter HMAC verification and
idempotent event application (a replayed webhook must not duplicate
timeline rows). A reconciliation cron (`api/cron/print-orders-sync.js`,
registered in `vercel.json` crons per the repo's cron conventions) polls
`status()` for non-terminal orders older than the adapter's lead time and
flags stalls to the operator channel. Note the CLAUDE.md rule: the cron
count claim lives in CLAUDE.md and is guarded by `check:claude`; run
`npm run check:claude` after touching `vercel.json` and update the count
in CLAUDE.md in the same commit if it moved.

### 6. Tests

Adapter contract conformance suite run against both adapters (manual fully,
partner-cn's credential-free paths), webhook idempotency, operator endpoint
authorization (anonymous and non-operator sessions get refused), stall
detection picks up a fixture order past lead time.

## Definition of done

- [ ] `npm test` green including adapter conformance + ops authorization tests.
- [ ] Dev-server proof in the report: a paid test order walked `screening → submitted → printing → shipped` entirely through the console UI, timeline showing operator-actor events.
- [ ] Webhook replay proven idempotent (same payload twice, one event row).
- [ ] `npm run check:claude` passes with the cron registered.
- [ ] Anonymous and non-operator access to every `api/print/ops/*` endpoint refused (test-proven).
- [ ] `npm run check:rules -- --paths <files you touched>` passes.
- [ ] Committed with explicit paths; this file deleted in the closing commit; PROGRESS.md appended.

## Never blocked

| Blocker | Resolution |
|---|---|
| No partner API docs | By design. Build the skeleton behind env per task 4; the missing vars are the report's one owner input. |
| Admin auth pattern unclear | Grep for the helper the KOL admin import uses; if the repo truly has no shared operator-role concept, add the minimal allowlist (env-listed user ids) and document it in the module header. |
| Telegram ops channel | The changelog push cron already posts to Telegram; reuse its client and env. A separate ops chat id, if absent, goes in the report as one env var, and notifications also land in the in-app bell meanwhile. |
| Fear of adding a cron | Follow `scripts/create-gcp-scheduler.mjs` conventions; scheduler sync is owner-run at deploy. Registering in vercel.json is the repo-side deliverable. |
| Refund mechanics | Marking `refunded` with an event note is this order. Moving actual funds is CLAUDE.md gate 1, owner-executed; the console renders the exact recipient + amount for that action. |

## Report format

Files + tests, the console walkthrough evidence, the exact env vars and
owner actions remaining (partner credentials, ops chat id if new), one
line per 00-CONTEXT deviation, next action.
