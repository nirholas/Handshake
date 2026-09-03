# @three-ws/agent-sniper

A lightweight, embeddable pump.fun sniper engine for 3D AI agents. One trade
loop — feed a stream of new launches, score each against a per-agent strategy,
run the pre-trade guards, buy, then sweep open positions on an interval and exit
on stop-loss / take-profit / trailing-stop / timeout / sentiment-flip. It is
multi-agent and multi-user by construction (one wallet per `agentId`), and every
external dependency — wallet custody, persistence, RPC/venue, launch feed — is a
pluggable adapter, so the same engine runs locally with in-memory state or
hosted across thousands of tenants. The package ships with four faces over that
one engine: a **library**, a **CLI**, an **MCP server**, and an **x402 paid HTTP
API**.

---

## Why — the adapter architecture

The engine is pure orchestration. It owns the decision pipeline; it owns nothing
about *where* the money, the data, or the chain live. Five adapter interfaces
(`src/types.js`) are the seams, and a default implementation ships for each:

```
                            ┌──────────────────────────── engine ────────────────────────────┐
   Feed ──{mint|intel|claim}─▶  score  ──▶  guards  ──▶  executeBuy  ──▶  claimPosition         │
   (PumpPortal)               (scorer)   (concurrency,    (quote +        (atomic slot)          │
                                          budget, SOL      build + sign                          │
                                          headroom,        + broadcast)                          │
                                          price impact)                                          │
                                                                  position sweep (every pollMs)  │
                                                                  ──▶ decideExit ──▶ executeSell │
                            └────────────────────────────────────────────────────────────────────┘
        adapters:    Feed          Solana            Wallet           Executor          Store
                  (launch        (quote/build      (resolve a       (sign +          (strategies,
                   stream)        pump.fun ix)      Keypair per      broadcast)        positions,
                                                    agentId)                           spend ledger)
```

Swap any one without touching the loop: a custodial KMS wallet instead of local
keys, a Postgres store instead of memory, a different launch feed, a different
venue. Implement the shape, pass it to `createSniper()`, done.

| Adapter    | Responsibility |
|------------|----------------|
| `Feed`     | Push `{ kind: 'mint'\|'intel'\|'claim', data: Candidate }` events into the engine. |
| `Solana`   | Quote + build pump.fun buy/sell instructions; expose a web3 `Connection`. |
| `Wallet`   | Resolve a signing `Keypair` for an `agentId` (or `null` if unprovisioned). |
| `Executor` | The one place that signs and broadcasts; returns landing telemetry. |
| `Store`    | Persist strategies, positions, and the daily spend ledger; atomic `claimPosition`. |

Optional `Hooks` (firewall `assessSafety`, `oracleGate`, `onScreen`, `onBuy`,
`onSell`, `recordDecision`) are best-effort cross-cutting callbacks — a throw is
swallowed and never aborts a trade, except `onTip`, which is a deliberate veto.

---

## Install

```bash
npm i @three-ws/agent-sniper
```

Optional peers, installed only if you use the face that needs them:

```bash
npm i better-sqlite3   # durable Store (src/adapters/store/sqlite.js)
npm i express          # the x402 HTTP API face
```

Requires Node >= 20.

---

## Quickstart (library)

The `presets.local` wiring is the zero-to-running path: in-memory store +
self-custody wallet + pump.fun client + web3 executor + PumpPortal feed. Run it
in **simulate** mode on **devnet** first — the engine scores, guards, and logs
every decision but never broadcasts.

A strategy **must** carry a `stop_loss_pct` — the engine refuses to arm a
strategy without one. SOL amounts on a strategy are expressed in **lamports**
(1 SOL = 1,000,000,000 lamports), as a string, number, or bigint.

```js
import { createSniper, createMemoryStore, presets } from '@three-ws/agent-sniper';

// 1 SOL = 1e9 lamports.
const SOL = 1_000_000_000n;

const strategy = {
  id: 'strat_scout_1',
  agent_id: 'scout',                  // one wallet per agentId
  enabled: true,
  trigger: 'new_mint',                // fire on the create event
  network: 'devnet',
  per_trade_lamports: (SOL / 100n).toString(),   // 0.01 SOL per snipe
  daily_budget_lamports: (SOL / 2n).toString(),  // 0.5 SOL/day ceiling
  max_concurrent_positions: 3,
  slippage_bps: 500,                  // 5%
  max_price_impact_pct: 10,           // entry circuit breaker
  stop_loss_pct: 30,                  // REQUIRED — exit when down 30%
  take_profit_pct: 80,                // exit when up 80%
  trailing_stop_pct: 20,              // exit when down 20% from peak (after profit)
  max_hold_seconds: 1800,             // hard time-stop
  require_socials: true,              // skip launches with no twitter/telegram/website
  max_creator_launches: 10,           // skip serial launchers
};

const sniper = await presets.local({
  network: 'devnet',
  mode: 'simulate',                   // no funds move
  strategies: [strategy],
  // secrets: { scout: '<base58 | [byte,array] | 0x-hex secret>' },  // for live mode
});

await sniper.start();

console.log(sniper.stats());          // { events, candidates, buys, sells, errors, strategies, queued, lastEventAt }
console.log(sniper.strategies());     // the live armed-strategy cache

// Fire a manual buy by hand (drives the same path as MCP snipe_now):
sniper.submitCandidate(
  { mint: 'THREEsynthetic1111111111111111111111111111111', entry_trigger: 'manual' },
  { force: true },
);

// later…
await sniper.stop();
```

`createSniper(deps)` is the lower-level constructor when you want to bring your
own adapters — pass `{ config, store, wallet, solana, executor, feed, hooks }`.
`presets.local` is just one wiring of it.

---

## CLI usage

The package installs an `agent-sniper` binary. Default mode is **simulate** — it
will not move funds until you pass `--mode live` (or set `SNIPER_MODE=live`),
which trades **real funds**.

```bash
# Run the engine. Mode defaults to simulate; live trades real funds.
npx agent-sniper run --network devnet --strategy ./strategy.json

# Serve the engine over MCP (stdio) for Claude / Cursor / any MCP client.
agent-sniper mcp

# Serve the x402-gated HTTP API + web console (open http://localhost:8787).
agent-sniper serve

# Help.
agent-sniper help
```

> **Safety.** `run`/`serve`/`mcp` all start in simulate mode unless you opt into
> live explicitly. In live mode every armed strategy can spend up to its
> `daily_budget_lamports` per UTC day. Read **Safety & guardrails** below before
> you flip the switch.

`--strategy ./strategy.json` loads a strategy (or array of strategies) as JSON.
A minimal file mirrors the object in the Quickstart — note `stop_loss_pct` is
required.

---

## MCP server

`agent-sniper mcp` exposes the engine as an MCP stdio server. Every tool maps
1:1 onto a public engine/store method — no internals are reached around. The
server is unauthenticated and meant to run locally against your own wallet/RPC.

| Tool | Kind | Purpose |
|------|------|---------|
| `arm_strategy` | write | Register/update a strategy. SOL → lamports for you; `stop_loss_pct` mandatory. |
| `disarm_strategy` | write | Disable a strategy (`enabled=false`); open positions still exit on their rules. |
| `list_strategies` | read | List the armed strategy set the engine is evaluating. |
| `snipe_now` | write | Force a manual buy of a mint across all armed agents (bypasses the scorer). |
| `list_positions` | read | List positions, filter by `agentId` and/or `status`. |
| `close_position` | write | Schedule an exit — flips the position's kill switch; the next sweep sells it. |
| `sniper_status` | read | Engine health: event/candidate/buy/sell counts, armed count, queue depth, network/mode. |

Wire it into an MCP client (Claude Desktop, Cursor, etc.):

```json
{
  "mcpServers": {
    "agent-sniper": {
      "command": "npx",
      "args": ["-y", "@three-ws/agent-sniper", "mcp"],
      "env": {
        "SNIPER_NETWORK": "devnet",
        "SNIPER_MODE": "simulate"
      }
    }
  }
}
```

`createSniperMcpServer(deps)` builds the fully-registered server **without**
connecting a transport, so you can construct it in a test and drive it over an
in-memory transport.

---

## x402 paid HTTP API

`agent-sniper serve` (or `import { serve } from '@three-ws/agent-sniper/api'`)
mounts the engine over HTTP. Reads are free; the four mutating endpoints are
gated behind x402 USDC micropayments via `@three-ws/x402-server` — the
middleware verifies the `X-PAYMENT` header against the facilitator, runs the
work, settles on-chain, and emits the receipt.

| Method | Endpoint | Price | Notes |
|--------|----------|-------|-------|
| GET  | `/health` | free | Liveness + network/mode/stats. |
| GET  | `/status` | free | Full stats + immutable runtime config. |
| GET  | `/strategies` | free | The armed strategy set. |
| GET  | `/positions?agentId=&status=` | free | Positions from the store. |
| GET  | `/activity` | free | The recent engine screen events (what the console feed renders). |
| GET  | `/` and `/console` | free | The built-in operator console (see below). |
| POST | `/strategies` | **$0.01 USDC** | Arm a strategy (SOL → lamports; stop-loss required). |
| POST | `/snipe` | **$0.05 USDC** | Force a snipe on `{ mint, symbol?, agentId? }`. |
| POST | `/strategies/:id/disarm` | **$0.005 USDC** | Disable a strategy. |
| POST | `/positions/:id/close` | **$0.005 USDC** | Schedule an exit; the next sweep sells it. |

Prices are the defaults (USDC atomic units, 6 decimals); override via
`deps.prices = { arm, snipe, disarm, close }`.

Gating turns on when a merchant wallet is configured — `deps.payTo.solana` or the
`X402_PAY_TO_SOLANA` env (a Base lane is available via `X402_PAY_TO_BASE`). When
no `payTo` is set, the mutating routes still mount but answer `503`, so the
server boots cleanly for local/dev without payment config.

The Solana lane also needs a facilitator sponsor fee-payer — set
`X402_FEE_PAYER_SOLANA` (or `deps.feePayer`). Without it the Solana lane
self-disables (falling back to the Base lane, or the `503` guard if that's the
only lane) rather than failing requests, and logs a one-time warning at boot.

```js
import { serve } from '@three-ws/agent-sniper/api';

await serve(
  { payTo: { solana: process.env.X402_PAY_TO_SOLANA } },
  { port: 8787 },
);
```

---

## Web console

`serve` also ships a **built-in operator dashboard** — a single, dependency-free
HTML file served from the same origin as the API, at `/` and `/console`. Open
`http://localhost:8787` and you get a live control room:

- **Live stats** — buys, sells, candidates, armed strategies, in-flight queue and
  signal count, animated as they change, with time-since-last-signal.
- **Positions table** — every position with entry, current value, and colored
  P&L (unrealized total in the header), plus a one-click **Close** that schedules
  an exit through the normal sell path.
- **Armed strategies** — each policy with its stop-loss / take-profit / trailing
  tags, and a **Disarm** button.
- **Arm a strategy** and **Manual snipe** forms with inline validation.
- **Live activity feed** — the same engine screen events the CLI prints, streamed
  in with relative timestamps.
- Designed loading / empty / error states, toasts, keyboard shortcuts
  (`s` snipe, `n` new strategy, `r` refresh, `,` settings, `?` help), a
  disconnected banner, and full mobile responsiveness.

Reads are free. The mutating controls (arm, snipe, disarm, close) are x402-paid
for external callers — so to drive them from your own console without paying
yourself, set an **operator token**:

```bash
export SNIPER_ADMIN_TOKEN="$(openssl rand -hex 24)"
agent-sniper serve --port 8787
```

Open Settings (⚙ or `,`) in the console and paste the same token. It is sent as
`X-Admin-Token` (or `Authorization: Bearer …`), stored only in your browser, and
bypasses the x402 gate — while unauthenticated external agents still pay. Pass it
programmatically as `deps.adminToken`. Without a token set, the console is a
full-featured **read-only monitor** and mutations return `503` with guidance.

---

## Multi-agent / multi-user

The engine is multi-tenant by design. The unit of isolation is the `agentId`:

- **One wallet per agent.** The `Wallet` adapter resolves a signing `Keypair`
  per `agentId`. Self-custody reads it (in order) from a `secrets` map,
  `SNIPER_WALLET_<AGENTID>` env, a keystore directory of `<agentId>.json` files,
  or a single default `SOLANA_SECRET_KEY`. If an agent has no provisioned
  wallet, `loadKeypair` returns `null` and the engine fails the trade cleanly —
  it never auto-provisions an unfunded wallet.
- **Custodial for hosted deployments.** `createCustodialWallet({ resolve })`
  takes a single async `resolve(agentId, ctx)` that decrypts a key from your own
  KMS/secret box on demand, with a short TTL cache so a long-lived process
  doesn't re-decrypt every trade. The cache is keyed per agent; `clearCache()`
  forces a re-resolve.
- **Per-agent caps.** Each strategy carries its own `daily_budget_lamports` and
  `max_concurrent_positions`. The guards enforce them per agent, independent of
  the platform-wide buy throttle.
- **Mandatory stop-loss.** `getArmedStrategies` filters out any strategy missing
  `stop_loss_pct`, so an agent can never run uncapped downside.
- **Idempotent claims prevent double-buys.** Before a buy, the engine calls
  `Store.claimPosition` to atomically reserve the `(agent_id, mint, network)`
  slot. A second event for the same slot returns `null` and is skipped.

---

## 3D agents

`@three-ws/agent-sniper/agents` is the presentation layer that lets a 3D AI
agent *embody* the sniper: avatar definitions, the canonical animation clip
library, and a desk-monitor visualization driven by the engine's `onScreen`
hook. Wire the hook to push live activity (`Sniper online…`, `$SYM scored N —
BUYING`) onto the agent's monitor so the trading loop is something you can watch,
not just a log stream. The `onScreen` payload shape is `{ text, kind }` with
`kind` in `activity | trade`.

---

## Adapter reference

Implement any of these (`src/types.js` has the full JSDoc contracts) and pass it
to `createSniper`. Defaults live under `src/adapters/`.

| Interface | Default implementation | Write your own when… |
|-----------|------------------------|----------------------|
| `Store` | `createMemoryStore` · `createSqliteStore` (`./adapters/store/sqlite`) | you need durable or shared multi-process state (e.g. Postgres). |
| `Wallet` | `createSelfCustodyWallet` · `createCustodialWallet` | keys live in a KMS/HSM or a hosted secret store. |
| `Solana` | `createPumpClient` (`./adapters/solana/pump-client`) | you route quotes/builds through a different venue. |
| `Executor` | `createWeb3Executor` (`./adapters/solana/executor-web3`) | you broadcast through a custom relay/bundler. |
| `Feed` | `createPumpPortalFeed` (`./adapters/feed/pumpportal`) | you ingest launches from a different source. |

The `Store` contract is the load-bearing one: `getArmedStrategies`,
`countOpenPositions`, `getDailySpendLamports`, `claimPosition` (atomic),
`updatePosition`, `getOpenPositions`, and optional `recordSpend`. See the
in-memory reference at `src/adapters/store/memory.js`.

---

## Configuration

All `SNIPER_*` env vars (read by `loadConfig`, `src/config.js`). Explicit
overrides passed to `createSniper`/`loadConfig` always win. See `.env.example`.

| Variable | Default | Meaning |
|----------|---------|---------|
| `SNIPER_NETWORK` | `mainnet` | `mainnet` \| `devnet`. |
| `SNIPER_MODE` | `simulate` | `simulate` \| `live`. Simulate never broadcasts. |
| `SOLANA_RPC_URL` | — | RPC endpoint. Live mode requires this (or `HELIUS_API_KEY`). |
| `SNIPER_GLOBAL_KILL` | `false` | Emergency switch — halts all buys when true. |
| `SNIPER_POLL_MS` | `5000` | Position re-quote / exit cadence (floor 1000). |
| `SNIPER_STRATEGY_REFRESH_MS` | `15000` | Strategy-cache refresh interval (floor 5000). |
| `SNIPER_MAX_GLOBAL_BUYS_PER_MIN` | `10` | Platform-wide buy throttle; 0 disables. |
| `SNIPER_BUY_CONCURRENCY` | `3` | Max concurrent in-flight snipes (floor 1). |
| `SNIPER_BUY_QUEUE_DEPTH` | `50` | Queued-snipe cap before drops (floor 1). |
| `SNIPER_CONFIRM_TIMEOUT_MS` | `60000` | Confirmation timeout per trade (floor 15000). |
| `SNIPER_FEED_WATCHDOG_MS` | `180000` | Re-subscribe if the feed goes quiet (floor 30000). |
| `SNIPER_EXIT_ON_BEARISH` | `false` | Enable the sentiment-flip exit. |
| `SNIPER_EXIT_BEARISH_MIN_CONFIDENCE` | `0.7` | Min bearish confidence (0..1) to act. |

---

## Safety & guardrails

- **Simulate by default.** Every face starts in simulate mode. You opt into live
  trading explicitly.
- **Mandatory stop-loss.** A strategy without `stop_loss_pct` is never armed.
- **Daily budget + concurrency caps.** Per-agent `daily_budget_lamports` and
  `max_concurrent_positions` are enforced before any transaction is built
  (`checkDailyBudgetLamports`, `checkConcurrency`).
- **SOL fee headroom.** `checkSolHeadroom` keeps ~0.012 SOL in the wallet so a
  snipe can't drain the account below the cost of the very next sell's fee.
- **Price-impact circuit breaker.** `max_price_impact_pct` (default 10) skips a
  buy whose quote impact is too high (`checkPriceImpact`; unset ⇒ no gate).
- **Live-RPC refusal.** Live mode refuses to start on a public RPC — it requires
  a real endpoint so trades aren't silently dropped to rate limits.
- **Optional firewall hook.** The `assessSafety` hook runs after the quote and
  before broadcast; a `block` verdict cancels the trade.
- **Mayhem exclusion.** `createMayhemFilter({ connection?, rpcUrl?, strictOnUnknown?, retries?, retryDelayMs? })`
  reads the bonding curve's `isMayhemMode` (cached per mint) and skips pump.fun
  Mayhem-mode launches. As of 0.1.4 a pre-built web3 `Connection` (for example a
  rotating multi-endpoint one) can be injected instead of a single `rpcUrl`, and
  a null read retries with backoff (default 2 retries) before resolving
  "unknown", so a throttled provider can't starve a strict gate. The pure
  `retryWhileNull(fn, { retries, delayMs })` helper is exported too.
- **Global kill switch.** `SNIPER_GLOBAL_KILL=true` (or `config.globalKill`)
  halts every buy across every agent immediately.

---

## Scaling beyond one process

`claimPosition` in the memory and sqlite stores is atomic **within one
process** — the memory store relies on JS being single-threaded; the sqlite
store on a single-writer transaction. Combined with the engine's bounded in-
process buy queue, that prevents double-buying the same `(agent_id, mint,
network)` slot inside a single sniper instance.

Run **two sniper processes against the same agent** and that guarantee no longer
holds: nothing serializes the claim across processes. To scale horizontally,
back the `Store` with a database whose `claimPosition` is a genuinely atomic
insert-if-absent (e.g. a unique constraint on `(agent_id, mint, network)` with
`INSERT … ON CONFLICT DO NOTHING RETURNING`), so the reservation is decided by
the database, not by any one process. The `Store` contract documents exactly
this requirement.

---

## Testing

Pure-logic and in-memory-adapter suites run with no network/RPC:

```bash
npm test            # vitest run
```

---

## License

Apache-2.0. See [LICENSE](./LICENSE).
