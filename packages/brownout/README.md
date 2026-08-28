<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" width="72" height="72" alt="three.ws" /></a>
</p>

<h1 align="center">@three-ws/brownout</h1>

<p align="center"><strong>Find out where an API's data actually came from, and break its providers on purpose to prove your integration survives it.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/brownout"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/brownout?logo=npm&color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/brownout?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/brownout?color=339933&logo=node.js">
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#the-problem">The problem</a> ·
  <a href="#api">API</a> ·
  <a href="#the-wire-format">Wire format</a>
</p>

---

## The problem

Your integration has fallbacks. A retry, a second provider, a cache you serve
when the upstream is down. You wrote them carefully and you have never seen a
single one of them run, because the thing they protect against does not happen
on demand.

So two questions have no answer today:

1. **When the API answered you just now, where did that number come from?** A
   `200` looks identical whether the price is a second old or came from a cache
   entry twenty minutes past its lifetime after three providers refused.
2. **Does your own code survive that?** You cannot know, because you cannot make
   their provider fail.

This package answers both against any service that speaks Brownout, which
[three.ws](https://three.ws/brownout) does on every endpoint.

## Install

```bash
npm install @three-ws/brownout
```

## Quick start

### Read where an answer came from

```js
import { parseProvenance, isStale, describeProvenance } from '@three-ws/brownout';

const res = await fetch('https://three.ws/api/coin/detail?id=solana');
const prov = parseProvenance(res);

console.log(describeProvenance(prov));
// tier=fallback, 1 source failed, 2123ms, refused: coingecko(429)

if (isStale(prov)) {
  // The number is real, just not fresh. Caption it rather than hiding it.
  render(price, { note: 'as of a few minutes ago' });
}
```

`tier` is a lattice, not a flag, and a response reports the **worst** tier that
contributed to it:

| tier | meaning |
| --- | --- |
| `live` | came off the wire during your request |
| `cache` | a cache hit inside its intended lifetime |
| `stale` | older than that, because an upstream could not answer |
| `fallback` | a different provider or a different method answered |

A page built from one live read and one half-hour-old reading is not live, so it
does not get to say it is.

### Prove your integration degrades correctly

Ask the operator for a chaos token, then break their provider inside your own
test:

```js
import { withChaos, assertDegraded } from '@three-ws/brownout';
import { test } from 'node:test';

const token = process.env.BROWNOUT_CHAOS_TOKEN;

test('our token page still renders when their price provider is throttled', async () => {
  const brokenFetch = withChaos({ 'dexscreener:tokens': 'http:429' }, { token });

  const res = await brokenFetch(
    'https://three.ws/api/ca2x402/resolve?mint=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
  );

  assertDegraded(res, {
    status: 200,
    tier: ['stale', 'fallback'],
    // The assertion that actually matters, see below.
    exercised: ['dexscreener:tokens'],
  });

  const page = renderTokenPage(await res.json());
  assert.match(page, /as of/); // your UI must admit the number is old
});
```

### The assertion that matters

`exercised` is the point of this package. Without it, a test like the one above
passes whenever a cache happened to be warm, which is exactly when it is telling
you nothing: the fault was accepted, no upstream call was made, and your fallback
never ran. `assertDegraded` refuses to pass in that case:

```
BrownoutAssertionError: `dexscreener:tokens` never failed during this request,
so the fallback under test never ran. A warm cache almost certainly answered
first: vary a parameter so the request misses it.
```

A test that cannot show the fault landing is not a green test. It is an untested
fallback with a green light on it.

## Faults

| spec | what the caller sees |
| --- | --- |
| `timeout` | the request aborts, exactly as a real deadline would |
| `network` | `TypeError: fetch failed` with `ECONNREFUSED` on `cause` |
| `http:429` | a real `429` response, with `Retry-After` |
| `http:503` | any 4xx or 5xx status you name |
| `empty` | a `200` with an empty body, the shape that breaks naive parsers |
| `slow:2000` | the real call, delayed, for timeout-budget tests |

Faults are scoped by name, and a directive for a provider covers every call
shape it serves: breaking `birdeye` also breaks `birdeye:txs`.

## Safety

Fault injection is a switch that makes a live service misbehave, so the server
side gates it hard and this package cannot get around any of it:

- **A token is required**, compared in constant time. If the operator has not
  configured one, the feature is off everywhere, including locally.
- **Money paths are refused outright.** A request carrying a payment header, or
  addressed to a settlement route, is never faulted, whoever holds the token.
- **Read-shaped methods only.**
- **One request, one caller.** Nothing global changes, so a probe against a
  production service cannot touch anybody else's request.

Always check `chaosOutcome(res).applied` (or let `assertDegraded` do it) before
drawing a conclusion. A refused directive means the request ran normally.

## API

| export | purpose |
| --- | --- |
| `parseProvenance(res)` | parse the headers; `null` when no upstream was touched |
| `isStale(prov)` | the answer is older than intended, or came from a substitute |
| `failedSources(prov)` | the sources that did not answer, in order |
| `describeProvenance(prov)` | a one-line summary for a log or a status pill |
| `withChaos(faults, { token, fetch })` | a `fetch` that injects faults on every call |
| `chaosHeaders(faults, token)` | just the headers, for your own client |
| `chaosOutcome(res)` | did the server apply the directive, and if not why |
| `assertDegraded(res, expect)` | assert status, tier, degradation and exercise |
| `TIERS` | the freshness lattice, best first |

## The wire format

Two headers, single-line ASCII, stable:

```http
x-brownout: v=1;tier=stale;sources=3;ok=1;failed=2;ms=512;degraded=1
x-brownout-trace: birdeye;o=429;t=412, tokens-xyz;o=timeout;t=8000, dex;o=ok;t=88
```

The summary is on every response that touched an upstream. The trace appears
only when something degraded, so a healthy response stays cheap. `degraded` is
true when a source failed over **or** the answer is stale; an ordinary cache hit
is not degraded, because if it were, almost every response on a healthy service
would be flagged and the signal would be worthless.

See the live registry and its proof receipts at
[three.ws/brownout](https://three.ws/brownout).

## License

Apache-2.0
