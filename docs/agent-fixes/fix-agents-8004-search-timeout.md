# Fix: GET /api/agents/8004/search — 6 × 504 (subgraph query timeout)

## Context

`GET /api/agents/8004/search` returns 504 on 6 requests. The endpoint queries the Agent0 ERC-8004 subgraph (a Graph Protocol endpoint) for on-chain agent listings. When the subgraph is slow or the query is complex, the function exceeds Vercel's timeout.

## Root Cause

Read `api/agents/8004/search.js` in full before touching anything.

The search endpoint:
1. Calls `searchAgents()` from the agent0 SDK, which hits a Graph Protocol subgraph endpoint
2. Has a hard timeout guard that returns 504 when exceeded (visible at line 123)
3. Does NOT limit the subgraph query complexity — a text search (`q` param) triggers a more expensive query plan

The 504 occurs when:
- The subgraph RPC endpoint is slow (Graph Protocol hosted service has variable latency)
- The query includes text search (`q=...`) which requires a `CONTAINS` or `STARTS_WITH` filter on the subgraph, which is slower than a simple list
- The default timeout budget is too long, causing Vercel to kill the function before the internal timeout fires

## What You Must Fix — Completely

### Fix 1: Verify and tighten the timeout budget

Read `api/agents/8004/search.js` to find the `SUBGRAPH_TIMEOUT_MS` or equivalent constant. If the timeout is ≥ 8000ms, reduce it:

```javascript
const SUBGRAPH_TIMEOUT_MS = 6_000; // leave margin before Vercel's 10s default
```

The `Promise.race` against a timeout at line 123 should use this value. Vercel's default function timeout for free/hobby plans is 10 seconds; for Pro it's 60 seconds (but Vercel kills functions that are unresponsive faster than the nominal limit).

### Fix 2: Reduce default page size for search queries

Text search queries are more expensive. When `q` is provided, cap the `limit` lower:

```javascript
const hasQuery = q.length > 0;
const effectiveLimit = hasQuery
    ? Math.min(limit, 10)  // smaller result set for text searches
    : Math.min(limit, 50); // larger result set for simple listing
```

This reduces the data the subgraph must scan and transfer.

### Fix 3: Add pagination parameters correctly

Read line 92–94 in `api/agents/8004/search.js`. The endpoint accepts `limit` and `skip` params but the comment says the SDK's `searchAgents()` ignores `limit` at the subgraph level. If this is confirmed, pass `first` and `skip` directly to the GraphQL query instead of using the SDK's abstraction:

```javascript
// Instead of:
const agents = await sdk.searchAgents({ ... });

// Use direct GraphQL query with explicit pagination:
const query = `{
    agents(first: ${effectiveLimit}, skip: ${skip}, where: { ... }) {
        id
        name
        description
        ...
    }
}`;
const result = await fetch(subgraphUrl, { 
    method: 'POST', 
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(SUBGRAPH_TIMEOUT_MS)
});
```

This gives full control over the subgraph query plan.

### Fix 4: Return partial results on timeout instead of 504

Rather than returning 504 on timeout, return whatever was fetched before the deadline (or an empty array with a `timed_out: true` flag):

```javascript
let agents = [];
let timedOut = false;
try {
    agents = await Promise.race([
        fetchAgents(params),
        new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), SUBGRAPH_TIMEOUT_MS))
    ]);
} catch (err) {
    if (err.code === 'TIMEOUT') {
        timedOut = true;
        console.warn('[agents/8004/search] subgraph timeout, returning empty');
    } else {
        throw err;
    }
}

return json(res, 200, { agents, timed_out: timedOut, total: agents.length });
```

A 200 with `timed_out: true` is better UX than a 504 — the UI can show "Results may be incomplete" instead of an error page.

### Verify the fix

1. Start the dev server (`npm run dev`)
2. Request `GET /api/agents/8004/search?chain=8453` — must return 200 with a list of agents
3. Request `GET /api/agents/8004/search?chain=8453&q=defi` — must return 200 within 8 seconds (text search)
4. No 504 responses in Vercel logs after deploy

## Do Not

- Do not remove the timeout guard — subgraph endpoints can hang indefinitely without it
- Do not return 504 when a timeout occurs — return 200 with partial/empty results and `timed_out: true`
- Do not cache subgraph results indefinitely — use a TTL of 60s maximum since on-chain state changes

## Related Files

- `api/agents/8004/search.js` — the search handler (primary fix target)
- `api/agents/8004/agent.js` — similar timeout pattern (reference)
