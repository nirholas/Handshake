# R — 3D World "Make It Fun" program · **complete**

Turn `/play` from a charming hangout into a place with things to **do** together: Roblox-style
social play + mini-games + an avatar economy, plus a Minecraft-style shared sandbox — all
wallet-native to `$THREE`.

Source roadmap: [`prompts/roadmap/3d-world-fun.md`](../../roadmap/3d-world-fun.md).

## Status

**All 18 briefs (R01–R09, R17–R25) shipped.** Each brief's prompt file was removed once its
Definition of Done was verified against the running code on 2026-07-10 — the code and its tests
are the record now. [R00 — Program overview](R00-program-overview.md) stays: it documents the
shared architecture (the off-schema networking pattern, coin rules, DoD) that all of these
surfaces are built on, and new `/play` work still assumes it.

## Where the work landed

| Brief | Feature | Lives in |
|-------|---------|----------|
| R01 | Server: generic world-object state sync | [`multiplayer/src/schemas.js`](../../../multiplayer/src/schemas.js) (`WorldObject`, `objects` map) + [`WalkRoom.js`](../../../multiplayer/src/rooms/WalkRoom.js) (`_handleObjSpawn/Update/Remove`, caps, bounds clamp) |
| R02 | Client: WorldObjects manager | [`src/game/world-objects.js`](../../../src/game/world-objects.js) (`WorldObjects`, `registerKind`), wired in [`coincommunities.js`](../../../src/game/coincommunities.js) |
| R03 | Cosmetics rig: accessory GLBs on avatars | `cosmetics` schema field + `set-cosmetics` handler; [`src/game/cosmetics-wardrobe.js`](../../../src/game/cosmetics-wardrobe.js) |
| R04 | Emoji & confetti reactions | reaction toolbar in [`coincommunities-ui.js`](../../../src/game/coincommunities-ui.js); server cooldown + rebroadcast in `WalkRoom.js` |
| R05 | Kickable physics ball | server-authoritative `_tickBall` in `WalkRoom.js`; `KIND_FACTORIES.set('ball', …)` |
| R06 | Dance floor zone | `floor:beat` broadcast + on-floor clip crossfade |
| R07 | Mini-game: King of the Totem | `game:king` broadcast, sole-occupant scoring, HUD scoreboard |
| R08 | Mini-game: Tag | `it` / `itSince` schema fields, transfer + reassign-on-disconnect, "YOU'RE IT" HUD |
| R09 | Emote wheel | radial wheel + gamepad input in `coincommunities-ui.js` / `coincommunities.js` |
| R17 | World-object persistence | [`multiplayer/src/persistence.js`](../../../multiplayer/src/persistence.js), [`block-store.js`](../../../multiplayer/src/block-store.js), `tests/block-store.test.js` |
| R18 | Build mode + placement UI | `PROP_CATALOG` + build-mode state machine (ghost / snap / rotate / delete-own) |
| R19 | Build netcode, permissions, anti-grief | density tiles, protected discs, per-player caps in `WalkRoom.js`; `tests/walkroom-build-perms.test.js` |
| R20 | Structures, snapping, sharing | `COMPOSITE_PIECES`, instanced voxels, build-shot share sheet, [`api/play/builds.js`](../../../api/play/builds.js) |
| R21 | Cosmetics catalog + shop UI | [`api/cosmetics/catalog.js`](../../../api/cosmetics/catalog.js), [`src/game/cosmetics-shop.js`](../../../src/game/cosmetics-shop.js) |
| R22 | x402 purchase flow | [`api/x402/cosmetic-purchase.js`](../../../api/x402/cosmetic-purchase.js), [`api/_lib/cosmetics-ownership.js`](../../../api/_lib/cosmetics-ownership.js), `tests/cosmetics-purchase.test.js` |
| R23 | Owned inventory + equip persistence | `cosmetics-wardrobe.js`; `_applyJoinCosmetics` in `WalkRoom.js` |
| R24 | Token-gated worlds | [`api/community/holder-pass.js`](../../../api/community/holder-pass.js) — real on-chain balance read → HMAC pass, `verifyHolderPass` at join |
| R25 | Creator revenue splits | [`api/_lib/cosmetics-economy.js`](../../../api/_lib/cosmetics-economy.js) (`recordSaleAndSplit` → real USDC payout), [`api/cosmetics/split.js`](../../../api/cosmetics/split.js), `tests/cosmetics-economy.test.js` |

The `/play` rows in [`STRUCTURE.md`](../../../STRUCTURE.md) are the canonical, maintained map of
these systems.
