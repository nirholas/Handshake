# REPORT 01 — Bug & Lazy-Code Audit (three.ws)

Date: 2026-05-29. Scope: live frontend (`src/`), API functions (`api/`), entry
pages. Diagnosis only — no code changed. Sources: grep smell sweep, `npx knip`,
full reads of high-traffic frontend modules and the token/pump API surface, with
the two P0 claims verified directly against source.

## Health summary

The code is broadly solid — parameterized SQL, auth correctly gating
`revenue-share`, consistent `api/_lib/http.js` boundaries in most handlers. The
real problem is concentrated and consequential: **the live $three / pump data
pipeline is broken end-to-end.** The pump dashboard calls Birdeye with an
undefined API key, the trades SSE stream uses a wrong callback contract and emits
nothing, and the avatar trade-reaction feature listens for an event the server
never sends. These three are load-bearing for the "wow" feature tasks (12, 13,
16), so they must be fixed first. Secondary theme: unguarded `await res.json()` /
direct field access on upstream (Birdeye/Helius) responses that throw on partial
data, plus a leaking `Act2Viewer` WebGL context on the home page.

## Top 10 — fix first

1. **Pump dashboard Birdeye key undefined** — `api/pump/dashboard.js:6` (P0)
2. **Trades SSE stream wrong contract + emits nothing** — `api/pump/trades-stream.js:17-25` (P0)
3. **Avatar trade reactions dead — `trade` event never emitted** — `src/pump/trade-reactions.js:66-68` + `api/agents/pumpfun.js` (P0)
4. **Home on-chain stat always null — field name mismatch** — `src/home-v4-scroll.js:39` (P1)
5. **`Act2Viewer` leaks WebGL context — no dispose** — `src/home-act2-viewer.js:80` (P2→P1 on home)
6. **pump/dashboard.js render throws on partial Birdeye data** — `src/pump/dashboard.js:19-23` (P1)
7. **three-token `burns`/`activity` return revenue rows relabeled as burns + hardcoded `total_burned:0`** — `api/three-token/[action].js:68-94,167-192` (P2, but it's shipped fake data)
8. **three-token agent-count query missing `.catch` — 500s the whole stats endpoint** — `api/three-token/[action].js:56` (P1)
9. **Birdeye error/empty responses cached for 60s** — `api/pump/dashboard.js:14-33` (P1)
10. **Hardcoded 1B supply fallback fabricates `per_token_yield`** — `api/three-token/[action].js:150` (P2)

---

## Findings — API surface

| # | Sev | File:line | Category | What's wrong | Suggested fix |
|---|-----|-----------|----------|--------------|---------------|
| A1 | P0 | api/pump/dashboard.js:6,52 | bug | `env.BIRDEYE_API_KEY` — no such getter on `env` (verified absent in `api/_lib/env.js`); sends `X-API-KEY: undefined` → all Birdeye calls 401. `three-token` does it right via `process.env.BIRDEYE_API_KEY`. | Read `process.env.BIRDEYE_API_KEY` (or add an `opt('BIRDEYE_API_KEY')` getter to env.js). |
| A2 | P0 | api/pump/trades-stream.js:17-25 | bug | Calls `connectPumpFunFeed({onTrade,onError,onClose})` and destructures `{close}`, but the fn takes `{onEvent,signal,kind}` and returns a bare `stop`. Callbacks never fire; `req.on('close', close)` registers `undefined`. | Use `onEvent:({kind,data})=>…`; `const stop = connectPumpFunFeed(...)`; `req.on('close', stop)`. |
| A3 | P0 | api/pump/trades-stream.js:18-21 | bug | Filters `trade.is_buy`, but the upstream feed never produces trade events (only mint/graduation) — stream emits nothing but pings. | Subscribe to a real trade source, or repurpose to forward mint/graduation. |
| A4 | P1 | api/three-token/[action].js:56 | broken-boundary | The `agent_identities` count query has no `.catch` (unlike the other two); if it fails, `stats` AND `revenue-share` 500. | `.catch(()=>[{total:0}])` for parity. |
| A5 | P1 | api/pump/dashboard.js:62 | broken-boundary | `history.data.items` assumes Birdeye shape; `data:null` or different shape throws → 502. | `history?.data?.items ?? []`. |
| A6 | P1 | api/pump/dashboard.js:14-33 | bug | `fetchWithCache` caches by URL only; empty/error `{data:null}` bodies cached 60s and reused. | Cache only `resp.ok` with non-null `data`. |
| A7 | P2 | api/three-token/[action].js:68-94,167-192 | lazy-code | `burns` queries `agent_revenue_events` (revenue, not burns) and returns hardcoded `total_burned:0`, `burn_rate_per_agent:1000`; `activity` relabels revenue as burns. Comment claims "real on-chain burn events." | Wire a real burn source or rename + drop the hardcoded numbers. |
| A8 | P2 | api/three-token/[action].js:150 | lazy-code | `totalSupply = ov.supply ?? 1_000_000_000` — fabricated 1B fallback drives `per_token_yield` when Birdeye is down. | Omit `per_token_yield` when supply unknown. |
| A9 | P2 | api/three-token/[action].js:134-135 | lazy-code | `revenue_share_pool_pct:10`, `agent_deploy_burn:1000` hardcoded inline. | Hoist to named config consts (ok if truly fixed params). |
| A10 | P2 | api/pump/helius-stats.js:32-35 | bug | Reports `enabled:false` based on `SOLANA_RPC_URL.includes('helius-rpc.com')`, but doc says it keys off `HELIUS_API_KEY`; misreports for key-only/other-host configs. | Detect via `HELIUS_API_KEY` or fix the comment. |
| A11 | P3 | api/pump/dashboard.js:23 | security | Throws Error embedding full upstream body (logged server-side only). | `text.slice(0,200)` like three-token. |
| A12 | P3 | api/_lib/db.js | lazy-code | Retrying `query()` exported but unused; endpoints use the non-retrying `sql` proxy. | Adopt `query()` or remove. |

No SQL injection found (tagged-template params throughout). No leaked secrets in
client responses. `revenue-share` correctly requires auth; `dashboard` scopes by `user_id`.

## Findings — Frontend

| # | Sev | File:line | Category | What's wrong | Suggested fix |
|---|-----|-----------|----------|--------------|---------------|
| F1 | P0 | src/pump/trade-reactions.js:66-68 | bug | Subscribes `kind=trades` and listens for `trade`; the feed (`api/agents/pumpfun.js`) only handles `claims/graduations/token/creator` and never emits `trade`. Buy/sell reactions + the whole percentile buffer are dead. | Emit `trade` server-side (with a real trade source), or listen for an event the feed actually sends. |
| F2 | P1 | src/home-v4-scroll.js:39 | bug | Reads `data.onchain`; `/api/home-stats` returns `onchain_agents`. On-chain stat never populates. | `data.onchain_agents ?? data.onchain`. |
| F3 | P1 | src/pump/dashboard.js:19-23 | broken-boundary | `data.price?.value.toFixed(6)` (optional chain then unconditional `.value`), `data.history.map`, `tx.side/amount/priceUsd` all unguarded — partial Birdeye data throws mid-render. | Null-check each field; `(data.history||[])`. |
| F4 | P1 | src/home-act2-viewer.js:80 | bug | Unconditional `requestAnimationFrame` loop, no visibility gate, no `dispose()` — leaves a running renderer + WebGL context when leaving the section. | Add `dispose()` that cancels raf + disposes renderer; gate on `_disposed`. |
| F5 | P2 | src/pump/dashboard.js:16 | broken-boundary | `await resp.json()` on the error path with no catch — non-JSON 500 body throws before the error message builds. | `.catch(()=>({}))`. |
| F6 | P2 | src/agent-home.js:498 | bug | `_renderMemoryBar` derefs `this.identity.memory.stats.total`; throws if `memory` set but `stats` undefined. | `if (!stats || !stats.total) return`. |
| F7 | P2 | src/agent-home.js:569 | broken-boundary | `_startEmotionPoll` `Object.entries(this.avatar.emotionState)` every 1s; throws if `emotionState` null mid-swap. | Guard null before `Object.entries`. |
| F8 | P2 | src/agent-home-pumpfun.js:683 | bug | `setInterval(... refresh())` unawaited; overlapping slow refreshes race and clobber `state`. | In-flight flag to skip overlap. |
| F9 | P2 | src/marketplace.js:429-430 | broken-boundary | `loadList` parses `r.json()` with no `r.ok` check (inconsistent with sibling loaders); 500 HTML throws generic error. | `if(!r.ok) throw` before `.json()`. |
| F10 | P2 | src/wallet-auth.js:147 | bug | "No wallet" gate checks `window.ethereum`, but connect may use a different provider; non-`window.ethereum` users wrongly told to install MetaMask. | Delegate detection to `ensureWallet`/registry. |
| F11 | P3 | src/home-v4-hero.js:120; home-v4-scroll.js:57 | bug | IntersectionObserver uses `entries[0]` only; batched entries on fast scroll use a stale entry. | Iterate entries or `entries.at(-1)`. |
| F12 | P3 | src/marketplace.js:1108-1111 | bug | Modal 3D `Loading…` overlay has no error/timeout state; stays forever on CORS/404. | Add `error` listener to swap to error state. |
| F13 | P3 | src/marketplace.js:599-600 | broken-boundary | `renderTheme` writes to `$('market-theme-title')` etc. without null-guarding child nodes; throws + half-renders if absent. | Null-check each node. |

## knip (dead code / unused deps)

- **27 unused files**, almost all under `character-studio/**` (a sub-app) — low priority, but worth a cleanup pass scoped to that package.
- **75 unused dependencies** across `package.json` and sub-package manifests (e.g. `@solana/wallet-adapter-*`, `ethers`, `livepeer`, `colyseus`, `graphql`, `node-fetch`, many `@x402/*`). Verify against dynamic imports before removing — knip can miss runtime-only deps. Trimming these shrinks install + supply-chain surface.
- **11 unused devDependencies**. Safe-ish to prune after a build check.

> Treat knip output as a candidate list, not gospel — confirm each removal with a grep + a clean `npm run build` before deleting.

## Grep smell sweep — result

- `TODO/FIXME/not implemented/mockData/sampleData` in shipped `src`+`api`+`pages`: **effectively zero real violations.** The only `not implemented` is a legit runtime error message in `api/pump-fun-mcp.js:209` for unknown MCP tools. CLAUDE.md's no-stub rule is largely being honored.
- "placeholder" hits are legitimate — CSS class names, input placeholder text, and designed UI fallbacks (avatar initials, etc.), not fake data.
- `setTimeout` near "load/progress": all real (reload-after-success, load timeouts, deferred re-fetch). No fake progress bars found.
- Empty `catch {}`: all benign cleanup (`sessionStorage`, `bitmap.close()`, `URL` parse). No swallowed network/logic errors at boundaries.

The shipped-fake-data problem is **not** in the frontend — it's the relabeled
revenue-as-burns and hardcoded supply/yield numbers in `api/three-token` (A7, A8).

## Recommended sequencing

Fix the P0 data-pipeline cluster (A1, A2, A3, F1) before starting feature tasks
12/13/16 — those tasks assume live trades and a working Birdeye key. Then F2–F5
(home + dashboard render robustness), then the three-token honesty fixes (A7, A8)
which task 17 also depends on.
