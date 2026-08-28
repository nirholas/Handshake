# x402 Preflight, version 1

A signed, time-bounded statement that an x402 seller can currently **settle**
what it charges for.

This is a wire contract, not a tutorial. It is written so that an implementation
that has never seen three.ws code can serve and verify a conforming attestation.
The format is unencumbered: implement it, ship it, no permission required.

- Report profile: `x402-preflight/1`
- Envelope version: `threews.x402.preflight.v1`
- Well-known path: `/.well-known/x402-preflight`
- Reference implementation: [api/_lib/x402/preflight.js](../api/_lib/x402/preflight.js)
  (server), [packages/x402-preflight](../packages/x402-preflight) (client)
- Human page: [/preflight](https://three.ws/preflight) · guide: [docs/x402-preflight.md](../docs/x402-preflight.md)

---

## 1. The problem

x402 answers *what does this resource cost*. It has no way to answer *can this
seller complete the transaction it is charging for*. The two questions share a
happy path and diverge only after the buyer has already committed:

1. Client `GET`s a paid route and receives `402` with a price and accepts.
2. Client signs a transfer and retries with `X-PAYMENT`.
3. Server cannot settle. The client gets `502`, having burned a signature, a
   blockhash and two round trips.

In the sponsored-fee model the buyer's own funds are fine. The broken thing
belongs to the **seller** (an empty fee wallet, an unreachable facilitator, an
over-quota RPC), and the buyer has no way to see it before paying.

three.ws was that seller on 2026-08-28: the fee sponsor held 0.000899107 SOL
against a 0.02 SOL floor, and every transaction it fee-paid failed simulation
with `InsufficientFundsForRent`. 95 payment attempts, 0 settled, three hours.
Every one of those was predictable from state the server already had.

Preflight closes the gap the way CORS preflight closes its own: one cheap,
cacheable request before the expensive one, answered from state the server
already computes.

## 2. Serving an attestation

A conforming seller answers `GET /.well-known/x402-preflight` with
`application/json`.

Query parameters, all optional:

| Parameter | Meaning |
|---|---|
| `network` | CAIP-2 id. `404` with an `offered` array if this origin does not offer it. |
| `endpoint` | Path of a specific route, echoed into `report.endpoint`. |
| `ttl` | Requested validity in seconds. Clamped to the server's maximum. |

Responses:

| Status | Meaning |
|---|---|
| `200` | A signed envelope (§3). |
| `404` | This origin does not implement preflight, or does not offer the requested network. |
| `503` | The seller cannot sign right now. **It MUST NOT return an unsigned report.** An unsigned report is not an assurance, and a client that accepted one would be worse off than one that got nothing. |

The response SHOULD be cacheable for exactly the attestation's remaining
lifetime and no longer (`cache-control: public, max-age=<remaining>,
must-revalidate`). A shared cache serving it one second past expiry hands
clients a document that fails verification.

The endpoint MUST be free, unauthenticated, and cheap. An assurance check that
costs money or requires a key is one nobody calls, and one nobody calls prevents
nothing.

## 3. The envelope

```json
{
  "spec": "threews.x402.preflight.v1",
  "report": { "...": "see §4" },
  "issuer": "<base58 ed25519 public key>",
  "signedAt": "2026-08-28T03:14:15.926Z",
  "digest": "<sha256 hex>",
  "algorithm": "ed25519",
  "signature": "<base58 ed25519 signature>"
}
```

### 3.1 Canonicalization

The digest is taken over a canonical JSON encoding of
`{ report, issuer, signedAt }`:

- object keys sorted lexicographically, recursively
- properties whose value is `undefined` omitted
- no insignificant whitespace
- arrays keep their order

Signer and verifier MUST produce byte-identical input. This is the one
representation that may be hashed.

### 3.2 Digest and signature

```
digest    = sha256_hex(canonical({ report, issuer, signedAt }))
message   = utf8("threews.x402.preflight.v1:" + digest)
signature = base58(ed25519_sign(message, secret_key))
```

The envelope version is mixed into the signed message as a **domain separator**.
Without it, a signature produced for a preflight report could be replayed as
some other statement signed by the same identity.

`ed25519` is the only defined algorithm. A verifier MUST reject any other value
rather than ignoring the field.

## 4. The report

```json
{
  "$schema": "https://three.ws/schemas/x402-preflight/1.json",
  "spec": "x402-preflight/1",
  "subject": "https://three.ws",
  "issued_at": "2026-08-28T03:14:15.926Z",
  "expires_at": "2026-08-28T03:15:15.926Z",
  "payable_any": true,
  "networks": {
    "solana:mainnet": {
      "payable": false,
      "reason": "sponsor_below_floor",
      "retry_after": 300,
      "settle": { "rate": 0.0, "attempts": 95, "window_hours": 3, "confidence": 0.9 },
      "alternates": ["eip155:8453"],
      "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "pay_to": "<recipient>"
    }
  }
}
```

| Field | Rule |
|---|---|
| `subject` | The origin this report speaks for. A verifier that knows which origin it asked MUST check it. |
| `issued_at` / `expires_at` | RFC 3339. Validity SHOULD be short (this implementation defaults to 60s, caps at 300s). |
| `networks` | Keyed by CAIP-2 id, the same identifier the `402` challenge uses, so a verdict maps to an accept without a translation table. |
| `payable_any` | True when at least one network is payable. Convenience only; it is inside the signature. |

### 4.1 `payable` is three-valued

`true`, `false`, or `"unknown"`. **A seller that cannot determine its own state
MUST answer `"unknown"` and MUST NOT answer `true`.**

This asymmetry is the safety property of the whole format. A client acting on
`true` makes an irreversible transfer, so a false `true` is expensive and a
false `"unknown"` costs a retry. Every failure path in a conforming
implementation degrades to `"unknown"`.

Clients SHOULD treat `"unknown"` as not payable by default.

### 4.2 `reason`

Machine-readable. Clients switch on it, so values may be added but never
repurposed.

| Reason | Meaning |
|---|---|
| `ok` | Settling normally. |
| `sponsor_below_floor` | The seller's fee wallet cannot pay network fees. **No buyer action can fix this.** |
| `settlement_degraded` | Recent settlements are failing. |
| `facilitator_unreachable` | The seller cannot reach its settlement facilitator. |
| `network_not_configured` | This origin does not accept payment on this network. |
| `rail_unavailable` | The payment rail itself is unavailable. |
| `unknown` | Not measurable right now. |

### 4.3 `settle`: a rate is never reported without its window

`{ rate, attempts, window_hours, confidence }`.

A rate without the sample behind it is a rumour. A seller that settled 3 of 3
payments overnight reports `rate: 1.0`, which is indistinguishable from a proven
rail unless `attempts` travels with it. `confidence` is derived from the sample
alone and is capped below `1`, because no finite sample proves the next payment
settles.

### 4.4 `alternates` and `retry_after`

`alternates` lists the other networks on **this same origin** that are payable,
so a client whose preferred rail is down re-routes within the same round trip
instead of discovering the outage one failed payment at a time. It is computed
by the server and covered by the signature so every consumer agrees on the same
fallback set.

`retry_after` is advisory back-off in seconds, so a fleet of agents meeting an
unpayable seller backs off instead of synchronising into a retry storm.

## 5. Verification (normative)

A verifier MUST perform all of these, and MUST NOT expose the report body to
application code unless every one passes:

1. `spec` equals `threews.x402.preflight.v1`.
2. `algorithm`, if present, equals `ed25519`.
3. `issuer`, `signature` and `signedAt` are present.
4. `report.spec` equals `x402-preflight/1`.
5. Recompute the digest from the report bytes; if `digest` is present it MUST
   match. This catches a body edited after signing before any curve arithmetic
   runs.
6. The signature verifies against `issuer` over the domain-separated message.
7. `report.expires_at` parses, and **now is not past it**, allowing a bounded
   clock skew (this implementation: 30s).
8. `report.issued_at`, if present, is not in the future beyond that same skew.
9. If the caller named an origin, `report.subject` matches it after
   normalization (scheme + host, case-insensitive, trailing slash ignored).

### 5.1 Expiry is part of verification, not a caller's responsibility

An expired attestation is **not** a valid one that happens to be old. Treating
it as valid is precisely the replay the format exists to prevent: a seller could
serve a cached healthy attestation straight through an outage. Verification that
returns "valid, but check the date yourself" will eventually be used by someone
who does not.

### 5.2 Verification never throws

A conforming verifier returns a verdict for every input, including `null`,
non-objects and hostile bodies. A paying agent's loop must not be crashable by a
malformed response from a seller.

## 6. What this format does NOT promise

Stated plainly, because an assurance format that oversells itself is worse than
none:

- **It is not a guarantee.** It is the seller's signed, timestamped best
  assessment. A seller can be wrong, and a rail can fail in the seconds after it
  signs.
- **It is not a reputation system.** It reports current settleability, not
  honesty, quality or history. It is an input a reputation system could use.
- **It does not protect against a malicious seller lying.** It makes lying
  *attributable*: a signed statement, bound to an instant, that the seller
  believed it could settle. In a marketplace of autonomous agents transacting
  with strangers, that is the difference between "it broke" and "you said it
  would work".

## 7. Adopting it

The wire format is deliberately small enough to implement in an afternoon
against any x402 server:

1. Generate an ed25519 keypair. Publish the public key wherever you already
   publish identity (a DID document, an agent card, a `.well-known` file).
2. Answer `GET /.well-known/x402-preflight` with a signed envelope built from
   whatever settlement health you already measure. If you measure nothing yet,
   report `"unknown"`. That is honest and still useful: a client learns you are
   not claiming health you cannot back up.
3. Keep the TTL short. A long TTL is not a stronger assurance, it is a weaker
   one.

Clients need no coordination with you: `@three-ws/x402-preflight` verifies any
conforming attestation from any origin, and passes through sellers that do not
publish one, so adoption is incremental in both directions.
