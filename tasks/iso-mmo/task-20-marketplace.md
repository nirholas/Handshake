# Task 20 — Marketplace: gold & gold-for-token listings

## Context

Players earn gold (mob kills) and gather stacks of resources, but there is no way
to trade with other players. The `api/marketplace*` endpoints in this repo are
the platform's AGENT marketplace — unrelated to the in-game item economy; do not
repurpose them. The world guide describes an in-game marketplace opened from a
HUD button (cart icon), with Buy / Sell / My Listings tabs, two listing types:
- **Gold listings** — trade items for gold; buyer pays gold, seller receives the
  full amount (no fee).
- **Gold-for-token listings** — a seller lists in-game gold priced in USD; buyers
  pay on-chain with the game token. Payment splits 95% to seller / 5% to treasury.

## Goal

A full player-to-player marketplace with both listing types, server-authoritative
escrow of listed goods, and on-chain settlement for token listings.

## What to build

1. **Listing store.** Persist listings (Task 16 store / `api/`): `id`, `seller`
   account, type (`gold` | `goldForToken`), the offered item(s) or gold amount,
   price (gold amount, or USD for token listings), status, timestamps. Listings
   are account-scoped and survive sessions/instances.
2. **Escrow on list.** When a player lists, remove the offered item/gold from
   their inventory immediately (escrow) so they can't list-and-spend the same
   goods. Returning unsold goods on cancel restores them. No duplication.
3. **Gold listings (buy).** A buyer with enough gold buys: atomically debit buyer
   gold, credit seller the full amount, deliver escrowed item(s) to the buyer
   (bag overflow if inventory full). No treasury cut.
4. **Gold-for-token listings (buy).** Buyer pays on-chain via Task 18: server
   quotes the token amount from the listing's USD price, buyer's wallet sends one
   transaction, server verifies it with a 95/5 seller/treasury split, then
   delivers the escrowed in-game gold to the buyer and records the sale. Seller
   receives 95% of the token to their wallet; 5% to treasury. Reject on failed
   verification; never release goods before settlement.
5. **Marketplace UI.** A HUD cart button (works anywhere, no need to stand at a
   building) opening tabs:
   - **Buy** — browse active listings (filter/sort by item, price), buy flow with
     gold or wallet payment per listing type.
   - **Sell** — pick inventory items / gold amount, set price + type, confirm.
   - **My Listings** — view/cancel own listings (cancel returns escrow).
   Designed loading/empty ("No listings yet — be the first to sell")/error states,
   and clear pending/confirming states for on-chain buys.

## Definition of done

- Listing escrows the goods; cancel returns them; nothing can be double-spent.
- Gold purchases transfer item↔gold atomically with no fee and no dupe/loss.
- Token purchases require a real verified on-chain payment with the 95/5 split
  before the gold is released; the seller is paid 95% and treasury 5%.
- Two sessions can complete a real trade each way. No console errors.

## Dependencies

Requires Task 16 (persistence/escrow store) and Task 18 (token quote + verified
payment + split). Distinct from the platform agent marketplace.

---
Build to the standards in [README.md](./README.md): real data, server-authoritative, fully wired end-to-end, every state designed, no shortcuts.
