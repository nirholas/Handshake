# @three-ws/x402-preflight

**Ask an x402 seller whether it can actually settle, before you sign anything.**

x402 tells your agent what a resource *costs*. It says nothing about whether the
seller can currently *settle* what it charges. Those look identical right up
until your agent has already signed, and the difference is paid for by the buyer:
a burned signature, a consumed blockhash, a `502`, and no service.

```bash
npm i @three-ws/x402-preflight
```

```js
import { guardedFetch } from '@three-ws/x402-preflight';

// A drop-in fetch that will not spend your money on a seller who cannot deliver.
const fetch402 = guardedFetch({ prefer: ['solana:mainnet'] });

const res = await fetch402('https://three.ws/api/x402/echo');
```

That's it. Before the request that could trigger payment, the seller's signed
payability attestation is fetched once (cached for its own lifetime), verified
offline, and either the request goes through on a rail that works, or it throws
before your agent signs anything.

---

## Why this exists

On 2026-08-28, three.ws was the broken seller. Its fee sponsor held 0.000899107
SOL against a 0.02 SOL floor, so every transaction it fee-paid died at simulation
with `InsufficientFundsForRent`. **95 payment attempts, 0 settled, three hours.**

Every one of those buyers could have known before signing, from state the server
already had. So we published the state, signed it, and wrote the client that
reads it.

## What you get

### `preflight(origin, opts?)`

Fetch and verify a seller's attestation. Throws `PreflightError` on transport
failure, a malformed body, or any check that does not pass.

```js
import { preflight } from '@three-ws/x402-preflight';

const { report } = await preflight('https://three.ws');
console.log(report.networks['solana:mainnet']);
// { payable: false, reason: 'sponsor_below_floor', retry_after: 300,
//   settle: { rate: 0, attempts: 95, window_hours: 3, confidence: 0.9 },
//   alternates: ['eip155:8453'] }
```

### `assertPayable(origin, network, opts?)`

Throw unless that rail can settle right now. The error carries everything you
need to recover without another round trip.

```js
import { assertPayable, PreflightError } from '@three-ws/x402-preflight';

try {
  await assertPayable('https://three.ws', 'solana:mainnet');
} catch (err) {
  if (err instanceof PreflightError) {
    err.reason;      // 'sponsor_below_floor'
    err.alternates;  // ['eip155:8453']   <- pay here instead
    err.retryAfter;  // 300               <- or come back in 5 minutes
  }
}
```

`unknown` counts as **not** payable. Your agent is about to make an irreversible
transfer, so the safe reading of "I cannot tell" is to not pay. Pass
`allowUnknown: true` to take the other trade-off, which is a decision worth
writing down at the call site.

### `guardedFetch(opts?)`

A `fetch` you can pass anywhere a `fetch` is accepted.

```js
const fetch402 = guardedFetch({
  prefer: ['solana:mainnet', 'eip155:8453'],
  onSkip: (info) => log.warn('seller unpayable', info),
});
```

- Preflights each origin once, cached for the attestation's lifetime.
- Picks your preferred rail when it works, the best alternative when it doesn't.
- Sets `x-preflight-network` so a seller can answer its `402` with only the
  accept you can actually pay, removing a negotiation round trip. Sellers that
  ignore it are unaffected.
- **Passes through origins that don't publish an attestation.** That's the entire
  existing x402 ecosystem, and refusing it would make this unusable on day one.
  Set `requirePreflight: true` to fail closed instead.

### `verifyPreflight(envelope, expect?)`

The trust boundary, exported on its own from `@three-ws/x402-preflight/verify`.
No I/O, no Node built-ins: it runs unchanged in a browser, a service worker and
on an edge runtime.

```js
import { verifyPreflight } from '@three-ws/x402-preflight/verify';

verifyPreflight(envelope, { subject: 'https://three.ws', issuer: KNOWN_KEY });
// { valid: true, reason: 'ok', issuer: '...', digest: '...', expired: false }
```

It checks all of this, so you cannot forget one:

- the ed25519 signature against the issuer key in the envelope
- the digest, re-derived from the report bytes, so a body edited after signing is
  caught before any curve arithmetic runs
- **expiry**, because an expired attestation is not a valid one that happens to
  be old (see below)
- that the report was not stamped in the future
- that `subject` is the origin you asked about, when you say which

It never throws. A hostile seller must not be able to crash a paying agent's
loop, so every input returns a verdict.

## The CLI

```bash
npx @three-ws/x402-preflight https://three.ws
```

```
https://three.ws  signed by 8k2n…Wq4
  attestation verified, valid for another 47s

  NOT PAYABLE   solana:mainnet
    reason   sponsor_below_floor
    settle   0.0% of 95 attempts over 3h (confidence 0.9)
    retry    after 300s
    instead  eip155:8453

  PAYABLE       eip155:8453
    reason   ok
    settle   98.0% of 412 attempts over 3h (confidence 0.98)
```

Exit codes are the point, so it composes:

| Code | Meaning |
|---|---|
| `0` | Payable |
| `1` | Verified, and **not** payable |
| `2` | Could not be verified (no attestation, bad signature, expired, timeout) |

```bash
npx @three-ws/x402-preflight https://three.ws --network solana:mainnet && ./pay.sh
```

`--json` prints the raw envelope for `jq`. `--issuer <pubkey>` pins the signer
you trust. `--timeout <ms>` bounds a slow seller.

## Why the attestation is signed

An unsigned health endpoint is a courtesy. A signed, time-bounded one is
evidence, and three properties follow that a status page cannot give you:

**Attributable.** A client that paid after reading `payable: true` holds a
statement signed by the seller's own key saying the seller believed it could
settle, at a stated instant. Between autonomous agents transacting with
strangers, that is the difference between "it broke" and "you said it would
work".

**Unreplayable.** Every attestation carries `expires_at`, and verification
*rejects* an expired one. A seller cannot serve a cached healthy attestation
through an outage, and an attacker who captures one cannot replay it later.

**Relayable.** Because it verifies offline against a public key, a registry or an
index can cache and forward attestations without becoming trusted. Discovery
services can rank sellers by measured settleability instead of by
self-description.

## Honesty rules the format enforces

- `payable` is **three-valued**: `true`, `false`, `"unknown"`. A seller that
  cannot determine its own state must say `"unknown"`, never `true`. Every
  failure path degrades to `"unknown"` rather than to a lie.
- Every rate carries its window and sample size. A seller that settled 3 of 3
  payments overnight reports 100%, which is indistinguishable from a proven rail
  unless `attempts` travels with it, so `confidence` is derived from the sample
  and capped below `1`.

## What it does not promise

- **Not a guarantee.** It is the seller's signed, timestamped best assessment. A
  rail can fail in the seconds after it signs.
- **Not a reputation system.** It reports current settleability, not honesty or
  history. It is an input a reputation system could use.
- **It does not stop a seller lying.** It makes lying attributable.

## Serving one yourself

The wire format is public and unencumbered. Any x402 seller can publish an
attestation and any client can verify it; nothing routes through three.ws.

Full contract, including the canonicalization rules and the normative
verification steps: [specs/x402-preflight.md][spec].

If you measure nothing yet, report `"unknown"`. That is honest and still useful:
a client learns you are not claiming health you cannot back up.

[spec]: https://github.com/nirholas/three.ws/blob/main/specs/x402-preflight.md

## License

Apache-2.0
