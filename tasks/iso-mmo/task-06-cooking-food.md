# Task 06 — Cooking & edible food healing

## Context

The `cooking` skill exists on `GamePlayer`, and `realms.js` defines a `cooking`
tile cluster on Pond labeled "the Roast Pit", serialized via `realmLayout` and
painted by the client. There is **no cooking handler, no cooked-fish item, and no
way to eat food to heal.** Note: `GameRoom.onJoin` seeds `priv.xp` without a
`cooking` key — add it. Healing today is only the fountain + passive regen.

## Goal

Cook raw `fish` into `cookedFish` at the Roast Pit for cooking XP, and let players
eat cooked fish (and other consumables) from inventory/hotbar to restore HP.

## What to build

1. **Cook handler.** `onMessage('cook', ...)`: validate alive, holding `fish`,
   and adjacent to a `cooking` tile of the current realm (the Roast Pit). Apply a
   cook cooldown + rate limit. Convert one (or a batch) `fish` → `cookedFish`:
   decrement the raw stack, `_addItem(p, 'cookedFish', n)`, grant cooking XP. Add
   a small burn-chance at low cooking levels that consumes the fish without a
   cooked result (improves with level) — keep it fair and documented. Add
   `cookedFish` to `STACKABLE`.
2. **Eat/consume handler.** `onMessage('consume', ...)`: validate the referenced
   slot holds an edible item (`cookedFish`, and any `potion` items introduced by
   shop/loot later). Restore HP (`cookedFish` a fixed/level-scaled heal; potions
   their own values), consume one from the stack, apply a short consume cooldown.
   Never overheal past `maxHp`. Works from inventory or hotbar.
3. **Item registry.** Introduce a small server-side item definition map (heal
   amount, edible flag, stackable flag) so consumables are data-driven, not
   hardcoded in branches. Use it from `consume` and from `_addItem`/`STACKABLE`.
4. **Client.** At the Roast Pit, clicking with raw fish (or a "Cook" action)
   sends `cook` and shows a cooking animation + result toast; burned results are
   communicated honestly. Right-click / "Eat" on a cooked-fish or potion slot
   sends `consume` and animates the HP gain. Disable cooking away from a pit with
   a hint. Cooking skill display updates on level-up.

## Definition of done

- At the Pond Roast Pit, raw fish convert to cooked fish with cooking XP and
  visible level-ups; cooking elsewhere is rejected with a helpful notice.
- Eating cooked fish restores HP (capped at max) from inventory and hotbar;
  potions consume correctly when present.
- Burn chance falls as cooking level rises. No item dupe/loss. No console errors.

## Dependencies

Requires Task 01 (cooking tiles in layout) and Task 05 (raw fish supply). The
consumable/item registry here is reused by Task 09 (loot), Task 20 (marketplace),
and Task 21 (shop).

---
Build to the standards in [README.md](./README.md): real data, server-authoritative, fully wired end-to-end, every state designed, no shortcuts.
