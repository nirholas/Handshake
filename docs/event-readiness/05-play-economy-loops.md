# Audit 5: /play economy, activities, and progression loops

The world's stickiness is its loops: gather, fight, trade, spin, buy cosmetics. Every loop must pay out correctly and every price shown must match what the server actually charges.

## Where the code lives

- Activities and systems: `src/game/play-activities.js`, `src/game/play-systems.js`
- Store/bank/economy UI: `src/game/economy-ui.js`, `src/game/agent-commerce.js`, `src/game/boutique-purchase.js`
- Wheel: `src/game/wheel-station.js`, `src/game/spin-wheel-ui.js`
- Combat: `src/game/combat-system.js`
- Quests: `src/game/quests-ui.js`
- Cosmetics: `src/game/cosmetics-shop.js`, `cosmetics-purchase.js`, `cosmetics-loadout.js`, `cosmetics-wardrobe.js`, `cosmetics-flex.js`
- Items and persistence: `src/game/items.js`, `src/game/world-persist.js`
- Published economy pages (must agree with the game): `/play/economy` and `/play/solver` (routes in `vercel.json`; `api/play/economy.js` imports every number from the same modules WalkRoom prices with, `multiplayer/src/{shop,items,cosmetics-catalog,spin-wheel,economy}.js`, so nothing is transcribed and a mismatch means one side drifted)

## What to audit

1. **Every loop end to end, with a real signed-in session.** Gather from a tree/rock/pond, sell at the store, bank cash, die and confirm the bank protected it, spin the wheel, complete a quest, buy and equip a cosmetic. Each step: correct payout, correct balance update in the HUD without a refresh, correct persistence across a reload.
2. **Price truth.** Cross-check a sample of prices shown in-game against `/play/economy`. Any disagreement is a bug; find which side is stale.
3. **The $THREE boutique.** The cosmetics boutique charges $THREE: verify the full purchase path including insufficient-balance handling (clear message + how to get $THREE, never a silent failure or a raw error toast). `boutique-purchase.js` already maps a short balance to "Not enough $THREE (or SOL for network fees) for this purchase. Get $THREE at three.ws/three-token, then try again.", times out a quote that never arrives, and only unlocks the item after the server's settle notice, never on the client's own "it worked"; verify that path holds rather than rebuilding it.
4. **Race and double-spend.** Double-click every buy/spin/sell button fast. Balances must never go negative or double-charge; buttons must disable while a request is in flight.
5. **Edge cases.** 0 inventory, full inventory, extremely long item names, network failure mid-purchase (the UI must reconcile with server state on reconnect, not trust its optimistic update).
6. **Progression feel.** XP and skill levels visible, level-ups celebrated (even minimally), next-unlock always discoverable. If a loop pays out but gives no feedback (no sound/flash/toast), add the feedback; silent success reads as broken.
7. **Wheel odds honesty.** The wheel paytable shown to users must match the server's real odds (that is the published promise of /play/economy).

## Verify

- Full loop walkthrough on `npm run dev` with a signed-in session, then the same on production for read paths.
- Zero console errors during purchases.
- `npm test` stays green; add a test where a payout calculation was wrong.

## Report format

Loop-by-loop pass/fixed table, every price mismatch found and which side you corrected, edge cases now handled.
