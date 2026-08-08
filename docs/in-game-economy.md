# The in-game economy

The `/play` open world runs a real economy. You gather materials, sell them to a
vendor for cash, buy better tools, bank what you cannot afford to lose, and
optionally spend `$THREE` on cosmetics that settle on Solana.

This page is the complete reference: every currency, vendor, gate and settlement
path, plus the wire format if you want to read the catalogs from code.

**Live numbers:** [three.ws/play/economy](https://three.ws/play/economy) renders
everything below from the running server. Prefer it over any figure quoted here,
because that page reads the game's own tables and this document is prose.

---

## Two currencies that never mix

The single most important thing to understand about this economy is that it has
two currencies and they are deliberately kept apart.

| | **Cash** | **`$THREE`** |
| --- | --- | --- |
| What it is | A game resource | The platform's coin |
| Where it lives | Your character profile, server-side | Solana |
| How you get it | Gathering, fishing, combat, selling to vendors | Buy it, or already hold it |
| What it buys | Tools, consumables, ammo, armor | Premium cosmetics, paid wheel spins |
| Can you cash it out? | No. Never. | It is already a token |

Cash is not a token, is not tradable between players for real value, and never
touches a blockchain. `$THREE` is never awarded by gameplay. That separation is
enforced in the code, not by convention: the two paths live in different modules
and settle through different systems.

The practical consequence: **you cannot farm the game for money, and you cannot
buy your way past the gameplay.** Cosmetics bought with `$THREE` are visual only.

---

## The general store

Walk up to the clerk NPC and press <kbd>E</kbd>.

### What it pays you for

Only gathered and looted goods are sellable. Tools, weapons, mounts and your
starter kit are deliberately excluded from the sell table, so nobody can dump
their kit for cash or farm a buy-then-sell arbitrage loop.

The sellable set is wood, stone, coal, fish, cooked fish, bones and hide. Cooking
a fish before selling it is worth noticeably more than selling it raw, which is
the intended reason to level cooking.

### What it sells you

Tools (rod, axe, pickaxe, hammer), a melee weapon, health potions, the armor
vest, and ammo in bundles. Ammo and arrows are sold in stacks, so their per-unit
price is lower than the sticker price suggests.

### Why prices cannot drift

`multiplayer/src/shop.js` holds one price table. The authoritative server prices
every trade against it, and the client renders its store UI from the same import.
There is no second copy to fall out of sync, so the price you are shown is
always the price you are charged.

Every trade is validated server-side. The client sends an intent; the server
prices it, checks your inventory and purse, mutates the profile, and streams the
result back. The UI never assumes a trade landed until the server confirms it.

---

## The bank

Walk up to the teller NPC and press <kbd>E</kbd> to move cash between your
**carried purse** and your **banked balance**.

This is the only real risk decision in the economy:

- **Carried cash drops when you die.** So do carried items. They go into a
  tombstone.
- **Banked cash survives.** Always.

That asymmetry is the entire point of the bank existing. If you are about to go
somewhere dangerous, deposit first. The walk back to the bank is the cost.

**The walk is enforced by the server, not by the UI.** Deposits, withdrawals and
every store trade are refused unless you are actually standing at the teller or a
store counter, the same proximity rule the ponds, the gather nodes and the wheel
have always used. Without it the cost above is imaginary: anything that can bank
from the middle of a fight never risks a coin.

---

## The `$THREE` boutique

The boutique sells premium wardrobe cosmetics for real, on-chain `$THREE` paid
from your connected Solana wallet. It is the only part of the world economy that
touches a blockchain.

### How a purchase settles

1. **Quote.** The server prices the charge from its own catalog. A client-supplied
   price is never trusted.
2. **Sign.** You sign one split transaction from your wallet.
3. **Verify.** The server re-fetches the confirmed transaction from Solana RPC and
   checks the destination and amount before granting the cosmetic. The settled
   quote nonce and the transaction signature are both consumed in a shared,
   Redis-backed ledger
   ([multiplayer/src/settlement-guard.js](../multiplayer/src/settlement-guard.js)),
   so one payment grants exactly one item across every coin world, every server
   restart, and every instance. The quote is also sealed to the character that
   requested it, so it cannot be redeemed onto another profile.

You are never granted an item on the strength of a client claiming it paid.

### Where the money goes

Every paid `$THREE` sale splits **50% to the holder-rewards sink and 50% to the
treasury**. Paid wheel spins use the same split and the same verified settlement
primitives.

### What it is not

This is **not** the same rail as the USDC cosmetics shop for the standalone
character creator, which sells a different catalog through
[x402](x402.md) and is surfaced publicly at [/fits](https://three.ws/fits).
Two catalogs, two currencies, two rails. Do not confuse them.

---

## Fortune's Folly (the wheel)

A landmark in the plaza. Walk up and press <kbd>E</kbd>.

- **One free spin every 12 hours.** The cooldown is persisted on your profile, so
  it survives a disconnect. You cannot reset it by rejoining.
- **Or pay $3 worth of `$THREE`** for a spin, split 50/50 to holder rewards and
  treasury, verified on-chain before any prize is granted.
- **Gated at average skill level 3.** A light anti-farm floor, not a grind. You
  start at level 1, so this asks for a little real play.

The wheel has 20 wedges and **all of them are equal odds by design**. That is not
an implementation detail to be tuned away: the client renders a fixed-angle wheel,
so the visual and the probability must stay identical or the wheel would lie.

Before a spin is offered or paid for, the server checks there is inventory room
for **every** item prize the wheel can award, not just one of them: the roll is
uniform across wood, stone and coal, so room for only one of the three would
still leave two thirds of the wheel with nowhere to land. A win can never be lost
to a full pack, and you can never pay for a spin whose prize would be discarded.

If a pack somehow fills between paying and rolling (you have a wallet open for a
while), the prize is never voided. It converts to its cash value and the result
says so in as many words, because a prize that quietly became four cash reads as
a broken wheel.

The full paytable with real per-outcome odds is on
[three.ws/play/economy](https://three.ws/play/economy).

---

## Progression

The economy is tuned against five skills: **combat, woodcutting, mining, fishing
and cooking**, each capped at level 99. You carry 24 inventory slots and a 6-slot
hotbar, with stackable items reaching 999 per stack.

Gathering skills feed the sell table, cooking multiplies what fish are worth, and
combat determines what you can survive long enough to loot. The wheel's level
gate reads the average across all five, so there is no single skill to rush.

---

## Reading the catalogs from code

Everything above is published as JSON.

### `GET /api/play/economy`

Public, no authentication, no session. Returns the complete reference: both
currencies, the store's buy and sell catalogs, the bank rule, the boutique
listings, the wheel's gates and paytable, and the progression constants.

```bash
curl -s https://three.ws/api/play/economy | jq '.generalStore.sell'
```

```json
[
  { "item": "wood", "label": "Wood", "price": 2 },
  { "item": "cookedFish", "label": "Cooked Fish", "price": 9 }
]
```

The response is static configuration, so it is cached hard at the edge and only
changes when the game's own tables change, which ships as a deploy.

A few fields worth knowing:

| Field | Meaning |
| --- | --- |
| `currencies.cash.onchain` | Always `false`. Cash never leaves the game. |
| `currencies.token.onchain` | Always `true`, with `chain: "solana"`. |
| `generalStore.buy[].unitPrice` | Per-unit cost, derived for bundled entries like ammo. |
| `boutique.rewardsBps` / `treasuryBps` | The split in basis points. They sum to `10000`. |
| `wheel.paytable[].wedges` | How many of the 20 wedges award this exact prize. |
| `wheel.paytable[].oddsPct` | Summed odds for that prize, not a single wedge's. |

Identical wedges are grouped in `paytable`, with their odds summed, so a client
can render "4 wedges, 20%" instead of four near-identical rows. The odds are
summed from each wedge's own `oddsPct` rather than assumed uniform, so the
numbers stay correct if the wheel is ever re-weighted.

### Why this endpoint exists

A reference that restates the game's numbers drifts the moment someone retunes a
price, and a stale price table is worse than none. So this endpoint does not
restate anything: it imports the same modules the multiplayer server prices
trades with (`multiplayer/src/shop.js`, `items.js`, `cosmetics-catalog.js`,
`spin-wheel.js`, `economy.js`) and serializes them. There is exactly one copy of
every number in this system.

---

## Where the code lives

| Piece | Location |
| --- | --- |
| Price tables (store + boutique) | [multiplayer/src/shop.js](../multiplayer/src/shop.js) |
| Purse, bank, inventory, skills, death drop | [multiplayer/src/economy.js](../multiplayer/src/economy.js) |
| On-chain quote, split, verification | [multiplayer/src/game-token.js](../multiplayer/src/game-token.js) |
| Wheel paytable, gates, handlers | [multiplayer/src/spin-wheel.js](../multiplayer/src/spin-wheel.js) |
| Server message handlers | [multiplayer/src/rooms/WalkRoom.js](../multiplayer/src/rooms/WalkRoom.js) |
| Store and bank UI | [src/game/economy-ui.js](../src/game/economy-ui.js) |
| Vendor NPCs | [src/game/npc/economy-npcs.js](../src/game/npc/economy-npcs.js) |
| Boutique purchase flow | [src/game/boutique-purchase.js](../src/game/boutique-purchase.js) |
| Public reference endpoint | [api/play/economy.js](../api/play/economy.js) |

---

## Next

- **[Earn and spend in /play](tutorials/earn-and-spend-in-play.md)** walks the
  whole loop end to end, from your first gathered log to a cosmetic unlock.
- **[three.ws/play/economy](https://three.ws/play/economy)** is the live reference
  with the current catalogs and odds.
- **[Coin communities](coin-pages.md)** covers the worlds themselves: how a coin
  becomes a walkable 3D space.
