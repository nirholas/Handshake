# 05 · Copilot

> Talk to your agent's wallet — by text or voice — and it answers with live on-chain data, then preps guarded trades you confirm with one tap.

## What it does

Copilot is a conversational trading assistant built into every agent wallet. The owner asks questions in plain language — "how's my portfolio?", "is this coin safe?", "buy 0.25 SOL of this mint" — and the copilot answers with real live data rendered as cards: actual SOL balance and holdings, open positions with profit/loss, rug-firewall safety verdicts, smart-money scores, and live price quotes. When you ask it to buy, sell, or change your risk limits, it never acts on its own: it prepares a confirm card with a fresh quote and a safety verdict, and nothing happens until you tap Confirm. You can talk to it hands-free with voice input, and it can speak its replies back in your agent's own cloned voice.

## How it works

The tab streams each conversation turn over server-sent events from a tool-calling LLM that runs on a free-first provider chain (Groq, OpenRouter, NVIDIA NIM, with OpenAI as paid backstop). The model gets six read-only tools that execute server-side against real sources — live Solana RPC balance and token-account reads, a pump.fun launch-intelligence database, a wallet-reputation smart-money graph, a rug/honeypot firewall that runs an actual simulated buy-then-sell round-trip on-chain, and live bonding-curve/AMM quotes. Any buy, sell, or risk-limit intent is returned to the browser as a structured proposal card grounded with a fresh quote and firewall verdict; only when the owner confirms does the client call the same guarded, server-signed trade endpoint the manual Trade tab uses, so a conversation can never bypass a spend cap, the kill switch, or the custody audit trail. If the model stalls in its tool loop, the server forces a plain-language wrap-up so the owner always gets an answer.

## Every feature

- Natural-language chat with the agent, streamed token-by-token over SSE with a typing indicator and live status phases (Thinking / Analyzing / Summarizing)
- Voice input via browser speech recognition — mic button with a pulsing listening state, live transcript in the composer, auto-sends when you stop talking, gracefully disabled where unsupported
- Voice output toggle — replies spoken in the agent's configured ElevenLabs cloned voice, with a free server TTS lane and a browser speech-synthesis fallback
- Agent persona: the copilot speaks in character using the agent's own persona prompt and name
- Live Portfolio card — real SOL balance, up to 30 SPL/Token-2022 holdings, and open sniper positions with green/red unrealized PnL
- Firewall safety card — allow/warn/block verdict badge, 0-100 safety score meter, and plain-language reasons from a real simulated on-chain buy→sell round-trip plus mint/freeze-authority audit
- Smart-money card — count of reputable wallets in a coin, a 0-100 smart-money score, and a sybil flag when one funder cluster dominates
- Coin intel card — quality score, graduation/rug outcome, ATH multiple, and risk-flag chips from the platform's pump.fun launch-intelligence engine
- Live quote card — expected output, price impact color-coded at 5% (warn) and 15% (danger) thresholds, and minimum received
- Risk-limits card — per-trade SOL cap, daily SOL budget, max price impact, and kill-switch state
- Buy proposal confirm cards — coin name, amount, expected tokens, price impact, max slippage, the model's one-line rationale, an embedded expandable firewall verdict panel, and Confirm/Cancel buttons
- Sell proposal confirm cards — sell by token amount or by percent of holding (percent resolves against the live held balance; defaults to sell-all)
- Risk-limit proposal cards — conversational changes to per-trade cap, daily budget, max price impact, or the kill switch ('pause trading'), applied only on confirm
- Firewall-blocked buys are un-confirmable — the confirm button is removed entirely and the block reason is shown
- One-tap trade execution through the guarded server-signed endpoint, with an idempotency key so a retry never double-spends
- Success results link straight to the transaction on Solscan (or Solana Explorer on devnet)
- Executed-actions log — a collapsible, persisted history of every buy, sell, and limit change with explorer links
- Slash-command palette with autocomplete: /portfolio, /limits, /safety <mint>, /buy, /sell, /clear, /help — arrow keys, Enter/Tab to pick, Escape to dismiss
- Suggestion chips on the empty state: 'How's my portfolio?', 'What are my risk limits?', 'Is this coin safe to buy?'
- Collapsible per-turn activity disclosure grouping everything the copilot read ('Looked at 3 sources'), open while streaming
- Markdown-rendered replies (bold, lists, links, inline code)
- Per-message hover actions: copy any reply, regenerate the last one
- Send button doubles as a Stop button mid-stream — aborting keeps whatever already streamed
- Retry-in-place on errors: re-runs the last turn without duplicating your message
- Conversation persistence per wallet and per network in local storage (last 40 messages plus the action log) — live trade proposals are deliberately dropped on reload so a stale quote can never be confirmed
- Mainnet/devnet aware — the network is read live on every turn and history is kept separately per network
- 45-second stall watchdog with 15-second server heartbeats, so a dead connection fails cleanly into a retry instead of hanging
- Free-first LLM provider chain with mid-turn failover (Groq → OpenRouter → NVIDIA → OpenAI backstop)
- Server-side memoization of duplicate tool reads within a turn — detects a spinning model and cuts straight to a final answer
- Guaranteed answer: if the tool loop hits its 4-round cap, the server forces a brief plain-language summary
- Owner-only: visitors see a locked notice instead of the copilot
- Accessible throughout — live-region announcements, focus rings, reduced-motion support, keyboard-first composer (Enter to send, Shift+Enter for a new line), responsive down to phone widths

## Guardrails & safety

Owner-only on both client and server — the tab is hidden from visitors and the API returns 403 for anyone but the wallet's owner. The model can never sign or execute: every buy, sell, and risk-limit change is a proposal card the owner must explicitly confirm, and confirmation routes through the same guarded server endpoint as manual trading — enforcing the kill switch, per-trade SOL cap, rolling daily SOL budget, price-impact circuit breaker (15% default), max-slippage ceiling, SOL fee/rent headroom, USD spend ceilings, anomaly detection, and natural-language spend policies, with every movement recorded in a custody audit ledger. The rug/honeypot firewall runs a real simulated buy-then-sell round-trip before any buy; a "block" verdict removes the confirm button entirely, and the system prompt orders the model to refuse blocked buys. Data sources that fail degrade to "warn" — never a fabricated "allow." Trades carry idempotency keys (retries can't double-spend) and single-use CSRF tokens; the endpoint is rate-limited per user. Proposal slippage is clamped to 50% max server-side. Stale proposals are never restored after a page reload, so a confirm card can't resurrect on an outdated quote. The copilot is coin-agnostic and instructed never to suggest or shill any token on its own initiative — it only trades mints the owner explicitly names.

## Screenshot-worthy (shot list)

- Say 'buy 0.25 SOL of <mint>' out loud and watch it become a confirm card with a live quote, color-coded price impact, and a rug-firewall verdict meter — and when the firewall says block, the confirm button literally doesn't exist
- Ask 'how's my portfolio?' and the agent streams back real data cards as it reads the chain: actual SOL balance, every holding, and open positions glowing green or red with live PnL
- Say 'pause all trading' and the kill switch flips through a confirm card — full risk management as a conversation, in your agent's own cloned voice

## API surface

- `POST /api/agents/:id/copilot (SSE conversation turn with tool events, proposals, and streamed narration)`
- `POST /api/agents/:id/solana/trade (guarded, server-signed buy/sell execution on confirm)`
- `PUT /api/agents/:id/trade/limits (apply confirmed risk-limit changes)`
- `GET /api/agents/:id/voice (agent's voice configuration for spoken replies)`
- `POST /api/tts/eleven (ElevenLabs cloned-voice speech)`
- `POST /api/tts/speak (free-lane server TTS fallback)`
