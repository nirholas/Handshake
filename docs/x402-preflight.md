# x402 Preflight

**Ask an x402 seller whether it can actually settle, before you sign anything.**

- Try it: [three.ws/preflight](https://three.ws/preflight)
- Live attestation: [three.ws/.well-known/x402-preflight](https://three.ws/.well-known/x402-preflight)
- Client: [`@three-ws/x402-preflight`](../packages/x402-preflight)
- Wire contract: [specs/x402-preflight.md](../specs/x402-preflight.md)

---

## The gap this closes

x402 answers *what does this resource cost*. It has no way to answer *can this
seller complete the transaction it is charging for*. The two questions share a
happy path and diverge only after the buyer has committed:

1. Your agent `GET`s a paid route and gets `402` with a price.
2. Your agent signs a USDC transfer and retries with `X-PAYMENT`.
3. The seller cannot settle. Your agent gets `502`, having burned a signature, a
   blockhash and two round trips.

In the sponsored-fee model **your funds were never the problem**. The broken
thing belongs to the seller: an empty fee wallet, an unreachable facilitator, an
over-quota RPC. You had no way to see any of it before paying.

We know because we were the broken seller. On 2026-08-28 the three.ws fee sponsor
held 0.000899107 SOL against a 0.02 SOL floor, which is 0.0000082 SOL of
spendable headroom, less than two transaction fees. Every transaction it fee-paid
died at simulation with `InsufficientFundsForRent`. **95 payment attempts, 0
settled, three hours.** Every one of those was predictable from state our server
already had and was not publishing.

So we published it, signed it, and wrote the client that reads it.

## Using it

### From an agent

```bash
npm i @three-ws/x402-preflight
```

```js
import { guardedFetch } from '@three-ws/x402-preflight';

// A drop-in fetch that will not spend your money on a seller who cannot deliver.
const fetch402 = guardedFetch({ prefer: ['solana:mainnet'] });

await fetch402('https://three.ws/api/x402/echo');
```

Before the request that could trigger payment, the seller's attestation is
fetched once (cached for its own lifetime), verified offline, and either the
request goes through on a rail that works, or it throws before your agent signs
anything.

Want the verdict rather than the guard:

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

### From a terminal

```bash
npx @three-ws/x402-preflight https://three.ws
```

```
https://three.ws  signed by 87ZCUMTEaXopUJtQoaFcrk7TrxJBtfd4F9RvkqgrQ4Bc
  attestation verified, valid for another 60s

  NOT PAYABLE   solana:mainnet
    reason   sponsor_below_floor
    settle   0.0% of 76 attempts over 3h (confidence 0.88)
    retry    after 300s
```

The exit code is the answer, so it composes: `0` payable, `1` verified and not
payable, `2` unverifiable.

```bash
npx @three-ws/x402-preflight https://three.ws --network solana:mainnet && ./pay.sh
```

### From a conversation

The MCP tool `x402_preflight` is free, read-only, and needs no wallet or account.
Any agent connected to the three.ws MCP server can ask about **any** origin:

> Before you pay that endpoint, check whether it can settle.

It returns the verdict per network with the reason in plain language, the
suggested retry delay, and any other rail on the same seller that does work.

### From a browser

[three.ws/preflight](https://three.ws/preflight) checks any origin you paste and
verifies the signature **in your browser**, not on our server. A status page you
have to trust is worth nothing; this one you can check with devtools open.

## What you get back

```json
{
  "solana:mainnet": {
    "payable": false,
    "reason": "sponsor_below_floor",
    "retry_after": 300,
    "settle": { "rate": 0.0, "attempts": 76, "window_hours": 3, "confidence": 0.88 },
    "alternates": ["eip155:8453"]
  }
}
```

**`payable` is three-valued**: `true`, `false`, or `"unknown"`. A seller that
cannot determine its own state must answer `"unknown"` and must never answer
`true`. That asymmetry is the safety property of the format: acting on `true`
means an irreversible transfer, so a false `true` is expensive and a false
`"unknown"` costs a retry. Clients treat `"unknown"` as not payable by default.

**Every rate carries its window and sample.** A seller that settled 3 of 3
payments overnight reports 100%, which is indistinguishable from a proven rail
unless `attempts` travels with it. `confidence` is derived from the sample alone
and is capped below `1`.

**`alternates`** names the other networks on the same seller that are payable, so
your agent re-routes in the same round trip instead of discovering the outage one
failed payment at a time.

## Why it is signed

An unsigned health endpoint is a courtesy. A signed, time-bounded one is
evidence, and three properties follow that a status page cannot give you:

- **Attributable.** A client that paid after reading `payable: true` holds a
  statement signed by the seller's own key saying the seller believed it could
  settle, at a stated instant. Between autonomous agents transacting with
  strangers, that is the difference between "it broke" and "you said it would
  work".
- **Unreplayable.** Every attestation carries `expires_at`, and verification
  *rejects* an expired one. A seller cannot serve a cached healthy attestation
  through an outage.
- **Relayable.** Because it verifies offline against a public key, a registry or
  an index can cache and forward attestations without becoming trusted.
  Discovery can rank sellers by measured settleability rather than by
  self-description.

Verification checks the signature, re-derives the digest from the report bytes,
enforces expiry and rejects a future timestamp, and pins the subject to the
origin you asked about. All of it happens before any field is readable, because
a check a caller can forget is one that will be forgotten.

## Serving one from your own endpoint

The format is open and unencumbered. Nothing routes through three.ws, and a
client needs no coordination with you.

1. Generate an ed25519 keypair; publish the public key wherever you already
   publish identity.
2. Answer `GET /.well-known/x402-preflight` with a signed envelope built from
   whatever settlement health you already measure.
3. Keep the TTL short. A long TTL is a weaker assurance, not a stronger one.

If you measure nothing yet, report `"unknown"`. That is honest and still useful:
a client learns you are not claiming health you cannot back up.

The full normative contract, including the canonicalization rules and the
verification steps a conforming client must perform, is in
[specs/x402-preflight.md](../specs/x402-preflight.md). The reference server is
[api/x402/preflight.js](../api/x402/preflight.js) and the pure format core is
[api/_lib/x402/preflight.js](../api/_lib/x402/preflight.js), both under 300
lines.

## What it does not promise

- **Not a guarantee.** It is the seller's signed, timestamped best assessment. A
  rail can fail in the seconds after it signs.
- **Not a reputation system.** It reports current settleability, not honesty or
  history. It is an input a reputation system could use.
- **It does not stop a seller lying.** It makes lying attributable.

## Related

- [docs/x402.md](x402.md) walks the payment flow itself.
- [docs/mcp.md](mcp.md) covers connecting an agent to the three.ws MCP server.
- [specs/x402-preflight.md](../specs/x402-preflight.md) is the wire contract.
