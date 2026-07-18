# Alpha Co-pilot: your agent reads a launch, out loud

The Alpha Co-pilot is the intelligence and voice layer on top of your agent's trade rails. Pick an agent, point it at a real live pump.fun launch, and it reads the coin in character, grounded in live liquidity, holder, and smart-money data, then its 3D avatar speaks the verdict aloud. Every figure it says is checked against the real numbers the server fetched; a fabricated one is rejected before it ever reaches the avatar's mouth. If you own the agent, you can act on the read, but only through the same guarded wallet path the rest of the platform uses, clamped to your spend limits and fully audited.

Page: [/alpha-copilot](https://three.ws/alpha-copilot)
API: `GET /api/agents/:id/alpha/candidates`, `POST /api/agents/:id/alpha/read`

## Why it exists

A raw launch feed is a wall of tickers. What a trader actually wants is a read: is this worth a shot, what could go wrong, and how convinced should I be, said quickly and in a voice with a point of view. The Alpha Co-pilot gives every agent that voice.

The hard part is trust. An LLM asked to comment on a coin will happily invent a market cap or a liquidity number. That is worse than useless when money is on the line. So the co-pilot is built anti-hallucination first: the model only ever sees real numbers the server pulled, and its output is clamped and scrubbed against those exact inputs before anything is shown or spoken. A figure that does not match the live data is replaced with a grounded line, and the page tells you it happened.

The second principle is separation of powers. The narrator reads and talks; it never signs. Acting on a read goes through the identical guarded path (`executeAgentTrade`) the conversational copilot uses, so the spend policy, the rug and honeypot firewall, and the custody audit all apply. The mouth and the wallet are different systems on purpose.

## How it works

**Loading an agent.** The picker draws from two real sources, the public agent directory and the featured endpoint, so it is never empty. Public agents unlock read-only commentary; owning the agent additionally unlocks wallet-aware sizing and the action gate. Its avatar mounts as a live `<agent-3d>` body on stage.

**Candidate launches.** `GET /api/agents/:id/alpha/candidates` returns real live pump.fun mints from the feed, each with a smart-money score, a quality score, market cap, age, and a sybil flag when one funder cluster dominates the holders. The page surfaces a single "Top pick", the highest combined real conviction, so a first-time visitor has an obvious coin to ask about.

**The read.** `POST /api/agents/:id/alpha/read { mint, network }` assembles a grounded `signals` bundle from live sources: bonding-curve state, a real non-binding buy quote at a reference size for a true price-impact read, graduation progress, smart-money wallets, and, for the owner, the agent's wallet balance and spend limits. The agent's persona then produces an in-character read: a verdict (`snipe`, `watch`, or `pass`), a conviction score, a spoken line, the risks, and which signals it cited. That output is validated against the bundle (`validateRead` in `api/_lib/alpha-read.js`); if a figure in the draft does not match, the line is replaced with a grounded one and a `hallucination_guard.line_replaced` flag is set. The read is coin-agnostic analytics over whatever mint the feed surfaces; it never names or recommends any specific other token.

**The voice.** The avatar plays a talk animation while the spoken line is voiced through the agent's configured TTS provider (ElevenLabs when set, otherwise the server's free TTS lane, with browser speech as a final fallback).

**Acting (owner only).** When the gate says you can act, an "Act" button opens a drawer that fetches a fresh live quote (`previewAgentTrade`), shows what you pay, the expected tokens, and the price impact, and only then lets you confirm. Confirming calls `executeAgentTrade`, which is re-checked against the firewall and your spend limits at submit and written to the custody audit. The narrator itself never moves funds.

## Walkthrough

1. Open [/alpha-copilot](https://three.ws/alpha-copilot). It resolves an agent to open with (a `?agent=` in the URL, your last-used one, your own agent if signed in, or a featured public agent) and brings it on stage.
2. Pick a different agent from the rail, or paste an agent ID or profile URL to load one directly.
3. Browse the live launches. The "Top pick" is highlighted. Each card shows the smart-money and quality bars, market cap, age, and any sybil-cluster flag.
4. Click "Ask for a read" on a launch. The avatar thinks while the server pulls live liquidity, holders, and smart-money signals.
5. The read lands: a verdict badge, a conviction bar that counts up, the spoken quote, the risks, and the exact signals it used (the ones it cited are highlighted). The avatar speaks the line aloud.
6. If you own the agent and the gate is open, click "Act", review the fresh live quote and price impact in the drawer, and confirm. The buy executes through the guarded wallet and links you to the transaction and the custody trail.

## Examples

Get real candidate launches for an agent:

```bash
curl -s 'https://three.ws/api/agents/YOUR_AGENT_UUID/alpha/candidates?network=mainnet' \
  | jq '.items[] | {symbol, market_cap_usd, smart_money_score, quality_score, sybil_flag}'
```

Ask for a grounded read (public, read-only for a published agent):

```bash
curl -s https://three.ws/api/agents/YOUR_AGENT_UUID/alpha/read \
  -H 'content-type: application/json' \
  -d '{ "mint": "SOME_LIVE_MINT", "network": "mainnet" }' \
  | jq '{verdict: .read.verdict, conviction: .read.conviction,
         line: .read.spoken_line, guard: .read.hallucination_guard,
         liquidity: .signals.liquidity_sol, mcap: .signals.market_cap_usd}'
```

When `read.hallucination_guard.line_replaced` is true, the co-pilot caught a figure that did not match the live data and spoke a grounded line instead; the `signals` block is the ground truth.

## Guardrails, states, and limits

- **No fabricated figures reach the mouth.** The model only sees real fetched numbers, and its output is validated against them. A mismatch replaces the line and raises `line_replaced`; the page shows a note that the grounded signals are authoritative.
- **The narrator never signs.** Reading and speaking are strictly separate from spending. Acting is a distinct, explicit owner action.
- **Owner-only, guarded action.** Only the agent's owner sees the action gate. A buy runs through `executeAgentTrade`, re-checked against the firewall and your spend limits at submit, and written to the custody audit. Public viewers see the read but no action.
- **Live quote before confirm.** The act drawer fetches a fresh, non-binding quote showing what you pay, expected output, and price impact; the trade is confirmed against that, not against a stale figure.
- **Spend policy is the ceiling.** Per-trade and daily limits, and a paused-trading flag, are surfaced in the owner's read and enforced server-side; the co-pilot cannot size past them.
- **Empty and error states are designed.** No live launches renders a "check again" state; a feed hiccup or a failed read shows an inline retry; a bad avatar or TTS provider degrades gracefully (browser speech backs up TTS, initials back up a broken avatar).
- **Coin-agnostic.** The read analyzes whatever runtime mint the live feed surfaces and never promotes a specific token.
- **Not financial advice.** A verdict and conviction are informational analytics, one input among many; live trading risks real funds.

## Related

- [Custody you can verify](./custody.md) - the spend limits, firewall, and audit the "Act" path runs under
- [Financial controls](./financial-controls.md) - the plain-English rules and real-time defense on the same rails
- [Oracle](./oracle.md) - the platform conviction engine over the same launch universe
- [Trading surfaces](./trading-surfaces.md) - Mission Control executes through this same guarded path
- [/agi](https://three.ws/agi) - a fully autonomous agent reading and trading the same feed
