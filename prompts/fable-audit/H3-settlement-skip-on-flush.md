# H3 — High (latent): Settlement silently skipped when a paid handler flushes its own response

**Severity:** High (latent — not exploitable today) · **Area:** Payments · **Commit-gate:** no

## The defect
[api/_lib/x402-paid-endpoint.js:875-878](../../api/_lib/x402-paid-endpoint.js):

```js
if (res.writableEnded) {
  if (ownsReservation) await releaseSlot({ route, paymentId });
  return;               // <-- returns BEFORE settlePayment()
}
let settled;
try { settled = await settlePayment({ verified }); } ...
```

The x402 broadcast happens in `settlePayment`, which runs *after* this branch. Any
paid handler that streams or ends its own body (binary download, `res.pipe`, SSE)
delivers the good and hits this branch — returning **without ever settling**. The
buyer keeps their funds and gets the good for free.

## Why it matters
Not exploitable today: every current `api/x402/*` handler returns a JSON value and
lets the wrapper settle+respond (the one `res.end` in `three-intel.js:239` is an MPP
branch that settles first). But it is a landmine — the natural shape for
`asset-download` / `animation-download` streaming endpoints is exactly a
self-flushing handler, so the first such endpoint silently ships as free.

## The fix
Make self-flush safe by construction. Preferred: settle **before** the handler can
flush for routes that stream — i.e. verify → settle → then hand the response to the
streaming handler. Minimal defensive version: fail loudly instead of silently
skipping:

```js
if (res.writableEnded) {
  if (ownsReservation) await releaseSlot({ route, paymentId });
  // A handler that flushed its own body must have settled first, or the good
  // was delivered without payment. Treat an unsettled flush as an error.
  logPaymentEvent({ eventType: 'payment_unsettled_flush', route, paymentId });
  throw new Error('handler flushed response before settlement');
}
```

If you introduce a legitimate settle-then-stream path, gate it on an explicit
per-route opt-in flag so the default stays fail-safe.

## Verification
1. Add a test: a mock handler that calls `res.end()` before returning → the wrapper
   must either have settled or must throw/log, never silently return.
2. Confirm all existing JSON-returning handlers still settle normally.

## Done checklist
- [ ] Self-flush path settles first or throws — never silently returns unsettled.
- [ ] Test covering a self-flushing handler added.
- [ ] Existing endpoints unaffected.
