# Upstream resilience toolkit

Three parts, each answering a question the previous one cannot.

| Part | Question it answers | Entry point |
|---|---|---|
| [`analyze.mjs`](analyze.mjs) | Where do we call other people's services, and what protects each call? | `npm run audit:upstreams` |
| [`contracts.mjs`](contracts.mjs) | When a service is down, what is an endpoint allowed to say? | `tests/upstream-degradation.test.js` |
| The baseline | Can this get worse without anyone noticing? | `data/upstream-baseline.json` |

## Why this exists

Adding a fallback is easy. Knowing whether it made things better is not.

In one week this repo added deadlines, retries, provider ladders and last-good
caches across 147 modules, and shipped four bugs in the process. Every one came
from the same mistake: serving a remembered value on a path where a remembered
value is the wrong answer.

- The post-402 payment retry re-signed the exact blockhash the facilitator had
  just refused. Same payer, same payee, same amount, same hash: byte-identical
  bytes, refused again for the same reason.
- `/api/v1/token/security` assembled a live `200` out of remembered on-chain
  state. Mint authority and holder concentration *are* the verdict, so that was
  a clean bill of health for a chain nobody could read.
- An access gate answered from a cached verdict.
- `/api/ca2x402/resolve` told callers a real token did not exist, because on a
  cold instance the remembered payload it was supposed to fall back to did not
  exist yet.

All four passed review. All four had fallbacks. What none of them had was a
written answer to a different question, and that question is what this toolkit
makes mechanical.

## Part 1: the audit

`npm run audit:upstreams` parses every runtime module and records, per call
site, which of five protections are present: `deadline`, `retry`, `failover`,
`lastGood`, `breaker`.

It is an AST pass, not a grep, because the property being measured is not
visible on the line the call is written on. The options object may be built
three statements earlier, the deadline may arrive through a wrapper, and a
`signal,` shorthand looks nothing like `signal:`. An earlier regex sweep of this
same repo reported one unguarded call and was wrong in both directions: it
missed real findings and invented 507 others, nearly all of them same-origin
calls it could not tell from third-party ones.

Two passes run. The first collects every module-level string constant, because
base URLs here are almost always `export const PUMP_FRONTEND_BASE = '...'` in
one module and imported everywhere else; without it the majority of call sites
cannot be attributed to the host they actually talk to. The second grades each
call site with those constants resolved.

Grades:

| Grade | Meaning |
|---|---|
| A | Bounded, and survives the upstream being down |
| B | Bounded, with one way to survive |
| C | Bounded, retries or trips a breaker, but has no second source |
| D | Bounded only |
| F | Unbounded: one stalled socket can outlive the request that opened it |

A deadline is the floor rather than one grade among five, because without one no
other protection ever gets a turn.

This complements [`scripts/check-fetch-timeouts.mjs`](../check-fetch-timeouts.mjs),
which enforces that floor as a binary rule. The audit measures everything above
it and is the tool to reach for when the question is "what happens to users when
this provider goes down", not "did someone forget a signal".

`--map` regenerates [`docs/resilience.md`](../../docs/resilience.md).
`--json` emits the full table for other tooling.

## Part 2: degradation contracts

Every endpoint can declare what it is allowed to say during a total outage:

```js
import { CONTRACT } from '../scripts/resilience/contracts.mjs';

CONTRACT.MAY_SERVE_STALE       // a remembered value beats an error, and it is marked as remembered
CONTRACT.MUST_REFUSE           // no honest answer exists without a live read
CONTRACT.MUST_NOT_SERVE_STALE  // acting on a stale answer costs money or grants access
```

`tests/upstream-degradation.test.js` then makes it true rather than taking it on
trust: it replaces `fetch` with one that fails the way a dead host fails, calls
the real handler, and judges the real response. Two failure shapes are injected,
because a refused connection and a socket that accepts and never answers are
different bugs and have caught different ones here.

`MAY_SERVE_STALE` requires the response to *say* it is stale (`stale: true`, an
`as_of` stamp, or an `x-*-stale` header). Degrading silently is how a remembered
answer gets mistaken for a current one, so an unmarked `200` fails the contract
even though it looks like a success.

Adding an endpoint is one entry in the `ENDPOINTS` table. The harness found a
real bug on its first run: `/api/ca2x402/resolve` answered `404 token_not_found`
on a cold instance during an outage, denying tokens that plainly existed.

## Part 3: the ratchet

`data/upstream-baseline.json` records the grade of every known call site.

- A **new unbounded call** fails the audit.
- A **call site that gets worse** fails the audit, naming the file, the host and
  the transition (`D -> F`).
- A call site that gets **better** lowers the baseline automatically, so nobody
  has to remember to re-record a fix and the floor only ever rises.
- Raising the floor back needs `--accept`, which is one reviewable line in a diff
  rather than a silent drift.

This shape matters because the tail is long and the fix is not always today's
job. A threshold ("no more than N unguarded calls") gets rounded up until it
means nothing. A baseline lets the existing tail be paid down at its own pace
while making it impossible to add to it by accident.

## Adding a new shared helper

The analyzer resolves protections by helper name. A new wrapper needs one entry
in `GUARDS` in [`analyze.mjs`](analyze.mjs) naming what it provides by
construction, otherwise every call site using it will be graded as if it were a
bare `fetch`. That is the toolkit's one maintenance cost, and it is deliberate:
it is also the list of blessed ways to call an upstream.
