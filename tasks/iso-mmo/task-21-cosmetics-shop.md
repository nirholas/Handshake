# Task 21 — Cosmetics shop

## Context

`GamePlayer` has a `cosmetic` field and players can set an avatar URL
(`_handleAvatar`, validated by `cleanAvatarUrl`), but there is no shop and no
catalog of purchasable looks. The world guide describes a cosmetic shop selling
visual-only outfits/styles (no combat effect), with rotating daily and weekly
offers, bought with gold, and equipped from the dashboard cosmetics page.

## Goal

A cosmetics shop where players spend gold on visual-only cosmetics from a rotating
catalog, own them permanently, and equip/unequip them — with no gameplay effect.

## What to build

1. **Cosmetic catalog.** Define cosmetics as data: `id`, name, visual asset/style,
   gold price, rarity, and rotation window (daily/weekly). Keep it data-driven and
   extendable. Cosmetics are strictly visual — never touch combat/stats.
2. **Rotation.** Compute the current daily and weekly offer sets from a fixed
   schedule (deterministic from the date, server-authoritative), exposing the next
   rotation time for a real countdown. Some cosmetics are always available; others
   only during their rotation.
3. **Purchase (server).** A buy handler: validate the cosmetic is currently
   offered and the player has enough gold; debit gold; add the cosmetic to the
   account's owned-cosmetics set (persisted, Task 16). Reject duplicates (already
   owned) and insufficient gold with clear notices.
4. **Equip/unequip.** Let the player equip an owned cosmetic (sets `cosmetic` /
   equipped-cosmetic state, broadcast so peers see it) or revert to default.
   Persist the equipped selection. Equipping affects only appearance.
5. **Client UI.** A cosmetics shop surface (HUD/dashboard) showing the rotating
   catalog with prices, owned vs. buyable state, affordability, a real rotation
   countdown, and buy buttons; plus a cosmetics page to equip/unequip owned items
   with a live preview on the avatar. Designed empty ("You don't own any cosmetics
   yet"), affordability, and confirmation states.

## Definition of done

- The shop shows a correct rotating catalog with an accurate next-rotation
  countdown; offers change on schedule.
- Buying debits gold, grants permanent ownership, prevents duplicate purchase,
  and rejects when gold is short.
- Equipping an owned cosmetic changes the avatar's appearance for the player and
  peers, persists across sessions, and never alters gameplay. No console errors.

## Dependencies

Requires Task 16 (owned cosmetics + equipped selection persistence). Uses the
existing avatar/cosmetic rendering path.

---
Build to the standards in [README.md](./README.md): real data, server-authoritative, fully wired end-to-end, every state designed, no shortcuts.
