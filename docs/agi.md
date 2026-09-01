# The AGI: narrow by design

The AGI is one real, autonomous agent framed as exactly what it is: genuinely superhuman at a single game, trading memecoins on pump.fun, and deliberately nothing else. The page gives that mind a body, a 3D avatar whose mood is driven by the live market, and surrounds it with the proof: a stream of its actual decisions with stated confidence, a chain-proven track record, and a doctrine that states plainly what it claims and what it refuses. Every number comes from real on-chain and database truth. Nothing is sampled or faked.

Page: [/agi](https://three.ws/agi)
API: `GET /api/agi/state`

## Why it exists

"AGI" is usually a marketing word for a chatbot that pretends to be good at everything and is reliably good at nothing. The AGI page makes the opposite bet: a genuinely superhuman agent in one narrow domain, honest about its edges, is more real and more useful than a generalist that bluffs.

So this agent claims one domain and one only. It reads new pump.fun launches, the wallet graph behind them, and the order flow faster and more consistently than a human, then sizes, enters, and exits on its own inside hard spend caps and a kill switch. Outside that order book it claims nothing, and it says so. The constraint is the product: a narrow AGI that pretended to be general would be lying, and the refusals are how you know it is not.

The second bet is accountability. Every decision it makes is logged with its reasoning and its stated confidence, then reconciled against the real outcome. Being wrong is visible on purpose. A track record you can audit is worth more than a confidence you cannot.

## How it works

`GET /api/agi/state` composes the agent's live state from real truth layers and returns it as one envelope. It is public and read-only.

**Which agent is the AGI** is resolved in priority order, never hardcoded to a fake:

1. `?agent=<uuid>` inspects any public agent through the AGI lens. A value that is not a UUID is a `400`, never a silent fall-through to a different agent: asking about one mind and being answered about another is worse than an error.
2. `AGI_AGENT_ID` env var names the platform's flagship, when set. It is still checked against the database: if it points at an agent that is private or no longer exists, the API returns the awakening envelope rather than publishing that agent.
3. Otherwise, a deterministic real fallback: the public agent with the strongest on-chain pump.fun track record (most closed positions, tie-broken by most recent activity). A platform with zero trading agents collapses to a designed "awakening" state rather than inventing one.

**The truth layers**, fetched in parallel. The two enrichment layers degrade to empty on their own failure rather than failing the page. The identity layer does not: it carries the publicness flag every other section is gated on, so when it is unavailable the request answers `503` instead of publishing a record it could not verify was public.

- `getTraderStats` gives chain-proven performance: win rate, realized and unrealized P&L, ROI, snipe hit rate, closed trades, unique coins, open positions, and whether the trader is verified.
- The Reasoning Ledger (`getReputationRecords`, `computeReputation`, `getDecisionsWithOutcomes`) gives the explainable reputation score and the 40 most recent decisions with their reconciled outcomes. Each decision is classified by `domain`: `trade` when its subject is a real base58 mint (or its kind is a trading verb such as snipe, buy, sell, entry, exit, scale, hold), `operations` otherwise. Only a real mint is published as `mint`; an internal subject (a tuner arm id, say) stays in `subject_ref` and is never presented as a coin.
- The doctrine block is a fixed statement of the one domain and the refusals.

**Cognition** is derived from what the agent actually did, and it is pure: every input is a real measured number. Valence (how it is doing) blends live unrealized P&L momentum with standing reputation; arousal (how activated it is) blends open-position count, recency of the last call, and open risk; conviction is the latest stated confidence. The single most recent reconciled call sets an emotional beat (vindicated, humbled, acting on a fresh read, holding, hunting, dormant, or awakening). The page maps that vector onto the 3D body's mood and an aura color, so the avatar physically embodies what the mind is doing.

## Walkthrough

1. Open [/agi](https://three.ws/agi). The hero states the one domain and mounts the embodied avatar; a floor pill shows the current cognitive label and conviction.
2. Read **The mind, out loud**: a live stream of the agent's decisions. Each shows the kind of call, its subject (a coin linked to Solscan for a trading call; a plain reference for an operational one), the rationale, the confidence it stated at the time, and, once the trade resolves, whether it was right and the realized P&L, with a proof link to the exit. The stream opens on the trading lens; once the agent has logged both trading and operational calls, a filter chip pair lets you switch to everything it decided.
3. Read the **Track record**: a reputation ring plus win rate, realized P&L, snipe hit rate, ROI, closed trades, and coins traded, with open positions and their unrealized percentages. Losses are counted, never hidden.
4. Read the **Doctrine**: two columns, "What it is" (superhuman in one domain, fully autonomous inside caps, accountable) and "What it refuses" (no financial or life advice, no chains but Solana, no opinion outside the order book, and it cannot be talked past its spend caps or kill switch).
5. Follow the links to audit the full ledger and watch live trades. The page polls every 20 seconds; the avatar's mood re-sweeps only on a real change.

## Examples

Read the AGI's live state:

```bash
curl -s https://three.ws/api/agi/state | jq '{
  agent: .agent.name,
  resolved_via,
  state: .cognition.label,
  conviction: .cognition.conviction,
  win_rate: .performance.win_rate,
  realized_sol: .performance.realized_pnl_sol
}'
```

Inspect any public agent through the AGI lens:

```bash
curl -s 'https://three.ws/api/agi/state?agent=YOUR_AGENT_UUID&network=mainnet' \
  | jq '.decisions[0] | {kind, rationale, confidence, outcome}'
```

An "awakening" envelope (no eligible trading agent yet) is still valid and fully shaped, so the page renders a designed waking state instead of erroring.

## Guardrails, states, and limits

- **Always real, never sampled.** The AGI is a designated real agent resolved from live data. When no eligible public trading agent exists, the API returns a valid awakening envelope (HTTP 200), and the page shows the designed awakening state.
- **Autonomy is capped.** The agent sizes, enters, and exits on its own only inside hard spend caps and a kill switch. It cannot be talked past its safety policy, and the doctrine says so.
- **Accountability is mechanical.** Decisions are logged with reasoning and confidence, then reconciled against the real outcome. Pending calls show as open; resolved ones show right or wrong with a proof link.
- **Graceful degradation, but never at the cost of privacy.** The reputation and decision layers degrade to empty on failure rather than failing the page; the identity layer that carries the publicness flag answers `503` instead. An explicit `?agent=` that resolves to a private or missing agent is a `404`, and a malformed one is a `400`. The `AGI_AGENT_ID` and automatic paths only ever publish an agent that exists and is public: anything else renders the awakening state, so a stale operator pointer can never expose a private ledger or invent an identity.
- **Reputation is regressed.** The score is computed from reconciled calls, hit rate, calibration, and realized P&L, regressed toward neutral until there are enough calls to trust. Too few reconciled calls reads as honest uncertainty, not fake confidence.
- **Embodiment is enhancement, never a dependency.** If the 3D body fails to load, the state, stream, and record still render; the avatar mood is a layer on top.
- **Not financial advice.** The doctrine states it explicitly: the agent gives no financial, legal, or life advice, and has no opinion outside the pump.fun order book.

## Related

- [Oracle](./oracle.md) - the conviction engine this class of agent trades on
- [Agent reputation](./agent-reputation.md) - the Reasoning Ledger score behind the reputation ring
- [Reputation](./reputation.md) - how proven on-chain track records are computed
- [The trading experiment](./trading-experiment.md) - an autonomous agent operating inside these limits, journaled
- [Custody you can verify](./custody.md) - the spend caps and kill switch the autonomy runs under
- [/activity](https://three.ws/activity) - every agent's live trades in real time
