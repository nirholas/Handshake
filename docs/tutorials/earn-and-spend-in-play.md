# Earn and spend in /play

By the end of this tutorial you'll have run the full economic loop in the three.ws
open world: **gather raw materials, sell them to a vendor for cash, buy a better
tool, bank the rest so death can't take it, and spin the wheel.** You'll also
understand the one decision the economy actually asks of you, and how the
optional on-chain side works if you want a premium cosmetic.

Along the way you'll learn why the world has two currencies that never touch,
and why the server, not your client, decides every price.

**Prerequisites:** a modern browser. No account, no wallet, and no crypto are
needed for anything except the final optional section, which spends `$THREE`.

---

## What you're building toward

```
  gather  ──►  sell at the store  ──►  cash  ──►  buy a better tool
                                        │                │
                                        ▼                ▼
                                     the bank      gather faster
                                   (survives death)
```

That loop is the whole game economy. Everything else, including the wheel and the
cosmetics boutique, hangs off it.

---

## Step 1: Get into the world

Open [three.ws/play](https://three.ws/play). You'll drop into a coin world as a
walkable 3D character.

Controls you need for this tutorial:

| Key | Does |
| --- | --- |
| <kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd> | Move |
| Mouse | Look |
| <kbd>E</kbd> | Interact with whatever you're standing next to |

Everything below is triggered by walking up to something and pressing
<kbd>E</kbd>. There is no menu to hunt through.

---

## Step 2: Gather something worth selling

Find a tree or a rock and gather from it. You'll pick up **wood** or **stone**,
and the matching skill (woodcutting, mining) will start earning experience.

Only gathered and looted goods can be sold. That's deliberate, and it's worth
understanding now rather than discovering later:

> The store will **not** buy your tools, weapons, mounts or starter kit. If it
> did, you could buy a rod for 45 and sell it back for something, and the whole
> economy would collapse into a buy-then-sell loop. The sell list is short on
> purpose.

The sellable set is wood, stone, coal, fish, cooked fish, bones and hide.

**Fishing is the highest-value early loop**, but only if you cook first. A raw
fish sells for 3. Cooking it turns it into a cooked fish worth 9, which is a
three-times return for one extra step. This is the intended reason to level
cooking, and it is the single best-paying thing a new player can do.

Gather a stack of something before moving on. Twenty logs is plenty.

---

## Step 3: Sell to the general store

Find the **general store clerk** NPC and press <kbd>E</kbd>.

The store panel has two sides: what it buys from you, and what it sells. Sell
your stack.

Watch what happens under the hood, because it explains the whole design:

1. Your client sends an *intent*: "sell 20 wood."
2. The **server** prices it against its own table, checks you actually have 20
   wood, mutates your profile, and streams back the result.
3. Only then does the UI update.

Your client never decides a price and never assumes a trade landed. If you edited
the price in your browser, the server would price it correctly anyway. This is
why the number you see is always the number you're charged: there is exactly one
price table, and both the server and the client render from it.

---

## Step 4: Buy a better tool

Still at the store, switch to what it sells. You'll see tools (rod, axe,
pickaxe, hammer), a sword, health potions, an armor vest, and ammo.

Buy the tool matching whatever you've been gathering. This is the reinvestment
step, and it's what makes the loop compound: better tool, faster gathering, more
cash.

**Watch the bundles.** Ammo and arrows are sold in stacks, so compare per-unit
cost rather than sticker price. The live reference at
[three.ws/play/economy](https://three.ws/play/economy) shows the per-unit price
for every bundled entry, which is the honest number to compare.

---

## Step 5: Bank what you can't afford to lose

Find the **bank teller** and press <kbd>E</kbd>. Deposit your remaining cash.

This is the one genuine decision the economy asks of you:

| | Carried purse | Banked |
| --- | --- | --- |
| Dying | **Drops into a tombstone** | **Survives** |
| Spending at a vendor | Immediate | Withdraw first |

Carried cash and carried items drop when you die. Banked cash never does. The
cost of safety is the walk back to the teller.

The practical rule: **bank before you go anywhere dangerous, carry only what you
plan to spend.** New players almost always learn this the expensive way.

---

## Step 6: Spin the wheel

Find **Fortune's Folly** in the plaza and press <kbd>E</kbd>.

You get **one free spin every 12 hours**. The cooldown lives on your profile
server-side, so logging out and back in does not reset it.

Two things worth knowing before you spin:

- **All 20 wedges have equal odds.** The client draws a fixed-angle wheel, so the
  visual and the real probability are the same by construction. Most wedges are
  modest gather resources; a few are cash; one is a jackpot.
- **You need average skill level 3.** It reads the average across all five skills
  (combat, woodcutting, mining, fishing, cooking), so no single skill can be
  rushed to unlock it. If you did steps 2 through 4, you're close.

The server also checks there's inventory room for any prize the wheel could award
*before* offering the spin, so a win can never be lost to a full pack.

The full paytable, with the real odds for each outcome, is published at
[three.ws/play/economy](https://three.ws/play/economy).

---

## Optional: buy a cosmetic with `$THREE`

Everything so far used **cash**, which is a pure game resource. It never leaves
the world, is not a token, and cannot be cashed out.

The boutique is the one place the world touches a blockchain. Premium wardrobe
cosmetics are unlocked with real `$THREE` from your connected Solana wallet.

> **This spends real money.** Nothing in the gathering loop above can earn
> `$THREE`, and nothing you buy here affects gameplay. Cosmetics are visual only.

If you want one, open your wardrobe and pick a premium fit. The flow is:

1. **Quote.** The server prices the charge from its own catalog. Your client
   cannot propose a price.
2. **Sign.** You approve one split transaction in your wallet.
3. **Verify.** The server re-fetches the confirmed transaction from Solana RPC
   and checks the destination and amount before granting anything. A settled
   quote can't be replayed for a second item.

Every paid sale splits 50% to the holder-rewards sink and 50% to the treasury.

---

## What you learned

- The world has **two currencies that never mix.** Cash is earned and spent
  in-game and can't be cashed out; `$THREE` is on-chain and can't be farmed.
- **The server prices everything.** One table, imported by both sides, so the
  displayed price and the charged price cannot disagree.
- **The bank is the real decision.** Carried cash drops on death, banked cash
  doesn't.
- **Cook before you sell.** A cooked fish is worth three times a raw one.
- **The wheel is honest by construction:** equal-odds wedges matching a
  fixed-angle render, with pack space checked before you're allowed to spin.

## Next

- **[The in-game economy](../in-game-economy.md)** is the full reference: every
  catalog, gate, settlement path, and the JSON wire format.
- **[three.ws/play/economy](https://three.ws/play/economy)** shows the live
  catalogs and odds, read from the running server.
- **[Coin communities](../coin-pages.md)** explains the worlds themselves, and how
  any coin becomes a walkable 3D space.
