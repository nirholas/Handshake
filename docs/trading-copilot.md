# The Trading Copilot — talk to your wallet

The **Trading Copilot** is the conversational front door to an agent's self-custodied
Solana wallet. You talk to it — by text or by voice — and it answers with **real live
data** (your balance, holdings, open positions, coin safety, smart-money) and prepares
**guarded trades you confirm**. It never signs on its own.

It lives in the **Copilot** tab of the Agent Wallet hub (`/agents/<id>/wallet` →
Copilot) and is **owner-only**: only the wallet's owner can open it, because it reads
that wallet's positions and can place trades from it.

> Think of it as a ChatGPT-style chat that happens to hold a wallet: markdown replies,
> streamed tokens, tool-use disclosure, copy/regenerate — plus crypto-native data cards
> and confirm-before-execute trade cards.

---

## What it can do

| You say | It does |
| --- | --- |
| "How's my portfolio?" | Reads your live SOL balance, SPL holdings, and open sniper positions, and shows a **portfolio card** |
| "Is `<mint>` safe to buy?" | Runs the rug/honeypot **firewall** and shows a verdict card (allow / warn / block) with reasons |
| "Is smart money in `<mint>`?" | Counts reputable wallets and scores smart-money conviction |
| "Buy 0.25 SOL of `<mint>`" | Surfaces a **buy card** — fresh quote + firewall verdict — that you confirm |
| "Sell 50% of `<mint>`" | Surfaces a **sell card** grounded on your actual held balance |
| "Cap my trades at 0.5 SOL" / "Pause trading" | Surfaces a **risk-limits card** (per-trade cap, daily budget, max impact, kill switch) |

Every read is instant and free — the copilot calls the tool immediately instead of
asking permission. Every **trade or limit change** comes back as a card you explicitly
confirm.

## Slash commands

Type `/` in the composer to open the command palette:

| Command | Action |
| --- | --- |
| `/portfolio` | Show live balance, holdings & positions |
| `/limits` | Read your current risk guardrails |
| `/safety <mint>` | Run the firewall on a mint |
| `/buy 0.2 <mint>` | Start a buy proposal |
| `/sell 50% <mint>` | Start a sell proposal |
| `/clear` | Clear the conversation |
| `/help` | List what the copilot can do |

Arrow keys move through the menu, `Enter`/`Tab` selects, `Esc` closes.

## Chat conveniences

- **Markdown replies** — bold, lists, and links render inline (via [`src/md.js`](../src/md.js)).
- **Live data cards** — grounded numbers appear as cards under a "Looked at N sources"
  disclosure, so the narration stays short (and voice-friendly) while the figures are
  always visible and exact.
- **Copy / Regenerate** — hover any reply to copy it or re-run the last turn.
- **Stop** — the send button becomes a stop button while a reply streams.
- **Voice**: 🎙 dictates your message (browser `SpeechRecognition`); 🔊 speaks replies
  in the agent's configured voice (ElevenLabs, with a browser-speech fallback). The
  request names the agent, so an owner-cloned voice on the owner's saved ElevenLabs key
  plays here too instead of silently degrading to browser speech.
- **Persistence** — the conversation, its data cards, and the executed-action log are
  saved per wallet + network in `localStorage` and restored when you return. Live trade
  proposals are intentionally **not** persisted, so a reload never resurrects a
  confirmable card grounded on a stale quote.

---

## How safety is enforced

The model is **read-and-propose only**. It cannot sign, and it cannot bypass a guard:

1. Read-only tools (`get_portfolio`, `get_coin_intel`, `get_smart_money`,
   `assess_safety`, `get_quote`, `get_trade_limits`) run **server-side** and feed
   grounded numbers back into the conversation. The model can never invent a balance,
   price, or safety verdict.
2. Any state-changing intent (buy / sell / risk-limits) is returned to the browser as a
   **structured proposal**, never executed on the server.
3. The browser **re-quotes it live** and, only on your confirmation, calls the existing
   guarded endpoints:
   - `POST /api/agents/:id/solana/trade`: enforces the spend guards
     ([`api/_lib/agent-trade-guards.js`](../api/_lib/agent-trade-guards.js)), the
     rug/honeypot firewall ([`api/_lib/trade-firewall.js`](../api/_lib/trade-firewall.js)),
     and the custody audit (`agent_custody_events`). The guards fail closed: a caller that
     passes neither pre-read limits nor the agent's `meta` gets the policy read from the
     agent's own row (a deleted agent has no policy and its spend is refused), and the
     ledger also meters a `per_counterparty_daily_usd` ceiling on what one agent can send
     to a single destination per day. The copilot's risk-limits card edits the per-trade
     cap, daily budget, max price impact, and kill switch; the counterparty cap is set
     from the wallet hub.
   - `PUT /api/agents/:id/trade/limits` — patches guardrails by key.

A conversation can therefore never bypass a spend cap, the kill switch, or the firewall.
If the firewall verdict is **block**, the buy card cannot be confirmed at all.

## The endpoint

```
POST /api/agents/:id/copilot          Owner-only. Body: { messages:[{role,content}], network }
                                      → text/event-stream
```

SSE events:

| Event | Payload | Meaning |
| --- | --- | --- |
| `status` | `{ phase }` | thinking / continuing / finalizing |
| `tool` | `{ name, summary, data }` | a read-only tool ran; `data` is the card payload |
| `proposal` | trade/limits proposal | a confirm-before-execute card |
| `chunk` | `{ text }` | streamed narration tokens |
| `done` | `{ reply, proposals, citations }` | final reply |
| `error` | `{ code, message }` | turn failed |

The provider chain is free-first and OpenAI-compatible, shared with the built-in chat
agent loop in [`api/_lib/llm-tool-chain.js`](../api/_lib/llm-tool-chain.js): Groq →
Cerebras → OpenRouter (including any `OPENROUTER_FALLBACK_KEYS`) → NVIDIA → SambaNova →
Mistral → Z.ai → Gemini (API key), with paid OpenAI as the backstop, each rung present
only when its key is set, so the copilot works without any paid key. Whenever the GCP
project is configured, a keyless, credits-billed **Vertex Gemini** rung is appended
unconditionally as the final anchor, so the chain always ends on a provider that cannot
be evicted by a dead key. Each round has a 45s deadline and fails over to the next rung on
any transport or non-2xx error. A 15s heartbeat keeps the stream alive across slow tool
rounds; the client aborts a genuinely dead stream and offers Retry rather than hanging.

## $THREE

`$THREE` (`FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`) is the only coin three.ws
promotes. The copilot trades **whatever mint the owner names at runtime** — coin-agnostic
plumbing — and never suggests, shills, or names another token on its own initiative.

---

## Code map

| Piece | Location |
| --- | --- |
| Client mount (chat UI, cards, slash, persistence, voice) | [`src/agent-copilot.js`](../src/agent-copilot.js) |
| Wallet-hub tab wrapper | [`src/agent-wallet-hub/tabs/copilot.js`](../src/agent-wallet-hub/tabs/copilot.js) |
| Server (tool loop, SSE, proposals) | [`api/agents/copilot.js`](../api/agents/copilot.js) |
| Provider chain + streamed tool-call reader (shared with the chat agent loop) | [`api/_lib/llm-tool-chain.js`](../api/_lib/llm-tool-chain.js) |
| Markdown renderer | [`src/md.js`](../src/md.js) |
| UI contract tests | [`tests/agent-copilot-ui.test.js`](../tests/agent-copilot-ui.test.js) |

## Related

- [The trading surfaces: Radar, Mission Control, Feed, Watchlist, Intel](trading-surfaces.md)
- [Financial controls & custody guardrails](financial-controls.md)
- [The autonomous trading experiment](trading-experiment.md)
