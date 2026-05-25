# Fix: POST /api/x402-pay — 2 × 503 (transient upstream payment service failure)

## Context

`POST /api/x402-pay` returned 503 (Service Unavailable) on 2 occasions. This is low volume (2 occurrences) but represents failed payment transactions — each 503 means a user's payment was not processed, which may or may not have debited their wallet.

## Root Cause

Read `api/x402-pay.js` in full before touching anything.

The 503 can come from:
1. **Coinbase x402 SDK upstream** — the payment settlement service returned 503 during the call to the Coinbase/x402 network
2. **Upstash Redis** — the feed/idempotency layer that `api/x402-pay.js` uses directly could be unavailable, returning 503
3. **A connected third-party service** (e.g., NFT minting, token transfer) being temporarily down

This is likely a transient infrastructure issue, not a code bug. However, the handler may not be retrying on transient 5xx from the upstream payment network before returning 503 to the client.

## What You Must Fix — Completely

### Step 1: Identify the exact source of the 503

Read `api/x402-pay.js` and trace what the handler calls:
1. Where does it interact with the x402 payment network?
2. What does it do with the Upstash Redis feed (`FEED_KEY = 'x402:pay:feed'`)?
3. Does the 503 come from a `res.status(503)` in the handler, or is it propagated from an upstream fetch?

Search for where the handler might return 503:
```bash
grep -n "503\|service_unavailable\|upstream\|settlement" api/x402-pay.js
```

### Step 2: Add retry logic for transient upstream 5xx

Wherever the handler makes an external HTTP call (to the Coinbase x402 network, a settlement API, or similar), add one retry on 503/504:

```javascript
async function fetchWithRetry(url, options, retries = 1) {
    const resp = await fetch(url, options);
    if ((resp.status === 503 || resp.status === 504) && retries > 0) {
        console.warn('[x402-pay] upstream', resp.status, '— retrying in 500ms');
        await new Promise(r => setTimeout(r, 500));
        return fetchWithRetry(url, options, retries - 1);
    }
    return resp;
}
```

Only retry transient errors (503, 504). Do NOT retry:
- 400/422 (bad payment request — client error)
- 402 (payment required — expected protocol response)
- 409 (conflict/duplicate — idempotency key already used)

### Step 3: Ensure idempotency before retry

The x402 protocol uses idempotency keys to prevent double-processing. Before adding retry logic, verify that:
1. The payment request includes an idempotency key in the upstream call
2. The retry sends the **same** idempotency key
3. The Upstash idempotency cache (see `api/_lib/x402/idempotency-cache.js`) is checked before the retry

If the upstream has already processed the payment and returns 503 for the settlement confirmation (not the payment itself), the retry is safe. If the 503 comes from the initial payment authorization, only retry if you're certain the first request did not go through.

### Step 4: Log the upstream response body on error

The current handler likely logs `console.error('[x402-pay]', err.message)` or similar. Enhance to include the upstream status and response body for future diagnosis:

```javascript
} catch (err) {
    const detail = err?.response ? `${err.response.status}: ${await err.response.text().catch(() => '')}`.slice(0, 300) : err?.message;
    console.error('[x402-pay] upstream failure:', detail);
    return error(res, 503, 'payment_upstream_error', 'Payment processing temporarily unavailable. Your card has not been charged. Please try again.');
}
```

The user-facing message is important — 503 from a payment endpoint must clearly tell users whether they were charged.

### Verify the fix

1. Start the dev server (`npm run dev`)
2. Simulate the payment flow with a test x402 request — must succeed on the first attempt
3. If you can simulate an upstream 503 (e.g., using a network intercept), verify the handler retries once and returns the upstream result, or returns a clear error on persistent failure

## Do Not

- Do not retry more than once — payment operations must be idempotent and minimal retries
- Do not swallow errors and return 200 — if payment fails, the response must reflect that
- Do not change the idempotency cache behavior

## Related Files

- `api/x402-pay.js` — the handler (primary fix target)
- `api/_lib/x402/idempotency-cache.js` — idempotency layer
