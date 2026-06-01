# Task 10 — Quests: tutorial & daily quests

## Context

New players spawn with a starter kit (`onJoin` hands out axe/pickaxe/rod/sword)
but there is **no guidance and no objectives system.** The world guide describes
a tutorial NPC that walks new players through tools, bank, and the marketplace,
plus daily quests with gather/combat objectives, gold/item/XP rewards, and a
daily reset. None of this exists.

## Goal

Two complementary systems:
- **Tutorial** — a first-session, step-by-step onboarding driven by a Mainland
  NPC that unlocks/teaches core actions (move, gather, hotbar, bank, marketplace)
  at the right pace and tracks completion per account.
- **Daily quests** — a rotating set of objectives (chop X wood, mine X stone,
  catch X fish, kill X mobs in realm Y) that grant rewards and reset on a daily
  schedule.

## What to build

1. **NPC entity.** Add an NPC to Mainland (data in `realms.js` or an NPC table):
   a fixed, interactable character near spawn. Clicking/approaching opens a
   dialog. Render it client-side as a distinct character with a name tag and an
   "!" / "?" quest marker reflecting available/turn-in state.
2. **Quest engine (server).** Define quests as data: `id`, `type`
   (`gather`/`combat`/`tutorial-step`), target item/mob/realm, count, and reward
   (gold, items, XP, optional badge). Track per-player progress server-side
   (`priv` and, once Task 16 lands, persisted). Increment progress from the real
   action hooks — gathering (`_handleGather`), kills (`_handleAttack`), fishing
   (Task 05) — not from client claims. Detect completion and allow turn-in for
   rewards (granted via `_addItem`/gold/`_grantXp`).
3. **Tutorial flow.** A scripted ordered list of steps; advancing requires the
   player to actually perform the action (gather once, open the bank, open the
   marketplace, etc.). Persist tutorial completion so it does not repeat. Unlocks
   should feel paced, not dumped at once.
4. **Daily quests.** Assign a daily set per account; reset on a fixed daily
   schedule (compute next-reset timestamp; expose it to the client for a real
   countdown). Rewards include gold/items/XP and sometimes a profile badge
   (badge stored on the account; surfaced wherever the profile renders).
5. **Client quest UI.** A quest panel (HUD button + maybe `Q`) showing active
   tutorial step and daily quests with live progress bars, reward previews, a
   real reset countdown, and turn-in buttons. NPC dialog UI for accepting/turning
   in. Designed empty state ("All dailies complete — back tomorrow") and
   completion toasts.

## Definition of done

- A fresh account is guided through the core loop by the NPC; the tutorial does
  not replay after completion.
- Daily quests track real progress from real actions, can be turned in for
  rewards, and reset on schedule with an accurate countdown.
- Badges awarded by quests appear on the player profile. No console errors; no
  client-side progress spoofing possible.

## Dependencies

Requires Task 16 (persistence) so tutorial completion, daily assignment, progress,
and badges survive sessions. Reads action hooks from gathering/combat/fishing.

---
Build to the standards in [README.md](./README.md): real data, server-authoritative, fully wired end-to-end, every state designed, no shortcuts.
