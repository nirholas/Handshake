# 14 · Intents

> Tell your agent's wallet what to do in one plain sentence — it compiles the rule, shows you a dry run, and then executes it for real on Solana, inside guardrails you set.

## What it does

Intents turns an agent's wallet into a programmable teammate you talk to. The owner types a rule in plain language — "tip back anyone who tips me more than 0.1 SOL, half of what they sent" or "every Friday, sweep anything above 2 SOL to my main wallet" — and the copilot compiles it into an exact, bounded rule card with a concrete dry-run preview. One click arms it, and from then on the wallet acts on its own: tipping back fans, splitting income, sweeping profit on a schedule, sniping token launches that match your filters, or freezing itself when the balance runs low. Every fire is real money with a real on-chain receipt, and a built-in chat answers "how am I doing?" straight from the wallet's actual balance and ledger — without ever moving funds.

## How it works

The plain-language rule goes to a server-side compiler where a Claude model (with an OpenRouter fallback) is forced into a strict structured schema — one trigger, one action, owner caps — and is explicitly forbidden from inventing amounts, destinations, or tokens; if anything is missing it asks one clarifying question instead of guessing. The server independently re-validates every field, resolves .sol names to real addresses at compile time, and returns a readback plus a live dry-run before anything is stored. Armed rules live in the database: tip, income, and money-stream rules fire instantly from the real payment-settlement hooks, while scheduled, balance-floor, and launch-matching rules are swept by a scheduler every 10 minutes. Every execution flows through the same spend-policy-gated, audited signing path as every other outbound wallet action — SOL transfers sign directly, token buys and snipes route through Jupiter with slippage control and revert detection — and each fire writes an idempotent custody event stamped with the rule's ID and transaction signature, which powers the per-rule receipts, fire counts, and running dollar totals in the UI.

## Every feature

- Plain-language rule composer: describe a rule in a sentence and hit Compile
- Four one-click starter templates: Tip back generously, Self-protect on low balance, Share my income, Sweep profit on a schedule
- AI compiler that asks one clarifying question when a detail is missing instead of guessing
- Compiled intent card with a human-readable readback sentence to confirm
- Trigger and action chips with icons, plus cap chips showing per-action / daily / total limits
- Concrete dry-run simulation on every compile (e.g. 'On a 0.2 SOL tip, this sends back 0.100 SOL to the tipper')
- Read-aloud button that speaks the rule in the agent's own synthesized voice, with browser speech as fallback
- Confirm & arm / Edit wording / Cancel flow — nothing runs until the owner confirms
- Six triggers: on tip received (with minimum amount), on any income, on balance below a floor, on schedule (daily or weekly, weekday + hour UTC), on matching pump.fun launch (creator and/or market-cap filters), on money stream start
- Eight actions: tip, transfer, buy, snipe, withdraw, split income, freeze (kill switch), notify
- Flexible amounts: fixed SOL, a percentage of the tip / income / balance, or sweep everything above a SOL floor
- Destinations as raw Solana addresses or .sol names, resolved to real addresses at compile time
- Tip-back rules with no fixed destination — the engine fills in whoever just tipped at fire time
- Owner caps per rule: max USD per action, daily USD budget, and lifetime USD total, tracked against the real ledger
- Rules list with live stats per rule: color-coded status pill, fire count, dollars moved, last-run time, and last note
- Explorer receipt link on every executed rule — the actual on-chain transaction signature
- Arm / pause toggle switch on every rule
- Test now button that dry-runs any rule against a sample event without moving funds
- Delete with a confirmation dialog
- Optional public trait: advertise the behavior on the agent's public profile (e.g. 'Tips back generously') — never the rule, amounts, or caps
- Ask-your-wallet copilot chat answering questions like 'How am I doing?' from the real balance and 30-day tip/spend/net ledger, phrased in the agent's persona
- Copilot replies can be spoken aloud; Cmd/Ctrl+Enter sends a question
- Hero dashboard: active rules count, live SOL balance, lifetime dollars moved, total fires
- Frozen-wallet banner when the kill switch is engaged, pointing to where to unfreeze
- Token buys and snipes routed through Jupiter with slippage control (default 5%, hard-capped at 50%)
- Snipe rules fire at most once per matched token launch, ever
- Freeze action flips the agent-wide spending kill switch and emails the owner
- Notify action writes an audit event and emails the owner without moving funds
- Event rules (tips, income, streams) fire instantly from real payment settlements; scheduled, balance-floor, and launch rules run on a 10-minute scheduler sweep
- Mainnet / devnet network awareness throughout
- Designed loading skeletons, error state with retry, helpful empty state, and reduced-motion support

## Guardrails & safety

Owner-only end to end: the server rejects any non-owner or logged-out caller on every read and write, so a visitor can never see, create, arm, or fire an intent. Every write is CSRF-protected and rate-limited. Nothing runs without an explicit Confirm & arm, and the server re-validates the full rule independently of the AI parse; the compiler itself is forbidden from inventing amounts, destinations, or tokens and must ask a clarifying question instead. Spending is triple-capped: the rule's own per-action / daily / lifetime USD caps are checked against the real custody ledger, then the agent-wide spend policy — the same hard ceiling every other outbound action obeys — is enforced at execution time, and a frozen wallet blocks all spends and even key recovery. Executions are idempotent (one fire per event, one snipe per launch, at most one low-balance freeze per day), keep a fee buffer so the wallet never empties itself, pause instead of guessing when the price feed is down, and detect reverted swaps so a failure is never reported as success. The signing key is decrypted only at the moment of signing with an audit-logged recovery; every execution writes an audited custody event with the transaction signature. Deletes require confirmation, the copilot chat is read-only by design, and the public-trait option exposes only a behavior label — never the rule, amounts, or caps.

## Screenshot-worthy (shot list)

- The compile moment: a typed sentence becomes a bounded rule card — trigger and action chips, dollar caps, and a live dry-run line like 'On a 0.2 SOL tip, this sends back 0.100 SOL to the tipper' — with a single Confirm & arm button and a speaker icon that reads the rule back in the agent's own voice.
- The rules list with real receipts: each armed rule shows its status pill, fire count, running dollars moved, and a 'receipt' link that opens the actual on-chain transaction in the explorer.
- Ask your wallet 'How am I doing?' and get an in-character answer built from the real balance and the last 30 days of tips, spend, and rule activity — a wallet that talks back but can never move money from a question.

## API surface

- `GET /api/agents/:id/intents`
- `POST /api/agents/:id/intents/compile`
- `POST /api/agents/:id/intents`
- `POST /api/agents/:id/intents/run`
- `POST /api/agents/:id/intents/copilot`
- `GET /api/agents/:id/intents/:intentId`
- `PUT /api/agents/:id/intents/:intentId`
- `DELETE /api/agents/:id/intents/:intentId`
- `POST /api/tts/speak`
- `GET /api/cron/wallet-intents (scheduler, secret-protected)`
