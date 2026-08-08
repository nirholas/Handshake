# Forge in world: spawn items into a `/play` server from a prompt

In [`/play`](https://three.ws/play), every coin is its own live server. Until now you could
only place props that already existed: a hand-authored catalog piece, a community gallery
model, or a `.glb` you uploaded yourself. Forge-in-world removes that last limit. Describe
an item in words, or hand it a photo, and about half a minute later the item is a real
textured 3D model standing in the world, visible to everyone connected to that server.

Nothing is faked. The text goes to the same free forge lane that powers
[`/forge`](https://three.ws/forge), the result is a genuine GLB in three.ws storage, and it
reaches other players over the world's existing object channel, which means it persists in
the world exactly like a block you placed by hand.

## Using it

### From the build palette

1. Enter a world and press `B` (or tap **Build**) to open build mode.
2. In the **Props** palette, click **Forge**.
3. Type what you want, for example `a mossy stone lantern with a copper roof`.
4. Optionally click **Photo** and attach a PNG, JPEG, or WebP reference image (up to 8 MB).
   With a photo attached, the prompt becomes a hint rather than the whole brief.
5. Click **Forge**. The palette's status strip reports progress the whole way
   (`Sending to the forge…`, then `Forging: waiting for a slot…`, then `Forging your model…`).

When it finishes, the model is added to your props as its own button and armed
automatically. Click anywhere on the ground to place it. `R` rotates before you commit,
and break mode removes props you own.

### From world chat

Type a slash command into the chat box:

```
/forge a brass telescope on a tripod
```

Chat is the fastest path because you do not have to open the palette first. The command is
answered locally and never broadcast to the other players, and when the model is ready
build mode opens with the new prop armed and waiting for your click. A bare `/forge` with
no description replies with a usage hint instead of sending `/forge` to the room.

## What everyone else sees

The moment you place a forged item it becomes a `WorldObject` in the room's authoritative
state, and Colyseus broadcasts it to every other client in that server. Their client reads
the model URL off the object itself, so nobody needs your palette entry, a page reload, or
the same version of the app. The world's persistence layer saves it with the rest of the
build, so the item is still standing when the room is next created.

That is the point of forging *inside* a server rather than on `/forge`: the thing you
imagined is immediately part of a shared place, not a file in your downloads folder.

## Cost and limits

| | |
|---|---|
| Price | Free. Forge-in-world uses the draft tier, which needs no account, wallet, or key. |
| Typical time | 20 to 60 seconds. A cold GPU can add up to a minute and a half. |
| Concurrency | One forge at a time per player. A second request while one is running is refused with a toast. |
| World caps | Forged props count against the normal build budget: 200 objects per world, 30 per player. |
| Rate limits | The free lane is rate-limited per client per hour. Hitting it reports that the forge is busy, and the request can be retried. |

Forged models are recorded against the same anonymous client id `/forge` uses
(`localStorage['forge:cid']`), so anything you make in-world also appears in that browser's
forge history.

## How it fits together

```
palette form / "/forge" chat        src/game/coincommunities-ui.js
  -> onForgeProp handler            src/game/coincommunities.js   (_forgeProp)
    -> forgeWorldProp()             src/game/forge-prop.js
      -> POST /api/forge            free draft lane, text or image_urls
      -> GET  /api/forge?job=<id>   polled to completion
    -> registerUploadedProp(url)    src/game/world-objects.js
    -> _pickProp(def.id)            arms it for placement
  -> click -> net.spawnObject(...)  obj:spawn { type, url, x, y, z, yaw, scale }
    -> WalkRoom._handleObjSpawn     multiplayer/src/rooms/WalkRoom.js
      -> normalizePropAssetUrl      multiplayer/src/build-limits.js  (allow-list)
      -> state.objects broadcast    every client in the server renders it
```

Two details worth knowing if you are extending this.

**The forge URL is already trusted.** Finished models are materialized into three.ws
storage on an `*.r2.dev` host, which is on the world asset allow-list
(`normalizePropAssetUrl` in [multiplayer/src/build-limits.js](../multiplayer/src/build-limits.js)).
No server change was needed to let forged items in, and no arbitrary third-party URL can
follow them: an off-list host is refused with `obj:reject` carrying `reason: 'asset_url'`.

**Nothing new is on the wire.** Forged props travel as ordinary world objects. The `url`
field that already carries player uploads carries these too, so older clients, the
persistence layer, ownership checks, and the per-player object cap all apply without
modification.

## Related

- [3D asset pipeline](3d-asset-pipeline.md) covers what the forge lanes are and how they differ
- [In-game economy](in-game-economy.md) covers the rest of what you can do inside a `/play` world
- [`/forge`](https://three.ws/forge) is the full studio, with paid tiers, rigging, and game-ready export
