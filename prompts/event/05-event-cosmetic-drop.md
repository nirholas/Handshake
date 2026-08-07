# 05 · Event cosmetic drop: a free wearable every attendee keeps

**How to run:** paste this whole file into a fresh Claude Code chat in the three.ws repo, or tell the agent to read `prompts/event/05-event-cosmetic-drop.md`. Read [00-CONTEXT.md](00-CONTEXT.md) first.

**Operating clause:** finish 100%. Never end the session with a question, an unexecuted plan, or "let me know". CLAUDE.md hard rules bind: no mocks, no TODO comments, no em-dash characters, commits stage explicit paths only, pushes and production deploys are owner-gated.

## Step 0 · Re-derive the current state

```bash
sed -n '1,80p' multiplayer/src/shop.js
grep -rn "cosmetic" src/game/cosmetics-shop.js src/game/cosmetics-wardrobe.js multiplayer/src | head -30
cat public/event.json
```

Read how the wardrobe grants, persists, and equips items before designing. Two rails exist: the $THREE-paid boutique (on-chain settle) and the free/cash wardrobe path. This drop rides the FREE path; it is a souvenir, not a sale.

## The feature

A commemorative wearable ("$THREE Community Day 2026" themed; e.g. an event badge, aura, or hat consistent with what the wardrobe system can already attach to an avatar) that any player who joins the $THREE world DURING the event window is granted automatically, keeps forever, and can equip from the wardrobe afterward.

- **Grant rule, server-side only:** on join of the event world between `startsAt` and `endsAt` (read from `public/event.json` on the server, the same single source every surface uses), grant the item once per account/player identity, idempotently, through the same persistence the wardrobe already trusts.
- **The moment matters:** when the grant lands, the player sees a real in-world moment: a toast plus the wardrobe badge, matching the monochrome design language. No modal that interrupts play.
- **Scarcity is honest:** after `endsAt` the item is simply never granted again. No countdown-to-FOMO mechanics, no purchase path.

## Tasks

1. Author the cosmetic asset the same way existing wardrobe items are authored (trace one existing item from catalog entry to render to find every place an item is declared). If items are GLB attachments, build a tasteful low-poly one (well under 1 MB) and stage it where the others live; if they are material/effect entries, define one in that format.
2. Server: the join-time grant in `multiplayer/src/rooms/WalkRoom.js` + persistence, gated on the event window and the event coin, idempotent across reconnects.
3. Client: grant toast, wardrobe listing, equip/unequip verified on a real avatar in a real browser (`npm run dev:walk-all`).
4. Tests: grant idempotency and window gating unit-tested under [tests/](../../tests/).
5. Changelog entry (tags: `feature`) telling holders the souvenir exists and how to get it; `npm run build:pages`.

## Definition of done

- [ ] With the window temporarily live: join grants the item exactly once (rejoin does not duplicate), it equips, persists across a reconnect, and other players see it. Config restored afterward.
- [ ] With the window closed: no grant, and previously granted items still equip.
- [ ] Asset budget respected (report the file size); no console errors.
- [ ] `npm test` passes; `npm run check:rules -- --paths <files you touched>` passes.
- [ ] Changelog entry present; committed with explicit paths; PROGRESS.md appended.

## Never blocked

| Blocker | Resolution |
|---|---|
| Unsure what item type the wardrobe supports | The existing catalog is the spec; pick the item type with the most existing examples. |
| Asset creation | The repo's own text-to-3D forge lane can generate a GLB (see the forge surfaces in `STRUCTURE.md`), or build a simple primitive-based accessory in code like existing props. |
| Identity for "once per player" | Use whatever identity the bank balance persists against; it already survives reconnects. |
| Tempted to charge $THREE for it | No. This order is the free souvenir; paid cosmetics stay the boutique's existing catalog. |

## Report format

The item (name, type, size), grant flow as observed including the idempotency rejoin, test output verbatim, files committed.
