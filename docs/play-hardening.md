# How `/play` stays safe, honest, and light

`/play` is the GTA-style coin-community world at [three.ws/play](https://three.ws/play). It is the largest interactive surface on the platform: a shared 3D city per pump.fun coin, with a server-authoritative economy, combat, quests, vehicles, voice chat, and live peers.

It is also the surface with the least trusted input. Its entry URL is a link strangers share:

```
/play?coin=<mint>&name=<name>&symbol=<sym>&image=<url>
```

Every part of that URL, every display name a peer picks, and every field of the pump.fun coin metadata is text an attacker chose. This document records the invariants that keep the world safe and honest, so that a future change does not quietly undo one of them. Each section names the failure it prevents, because each of these actually shipped once.

Related docs: [in-game economy](./in-game-economy.md), [architecture](./architecture.md), [security](./security.md).

---

## 1. Untrusted text never becomes markup

**Invariant: every user- or network-controlled string is written with `textContent`, never `innerHTML`.**

The `/play` UI modules share an `el()` helper that supports an `html:` property. That property is for *static literals only*. If you find yourself interpolating a variable into it, you have found a bug.

The one place this was violated was the tombstone loot prompt in [src/game/combat-system.js](../src/game/combat-system.js). It built its prompt as a template string containing `nearest.t.owner`, which is a remote player's chosen display name, replicated to every client:

```js
// WRONG: shipped, and exploitable
this.prompt.innerHTML = `<span class="combat-key">E</span> Loot ${nearest.t.owner}…`;
```

The server's only name gate is a hate-slur word list ([multiplayer/src/display-name-safety.js](../multiplayer/src/display-name-safety.js)), which is not an HTML escaper. A player could name themselves `<img src=x onerror=…>`, die in a danger zone, and have the payload execute for every player who walked near their tombstone. The fix builds the prompt from real nodes:

```js
const key = document.createElement('span');
key.className = 'combat-key';
key.textContent = 'E';
this.prompt.replaceChildren(key, document.createTextNode(` Loot ${nearest.t.owner}…`));
```

**When you add a prompt, label, nameplate, chat line, or panel row that shows a name, a coin symbol, quest text, or anything from an API: use `textContent`.**

## 2. A coin image cannot escape its CSS declaration

**Invariant: a URL that lands inside a CSS `url(...)` value goes through `cssBgImage()` in [src/game/coincommunities-ui.js](../src/game/coincommunities-ui.js).**

Lobby cards paint the coin's artwork as a background image. `proxiedImageURL()` ([src/ipfs.js](../src/ipfs.js)) only URL-encodes values matching `^(https?|ipfs|ar):`; anything else is returned unchanged. So a coin minted with an `image_uri` of

```
x");position:fixed;inset:0;z-index:99999;background:#000 url(//evil/phish.png);content:"
```

would close the `url()`, close the declaration, and paint a full-viewport overlay (a fake wallet prompt, say) over the lobby of everyone browsing trending coins. The same raw value rides in `?image=` on a shared link.

`cssBgImage()` refuses script-bearing schemes and percent-encodes every character that could terminate the value:

```js
el('div', { class: 'cc-card-img', style: cssBgImage(c.image) }, …)
```

The payload may still be *present* in the output, but only ever as inert text inside one URL. [tests/play-deeplink-safety.test.js](../tests/play-deeplink-safety.test.js) proves this with a real CSS parser: it sets the returned style on a jsdom element and asserts that `position`, `inset`, `z-index` and `content` are all empty and only `background-image` is set.

## 3. A broken world link says so

**Invariant: `?coin=` is validated against `isPlausibleMint()` before any world is built.**

A mint is either a Solana base58 address (pump.fun mints, including `$THREE`) or an EVM `0x` address (Robinhood Chain coins). `/play?coin=notarealmint` used to build a complete, convincing world: a real district, a totem reading "COMMUNITY", a Colyseus room keyed on the garbage string, and a persistent build layer no other player would ever see. Nothing anywhere told the visitor the link was broken.

Now a malformed mint leaves the player in the lobby with a plain explanation, one tap from every real world. `name` and `symbol` are separately clamped by `clampParam()` to the same caps the room server enforces, with control characters, line breaks, bidi overrides and zero-width characters stripped, so a 10 KB `name=` cannot rewrap the HUD.

## 4. Losing the connection recovers cleanly

**Invariant: a reconnect must retire the peers who left while you were offline.**

`CommunityNet` reconnects with a fresh `joinOrCreate`, and it removes the old room's listeners *before* leaving it (deliberately, to avoid duplicate-socket bugs). Two consequences follow, and both are load-bearing:

1. The old room's `onRemove` never fires, so peers from before the drop are never cleaned up by the normal path.
2. Colyseus reissues session ids, so the same human can come back under a new key.

`_markRemotesStale()` flags every current peer when the socket goes to `connecting`; the fresh room's `add` events clear the flag; `_pruneStaleRemotes()` retires whatever is still flagged once the snapshot lands. Both live in [src/game/coincommunities.js](../src/game/coincommunities.js).

These two methods were *called* on every drop but never *defined*, so a reconnect threw a `TypeError` and ghosts accumulated: two drops in a ten-person world left thirty avatars on screen, twenty of them frozen, with the online count reporting triple the truth. If you rename or move them, update both call sites and [scripts/play-desktop-audit.mjs](../scripts/play-desktop-audit.mjs), which asserts they are callable in a real browser.

Related: the death overlay hides on a `respawn` notice, but a reconnect re-sends the authoritative profile without any notice. `_applyVitals()` in [src/game/combat-system.js](../src/game/combat-system.js) clears the overlay whenever the server says `hp > 0`, so nobody rejoins a live world stuck behind "You died".

## 5. The world frees what it loads

**Invariant: anything that allocates GPU memory has a disposal path, and that path runs when the player leaves.**

This is the difference between "works on a laptop" and "works on a phone". Detaching an object from the scene graph (`scene.remove(...)`) drops the JS reference but leaks the geometry, materials and textures. On iOS Safari, the accumulated pressure shows up as a `webglcontextlost` event and a killed tab, which reads to the player as being randomly kicked out of the world.

The rules:

- **Avatars go through `releaseAvatar(rig)`** from [src/game/avatar-rig.js](../src/game/avatar-rig.js), never a bare `scene.remove()`. That module keeps one download + parse per distinct model URL and hands out `SkeletonUtils` clones; `releaseAvatar` disposes the per-rig materials, drops the template's refcount, and evicts idle templates past the memory budget. NPCs ([src/game/npc/npc.js](../src/game/npc/npc.js)), ambient pedestrians ([src/game/npc/ambient-life.js](../src/game/npc/ambient-life.js)) and the local player all call it. **A rig disposed while its GLB is still downloading must also call it in the `then`,** or the clone that lands on the detached rig holds its template resident forever. Pedestrians churn on every peer join/leave, so that path is hot.
- **Lights need explicit disposal.** A `traverse` that only handles `isMesh` skips them, and the sun's 2048x2048 shadow map is one of the largest allocations in the world. `world-env.js`'s `dispose()` frees it directly.
- **`leave()` disposes, it does not merely detach.** The totem, jumbotron and dance floor go through `_disposeObject3D()`; the environment, district and day/night cycle are freed on the way out rather than being held until the *next* `enter()`, so returning to the lobby no longer keeps a whole city resident with nothing rendering it.

## 6. Every failure has a designed, actionable state

**Invariant: no indefinite spinner, no blank void, no green checkmark on a failure.**

Examples currently holding the line:

- The **jobs board** ([src/game/quests-ui.js](../src/game/quests-ui.js)) shows "Loading the jobs board…" until the first server snapshot lands. It used to render "No jobs on the board right now" before the server had answered, telling players on a slow link that there was no work a beat before it all appeared.
- The **Wheel of Fortune** ([src/game/spin-wheel-ui.js](../src/game/spin-wheel-ui.js)) reaches its documented `error` phase: if `spinInfo` never arrives it says so and offers a retry, instead of sitting on "Loading the wheel…" forever with both buttons dead. It also ships its own stylesheet ([src/game/spin-wheel.css](../src/game/spin-wheel.css)), because it is a lazy chunk and cannot assume `coincommunities.css` loaded.
- **Closing the wheel mid-payment does not discard a paid spin.** Once the transaction is broadcast, real money has moved; closing the modal detaches it but keeps the server subscriptions alive and delivers the outcome (and its Solscan receipt) in a background pill. Previously, dismissing the wallet overlay with <kbd>Esc</kbd> unsubscribed the result handlers and the player lost $3 with nothing shown.
- The **boutique purchase flow** ([src/game/boutique-purchase.js](../src/game/boutique-purchase.js)) rejects on the server's own failure notices rather than treating any `boutique` notice as success.
- The **boot loader** cannot strand: an inline watchdog in [pages/play.html](../pages/play.html) replaces the spinner with a real error card (with a retry) if a script or stylesheet fails, and `enter()` failures tear down and return a working lobby.

## Verifying a change

```bash
# Pure-logic guards: CSS-injection, mint validation, param clamping.
npx vitest run tests/play-deeplink-safety.test.js

# Everything else that touches the surface.
npx vitest run tests/play-gate.test.js tests/play-pass.test.js \
  tests/minimap-projection.test.js tests/quests-vehicle-delivery.test.js \
  tests/play-friends-presence.test.js

# A real browser: console errors, boot, reconnect helpers, CSS injection,
# malformed mints, wheel styles. Point it at prod or a local `npm run dev`.
node scripts/play-desktop-audit.mjs "https://three.ws/play?coin=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump"

# Phone emulation: transferred bytes, heap growth, WebSocket lifecycle, and
# every GLB load attributed to the code that asked for it.
ENGINE=webkit node scripts/play-mobile-repro.mjs "https://three.ws/play" 120000
```

The mobile harness is the one that catches memory regressions. It reports total transferred bytes grouped by path, so a change that starts re-downloading avatars shows up as a jump in the `/avatars/*` and `/r2-proxy/*` rows rather than as a mysterious crash report weeks later.
