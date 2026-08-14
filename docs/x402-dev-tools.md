# x402 Developer Tools

A free test bench for building and debugging x402 integrations against a live
server. Six tools (three free diagnostics plus three paid probe endpoints)
that let you inspect what the server sees, understand why a payment was
rejected, and confirm a receipt.

The three diagnostic tools are **free and keyless**, rate-limited to
**30 requests/minute per IP**. The three probe endpoints are paid
($0.001 USDC each).

Base URL: `https://three.ws`

---

## The three free diagnostics

### 1. Echo — `POST /api/x402/echo`

httpbin for x402. Returns exactly what your request looked like from the
server's perspective: method, the headers that matter for a paid call, and your
body. If an `X-PAYMENT` header is present (or you pass `paymentHeader` in the
body), it is base64-decoded and echoed back with **every signature and secret
redacted to a short prefix**, plus the rail's local verification verdict — the
same pre-facilitator checks a real paid endpoint runs — **without settling or
charging anything**.

Pass a `requirement` (one `accepts[]` entry) to have the verdict check your
signed amount and recipient against it:

```bash
curl -s https://three.ws/api/x402/echo \
  -H 'content-type: application/json' \
  -d '{
    "paymentHeader": "<base64 X-PAYMENT value>",
    "requirement": { "amount": "10000", "payTo": "0x…", "network": "eip155:8453" }
  }'
```

Response (abridged):

```json
{
  "ok": true,
  "method": "POST",
  "headers": { "x-payment": "eyJ4NDAyVm…(redacted, 512 chars)" },
  "payment": {
    "x402Version": 2,
    "scheme": "exact",
    "network": "eip155:8453",
    "signedAmount": "10000",
    "signedRecipient": "0x75d0…cf69",
    "envelope": { "payload": { "signature": "0xdededede…(redacted, 132 chars)" } },
    "verdict": { "valid": true, "checks": [ … ] },
    "note": "Local pre-facilitator verdict only — no facilitator round-trip, no settlement, no charge."
  }
}
```

You can also send the payment as a real `X-PAYMENT` header instead of in the
body — the header wins when both are present. The full signature is never
returned; only a prefix, so the echo is safe to paste into a bug report.

### 2. Debug — `POST /api/x402/debug`

Paste any subset of a failed exchange and get a structured diagnosis keyed to
the failure modes this server's rail actually produces. Each finding is
`{ severity, field, problem, fix }`, ordered most-severe first.

```bash
curl -s https://three.ws/api/x402/debug \
  -H 'content-type: application/json' \
  -d '{
    "challenge": { "x402Version": 2, "accepts": [{ "scheme": "exact", "network": "eip155:8453", "amount": "10000", "payTo": "0x…" }] },
    "payment":   { "x402Version": 1, "network": "base", "payload": { "authorization": { "value": "0.01", "to": "0x…" } } },
    "response":  { "error": "invalid_payment" }
  }'
```

Response:

```json
{
  "ok": false,
  "count": 5,
  "findings": [
    { "severity": "error", "field": "payment.x402Version", "problem": "payment declares x402Version 1; server requires 2", "fix": "Set x402Version: 2." },
    { "severity": "error", "field": "payment.network", "problem": "network \"base\" is a shorthand, not the CAIP-2 id the rail matches on", "fix": "Use \"eip155:8453\"." },
    { "severity": "error", "field": "payment.network", "problem": "you signed for \"base\" but the challenge only offers [eip155:8453]", "fix": "Pick one of the offered networks and re-sign against that accepts[] entry." },
    { "severity": "error", "field": "payment.authorization.value", "problem": "value \"0.01\" contains a decimal point", "fix": "Authorization value is atomic units as an integer string (\"10000\"), not a decimal token amount." },
    { "severity": "info", "field": "response.error", "problem": "server returned \"invalid_payment\"", "fix": "The payload was structurally valid but failed a check — usually underpayment, wrong payTo, or a malformed authorization. Run /api/x402/echo on your header to see the decoded amount/recipient." }
  ]
}
```

Common footguns it catches: wrong `x402Version`, shorthand instead of CAIP-2
network ids, signing for a network the challenge doesn't offer, decimal amounts
where atomic-unit integer strings are required, underpayment, and a missing
`accepts[]` array.

### 3. Verify receipt — `POST /api/x402/verify-receipt`

Two independent checks; supply either or both. The response says exactly what
was and wasn't verifiable.

**Attestation integrity** — pass a three.ws paid response carrying a
`sha256:…` attestation (e.g. from [`/api/x402/fact-check`](/docs/x402-endpoints)).
The digest is recomputed over the committed fields; if any was altered after
signing, the recomputed digest won't match.

```bash
curl -s https://three.ws/api/x402/verify-receipt \
  -H 'content-type: application/json' \
  -d '{ "result": { "verdict": "true", "confidence": 0.92, "claim": "…", "sources": ["https://…"], "attestation": "sha256:…" } }'
```

```json
{ "ok": true, "attestation": { "verified": true, "scheme": "sha256", "recomputed": "sha256:…", "claimed": "sha256:…" } }
```

**Settlement confirmation** — pass `{ tx: { hash, network } }` for a read-only
on-chain lookup confirming the settlement transaction exists and is confirmed.
`network` is CAIP-2 (`solana:…`, `eip155:8453`) or shorthand (`solana`, `base`).
An unreachable RPC is reported as `status: "rpc_unavailable"`, never a false
`confirmed`.

```bash
curl -s https://three.ws/api/x402/verify-receipt \
  -H 'content-type: application/json' \
  -d '{ "tx": { "hash": "<signature or txhash>", "network": "solana" } }'
```

```json
{ "ok": true, "settlement": { "verified": true, "status": "confirmed", "detail": "settlement confirmed on Solana", "slot": 301234567 } }
```

The settlement check also works over a plain `GET`, so you can confirm a
settlement from a browser address bar, a `curl` one-liner, or an uptime probe
with no request body:

```bash
curl -s 'https://three.ws/api/x402/verify-receipt?hash=<signature or txhash>&network=solana'
```

Attestation integrity stays `POST`-only, because it needs the whole attested
object. When a `POST` body supplies `tx`, the body wins over the query string.

---

## The three probe endpoints

These already existed; the docs are consolidated here.

### Schema check — `POST /api/x402/schema-check` *(paid, $0.001 USDC)*

Fetches a named three.ws public JSON API and validates its response against the
declared schema, so a breaking change surfaces before consumers notice. Current
target: `changelog_json` (the `/changelog.json` feed).

```bash
# Requires an x402 payment; see docs/x402-buyer.md for the buyer flow.
curl -s https://three.ws/api/x402/schema-check -d '{ "api": "changelog_json" }'
```

### Rate-limit probe — `POST /api/x402/rate-limit-probe` *(paid, $0.001 USDC)*

Returns how many more calls the x402 autonomous loop can make to a target
endpoint today before hitting its daily USDC spend cap — `remaining_calls`,
`reset_at`, and `cooldown_active` — so an agent can throttle before it fails.

```bash
curl -s https://three.ws/api/x402/rate-limit-probe -d '{ "endpoint": "/api/x402/forge" }'
```

`endpoint` must be a metered route: a path under `/api/x402`, `/api/mcp`, or
`/api/ibm-mcp`. Those are the only routes that answer a 402 challenge, so they
are the only ones with a price to report; anything else is rejected `400
endpoint_not_metered` before the probe runs.

### Permit2 paid demo: `GET /api/x402/permit2-paid-demo` *(paid, $0.001 USDC)*

A target that advertises **only** the Permit2 + EIP-2612 gas-sponsoring accept
(no EIP-3009 fallback), so you can prove a wallet with USDC but zero native gas
can pay end-to-end through the gasless path. Use it to test a Permit2 client
implementation against a live server.

---

## Typical debugging loop

1. Your paid call fails. Copy the base64 `X-PAYMENT` header you sent.
2. `POST /api/x402/echo` with it → see the decoded amount, recipient, and the
   local verdict. If the verdict is invalid, the `reason` tells you which check
   failed.
3. Still unclear? `POST /api/x402/debug` with `{ challenge, payment, response }`
   → get an ordered fix list.
4. After a successful call, `POST /api/x402/verify-receipt` to confirm the
   attestation and settlement.

## Related

- [x402 Protocol](/docs/x402) - the challenge / verify / settle mechanics.
- [x402 Paid Endpoints](/docs/x402-endpoints) - the full catalog and pricing.
- [x402 Buyer Client](/docs/x402-buyer) - how to settle a challenge from code.
- [x402 Revenue & Receipts](/docs/x402-revenue) - how signed receipts are recorded.
