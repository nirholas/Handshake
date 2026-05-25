# Fix: pump-agent-stats cron — 7,000+ 504 timeouts due to Solana RPC rate limiting

## Context

The `pump-agent-stats` cron job is completely broken in production, producing 7,200+ 504 timeout errors across all deployments (`3dagent-lkvpaeq68` alone has 4,085). The cron runs every minute and times out on Vercel's 30-second limit every single invocation without doing useful work.

Vercel logs:
```
Server responded with 429 Too Many Requests. Retrying after 500ms delay...
Server responded with 429 Too Many Requests. Retrying after 1000ms delay...
Server responded with 429 Too Many Requests. Retrying after 2000ms delay...
Server responded with 429 Too Many Requests. Retrying after 4000ms delay...
Vercel Runtime Timeout Error: Task timed out after 30 seconds
```

## Root Cause

Read `api/cron/[name].js` at `handlePumpAgentStats` (line 687) and `pumpStatsSnapshotMint` (line 806) before touching anything.

`pumpStatsSnapshotMint` calls `getRpcFallback({ network })` which is implemented in `api/_lib/pump.js`:

```javascript
const RPC_MAINNET = () => process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
```

When `SOLANA_RPC_URL` is not set in the Vercel environment, every RPC call goes to the public `https://api.mainnet-beta.solana.com` endpoint, which is aggressively rate-limited and returns 429 on almost every call in production-scale usage.

The retry delays (500ms → 1s → 2s → 4s = 7.5s per mint) burn through the 22-second deadline before completing even 2 mints. The handler already has a deadline check and circuit breaker (3 consecutive 429s triggers early exit), but they only work correctly when the RPC succeeds on at least some calls. When every call returns 429 immediately, the circuit breaks after 3 mints and skips the rest — still logging errors and never making progress.

**This is fundamentally an infrastructure configuration problem.** The code is correct. The fix is to set a paid, private Solana RPC endpoint.

## What You Must Fix — Completely

### Step 1: Provision a paid Solana RPC endpoint

Options (in order of preference):
1. **Helius** (https://helius.dev) — best support for `getSignaturesForAddress` used in `pumpStatsSnapshotMint`. Free tier includes 100k credits/day.
2. **QuickNode** (https://quicknode.com) — reliable, paid plans.
3. **Triton One** (https://triton.one) — performance-focused.

Sign up, create a mainnet-beta endpoint, and get the HTTPS endpoint URL. It will look like:
- Helius: `https://mainnet.helius-rpc.com/?api-key=<YOUR_KEY>`
- QuickNode: `https://<name>.solana-mainnet.quiknode.pro/<KEY>/`

### Step 2: Set SOLANA_RPC_URL in Vercel

```bash
vercel env add SOLANA_RPC_URL production
# paste the RPC endpoint URL when prompted
```

Also add to `.env` for local dev:
```
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=<YOUR_DEV_KEY>
```

Optionally set a separate devnet endpoint:
```bash
vercel env add SOLANA_RPC_URL_DEVNET production
```

### Step 3: Verify the RPC is in use

After setting the env var, trigger a manual cron invocation:
```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://three.ws/api/cron/pump-agent-stats
```

Expected response: `{"scanned":N,"updated":M,"errors":0,"graduations":0,"timeouts":0,"rate_limited":0,"skipped":0}` with `updated > 0`.

### Step 4: Code guard — add per-mint RPC timeout

Read `pumpStatsSnapshotMint` (line 806) and confirm the `getSignaturesForAddress` call is wrapped. If not, add a per-call AbortSignal so an individual RPC call can't hang indefinitely:

```javascript
const conn = getRpcFallback({ network });
const sigs = await conn.getSignaturesForAddress(mintPk, { limit: 50 }, 'confirmed');
```

The existing `Promise.race` timeout in the outer loop (`PUMP_STATS_MINT_TIMEOUT_MS`) already guards this, but confirm `PUMP_STATS_MINT_TIMEOUT_MS` is defined and set to a value less than `22_000 / PUMP_STATS_MAX_PER_RUN`.

### Step 5: Confirm existing safeguards are working

After deploying with the real RPC:
- The deadline check at line 704 (`DEADLINE = Date.now() + 22_000`) must still function — do not remove it.
- The circuit breaker at line 713 (`consecutiveRateLimit >= 3`) must still function — do not remove it.
- On a paid RPC with proper rate limits, both safeguards should rarely trigger.

### Step 6: Redeploy and monitor

```bash
# After adding env var, trigger redeploy
vercel deploy --prod
```

Monitor for 5 minutes after deploy. Vercel logs for `pump-agent-stats` should show:
- No more "429 Too Many Requests" messages
- No more "Task timed out after 30 seconds"
- Valid JSON report responses

## Do Not

- Do not reduce `ERC8004_BLOCK_CHUNK` or modify the circuit breaker logic — those are unrelated to the 429 problem.
- Do not add a `X402_ALLOW_MEMORY_FALLBACK=1` style workaround — the RPC must be a real paid endpoint.
- Do not use `https://api.mainnet-beta.solana.com` in production — it will rate-limit immediately.
- Do not mock the Pump.fun or Solana calls — this cron must call real endpoints.

## Related Files

- `api/_lib/pump.js:23` — `RPC_MAINNET` fallback to public endpoint
- `api/cron/[name].js:687` — `handlePumpAgentStats`
- `api/cron/[name].js:806` — `pumpStatsSnapshotMint` (RPC call at line 867)

The code change (if any) is minimal — just an env var configuration. The primary fix is infrastructure.
