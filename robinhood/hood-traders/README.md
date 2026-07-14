# hood-traders

Autonomous trading agents for **Robinhood Chain** — a live fleet that trades memecoins on NOXA
and The Odyssey, and watches Stock Token premium/discount against Chainlink, with real signed
swaps, hard risk caps, and a live decision-journal dashboard.

> ## ⚠ Risk disclaimer
> This software can autonomously sign and broadcast **real transactions with real funds** when
> run in live mode. Trading is risky. Strategies here are honestly documented, not guaranteed —
> **most new memecoin launches go to zero**, thin Stock Token pools can move against you, and
> software has bugs. Read the [strategy failure modes](#strategies) before funding a wallet.
> **Paper mode is the default and does not touch real funds.** Live mode requires you to set
> `HOOD_TRADERS_LIVE=1` **and** provide a funded private key — never enabled by accident. There
> are no guarantees, no warranty, and no recovery for funds lost to a bug, a bad market, or a
> misconfigured risk cap. Start in paper mode. Use a wallet you can afford to lose. You are
> responsible for every transaction this software signs on your behalf.

Built on [`hoodchain`](../robinhood-chain-sdk) — the Robinhood Chain (chain ID 4663) TypeScript
SDK for Stock Tokens, Chainlink quotes, Uniswap v3 swaps, USDG, and launchpad watchers.
`hoodkit`/`hood-js` (the wave-2 convenience wrappers) had not shipped at the time this package
was built, so `hood-traders` talks to `hoodchain` directly — swapping in a wrapper later is a
drop-in change confined to `src/framework/market.ts`.

## What it does

- **Framework** (`src/framework/`): agent = strategy + wallet + risk budget + journal. Every tick
  runs observe → decide → simulate (a real Uniswap v3 `eth_call`) → risk-check (fail-closed) →
  execute → journal.
- **Three strategies** (`src/strategies/`): `launch-sniper`, `momentum`, `premium-watch` — each
  with an honestly documented edge hypothesis and failure modes (see [Strategies](#strategies)).
- **Live dashboard** (`dashboard/`): fleet overview, per-agent equity curve, open positions, the
  full decision journal (why each trade fired — or didn't), and a kill button.
- **Risk layer** (`src/framework/risk.ts`): per-agent position cap, daily spend cap, fleet-wide
  daily spend cap, slippage bound, and cooldown — every one enforced *before* execution, not
  advisory.
- **Kill switch** (`src/framework/kill.ts`): SIGINT/SIGTERM, a `KILL` file, or `POST /api/kill` —
  any of the three halts new orders across the whole fleet immediately. It never force-sells; it
  only stops taking on new risk.

## Quickstart — paper mode in 5 minutes

Paper mode simulates fills against **live** market data (real Chainlink prices, real Uniswap v3
quotes) — it is a real simulation, not fake data. No wallet, no key, no config needed.

```bash
git clone https://github.com/nirholas/hood-traders.git
cd hood-traders
npm install
npm run build
npm run fleet
```

Open **http://localhost:4670** — the dashboard is live: fleet equity, per-agent P&L, open
positions, and the decision journal.

Or with Docker (same result, zero local Node/npm needed):

```bash
cd hood-traders
docker compose up --build
```

### About `hoodchain`

`hood-traders` depends on [`hoodchain`](https://www.npmjs.com/package/hoodchain), the Robinhood
Chain TypeScript SDK, as a normal published npm dependency (`^0.1.1`) — `npm install` resolves it
from the registry like any other package. If you're developing the SDK and this fleet together,
clone [`robinhood-chain-sdk`](https://github.com/nirholas/robinhood-chain-sdk) as a sibling and
point `package.json` at `file:../robinhood-chain-sdk` for local iteration; revert to the published
semver before shipping.

## Going live

Live mode signs and broadcasts real transactions. It requires **both**:

```bash
cp .env.example .env
# edit .env:
HOOD_TRADERS_LIVE=1
ROBINHOOD_CHAIN_PRIVATE_KEY=0x...   # env var only — never hardcode a key
```

Missing either one keeps the fleet in paper mode — there is no accidental-live path. Every risk
cap in `.env.example` applies identically in live mode; they are not paper-mode-only guardrails.

**Stock Token trading** additionally requires `HOOD_STOCK_TOKEN_ELIGIBLE=true` — an explicit
affirmation that you are not a US/Canada/UK/Switzerland person, per the legal restriction on
these tokenized debt securities (issuer: Robinhood Assets (Jersey) Ltd). Without it,
`premium-watch` stays alerts-only and any Stock Token swap attempt throws
`StockTokenEligibilityError`. Memecoin trading (`launch-sniper`, `momentum`) is never gated.

## Architecture

See [`docs/architecture.html`](docs/architecture.html) for the full observe → decide → simulate →
risk-check → execute → journal diagram, and how the three strategies plug into it. Short version:

```
Market (hoodchain SDK, live RPC)
   │
   ▼
Strategy.tick(ctx) ──► Decision { intents[], alerts[] }
   │
   ▼
Agent: for each intent
   1. simulate  — real QuoterV2 eth_call, no state change
   2. price     — USD notional from the simulated fill
   3. risk gate — RiskEngine.check(...) — fails CLOSED
   4. execute   — paper: record the simulated fill
                  live:  buildSwapTx → approve → sendTransaction → wait for receipt
   5. journal   — every trade AND every refusal, into SQLite
```

A strategy can never bypass the risk gate — it proposes intents, the agent enforces every cap
before anything executes, paper or live.

## Strategies

Full docs with live examples: [`docs/strategies.html`](docs/strategies.html). Summary:

| Strategy | Edge hypothesis (short) | Primary failure mode |
|---|---|---|
| `launch-sniper` | Opening-minutes volatility on new launches is real; discipline (round-trip + deployer-concentration filters, mechanical exits) harvests a slice of it. | Most new launches go to zero — the stop loss fires often; this is negative-carry unless winners cover losers. |
| `momentum` | Tokens that survive to graduation and then break out on price reflect real demand, not launch-day noise. | Breakouts on thin pools are trivially fakeable by one wallet; price-only signal has no depth check. |
| `premium-watch` | Stock Token pools are thin and drift from the Chainlink oracle; buying the discount captures reversion. **Alerts-only by default** — trading requires explicit eligibility + opt-in. | A premium/discount can be *correct* (DEX reacting to news the ≤24h Chainlink heartbeat hasn't caught yet); fading it loses on purpose. No shorting primitive exists. |

Every strategy exposes its `meta.edge` / `meta.failureModes` at runtime (`strategy.meta`) — the
dashboard and docs pull the live values, not a stale copy.

## Configuration

All of `.env.example` is optional for paper mode. Key knobs:

| Var | Default | Meaning |
|---|---|---|
| `HOOD_NETWORK` | `mainnet` | `mainnet` (4663) or `testnet` (46630) |
| `HOOD_RPC_URL` | *(viem's public RPC)* | Optional paid RPC (Alchemy recommended for live trading) |
| `HOOD_TRADERS_LIVE` | `0` | Must be `1` (+ a valid key) to trade real funds |
| `HOOD_STOCK_TOKEN_ELIGIBLE` | `false` | Non-US-person affirmation gating Stock Token acquisition |
| `FLEET_MAX_DAILY_SPEND_USDG` | `250` | Hard ceiling across the whole fleet, USD/day |
| `AGENT_MAX_POSITION_USDG` | `50` | Per-agent, per-token position cap |
| `AGENT_MAX_DAILY_SPEND_USDG` | `100` | Per-agent daily spend cap |
| `AGENT_MAX_SLIPPAGE_BPS` | `100` | Per-agent slippage bound (1%) |
| `AGENT_COOLDOWN_SECONDS` | `60` | Minimum gap between an agent's trades |
| `KILL_FILE` | `./KILL` | Drop a file here to halt the fleet immediately |
| `DASHBOARD_PORT` | `4670` | Dashboard + API port |

## Kill switch

Three independent triggers, all wired the same way — any one halts new orders across every agent:

```bash
# 1. Ctrl-C the process (SIGINT), or `docker compose stop` (SIGTERM)

# 2. Drop the kill file
touch KILL          # local
touch data/KILL      # docker (mounted volume)

# 3. HTTP
curl -X POST http://localhost:4670/api/kill
```

The kill switch **never force-sells** — it stops new risk, it doesn't unwind existing positions.
Deciding whether to exit into whatever caused the panic is an explicit operator call.

## Development

```bash
npm run typecheck     # tsc --noEmit
npm test               # unit tests — risk, kill switch, journal, strategies, agent (58 tests)
npm run test:e2e       # live-network E2E — see below
npm run snapshot        # capture a fresh live market snapshot into tests/snapshots/
npm run dev              # tsx watch — fleet + dashboard with hot reload
```

Unit tests never hit the network: strategy logic is tested against **real recorded market
snapshots** (`tests/snapshots/`, captured with `npm run snapshot`) fed through a scriptable fake
market, and risk/kill/journal tests are pure logic. `npm run test:e2e` is the one suite that talks
to live RPCs.

## Deploy

### Docker / Google Cloud Run (preferred)

```bash
docker build -f Dockerfile -t hood-traders ..   # context = parent dir, see Dockerfile comment
docker run -p 4670:4670 -v hood-traders-data:/app/data hood-traders

# Cloud Run
gcloud run deploy hood-traders \
  --source .. \
  --dockerfile hood-traders/Dockerfile \
  --region us-central1 \
  --port 4670 \
  --set-env-vars HOOD_NETWORK=mainnet,FLEET_MAX_DAILY_SPEND_USDG=250 \
  --min-instances 1 --max-instances 1   # single instance — the journal is a local SQLite file
```

For live trading on Cloud Run, set `HOOD_TRADERS_LIVE` and `ROBINHOOD_CHAIN_PRIVATE_KEY` via
`--set-secrets` (Secret Manager), never `--set-env-vars`, and mount a persistent volume (Cloud Run
+ a GCS FUSE mount, or migrate the journal to Cloud SQL) so the decision journal survives restarts.

### Vercel

Vercel's serverless functions are not a fit for a long-running tick loop + stateful SQLite
journal — this is a **long-running process**, deploy it to Cloud Run, Fly.io, Railway, or any
always-on container host instead.

## License

All rights reserved. See [LICENSE](LICENSE).
