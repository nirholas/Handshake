# H1 — High: `premium/status` leaks any wallet's API keys + purchase history

**Severity:** High · **Area:** API authorization · **Commit-gate:** no

## The defect
[api/premium/status.js:18](../../api/premium/status.js) reads `?wallet=` with no
session and no ownership signature, then calls `passStatus(wallet)`
([api/_lib/premium.js:377](../../api/_lib/premium.js)), which returns for that
wallet: the last 24 `premium_passes` rows (`plan, asset, amount_atomics, usd_price,
tx_signature, started_at, expires_at`) **and** each linked API key's
`id, name, key_prefix, rate_limit_per_minute, expires_at, status`, plus usage
counters.

## Why it matters
Wallet addresses are public (on-chain, leaderboards, OG endpoints). Anyone can
enumerate a subscriber's **API-key inventory (names + prefixes), rate limits, usage
volume, and full purchase history**. Plaintext keys are never returned (hence High,
not Critical), but this is private, account-scoped data with the ownership check
omitted. The sibling [api/x402/my-receipts.js](../../api/x402/my-receipts.js)
correctly requires a fresh SIWS/SIWE signature for the same data class — this
endpoint is the same shape with the gate missing.

## The fix
Gate the sensitive fields behind wallet-ownership proof, mirroring `my-receipts.js`.
Unauthenticated callers get only the boolean pass state:

```js
// premium/status.js
const u = new URL(req.url, 'http://x');
const wallet = (u.searchParams.get('wallet') || '').trim();
const signature = (u.searchParams.get('signature') || '').trim();
const issuedAt = (u.searchParams.get('issuedAt') || '').trim();

const owns = await verifyWalletOwnership({ wallet, signature, issuedAt }); // same helper my-receipts uses
if (!owns) {
  const { active, pass } = await passStatus(wallet);
  return json(res, 200, { active, pass, resources: [], keys: [], history: [] },
    { 'cache-control': 'no-store' });
}
const status = await passStatus(wallet);
return json(res, 200, status, { 'cache-control': 'no-store' });
```

**Alternative (if the dev dashboard already holds a session):** require
`getSessionUser(req)` and confirm the wallet is linked to that user via
`user_wallets` before returning keys/history. Pick whichever the dashboard client
actually uses — check `src/dashboard*/` for how it calls this endpoint and keep the
happy path working.

## Verification
1. `GET /api/premium/status?wallet=<someone-elses>` (no signature) → returns only
   `{active, pass}`, no `keys`/`history`.
2. With a valid signature for the wallet → full payload.
3. The developer dashboard still renders keys for the signed-in owner.

## Done checklist
- [ ] Ownership proof required for keys/history.
- [ ] Public path returns only pass state.
- [ ] Dashboard client updated if it needs to pass the signature/session.
- [ ] `data/changelog.json` security entry added.
