# Fix: cron/erc8004-crawl — multiple 504 timeouts (block chunk size and RPC timeouts)

## Context

The `erc8004-crawl` cron job times out on some deployments with 504 errors. The cron scans EVM chain logs for ERC-8004 agent registration events using `eth_getLogs` on public RPC endpoints. When the block range is too large or the RPC is slow, the function hits Vercel's timeout.

## Root Cause

Read `api/cron/[name].js` at `handleErc8004Crawl` (line 111) and `erc8004CrawlChain` (line 145) before touching anything.

The current `ERC8004_BLOCK_CHUNK = 2_000` is noted in the code comment: "Public RPCs typically allow 2000-block ranges; lower this if a chain's RPC rejects with 'block range'." The 504 timeouts may occur because:

1. **A specific chain's public RPC is slow** — some chains (e.g., Polygon, Arbitrum) have public RPCs with high latency or strict block range limits lower than 2000.
2. **Multiple chains are crawled in a single cron run** — if there are many chains in `CHAINS`, the total time across all of them exceeds `CRAWL_BUDGET_MS = 240_000` (240 seconds), but Vercel's actual function timeout for cron jobs may be lower.
3. **`erc8004EnrichMetadata` hangs** — the metadata enrichment step fetches external URLs for 25 agents per run. If any of those URLs hangs, the entire function waits.

## What You Must Fix — Completely

### Fix 1: Reduce ERC8004_BLOCK_CHUNK for slower chains

Read `erc8004CrawlChain` and the `CHAINS` array. Identify which chains are present.

For chains with known slow RPCs (Polygon, Base, Arbitrum, Optimism on free-tier public RPCs), reduce the chunk size. Either:

**Option A:** Reduce the global default:
```javascript
const ERC8004_BLOCK_CHUNK = 1_000; // Reduced from 2000 — safer for all public RPCs
```

**Option B:** Add per-chain chunk size override:
```javascript
// In the CHAINS array:
{ id: 137, name: 'polygon', rpcUrl: '...', registry: '...', blockChunk: 500 }

// In erc8004CrawlChain:
const chunkSize = chain.blockChunk || ERC8004_BLOCK_CHUNK;
const toBlock = Math.min(fromBlock + chunkSize - 1, latestBlock);
```

Option B is cleaner because it lets you tune per-chain without affecting well-functioning chains.

### Fix 2: Add per-RPC-call timeout via AbortSignal

Read `erc8004RpcCall` function. Verify it has a timeout. If not, add one:

```javascript
async function erc8004RpcCall(rpcUrl, method, params) {
    const resp = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(ERC8004_FETCH_TIMEOUT_MS), // already defined as 10_000
    });
    if (!resp.ok) throw new Error(`RPC ${resp.status}: ${method}`);
    const data = await resp.json();
    if (data.error) throw new Error(`RPC error: ${data.error.message || JSON.stringify(data.error)}`);
    return data.result;
}
```

The `ERC8004_FETCH_TIMEOUT_MS = 10_000` constant already exists — verify it's being used in the actual fetch call with `AbortSignal.timeout()`.

### Fix 3: Add per-metadata-URL timeout in erc8004EnrichMetadata

Read `erc8004EnrichMetadata`. Each external metadata URL fetch must have a timeout:

```javascript
const resp = await fetch(metadataUrl, {
    signal: AbortSignal.timeout(5_000), // 5 seconds max per metadata URL
});
```

If a metadata URL hangs (e.g., IPFS gateway slow), it must not block the entire enrichment batch.

### Fix 4: Verify CRAWL_BUDGET_MS is respected for Vercel's actual limit

The `CRAWL_BUDGET_MS = 240_000` assumes a 300-second Vercel timeout (the maximum for Pro plan cron jobs). Verify in `vercel.json` that the `erc8004-crawl` function has `"maxDuration": 300` set:

```json
"functions": {
    "api/cron/[name].js": {
        "maxDuration": 300
    }
}
```

If `maxDuration` is not set, the default is 10 seconds (hobby) or 60 seconds (Pro) — far less than 240 seconds. The budget check at line 125 (`Date.now() - crawlStart > CRAWL_BUDGET_MS`) would never fire before Vercel kills the function.

### Verify the fix

1. After making the changes, trigger the cron manually:
   ```bash
   curl -H "Authorization: Bearer $CRON_SECRET" https://three.ws/api/cron/erc8004-crawl
   ```
2. Must return a valid JSON report within 30 seconds: `{"chains":[...],"enriched":N,"errors":[]}`
3. No 504 responses in Vercel logs for this cron after deploy

## Do Not

- Do not set `ERC8004_BLOCK_CHUNK = 0` or skip the crawl — it must scan real on-chain data
- Do not increase `CRAWL_BUDGET_MS` beyond 270_000 (270s) — leave at least 30 seconds of margin before Vercel's hard kill
- Do not remove the chain-level error handling in `erc8004CrawlChain` — one chain failing must not abort all others

## Related Files

- `api/cron/[name].js:96` — `ERC8004_BLOCK_CHUNK` constant
- `api/cron/[name].js:111` — `handleErc8004Crawl`
- `api/cron/[name].js:145` — `erc8004CrawlChain`
- `api/cron/[name].js:106` — `ERC8004_FETCH_TIMEOUT_MS`
- `vercel.json` — `maxDuration` for the cron function
