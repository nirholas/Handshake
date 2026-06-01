# Task 11 — Skills panel UI & progression feedback

## Context

Progression works server-side: `_grantXp` accumulates per-skill XP in the `priv`
map and `levelForXp` converts it to a level (cap 99), broadcasting only the
integer level on `GamePlayer` (`combat`, `woodcutting`, `mining`, `fishing`,
`cooking`). The client renders none of this as a dedicated surface — there is no
skills panel, no XP bar, no level-up feedback, and the current level cap is not
shown anywhere. Some content is meant to be skill-gated (e.g. a level-gated
cave in Task 22; the spinner requires an average skill level — Task 19).

## Goal

A skills UI that shows each skill's level, progress to the next level, and the
cap, with satisfying level-up feedback — plus a reusable "average skill level"
read other systems can gate on.

## What to build

1. **Expose XP progress.** The schema broadcasts only levels (kept lean on
   purpose). Add a way for a player to see their own XP progress: send the
   requesting client its private XP map + the XP thresholds (e.g. an
   `onMessage('skills', ...)` that replies with current XP, XP for current and
   next level, and the cap). Do not broadcast XP to peers.
2. **Level-up events.** When `_grantXp` raises a level, send the client a
   `levelup` notice ({ skill, level }) so the UI can celebrate it.
3. **Average-skill helper.** Add a server helper computing the player's average
   skill level (used by Task 19's spin gate and any future gates). Expose it where
   needed; keep the computation authoritative.
4. **Client skills panel.** A HUD-accessible panel (button + a key, e.g. `K`)
   listing all five skills with: level, an XP progress bar to next level (from the
   `skills` reply), and the level cap. Show total/average level. Live-update on
   `levelup`. Designed states for level 1 (fresh) through 99 (maxed: "Mastered").
5. **Level-up feedback.** A non-intrusive celebratory toast/animation on
   `levelup` with the skill icon and new level. No fake numbers — driven by real
   server events.

## Definition of done

- The skills panel shows accurate levels, XP-to-next, and the cap for the local
  player, updating live as XP is earned.
- Leveling a skill triggers a visible level-up celebration.
- Peers cannot see each other's raw XP. The average-skill helper returns correct
  values for gating. No console errors.

## Dependencies

None hard; pairs with Task 19 (spin gate uses the average-skill helper) and Task
22 (cave level gate). Persistence (Task 16) keeps levels across sessions.

---
Build to the standards in [README.md](./README.md): real data, server-authoritative, fully wired end-to-end, every state designed, no shortcuts.
