# Pump.fun integration for Solana agents

This integrates the upstream [`pumpfun-claims-bot`](https://github.com/nirholas/pumpfun-claims-bot) MCP server into the three.ws platform so a Solana agent can:

- Observe live pump.fun activity (GitHub social-fee claims, token graduations)
- React to events through the existing Empathy Layer (speak, gesture, emote)
- Expose enriched intel (`getRecentClaims`, `getTokenIntel`, …) via the platform MCP endpoint
- Feed off-chain trust signals into the Solana reputation score
- Surface a live cards overlay through a new widget type

This document covers what was added, how it composes with what was already there, and what is intentionally **not** included.

---

## Architecture

```
                 npx pumpfun-claims-bot              (Railway / standalone)
                          │  JSON-RPC 2.0 (HTTP MCP)
                          ▼
              api/_lib/pumpfun-mcp.js                (cached client, Upstash)
                          │
        ┌─────────────────┼─────────────────────────────────┐
        ▼                 ▼                                 ▼
 api/agents/pumpfun.js   api/agents/pumpfun.js?_handler=feed   api/cron/[name].js
   (read-only proxy)        (SSE: claims+graduations)    (name=pumpfun-signals)
        │                 │                                 │
        │                 │  EventSource                    │  pumpfun_signals
        ▼                 ▼                                 ▼
  src/agent-skills-pumpfun-watch.js          api/agents/solana/[action].js
       protocol.emit ──► Empathy Layer (avatar)     reputation + card actions
                                                    (passport block)
                          ▲
                          │
              src/widgets/pumpfun-feed.js (DOM overlay v1)
```

---

## What's added

| Surface | Path | Purpose |
|---|---|---|
| MCP client | [api/_lib/pumpfun-mcp.js](../api/_lib/pumpfun-mcp.js) | Cached JSON-RPC client to upstream bot |
| Read API | [api/agents/pumpfun.js](../api/agents/pumpfun.js) | `?op=claims|graduations|token|creator` |
| SSE feed | [api/agents/pumpfun.js](../api/agents/pumpfun.js) (`?_handler=feed`) | Live event stream, 90s window, auto-reconnects |
| Cron crawler | [api/cron/\[name\].js](../api/cron/%5Bname%5D.js) (`name=pumpfun-signals`) | 15-min sweep → `pumpfun_signals` |
| Schema | [api/_lib/schema.sql](../api/_lib/schema.sql) | New `pumpfun_signals` table |
| Skills | [src/agent-skills-pumpfun-watch.js](../src/agent-skills-pumpfun-watch.js) | 4 skills: recent-claims, token-intel, watch-start, watch-stop |
| Widget | [src/widgets/pumpfun-feed.js](../src/widgets/pumpfun-feed.js) | DOM overlay v1 |
| Widget type | [src/widget-types.js](../src/widget-types.js) | `pumpfun-feed` registered |
| Reputation | [api/agents/solana/\[action\].js](../api/agents/solana/%5Baction%5D.js) (`action=reputation`) | `pumpfun_signals` block in response |
| Passport | [api/agents/solana/\[action\].js](../api/agents/solana/%5Baction%5D.js) (`action=card`) | `pumpfun` block on the agent card |
| Cron schedule | [vercel.json](../vercel.json) | `*/15 * * * *` |

---

## Configuration

```env
# Upstream pumpfun-claims-bot MCP endpoint. Required to enable the integration.
PUMPFUN_BOT_URL=https://pumpfun-bot.example.com/mcp
PUMPFUN_BOT_TOKEN=                 # optional bearer for upstream auth

# Solana RPCs (also used by attestations crawler + pump-sdk skills)
SOLANA_RPC_URL=                    # mainnet (Helius/Triton recommended)
SOLANA_RPC_URL_DEVNET=
```

`PUMPFUN_BOT_URL` is an **optional enrichment layer**, not a hard dependency. When it's unset (the prod default), the `pumpfun-signals` cron still runs off the live WS-fed `pumpfun_graduations` table and the `pf:claims` / `pf:whales` / `pf:mints` Redis lanes — only the bot's richer claim intel (tier, GitHub account age) is skipped. The `op=claims` read proxy and watch skills soft-degrade to empty when the bot is absent. Solana agents that don't use it pay no cost.

---

## Skills

All registered through `registerPumpFunWatchSkills` in [src/agent-skills.js](../src/agent-skills.js).

| Skill | MCP-exposed | Effect |
|---|---|---|
| `pumpfun-recent-claims` | ✅ | Returns latest N enriched claims |
| `pumpfun-token-intel` | ✅ | Returns full intel for a mint |
| `pumpfun-watch-start` | ❌ (browser-only) | Opens SSE; emits `speak`/`emote`/`gesture` per event |
| `pumpfun-watch-stop` | ❌ | Closes the stream |

### Reaction map (watch-start)

| Event | Empathy Layer trigger | Speech sentiment |
|---|---|---|
| `first_time_claim` | `celebration` 0.9 | +0.7 |
| `fake_claim` | `concern` 0.7 | -0.5 |
| `tier ∈ {influencer, mega}` | `curiosity` 0.5 | +0.2 |
| `graduation` | gesture: `wave` (1.5s) | +0.6 |

These are continuous-blend stimuli, not discrete states — they decay according to the per-second rates in [agent-system.md](agent-system.md#5-the-avatar-emotion-system-empathy-layer).

---

## Reputation signals

The cron writes typed rows to `pumpfun_signals(wallet, agent_asset, kind, weight, payload, tx_signature)`. `solana-reputation` aggregates them as `pumpfun_signals: { count, weight, by_kind }` in the response, and the agent-passport card surfaces a `pumpfun` block. The `/api/pump/channel-feed` `signal` lane renders them as live, agent-attributed feed cards.

### Sources (no upstream bot required)

The cron is **not gated on the optional `PUMPFUN_BOT_URL`** — every lane has a real, always-on source, and the cron emits whatever is live:

| Lane | Source | Actor wallet |
|---|---|---|
| graduations | `pumpfunMcp.graduations()` → the WS-fed `pumpfun_graduations` table (kept fresh by the `pumpfun-graduations-sync` cron), or the bot when configured | `creator` / `dev_wallet` |
| claims | bot `getRecentClaims` (rich tier/age intel) when configured, merged with the `pf:claims` Redis lane | `claimer` / `github_wallet` |
| whales | `pf:whales` Redis lane (first whale-buy events) | `buyer` |
| mints | `pf:mints` Redis lane (new token launches) | `creator` |

A signal is only written when the actor wallet is linked to a three.ws agent (`user_wallets` → `agent_identities`, Solana). Each lane keeps a Postgres cursor in `pumpfun_signals_cursor(source, last_seen_ms, …)` so a run only evaluates events newer than the last — no re-scanning the whole window. The cursor lives in Postgres (not Redis) to keep Upstash write volume flat; the cron makes **zero new Redis writes** — only `lrange` reads.

### Dedup key

Rows are unique on `(tx_signature, kind)`, not `tx_signature` alone — a single claim transaction can legitimately produce `first_claim` + `influencer` + `new_account` rows at once.

Default weights:

| Kind | Weight | Lane |
|---|---|---|
| `graduation` | +0.3 | graduations |
| `first_claim` | +0.2 | claims |
| `influencer` | +0.2 | claims |
| `whale_buy` | +0.1 | whales |
| `launch` | +0.05 | mints |
| `new_account` | -0.2 | claims |
| `fake_claim` | -0.6 | claims |

These are **off-chain** signals — flagged as such, not on-chain attestations. `verified=false` semantically. Weighting them into a final composite score is up to consumers; the endpoint exposes the raw aggregates.

---

## Widget

The `pumpfun-feed` widget renders a stack of cards (claim or graduation) as an absolutely-positioned overlay on top of the 3D viewer. With `autoNarrate: true`, the avatar narrates each event through the protocol bus.

Studio config schema (validated in `widget-types.js`):

```js
{
  kind: 'all' | 'claims' | 'graduations',
  minTier: '' | 'notable' | 'influencer' | 'mega',
  autoNarrate: true,
  maxCards: 8,                 // 1..50
}
```

---

## What's intentionally not included

- **Long-lived SSE** — the feed handler runs a 90s bounded loop and lets the browser auto-reconnect; the Cloud Run request handlers aren't meant to hold a connection open indefinitely. For higher throughput, deploy the bot itself as a streaming service.
- **On-chain signal attestations** — signals are off-chain only. Promoting them to SPL Memo attestations signed by a platform key is a future step (see [docs/solana.md](solana.md) "What's intentionally not on Solana yet").
- **Agent-as-signer** — the watch skills are read-only; they never sign transactions. The existing `pumpfun-create / -buy / -sell` skills cover signing flows.
- **Anchor program for reputation** — still EVM-only on the on-chain path.

---

## Testing

```bash
npx vitest run tests/pumpfun-mcp.test.js tests/pumpfun-signals.test.js
```

The MCP client and cron crawler are unit-tested with mocked `fetch` and `sql`. End-to-end requires a live `PUMPFUN_BOT_URL` and is exercised via the Solana smoke test path.
