# 13 · Autopilot

> Write one sentence in plain English and your agent starts paying its own bills, stacking $THREE, buying back its own coin, and sweeping the profit to you — for real, on-chain.

*One of the 23 abilities of the [Agent Wallet](../chapters/10-the-agent-wallet.md) — the money layer of a three.ws agent.*

## What it does

Autopilot turns your agent into a business that funds its own existence. You describe a treasury policy in plain English — "pay your own compute, keep a 1 SOL buffer, put 10% of tips into $THREE, sweep anything over 3 SOL to me on Fridays" — and Autopilot compiles it into clear rules you review and arm. From then on the agent settles its own AI compute bill, protects a safety buffer, dollar-cost-averages income into $THREE, compounds its coin's fees into buybacks, and sweeps profit to your wallet, every action a real on-chain transaction with an explorer link. A live runway view shows the honest truth at all times: real income versus real burn, and exactly how long the agent can sustain itself — or that it's fully self-sustaining.

## How it works

The policy text is compiled server-side by the platform's AI model chain into a strict, bounded rule set (a deterministic parser takes over if no model is available, so compiling never fails), and nothing executes until the owner reviews the rules and explicitly arms them. Once armed, an hourly platform scheduler — plus the on-demand Run Now button — runs each due rule as a real Solana transaction signed by the agent's own custodial wallet: SOL transfers for compute settlement and profit sweeps, and Jupiter-routed swaps for $THREE DCA and the agent's own coin buybacks, each confirmed on-chain before being reported as done. The runway numbers are all real reads: the agent's metered compute cost comes from its usage ledger, tip income from its custody records, and balances (including accumulated $THREE) straight from the chain. Every action first claims a unique per-period record so retries can never double-spend, is clamped by the agent's hard spend-limit policy at the moment of execution, and lands in an audit trail with an explorer link.

## Every feature

- Plain-English treasury policy editor — describe how the agent should manage its money in a sentence or two
- Three one-tap example policies (chips) that fill the editor, e.g. 'Pay your own compute. Keep a 1 SOL buffer. Put 10% of tips into $THREE. Compound coin fees into buybacks weekly. Sweep anything over 3 SOL to me on Fridays.'
- Compile step: the policy is compiled by an AI model (with a deterministic parser fallback so compiling always works) into bounded, reviewable rules — preview only, nothing runs yet
- Compile provenance note: shows whether rules were compiled 'by the model' or 'from your wording'
- Five rule types: self-fund (pay its own compute bill), buffer (hold a SOL safety floor), DCA (dollar-cost-average income or surplus into $THREE), buyback (compound its own coin's fees into buybacks), sweep (send profit above a threshold to the owner)
- Each rule type gets its own icon: 🧠 self-fund, 🛟 buffer, 📈 DCA, 🔥 buyback, 🏦 sweep
- Conflict detection: contradictory rules (e.g. a sweep threshold at or below the buffer) are flagged in red and block arming until fixed
- Assumptions panel (amber): anything ambiguous the compiler defaulted is listed so the owner knows exactly what was assumed
- DCA sizing modes: a percentage of tip income, a percentage of surplus above the buffer, or a fixed SOL amount per period
- Scheduling per rule: hourly, daily, or weekly cadence, with optional specific-weekday runs ('on Fridays')
- Sweep destination field with live Solana-address validation; arming a sweep policy without a destination is blocked
- Explicit two-step consent: compile shows every rule back, then a separate 'Arm autopilot' action (with a risk acknowledgment dialog) turns it on
- Live status badge: pulsing green 'Self-funding' when armed, grey 'Disarmed', red 'Halted' when the kill switch is on
- Runway hero: a big honest number — days (or hours/years) of runway at the current real burn, or 'Self-sustaining' when income covers costs
- Net 30-day profit/loss indicator with up/down arrow
- Income vs Compute bar comparison over the last 30 days, from real ledger data
- Six live stat tiles: wallet balance (SOL + USD), safety buffer floor, $THREE accumulated (live on-chain token balance), compute self-funded to date, buyback count + total, SOL swept to the owner + sweep count
- Armed-rules list with per-rule status chips (ok, confirmed, skipped, alert, paused, error) and the honest note from the last run
- Per-rule Pause / Resume toggle — one tap, no re-compiling
- Edit policy at any time; the saved policy text reloads into the editor
- 'Run now' button: fires one real cycle on demand and shows a per-rule results list
- Every executed action links straight to the transaction on a Solana block explorer ('view tx ↗')
- Prominent kill switch card: 'Halt autopilot' stops everything instantly; a red banner with one-tap 'Re-enable' appears while halted
- Dry-run support in the engine: rules can be evaluated and report 'would spend ~$X' without moving funds
- Hands-free operation: an hourly platform scheduler runs every armed agent's policy automatically (up to 200 agents per sweep, failures isolated per agent)
- Self-fund settles the agent's real metered AI/voice compute bill from its own wallet, converted at the live SOL/USD price — with honest partial settlement if the buffer constrains it
- Buyback targets the agent's own coin launched through three.ws; agents without a coin skip honestly
- Income-based DCA counts each period's tips exactly once, windowed from the last settled DCA
- Mainnet/devnet aware — the tab follows the wallet hub's network switch
- Designed states throughout: skeleton loading, retry-able error state, empty state with a 'Write a policy' call to action, reduced-motion support, screen-reader labels

## Guardrails & safety

Owner-only, structurally: the tab is hidden from non-owners and every endpoint re-verifies ownership server-side; all writes are CSRF-protected and rate-limited. Compiling never arms anything — arming is a separate, explicit step that shows every rule back, requires a real-funds risk acknowledgment, and is timestamped server-side as consent. Detected rule conflicts hard-block arming. At execution time every spend is clamped by the agent's spend policy (per-transaction USD cap, rolling 24-hour USD cap, wallet-freeze flag, anomaly-detection freeze) — the plain-English policy can only tighten that ceiling, never widen it. The buffer floor plus ~0.006 SOL fee headroom can never be breached, actions under a $0.02 dust threshold are skipped, and a breached buffer gates DCA and buybacks. Each rule claims a unique per-period idempotency record before spending, so a retry can never double-spend. Fail-safe by design: a missing price feed pauses the whole cycle, a failed or blocked rule pauses with an honest note instead of guessing, and swaps that land but revert are reported as failures. The DCA target is hard-locked to $THREE and cannot be redirected; token swaps are mainnet-only with slippage clamped to sane bounds. A kill switch halts every action instantly, each rule pauses individually, and every configuration change and on-chain action is written to an audit trail with explorer-verifiable signatures.

## Screenshot-worthy (shot list)

- The runway hero: a pulsing green 'Self-funding' badge next to a giant honest number — '43 d runway at the current burn' or simply 'Self-sustaining' — over live income-vs-compute bars and six real stat tiles ($THREE accumulated, compute self-funded, buybacks, SOL swept to you)
- The compile moment: type one English sentence — 'Pay your own compute. Keep a 1 SOL buffer. Put 10% of tips into $THREE. Sweep anything over 3 SOL to me on Fridays.' — and watch it become five bounded rules with icons, plus red conflict callouts and amber 'here's what I assumed' notes before you're allowed to arm
- Hit 'Run now' and each rule reports back with a status chip and a 'view tx ↗' link to a real Solana explorer page — proof on-chain, not a dashboard animation

## API surface

- `GET /api/agents/:id/autopilot?network=mainnet|devnet (policy + runway + spend caps)`
- `POST /api/agents/:id/autopilot/compile (plain English → structured rule preview)`
- `PUT /api/agents/:id/autopilot (save / arm / disarm / pause / kill)`
- `POST /api/agents/:id/autopilot/run (run one real cycle now, supports dry_run)`
- `Server-side: Jupiter swap API for $THREE DCA and coin buybacks, Solana RPC for balances/sends, hourly cron /api/cron/treasury-autopilot`
