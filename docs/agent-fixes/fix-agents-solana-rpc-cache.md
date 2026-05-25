# Fix: /api/agents/*/solana — Solana RPC 429 on wallet balance checks, no caching

## Context

Multiple `/api/agents/{id}/solana` endpoints log balance fetch failures with:

```
[agents/solana/wallet] balance fetch failed Error: failed to get balance of account X:
Error: 429 Too Many Requests: {"jsonrpc":"2.0","error":{"code":-32429,"message":"max usage reached"}}
```

The endpoints return 200 (not 500) but the wallet balance in the response is null or 0, which the frontend renders as "balance unavailable." This affects every user who views an agent's Solana wallet details.

Note: the 404s on `/api/agents/{uuid}/solana` are NOT a bug — those agents simply don't have Solana wallets registered. Only the 429-related balance failures need fixing.

## Root Cause

Read `api/agents/solana/_handlers.js` and `api/_lib/balances.js` in full before touching anything.

Wallet balance fetches call `connection.getBalance(pubkey)` using a `Connection` instance pointed at `SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'`. When `SOLANA_RPC_URL` is not set (same infrastructure gap as `fix-pump-agent-stats-rpc-429.md`), the public endpoint rate-limits at scale.

The secondary problem is that there is no caching — every page load triggers a fresh RPC call. Even with a paid RPC, hitting it on every request for popular agents is wasteful and fragile.

## What You Must Fix — Completely

### Fix 1: Set SOLANA_RPC_URL (infrastructure — same as pump-agent-stats fix)

If `SOLANA_RPC_URL` is not set in Vercel env, set it to a paid Helius or QuickNode endpoint. See `fix-pump-agent-stats-rpc-429.md` for provisioning instructions. A single paid RPC endpoint fixes both the pump-stats cron AND the agent wallet balance calls.

### Fix 2: Cache wallet balances to reduce RPC calls

In `api/_lib/balances.js` (or wherever `getBalance()` is called for agent wallets), wrap the fetch with a short-TTL cache using Upstash Redis:

```javascript
import { Redis } from '@upstash/redis';

const redis = process.env.UPSTASH_REDIS_REST_URL
    ? new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN })
    : null;

const BALANCE_TTL_SECONDS = 60;

export async function getCachedSolBalance(pubkeyStr, connection) {
    const cacheKey = `sol:balance:${pubkeyStr}`;

    if (redis) {
        const cached = await redis.get(cacheKey).catch(() => null);
        if (cached !== null) return Number(cached);
    }

    const lamports = await connection.getBalance(new PublicKey(pubkeyStr));

    if (redis) {
        await redis.set(cacheKey, lamports, { ex: BALANCE_TTL_SECONDS }).catch(() => {});
    }

    return lamports;
}
```

Replace direct `connection.getBalance()` calls with `getCachedSolBalance()`. A 60-second TTL means a popular agent's balance is fetched from RPC at most once per minute regardless of traffic.

If Upstash Redis is not available (see `fix-x402-upstash-redis.md`), use a module-level in-memory Map as fallback:

```javascript
const memCache = new Map(); // { pubkey → { value, expiresAt } }

function getMemCached(key) {
    const entry = memCache.get(key);
    return entry && Date.now() < entry.expiresAt ? entry.value : null;
}

function setMemCached(key, value, ttlMs) {
    memCache.set(key, { value, expiresAt: Date.now() + ttlMs });
}
```

The in-memory cache is per-instance (not shared across Vercel replicas) but still reduces RPC calls significantly for any single replica.

### Fix 3: Add 429 retry with exponential backoff for balance checks

In the balance fetch code, wrap the RPC call with a single retry on 429:

```javascript
async function fetchBalanceWithRetry(connection, pubkey, retries = 1) {
    try {
        return await connection.getBalance(pubkey);
    } catch (err) {
        if (retries > 0 && /429|rate.limit/i.test(err?.message || '')) {
            await new Promise(r => setTimeout(r, 500));
            return fetchBalanceWithRetry(connection, pubkey, retries - 1);
        }
        throw err;
    }
}
```

Do NOT retry more than once — the goal is to recover from a transient spike, not to loop on a systematically rate-limited endpoint.

### Fix 4: Return a graceful response on persistent 429

If the balance fetch fails after retry, return a response with `balance: null` and a `balance_error: 'rpc_rate_limited'` field rather than letting the error propagate:

```javascript
let balance = null;
let balanceError = null;
try {
    balance = await getCachedSolBalance(wallet, connection);
} catch (err) {
    balanceError = /429|rate.limit/i.test(err?.message || '') ? 'rpc_rate_limited' : 'rpc_error';
    console.warn('[agents/solana/balance]', err?.message);
}
```

The frontend should display "Balance unavailable" when `balance_error` is set, rather than showing 0 or crashing.

### Verify the fix

1. Start the dev server with a valid `SOLANA_RPC_URL` set in `.env`
2. Request `GET /api/agents/{id}/solana` for an agent with a registered wallet — must return 200 with a non-null balance
3. Make the same request twice in rapid succession — the second must return the cached value (confirm by checking that only one RPC call is made via logs or network tab)

## Do Not

- Do not cache indefinitely — use a TTL of 60 seconds maximum for balances (stale balances mislead users).
- Do not suppress all RPC errors — log them at WARN level so they appear when debugging.
- Do not return fake/hardcoded balances on error.

## Related Files

- `api/agents/solana/_handlers.js` — agent solana endpoint handlers
- `api/_lib/balances.js` — wallet balance fetching (primary fix target)
- `api/_lib/pump.js:23` — `SOLANA_RPC_URL` fallback pattern (reference)
- `fix-pump-agent-stats-rpc-429.md` — same infrastructure fix for SOLANA_RPC_URL
