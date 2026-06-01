# Task 12 — Hotbar number keys & rebindable keybindings

## Context

The client (`iso-game.js`) handles movement and camera input and has a 6-slot
hotbar with an `equip` message, but **the number keys 1–6 are not wired to
select hotbar slots**, and there is no keybindings settings UI. The world guide
specifies defaults: `I` inventory, `M` map, `B` build, `C` chat, `F` friends,
`R` rotate camera, `1–6` hotbar, `0` clear hotbar selection, `Esc` close top
modal, `Enter` confirm. `R` rotate already exists; others are partial or missing.

## Goal

Wire all default keybindings, including hotbar 1–6 and 0-to-clear, and add a
settings UI to rebind any action, persisted per account.

## What to build

1. **Central keybinding map.** Introduce a single source of truth for actions →
   keys (default to the spec above). Route all keydown handling through it instead
   of scattered literal key checks. Guard so bindings don't fire while typing in
   chat or an input field.
2. **Hotbar keys.** `1`–`6` set `activeSlot` (send `equip`); `0` clears selection
   (`activeSlot = -1`). Reflect the active slot visually in the hotbar.
3. **Panel toggles.** `I`/`M`/`B`/`C`/`F` open/close their panels (wire to the
   inventory, map, build (Task 07), chat (Task 14), friends (Task 15) surfaces as
   they exist; for not-yet-built panels, wire the toggle to the placeholder the
   owning task will fill — do not leave a dead key). `Esc` closes the top-most
   modal; `Enter` confirms the focused dialog. `R` keeps rotating the camera.
4. **Rebinding UI.** A Settings → Controls panel listing every action and its
   current key, with a "click to rebind → press a key" capture flow. Detect and
   warn on conflicts; allow reset-to-defaults. Persist the custom map per account
   (Task 16; until then, persist to the same save interface).
5. **Accessibility.** Visible focus states, keyboard navigability of the settings
   panel itself, and ARIA labels on the rebind controls.

## Definition of done

- Pressing 1–6 selects the matching hotbar slot and 0 clears it; the active slot
  is visually obvious and used by world clicks.
- All default keys perform their action and none fire while typing in chat.
- Rebinding any action works, conflicts are surfaced, reset-to-defaults works,
  and custom bindings persist across sessions. No console errors.

## Dependencies

Toggles connect to panels owned by Tasks 07/14/15; wire them as those land.
Persistence of custom bindings uses Task 16.

---
Build to the standards in [README.md](./README.md): real data, server-authoritative, fully wired end-to-end, every state designed, no shortcuts.
