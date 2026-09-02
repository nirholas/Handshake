# Materialize fulfillment: the operator console and the adapter layer

Every paid Materialize order has to become an object in a box. This runbook is
for the person who makes that happen, and for whoever wires the next
fulfillment partner.

Two things are worth stating before the mechanics, because they explain every
design decision below:

1. **The launch lane is a human.** A print marketplace's first fulfillment lane
   is always an operator driving a real print bureau by hand. That is not a
   placeholder for a partner API; it is a first-class adapter with a
   first-class console, and the product ships on it.
2. **The state machine, not the provider, decides what may follow what.** A
   partner reporting "shipped" for a job we already refunded is refused and
   recorded, never applied. That refusal is what keeps a partner's release
   notes from being able to corrupt an order.

Buyer-facing documentation lives in [../materialize.md](../materialize.md).
This file is the other half.

## The console

`/materialize/ops` ([pages/materialize-ops.html](../../pages/materialize-ops.html),
runtime [src/materialize-ops.js](../../src/materialize-ops.js)). Queues on the
left, orders in the middle, one order's whole story in a drawer on the right.

The working loop:

1. Open **Needs action**. Anything late shows `+Nd` next to its status, so the
   question "which of these is in trouble" is answered before you click.
2. Open an order. The drawer carries the prepared STL / 3MF / GLB as download
   links (this is what you hand the bureau), the shipping address, the timeline,
   and every webhook delivery we have received for it.
3. **Submit to lane.** Pick a lane or leave it on *Route automatically*, which
   takes the first configured adapter whose declared capabilities cover the
   order. The order moves to `submitted` and the operator channel is paged.
4. Run the job. Move the order as reality moves: `printing`, then
   `quality check`. Notes go on the timeline; write them for the next operator,
   not for yourself.
5. **Enter the tracking number.** That is the action that marks the order
   `shipped`, which is also what issues its certificate. Correcting a typo
   afterwards updates the number without a second shipment event.

Every button is generated from the order's own legal moves, so the console can
never offer a transition the server would refuse. A closed order shows no
actions and says so.

### Authorization

Three doors, strongest first
([api/_lib/print/ops-auth.js](../../api/_lib/print/ops-auth.js)):

| Door | Who | Attribution on the timeline |
|---|---|---|
| Platform admin session | wallet in `ADMIN_ADDRESSES`, the built-in owner address, or `is_admin` | the operator's user id |
| Operator allowlist | a signed-in user whose id or wallet is in `PRINT_OPERATORS` | the operator's user id |
| `x-ops-secret` header | scripts, matching `OPS_SECRET` | `ops-secret`, no user id |

`PRINT_OPERATORS` exists so fulfillment can be staffed without handing out
platform admin, which is a far larger privilege than "may mark a job shipped".
It is a comma-separated list of user ids or wallet addresses.

**This gate fails closed in development too.** The read-only ops boards
(`api/_lib/ops-auth.js`) deliberately open when no `OPS_SECRET` is configured;
these endpoints must not, because they return shipping addresses. A deployment
with no credentials configured serves nobody.

Shipping addresses are the first real PII this platform stores. They appear in
exactly two places: the order detail in this console, and the payload handed to
a fulfillment adapter. They are never logged, never in an analytics event, and
never in an operator notification, which carries only the destination country.

## The adapters

An adapter is the machine-readable face of whoever actually prints the thing.
The contract is one interface
([api/_lib/print/adapters/contract.js](../../api/_lib/print/adapters/contract.js)):

```
key            stable string, stored in print_orders.provider
label          human name for the console
capabilities   { materials, maxBboxMm, shipsFrom, leadTimeDays }
configured()   false hides the adapter from the registry entirely
submit(order, assets)       → { providerOrderId, status, leadTimeDays, note, state }
status(providerOrderId)     → { status | null, trackingNumber, carrier, note, state }
cancel(order, reason)       → { ok, note, state }
verifyWebhook(raw, headers) → { ok, deliveryId, reason }
parseWebhook(payload)       → { providerOrderId, status, trackingNumber, carrier, note, state }
```

Rules that make the layer worth having:

- **An adapter never writes the database.** It returns vocabulary the store
  understands and the caller drives the transition. Every result is normalized
  first, so a malformed return fails at its own boundary with a named error.
- **Capabilities are declared, not inferred.** Routing an order to a lane is a
  comparison against published facts, so a lane that cannot run a part declines
  it before the job is taken rather than after.
- **An adapter may only drive `submitted`, `printing`, `quality_check`,
  `shipped`, `delivered`, `canceled`, `rejected`.** Everything before
  submission is ours, and `refunded` is a money decision that stays with an
  operator.
- **An unknown provider status maps to `null`, meaning "no news".** Guessing a
  transition from a string a partner added in a release we have not read is
  exactly how a state machine gets corrupted.
- **Registration is conditional on `configured()`.** A lane whose credentials
  are absent is invisible: nothing can route into it and the console never
  offers it.

### `manual`, the launch lane

[api/_lib/print/adapters/manual.js](../../api/_lib/print/adapters/manual.js).
Always configured, because it needs a person rather than a credential.

- `submit()` puts the job on the operator queue and pages the operator channel.
- The provider order id **is** our order id. There is no second system, so an
  opaque handle would be a fiction the operator has to translate back by hand.
- `status()` reads our own order row: the console's transitions are this lane's
  source of truth, so a poll always agrees with the order it is polling and
  reports "no change" by construction.
- There is no webhook. `verifyWebhook()` refuses every delivery rather than
  leaving an unauthenticated door open on a lane that cannot call it.

### `partner-cn`, wired and waiting on a contract

[api/_lib/print/adapters/partner-cn.js](../../api/_lib/print/adapters/partner-cn.js).

The Chinese high-precision print operator who approached us on 2026-08-13 is
**unverified and uncontracted.** The adapter is fully structured and registers
itself only when both env vars are present:

```
PRINT_PARTNER_CN_URL   https base of the partner API, no trailing slash
PRINT_PARTNER_CN_KEY   bearer credential, also the webhook HMAC secret
```

The request and callback shapes the module assumes are documented in its own
header, in the store's vocabulary. They are the contract to reconcile against
the partner's real API documentation the day it arrives; reconciling should be
a rename of wire fields, never a redesign. The status mapping is one table
(`PARTNER_STATE_MAP`), which is the piece most likely to need a line added.

Signing a partner is an owner action. Nothing in this lane is reachable until
the credentials exist.

### Adding a lane

1. Write the module beside the other two, satisfying the interface above.
2. Register it in [adapters/index.js](../../api/_lib/print/adapters/index.js).
   Order matters: the first configured adapter that supports an order is the
   default route, and `manual` is deliberately last. A contracted partner
   should take a job it can run; a human should take everything else.
3. Add it to the conformance suite's adapter list in
   [tests/print-adapter-contract.test.js](../../tests/print-adapter-contract.test.js).
   Every adapter runs through the same checks; that is the point.

## Webhooks

`POST /api/print/webhook/:provider`
([api/print/webhook/[provider].js](../../api/print/webhook/%5Bprovider%5D.js)).
Three properties, enforced in this order:

1. **Authenticity.** The adapter verifies the delivery against the exact bytes
   received, constant-time. An unverified delivery is refused before the body
   is parsed, so a forged payload never reaches a `JSON.parse`.
2. **Idempotency.** Every serious provider retries. The claim on
   `print_webhook_deliveries` is a unique-key insert and happens *before* the
   payload is interpreted, so even a delivery we end up not applying is
   recorded and cannot be replayed. A duplicate answers `200 {duplicate:true}`;
   a 4xx would make the provider retry forever.
3. **Ordering.** A report the state machine refuses is written to the timeline
   as a provider event carrying the refusal, and answered `200
   {applied:false}`.

A provider that sends no delivery id gets a stable one derived from the payload
hash, so "the same event twice" is still one row.

## The reconciliation sweep

[api/cron/print-orders-sync.js](../../api/cron/print-orders-sync.js), hourly at
`:17` (registered in `vercel.json`; Cloud Scheduler is synced by
`scripts/create-gcp-scheduler.mjs` at deploy time).

Webhooks are the fast path and are not sufficient: a delivery gets lost, a
callback queue backs up, and the manual lane has no webhook at all. Without the
sweep, the worst failure a physical product has goes unnoticed, which is a
finished order sitting in `printing` until the buyer asks.

Two passes, deliberately separate:

- **Reconcile.** Poll every order a configured adapter still owns and apply the
  answer through the state machine. A provider with no news moves nothing, so
  this is safe to run often. **One unreachable partner is counted, not thrown**,
  because the stall pass is exactly what catches the orders that partner is
  sitting on.
- **Stall.** Page the operator once for any order more than `lead_time_days + 2`
  old, then stamp `stall_alerted_at` so the next sweep stays quiet for 24 hours.

Read the response: `{ open, polled, applied, stalled, alerted, failures }`. A
non-empty `failures` array names the orders whose lane could not be reached and
why.

## The operator channel

[api/_lib/print/ops-notify.js](../../api/_lib/print/ops-notify.js). Three sinks,
layered so no single missing credential silences the queue:

1. **Telegram**, to a private ops chat: `TELEGRAM_PRINT_OPS_CHAT_ID`, falling
   back to the existing `TELEGRAM_ALERTS_CHAT_ID`. Same bot token and the same
   retrying sender the ops alerts use. Never the public changelog channel:
   these messages carry order ids.
2. **The in-app bell**, for every platform admin. This is what makes the channel
   work on a deployment with no dedicated ops chat id.
3. **`ops_alerts`**, for stalls only, which is the durable record when the other
   two are unconfigured.

## Refunds

Marking an order `refunded` in the console records the decision, attributes it
to the operator, and returns the exact payout instruction: amount, recipient,
chain, asset. **It moves no money.** Sending USDC is an owner-executed action
under the CLAUDE.md spend gate, and the console renders what the owner needs
rather than performing it. The instruction stays on screen after the order
reloads, so it can be acted on rather than glimpsed.

## Environment variables

| Var | Required for | Notes |
|---|---|---|
| `DATABASE_URL` | everything | Without it the console and the sweep answer 503. |
| `PRINT_OPERATORS` | staffing without platform admin | Comma-separated user ids or wallet addresses. Optional: admins always get in. |
| `OPS_SECRET` | script access to the ops API | The dedicated ops credential. Never `CRON_SECRET`. |
| `CRON_SECRET` | the sweep | Standard cron gate. |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_PRINT_OPS_CHAT_ID` | Telegram paging | Falls back to `TELEGRAM_ALERTS_CHAT_ID`. Without either, paging degrades to the bell and `ops_alerts`. |
| `PRINT_PARTNER_CN_URL` + `PRINT_PARTNER_CN_KEY` | the partner lane | Absent today. Until both exist the adapter is not registered at all. |

## Diagnosing a stuck order

1. Open it in the console and read the timeline bottom to top. Every status
   change is there with its actor; nothing mutates history.
2. Check **Webhook deliveries** in the drawer. Empty on a partner order means
   their callbacks are not reaching us, which is a different problem from a
   slow print. Empty on a manual order is expected.
3. Run the sweep by hand and read `failures`:
   ```bash
   curl -s -H "authorization: Bearer $CRON_SECRET" https://three.ws/api/cron/print-orders-sync | jq
   ```
4. A refused provider report appears on the timeline as
   `Refused provider report '<status>': <reason>`. That means their system and
   ours disagree about where the job is; the timeline is right.
