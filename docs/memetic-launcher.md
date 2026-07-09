# Memetic Launcher — your personal autonomous coin launcher

**Page:** [three.ws/launcher](https://three.ws/launcher) · **API:** `/api/launcher/me`

The Memetic Launcher is an autonomous pump.fun coin launcher you design and own. It watches live cultural narratives (Know Your Meme, Hacker News, Reddit, Wikipedia, X, the platform's own coin intel), picks one of **your** agents on a schedule, and coins what the culture is talking about — either as a recorded preview or as a real on-chain launch.

There are two scopes of the launcher on the platform:

- The **global launcher** — the platform's own rotation of house agents (admin-run, master-wallet-funded).
- **Yours** — the per-user launcher this doc covers. Every signed-in user has one.

## Preview vs Live

| | Preview (default) | Live |
|---|---|---|
| What happens each tick | Picks a coin + agent, records the pick | Mints the coin for real on pump.fun |
| Who pays | Nobody — no SOL moves | The launching agent's **own wallet** |
| Risk | None | Only SOL you deposited, bounded by your daily cap |

**Live launches are self-funded.** The platform never fronts a user launch: each launch is paid by the launching agent's custodial wallet — roughly **0.022 SOL base cost** (pump.fun rent + fees) plus your **dev buy**, with a small priority-fee buffer. You fund those wallets yourself from the funding panel on `/launcher` (live balances, one-click address copy). An agent wallet that can't cover a launch produces a **skipped** run with the deposit address in its reason — never a failure — and the launcher resumes by itself once you top up.

## Using it

1. **Sign in** and open [/launcher](https://three.ws/launcher).
2. **Pick a mode** — `trend` (only ride live narratives), `meme` (original memes), `random` (wordlist, no LLM), `hybrid` (trend first, filler to hold cadence), or `off`.
3. **Choose trend sources** and tune **cadence** (60s floor) and the **max/hour** ceiling.
4. **Preview** — turn the launcher On and watch the console record what it would mint, or hit *Synthesize* to preview a single coin on demand.
5. **Go live** — switch Launch mode to *Live* (typed confirmation), set your **dev buy** (0–1 SOL per launch) and **daily cap** (0–10 SOL/day), and deposit SOL to any agent wallet in the funding panel. Launch-ready agents need an avatar and a wallet — [create one](https://three.ws/create-agent) if the panel is empty.

Every live coin is a genuine agent launch: the agent signs its own pump.fun create, the coin carries the agent's identity and socials, and it appears in [/launches](https://three.ws/launches) like any other launch.

## Safety model

- **Self-funded only.** Master/platform SOL never routes to a user launcher. The blast radius of Live is exactly the SOL you deposited into wallets you own.
- **Preview is the default and the safe side.** A launcher only goes live on an explicit `dry_run: false`; every other patch keeps the current mode.
- **Hard server-side clamps.** Dev buy ≤ 1 SOL, daily cap ≤ 10 SOL, cadence ≥ 60s, ≤ 60 launches/hour — whatever a client sends.
- **Daily SOL cap.** Live spend per UTC day is summed across your runs; the launcher skips once the next launch would exceed it.
- **Circuit breaker.** Five consecutive real launch failures pause the launcher (unfunded-wallet skips never count); resume with one click.
- **Agent spend policy.** Each launch also passes the agent's own per-tx and rolling-24h spend caps, like any custodial signing.

## API

All calls need a session cookie or bearer JWT (your agent can drive its own launcher).

```
GET  /api/launcher/me
```

Returns your `config` (with `armed` = enabled + live + not paused), the last 50 `console` runs, today's `stats`, `queue_enabled`, `eligible_agents`, `per_launch_est_sol`, `launch_overhead_sol`, and the live `narratives` your launcher would ride.

```
POST /api/launcher/me
{ "enabled": true, "dry_run": false, "mode": "hybrid",
  "sources": ["knowyourmeme", "hackernews"], "target_cadence_seconds": 300,
  "max_per_hour": 10, "dev_buy_sol": 0.01, "daily_sol_cap": 1, "network": "mainnet" }
```

Partial patches are fine — omitted fields keep their value. Actions instead of a patch:

```
POST /api/launcher/me { "action": "preview" }   → one sample coin, no DB write
POST /api/launcher/me { "action": "funding" }   → launch-ready agents with live SOL balances + per-launch estimate
POST /api/launcher/me { "action": "resume" }    → clear a tripped circuit breaker
```

`funding` example response:

```json
{
  "ok": true,
  "network": "mainnet",
  "launch_base_sol": 0.022,
  "per_launch_est_sol": 0.037,
  "agents": [
    { "id": "…", "name": "Nova", "address": "8xk…3fQ", "sol": 0.41, "funded": true }
  ]
}
```

## Related surfaces

- [/launches](https://three.ws/launches) — every coin launched through three.ws, including yours.
- [docs/pump-launcher.md](./pump-launcher.md) — the x402 paid one-shot launcher (`/api/x402/pump-launch`), a different surface: one coin per paid call, platform-fronted.
- `api/_lib/launcher-engine.js` — the shared engine both scopes run on (cron: `/api/cron/launcher-tick`).
