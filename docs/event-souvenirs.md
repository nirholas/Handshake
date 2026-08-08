# Event souvenirs: the wearable you keep for having been there

Some things should not be for sale.

When a live event runs in `/play`, everyone who walks into the event world while
it is happening is handed a free commemorative wearable. It lands on your
account, it is yours forever, and you can wear it in every coin world from then
on. When the event ends, it is never granted again. There is no purchase path,
no second chance, no listing in the boutique. The only way to have one is to
have been there.

That constraint is the entire product. A cosmetic you can buy later says nothing
about you. This one says exactly one thing, permanently, to every player who
walks past you.

The first one is the **Meetup Laurel**: a gold laurel circlet, open at the
front, with three pearl berries in the gap. It is granted at the
[`$THREE` First Holders Meetup](play-live-events.md).

---

## For players

1. Open the event world while the event is live. The countdown chip and the
   lobby banner both link straight to it.
2. A card slides in over the corner of the HUD the moment the souvenir lands:
   what you got, why, and a **Wear it** button. It is not a modal, so it never
   interrupts what you were doing, and it retires itself after a few seconds
   (it pauses while your pointer or keyboard focus is on it).
3. Dismissed it? It is waiting in **My Fits**, badged as new, in the Headwear
   row.

You are granted it once. Reconnecting, refreshing, or coming back the next day
does not give you a second one and does not show the card again.

---

## For whoever runs the event

Everything lives in one file: [`public/event.json`](../public/event.json), the
same config that drives the countdown pill, the agenda drawer, and the fireworks
finale. Add a `souvenir` block:

```json
{
  "id": "three-first-meetup",
  "name": "$THREE First Holders Meetup",
  "startsAt": "2026-08-09T17:00:00Z",
  "endsAt": "2026-08-09T19:30:00Z",
  "link": "/play?coin=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump&name=three.ws&symbol=three",
  "souvenir": { "cosmeticId": "laurel-meetup" }
}
```

That is the whole configuration. Three fields already had to be right for the
countdown to work, and the drop reuses all three:

| Field | What the drop reads from it |
| --- | --- |
| `startsAt` / `endsAt` | The claim window, half-open: `[startsAt, endsAt)`. At the instant the event ends, the souvenir stops being granted. |
| `link` | The **world**. The `coin` query parameter names the only world the drop applies in, so it can never target a world the event does not advertise. |
| `souvenir.cosmeticId` | The item. Must be a `tier: 'event'` entry in the cosmetics catalog. |

Omit the `souvenir` block entirely to run an event with no drop.

### Running a drop, start to finish

1. **Author the item** in
   [`multiplayer/src/cosmetics-catalog.js`](../multiplayer/src/cosmetics-catalog.js)
   with `tier: 'event'` and `price: 0`. See [Adding a new souvenir](#adding-a-new-souvenir).
2. **Point the config at it** with the `souvenir` block above.
3. **Check it parses** before the night of the event, not during it:
   ```bash
   npx vitest run tests/event-souvenir.test.js
   ```
   The suite reads the real `public/event.json` and fails if the shipped config
   would grant nothing.
4. **Deploy.** The game server fetches the config over HTTP and re-reads it
   every two minutes, so moving a window does not need a game-server redeploy.
   `EVENT_CONFIG_TTL_MS` tightens that interval while you are setting up.
5. **Watch it land.** Every grant logs one line:
   ```
   [walk_world <roomId>] souvenir laurel-meetup → <account> (three-first-meetup)
   ```

### What the server refuses to do

These are guards, not warnings: each one silently grants nothing rather than
doing the wrong thing.

- **Grant outside the window.** Before `startsAt` or at/after `endsAt`, nothing.
- **Grant in another world.** Standing in an unrelated coin world during the
  event earns nothing, even though the event is live.
- **Grant a boutique item.** If `cosmeticId` names a `premium` cosmetic, the
  whole drop is treated as unconfigured. A typo cannot hand every attendee a
  400-`$THREE` Stetson.
- **Grant twice.** The grant is idempotent on the account, so reconnects and
  room hops produce one unlock and one announcement.
- **Block a join.** An unreachable or malformed config means no drop, never an
  error and never a delay: the world opens normally.

---

## How it works

```
public/event.json  ──HTTP──▶  multiplayer/src/event-drop.js   (window + world + item)
                                        │
                              WalkRoom.onJoin
                                        │  dropClaimable(drop, world, now)?
                                        ▼
                              grantCosmetic(profile, id)      (idempotent)
                                        │  newly unlocked?
                        ┌───────────────┴───────────────┐
                        ▼                               ▼
                  persist to account            send `souvenir` to that client
                                                        │
                                                        ▼
                                          src/game/event-souvenir.js (the card)
                                          cosmetics-wardrobe.js (the "New" badge)
```

The grant is **server-side only**. A client never asks for a souvenir and cannot
claim one: it learns it has one because the server tells it. The `souvenir`
message is sent on the transition from not-owned to owned and at no other time,
which is what lets the client treat it as a moment rather than state to
reconcile.

Ownership then behaves exactly like a purchased cosmetic: it is stored on the
account profile, survives restarts and world switches, is re-validated on every
equip, and is published on the shared schema so peers render it. A client
asserting the item in a join loadout without owning it is silently dressed in
the slot default.

### Why the window lives in the config and not in code

The countdown chip, the agenda, the fireworks and the drop all derive from the
same `startsAt`/`endsAt`. If the drop had its own copy of the schedule, the two
could disagree, and the failure mode is the worst one available: a player who
watched the countdown hit zero, walked in, and got nothing. Reading one file
makes that class of bug unrepresentable.

---

## Adding a new souvenir

An event-tier cosmetic is an ordinary catalog entry with a tier that keeps it
out of the shop:

```js
{
  id: 'laurel-meetup',
  name: 'Meetup Laurel',
  slot: 'headwear',
  rarity: 'legendary',
  tier: 'event',      // granted, never sold
  price: 0,           // and so never listed in the boutique
  visual: { prop: '/accessories/laurel-meetup.glb', anchor: 'head' },
  thumb: '/accessories/thumbs/laurel-meetup.png',
}
```

If it needs an asset, both the model and its poster are generated from the repo,
so neither can drift from the other:

```bash
node scripts/generate-accessory-glbs.mjs laurel-meetup.glb   # the GLB (68 KB)
node scripts/render-accessory-thumbs.mjs laurel-meetup       # the poster PNG
```

Passing a filename regenerates only that one, leaving every other committed
binary untouched. The geometry is authored procedurally in
[`scripts/generate-accessory-glbs.mjs`](../scripts/generate-accessory-glbs.mjs)
alongside the hats and glasses; repeated elements (the laurel's eighteen leaves)
are built in a loop and merged into a single primitive so one look costs one
material.

Do **not** add an event souvenir to
[`public/accessories/presets.json`](../public/accessories/presets.json). That
catalog is the character studio's, it is not ownership-gated, and listing a
souvenir there would hand it to everyone.

---

## Verifying it

Two layers, both real.

```bash
npx vitest run tests/event-souvenir.test.js   # window gating, idempotency, economy separation
node scripts/play-souvenir-e2e.mjs            # a real browser against a real game server
```

The e2e run boots Vite and Colyseus on private ports, serves an event config it
controls, and walks the whole feature: a player joins during a live window and
is granted the item once, wears it from the card, a second player sees it on
them, a full reconnect re-grants nothing and the item is still worn, and a fresh
player joining after the window closes gets nothing while the earlier attendee
keeps theirs. It edits nothing in the repo to do it, so there is no live window
left behind to clean up.

---

## Where the code lives

| Piece | Location |
| --- | --- |
| Window, world and item resolution | [multiplayer/src/event-drop.js](../multiplayer/src/event-drop.js) |
| Join-time grant | `_grantEventSouvenir` in [multiplayer/src/rooms/WalkRoom.js](../multiplayer/src/rooms/WalkRoom.js) |
| The `event` tier + catalog entry | [multiplayer/src/cosmetics-catalog.js](../multiplayer/src/cosmetics-catalog.js) |
| Unlock + persistence | `grantCosmetic` / `restoreProfile` in [multiplayer/src/economy.js](../multiplayer/src/economy.js) |
| The drop card | [src/game/event-souvenir.js](../src/game/event-souvenir.js) |
| Wardrobe treatment ("New", "Not for sale") | [src/game/cosmetics-wardrobe.js](../src/game/cosmetics-wardrobe.js) |
| Event config | [public/event.json](../public/event.json) |
| Asset generators | [scripts/generate-accessory-glbs.mjs](../scripts/generate-accessory-glbs.mjs), [scripts/render-accessory-thumbs.mjs](../scripts/render-accessory-thumbs.mjs) |

---

## Related

- **[Live events in /play](play-live-events.md)** covers the rest of what that
  config file drives: the countdown, the agenda drawer, the fireworks.
- **[The in-game economy](in-game-economy.md)** covers the two currencies and
  the `$THREE` boutique the souvenir deliberately stays out of.
- **[Coin communities](coin-pages.md)** covers the worlds the events happen in.
