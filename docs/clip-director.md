# Clip Director: every trade becomes content

We are a media company that happens to trade. Every notable close emits a piece of
content: a ticker, a multiple, an avatar reaction, and a *reason*. The Clip Director
turns one real closed trade into the optimal shareable artifact per surface, X,
Telegram, or the in-app Feed, so the reasoning and the card become the acquisition
channel and the trading stays the retention.

Page: [/clip-director](https://three.ws/clip-director) · API: `/api/clip-director`

## What it produces

For a chosen trader agent it fetches the most notable recent closed round-trip (biggest
absolute realized move, so the card headlines a real story, a big win *or* a big honest
loss) and directs one card per surface:

- **hook** (<=80 chars, the scroll-stopping first line, true),
- **feature_stat** (the single most compelling real number to headline),
- **avatar_gesture** (`celebrate` / `point` / `wave` / `shrug` / `sweat`) plus a
  **gesture_clip** that resolves to a real animation clip in the manifest, so the
  arena / trader avatar can actually perform the reaction,
- **body** (1-2 lines, what happened and why, tuned per surface: X punchier, Telegram chattier, Feed mid),
- **cta** (`fork-this-trade` / `copy-the-agent` / `view-track-record`),
- **alt_text** (an accessibility description of the card).

Honest by design: a losing trade still gets a card (radical downside-transparency is the
brand), with a "live to trade again" tone, always with a verifiable on-chain angle. No
number is invented; every stat traces to the closed position it was handed. When no LLM
provider is available a deterministic director produces the same-shaped artifact.

## Where the numbers come from

A closed row in `agent_sniper_positions` gives entry/exit quote (SOL), realized P&L,
realized P&L %, open/close timestamps, and the exit reason. The Clip Director derives
multiple, hold time, and win/loss from those present fields and never fabricates a
market cap it does not have. The `sell_sig` becomes an on-chain proof link.

## API

Public, IP rate-limited. Sizes in SOL. $THREE is the only coin promoted; the traded
coin is user runtime data.

```bash
# Cards for an agent's most notable recent close, one per surface.
curl 'https://three.ws/api/clip-director?agent_id=<AGENT_UUID>&surface=all'

# A single surface, or a specific closed position.
curl 'https://three.ws/api/clip-director?agent_id=<AGENT_UUID>&surface=x'
curl 'https://three.ws/api/clip-director?agent_id=<AGENT_UUID>&position_id=<POSITION_UUID>'

# Direct a clip from an already-shaped trade (for the copy-engine fan-out / arena feed).
curl -X POST 'https://three.ws/api/clip-director' \
  -H 'content-type: application/json' \
  -d '{"agent_name":"Curve Sniper","surface":"x","copied_by_count":12,
       "trade":{"symbol":"TICKER","multiple":4.2,"realized_pnl_sol":1.6,
                "hold_min":42,"exit_reason":"take_profit","pnl_pct":320}}'
```

Response shape (GET):

```json
{
  "agent": { "id": "…", "name": "Curve Sniper", "avatar": null },
  "position_id": "…",
  "trade": { "symbol": "TICKER", "multiple": 4.2, "hold_min": 42, "exit_reason": "take_profit", "is_win": true },
  "proof": "https://solscan.io/tx/<sig>",
  "copied_by_count": 12,
  "clips": [
    { "surface": "x", "hook": "…", "feature_stat": "4.2x", "avatar_gesture": "celebrate",
      "gesture_clip": "celebrate", "body": "…", "cta": "copy-the-agent", "alt_text": "…" }
  ]
}
```

When the agent has no closed trades yet the response returns `clips: []` with an `empty`
message instead of an error, so a card is only ever minted from a real closed round-trip.

## Related

- [Trader Card & the claim-your-wallet wedge](trader-card.md)
- [Meta-Allocator: the ETF of degens](meta-allocator.md)
- [The trading surfaces](trading-surfaces.md) · [The Arena](https://three.ws/arena)
- [Animations & gestures](animations.md)
