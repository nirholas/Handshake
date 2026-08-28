# Brownout

Every response this API sends says where its data came from and how fresh it is.
Every fallback it claims to have has been executed for real, with the provider it
protects against genuinely refusing, inside the same request path a user hits.

The live registry and its proof receipts are at [/brownout](https://three.ws/brownout).
The client library is [`@three-ws/brownout`](https://www.npmjs.com/package/@three-ws/brownout).

## Why this exists

A fallback is code that only runs when something is broken, which makes it the
least-tested code in any codebase. Two failures follow from that, and this
platform has shipped both:

- **A degraded answer that passes for a fresh one.** A paid market datapoint was
  stamped `as_of: <now>` over an hour-old payload, and a token security verdict
  was assembled out of remembered on-chain state. Neither was visible, because a
  degraded response and a live one are the same bytes.
- **A fallback nobody has ever run.** Unit tests stub `fetch` and prove the stub
  was called. They cannot prove that a page renders when a provider 429s,
  because the stub replaces the very layer whose behaviour is in question.

Brownout is the answer to both: make the degradation visible, and make the
failure reproducible on demand.

## Reading a response

Two headers, single-line ASCII, stable:

```http
x-brownout: v=1;tier=stale;sources=3;ok=1;failed=2;ms=512;degraded=1
x-brownout-trace: birdeye;o=429;t=412, tokens-xyz;o=timeout;t=8000, dex;o=ok;t=88
```

`x-brownout` is present on any response that touched an instrumented upstream.
`x-brownout-trace` appears only when something degraded, so a healthy response
pays one short header and no per-source cost. Both are exposed via
`Access-Control-Expose-Headers`, so a browser can read them.

### Freshness is a lattice

| tier | meaning |
| --- | --- |
| `live` | came off the wire during this request |
| `cache` | a cache hit inside its intended lifetime |
| `stale` | older than that, because an upstream could not answer |
| `fallback` | a different provider, or a different method, answered |

A response reports the **worst** tier that contributed to it. A page assembled
from one live read and one half-hour-old reading is not live, and reporting the
best tier would be worse than reporting nothing: a confident lie.

`degraded=1` means the answer is worse than the endpoint intends to give:
something failed over, or the answer is stale. **An ordinary cache hit is not
degraded.** That distinction is load-bearing: almost every response on a healthy
service is a cache hit, so counting those would flag the whole platform and train
every reader to ignore the field.

## Breaking an upstream on purpose

```http
x-brownout-chaos: birdeye=http:429, tokens-xyz=timeout
x-brownout-chaos-token: <token>
```

The request runs the real handler, the real provider ladder, the real cache
tiers and the real retry policy. Only the named upstreams misbehave, and only
for the caller who asked, so a probe can run against production without touching
anyone else's request.

| fault | what the code sees |
| --- | --- |
| `timeout` | an abort, exactly as a real deadline produces |
| `network` | `TypeError: fetch failed` with `ECONNREFUSED` on `cause` |
| `http:429` | a real 429 response carrying `Retry-After` |
| `http:<status>` | any 4xx or 5xx you name |
| `empty` | a 200 with an empty body, the shape that breaks naive parsers |
| `slow:<ms>` | the real call, delayed, for timeout-budget tests |

Faults are scoped by name and a directive for a provider covers every call shape
it serves, so `birdeye` also breaks `birdeye:txs`.

The server answers `x-brownout-chaos-status` with `applied;faults=N` or
`refused;reason=<why>`. **Always check it.** A refused directive means the
request ran normally, and a green assertion after a refusal proves nothing.

### Safety

Fault injection makes a live service misbehave, so it is gated three ways and
every one must pass:

1. **A token**, compared in constant time. `BROWNOUT_CHAOS_TOKEN` must be set
   and match. Without it configured the feature is off everywhere, including
   locally, so there is no "forgot to set it in prod" state that leaves it open.
2. **Never a money path.** A request carrying an x402 payment header, or
   addressed to a settlement, withdrawal, transfer, purchase or launch route, is
   refused outright. The blast radius of a wrong answer there is not a stale
   price, it is a payment.
3. **Read-shaped methods only.**

## Declared contracts, and proving them

`data/brownout.json` declares what the platform promises when a given upstream
fails: the endpoint, the fault, and what must still happen.

```json
{
  "id": "token-page-survives-dexscreener",
  "endpoint": "/api/ca2x402/resolve",
  "query": { "mint": "FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump" },
  "break": { "dexscreener:tokens": "http:429" },
  "expect": {
    "status": [200, 404, 503],
    "exercised": ["dexscreener:tokens"]
  }
}
```

Run them against a live server:

```bash
BROWNOUT_CHAOS_TOKEN=... node scripts/prove-brownout.mjs \
  --base https://three.ws --write public/brownout.json
```

### `not_exercised` is not a pass

The verdict that matters most is neither pass nor fail. A fault can be accepted
and still never reach the code, because a warm cache answered before any
upstream call happened. A prover that called that a pass would be certifying a
fallback nothing ran, turning an unknown into a false assurance.

So every contract declares which sources must appear as **failed** in the
response trace, and a run that cannot show them reports `not_exercised`. That
check earned its keep on its first run: three of the first four contracts were
unexercisable, two because their endpoint caches in a module slot no query
parameter can miss, and one because the warm-up and the attempt shared a cache
key.

Caches are not symmetric either. The heatmap answers any smaller `limit` out of
a larger cached field, so only warm-small-then-attempt-large actually misses,
which is why the direction is the contract's to state:

```json
"bust": { "param": "limit", "warm": 6, "attempt": 40 }
```

## What is instrumented

Provenance is recorded by the shared layers every read already goes through, so
a new endpoint reports without its author doing anything:

- `api/_lib/upstream-fetch.js`, the single wrapper for third-party calls in `api/`
- `src/shared/failover-fetch.js`, every ordered provider ladder
- `api/_lib/coingecko.js` and `api/_lib/coinpaprika.js`, the market pair whose
  primary throttles constantly and whose understudy carries the page
- `api/_lib/solana/connection.js`, the RPC rotation, which records the lane that
  answered and every lane that refused first

The header is attached in `wrap()` (`api/_lib/http.js`), the seam every handler
already passes through.

## Client library

```bash
npm install @three-ws/brownout
```

```js
import { withChaos, assertDegraded } from '@three-ws/brownout';

const brokenFetch = withChaos({ 'dexscreener:tokens': 'http:429' }, { token });
const res = await brokenFetch('https://three.ws/api/ca2x402/resolve?mint=...');

assertDegraded(res, {
  status: 200,
  tier: ['stale', 'fallback'],
  exercised: ['dexscreener:tokens'],
});
```

`assertDegraded` refuses to pass when the upstream under test never actually
failed, for the same reason the prover does.

## Related

- [/brownout](https://three.ws/brownout), the live registry and its receipts
- [/guards](https://three.ws/guards), the mechanical checks that protect the codebase
- [docs/shared-utilities.md](./shared-utilities.md), the retry, ladder and last-good helpers this instruments
