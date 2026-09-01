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

Lobby cards paint the coin's artwork as a background image. `proxiedImageURL()` ([src/ipfs.js](../src/ipfs.js)) URL-encodes values matching `^(https?|ipfs|ar):` and passes relative, `blob:` and `data:image/*` sources through untouched (see section 11 for what it now refuses outright). A coin minted with an `image_uri` of

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

### 3a. The loading screen reads the same URL, and obeys the same rules

**Invariant: the inline identity script in [pages/play.html](../pages/play.html) writes only `textContent`, accepts only site-absolute or `https:` image URLs, and length-clamps every value.**

The app bundle is not on screen yet while the boot loader is up, so the loader has its own, deliberately tiny reader of `?name` / `?symbol` / `?image`. It exists because a shared world link spent that entire window saying nothing about which world was opening. It is a *second* consumer of the least trusted input on the platform, running earlier than every guard in section 1 through 3, so it repeats them locally rather than importing them (importing a module would defeat the point of painting before the bundle arrives):

- Text goes in with `textContent`. There is no `innerHTML` in the script.
- `image` is accepted only when it starts with a single `/` (the same-origin `/api/img` proxy, which is what the share-link rewrite emits) or `https://`. A `javascript:` or `data:` value is dropped and the letter-mark stands in.
- `name` is capped at 28 characters and `symbol` at 12, cut on a word boundary.
- Anything unexpected throws into a `catch` that leaves the generic loader exactly as it shipped.

The art has a designed failure path in both places it appears. In the loader, a monogram sits under the `<img>` and the image only fades in on `load`; an `error` removes the `<img>` and leaves the monogram. In the world, the HUD banner's `.cc-coin-img` does the same against `.cc-coin-mono` ([src/game/coincommunities-ui.js](../src/game/coincommunities-ui.js)). The 3D totem and jumbotron already degraded to text-only on a failed `TextureLoader` fetch. This matters on venue wifi, where the IPFS gateway behind `/api/img` is the single most likely thing to fail while everything else about the world works. A single gateway is also no longer the only try: `uriCandidates()` in [src/ipfs.js](../src/ipfs.js) expands an `ipfs://` source, or a URL that already names one gateway, into one candidate per gateway in preference order, and each fetch is bounded at 8 s, so one rate-limited gateway degrades to the next rather than to the monogram.

The loader also sets a provisional `document.title` from the link and stashes the original in `documentElement.dataset.lobbyTitle`; `_setTabTitle()` in [src/game/coincommunities.js](../src/game/coincommunities.js) replaces it with the resolved coin on entry and restores the stashed original on leave, so the two writers never fight and the localised title is never re-spelled in JS.

### 3b. A link that kept only the mint still opens a named world

**Invariant: `enter()` backfills a missing name, symbol, image or market cap from `/api/pump/coin` before it builds anything, and what the link carried always wins.**

The mint is the only part of `/play?coin=…&name=…&symbol=…&image=…` that identifies the coin. Everything after it is decoration the sharer's client appended to the URL, and it goes missing constantly: a hand-typed link, a chat client that truncated the query, an unfurl that kept only the mint, a link copied out of a screenshot. The market cap was never on the URL at all, because a number that moves cannot be baked into a link people re-share for weeks.

A link short of that decoration used to build the full world anyway, with no identity in it: a totem reading "COMMUNITY", a welcome card offering "the Community community", a tab titled Community, and a blank market cap on both the jumbotron and the in-world chart screen. That is the same failure section 3 refuses for a *broken* mint, arriving through a mint that is perfectly valid.

`_fetchCoinIdentity()` in [src/game/coincommunities.js](../src/game/coincommunities.js) reads the coin from the same feed the lobby cards are built from, and `mergeCoinIdentity()` fills only the blanks: whatever the link did carry is what every peer already on that link sees, so it stays authoritative even if the feed disagrees. The rules from sections 1 through 3 still apply to the result, since it is upstream text like any other: the name and symbol go through `clampParam()`, the image through `proxiedImageURL()`. Four properties keep the lookup from ever being worse than the nameless world it replaces:

- It is skipped entirely for a coin that arrived complete, so a lobby card never pays for it.
- It is skipped for an EVM mint, which the pump.fun lookup cannot answer for.
- It is bounded by an `AbortController` at `COIN_IDENTITY_TIMEOUT_MS`, so a slow upstream cannot hold a player on the loading screen; any failure resolves to `null` and the world builds exactly as it did before.
- It re-checks the entry phase and epoch after awaiting, so backing out mid-lookup bails instead of resurrecting a torn-down world.

The URL rewrite that follows puts the resolved identity back on the address bar, so the next person to receive that link never pays for the lookup at all.

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

## 7. A saved character belongs to one credential

**Invariant: the account key a profile loads under is never a raw join option.**

A `/play` profile is everything a player has earned: cash, bank, pack, unlocked cosmetics, quest log. It is keyed by `playerId`, resolved in `WalkRoom._resolveIdentity()` ([multiplayer/src/rooms/WalkRoom.js](../multiplayer/src/rooms/WalkRoom.js)).

`playerId` used to fall back to `options.pid`, a string the browser sent verbatim. Joining with `pid` set to somebody else's wallet address or guest id loaded *their* profile: you could spend their cash, sell their items, wear their premium cosmetics, and every mutation persisted back over their record. Their placed blocks and props also became yours to delete, because build ownership keys off the same id.

The trust order is now explicit, highest first:

1. The wallet `onAuth` verified, when the platform token gate is on.
2. A wallet sealed inside a valid play pass ([multiplayer/src/play-pass.js](../multiplayer/src/play-pass.js)). Possession of the HMAC-signed pass proves the wallet even when the gate is off.
3. A guest id sealed inside a signed guest token ([multiplayer/src/guest-token.js](../multiplayer/src/guest-token.js)). **The token is the credential, not the id.**
4. A one-time migration for the legacy `guest-…` ids clients persisted in `localStorage` before tokens existed. Honored only if that record has never been upgraded, never for a wallet-shaped id, and the id is sealed into a signed token on the spot. The record is stamped `guestUpgraded`, so the same bare claim from anyone else afterwards gets a fresh guest instead.
5. A brand new server-minted guest id.

Lanes 3 to 5 send the client a `guestToken` message, which it stores under `tws-guest-token` and replays on the next join ([src/game/community-net.js](../src/game/community-net.js)). Guest ids are minted server-side with 12 random bytes, so they cannot be guessed the way a sequential or client-chosen id can.

`guest-token.js` shipped with a header describing this exact fix and **zero callers** for months. If you write a module to close a hole, wire it in the same change.

Tests: [tests/play-account-identity.test.js](../tests/play-account-identity.test.js), which drives `_resolveIdentity` through every lane including the original exploit.

## 8. One payment grants exactly one thing

**Invariant: a settled transaction is consumed once, process-wide and across restarts.**

Paid wheel spins and `$THREE` boutique purchases both verify a real Solana transaction before granting anything. The replay guard that stops a verified payment being cashed twice used to be a `Map` on each `WalkRoom` instance.

Rooms are partitioned per coin world, so that guard only held *within one room*. The same `{ quoteToken, txSig }` pair replayed into N different coin worlds verified on-chain N times and granted N times. One $3 payment could be rolled into a best-of-N jackpot hunt, and a process restart or a second Cloud Run instance widened it further.

Replay protection now lives in [multiplayer/src/settlement-guard.js](../multiplayer/src/settlement-guard.js): one shared ledger for the whole process, backed by Redis `SET NX` when `UPSTASH_REDIS_REST_URL`/`_TOKEN` are configured, so consumption spans rooms, restarts, and instances. Both the quote nonce **and** the transaction signature are consumed, so a second quote cannot be settled by the same transfer.

Quotes are also sealed to the profile that asked for them (`forAccount` in [multiplayer/src/game-token.js](../multiplayer/src/game-token.js)). A leaked `{ quote, txSig }` pair can no longer be redeemed onto a different account.

Settlement reads at `confirmed` for latency; set `GAME_TOKEN_VERIFY_COMMITMENT=finalized` to trade responsiveness for fork certainty.

Tests: [tests/spin-wheel.test.js](../tests/spin-wheel.test.js) covers same-room replay and cross-world replay.

## 9. The world never destroys what a player earned

**Invariant: a server action that cannot complete leaves the player's things where they were.**

Each of these shipped as a real loss:

- **Loot no longer eats an overflowing drop.** `handleLoot` ([multiplayer/src/combat-handlers.js](../multiplayer/src/combat-handlers.js)) used to delete the tombstone and *then* check pack space, so everything that did not fit was destroyed silently. It now absorbs what fits, writes the remainder back, and only removes the marker once it is fully drained.
- **Dying and disconnecting no longer bricks a character.** The respawn timer bailed early when the session had already left, persisting `hp: 0`; the player returned walking but died to the next hit. `reviveProfile` now runs unconditionally, and `onJoin` self-heals any profile restored at zero health.
- **A large balance no longer wraps to zero.** `restoreProfile` clamped with `saved.gold | 0`, which is ToInt32 and runs *before* the ceiling, so anything past 2^31 wrapped negative and clamped to 0. It now floors then clamps, and every reward path credits through `creditGold()` so a balance saturates instead of overflowing.

## 10. Movement and interaction are policed against real time and real distance

**Invariant: an anti-cheat clamp is derived from elapsed time and world distance, never from a per-message constant.**

The vehicle teleport clamp allowed a fixed displacement *per `vsync` message*, sized for a 15Hz sender. The rate limiter permits 30 messages a second, so maxing the step on every message legally covered roughly ten times a car's top speed, fast enough to farm the repeatable cross-town delivery jobs. The clamp now derives its allowance from `Date.now() - v.tsServer` and validates the derived speed rather than the client's self-reported scalar.

Every world interaction gates on the server's authoritative position: fishing spots, the wheel, quest zones, loot reach, vehicle entry, and now `ball:kick`, which had no proximity check and let anyone in the district drive the shared ball.

Read-only request handlers are rate limited too. `store`, `boutique`, `profile`, `questBoard`, and `spinInfo` each had a declared bucket in `ACTION_RATES` ([multiplayer/src/rooms/WalkRoom.js](../multiplayer/src/rooms/WalkRoom.js)) that nothing consulted. `questBoard` is the expensive one: it runs `boardOffers` over the whole mission registry per call, so an unbounded loop from one client was a self-service denial of service against every player in that room.

## 11. A value that is not an image never reaches an image sink

**Invariant: every URL bound for an `<img src>`, a `TextureLoader`, or a CSS `url()` passes `isSafeImageURL()` in [src/ipfs.js](../src/ipfs.js) first.**

Section 2 stops a hostile value from escaping the CSS declaration it lands in. This is the layer before that: deciding whether the value is art at all. `proxiedImageURL()` used to return anything it did not recognise unchanged, so `/play?image=javascript:…` travelled all the way into `this.coinImg.src` and `new TextureLoader().load(coin.image, …)`. It cannot execute from either sink, but it does log `ERR_UNKNOWN_URL_SCHEME` and leave a permanently dead tile, on a surface whose bar is a clean console.

The resolver now answers with `''` for anything outside `http`, `https`, `ipfs`, `ar`, `blob`, `data:image/*`, and plain relative paths, which includes `javascript:`, `vbscript:`, `data:text/html`, `file:`, `about:`, a scheme smuggled past a naive parser with a control character (`java\tscript:`), and any source past 2048 characters. Every caller already branches on `if (coin.image)`, so a refused value falls through to the world's own generated-art path.

Two consequences worth knowing:

- **Protocol-relative art is proxied, not fetched raw.** `//cdn.example/art.png` gets the page's scheme before resolution, so it goes through `/api/img` like every other cross-origin source instead of bypassing it.
- **Avatar and build thumbnails go through the proxy too.** `thumbnail_url` values from the public gallery and R2 were being set directly on `<img src>`, where Chrome's Opaque Response Blocking killed them with `ERR_BLOCKED_BY_ORB`: a console error on a plain `/play` load and a lost tile. Routing them through `/api/img`, which always answers with a valid image, fixes both.

[tests/ipfs-image-url-safety.test.js](../tests/ipfs-image-url-safety.test.js) pins the allowlist, the length cap, and the proxy routing.

## 12. The boot watchdog only fires for failures that are actually fatal

**Invariant: the `#kx-loading` error card is reserved for a world that genuinely cannot start, never for a page that is merely still loading.**

The inline watchdog in [pages/play.html](../pages/play.html) exists for one failure: a stale cached document pointing at chunks a deploy already removed, where nothing will ever finish and only a reload helps. It used to treat *any* failed `SCRIPT`/`LINK` as fatal immediately, and *any* uncaught rejection as fatal within 8 seconds. Both misfire on visitors we expect at an event:

- An ad blocker or privacy extension blocks `/brand.js` or `/i18n.js`, or any third-party script. The world does not depend on one of them, but the card appeared instantly anyway, over game modules that were downloading normally.
- Venue wifi makes some background request reject. Every fetch boundary in `/play` already handles its own failure, so the rejection is noise, but on a connection slow enough that boot took longer than the 8s grace, it replaced the loading card with "Couldn't load the world".

A resource error now counts only when it is same-origin *and* not one of the optional extras. A rejection whose reason is network-shaped (`Failed to fetch`, `NetworkError`, `AbortError`, `ERR_BLOCKED`, anything naming a `WebSocket`) is ignored outright, and anything else gets 20 seconds, long enough for a slow but healthy boot to finish and disarm it via `bootPending()`. The 45s hard timeout is untouched: a boot that truly stalls still gets its error card with a working retry.

The `WebSocket` case is not hypothetical: `/play` opens the multiplayer socket during boot, `community-net` already reconnects it with backoff, and a socket that cannot open on venue wifi surfaces as an uncaught `WebSocket closed without opened.` It has no business replacing a working world with an error screen.

`adblock-extras` and `api-blackout` in [scripts/audit-play-failure-modes.mjs](../scripts/audit-play-failure-modes.mjs) assert that neither situation produces a card.

## Verifying a change

```bash
# Pure-logic guards: CSS-injection, mint validation, param clamping,
# and the image-URL scheme allowlist.
npx vitest run tests/play-deeplink-safety.test.js tests/play-deeplink-identity.test.js \
  tests/ipfs-image-url-safety.test.js

# Deliberate failure injection in a real browser: hostile query strings, blocked
# coin art and GLBs, a dead auth gate, an ad blocker, a total API outage.
npm run audit:play-failures                       # local dev server
BASE_URL=https://three.ws npm run audit:play-failures
# A scenario the harness itself broke (a host transport reset, a starved
# browser) is retried up to ATTEMPTS times (default 4) with a growing backoff
# and reported NOT RUN if it never runs, never counted as a /play defect; the
# sweep abandons itself if the origin under test stops answering. Authed
# scenarios use AUDIT_EMAIL / AUDIT_PASSWORD (see docs/ops/page-audit.md).

# Everything else that touches the surface.
npx vitest run tests/play-gate.test.js tests/play-pass.test.js \
  tests/minimap-projection.test.js tests/quests-vehicle-delivery.test.js \
  tests/play-friends-presence.test.js

# Account identity and one-payment-one-grant: the two invariants above that
# protect what a player owns.
npx vitest run tests/play-account-identity.test.js tests/spin-wheel.test.js

# A real browser: console errors, boot, reconnect helpers, CSS injection,
# malformed mints, wheel styles. Point it at prod or a local `npm run dev`.
node scripts/play-desktop-audit.mjs "https://three.ws/play?coin=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump"

# Phone emulation: transferred bytes, heap growth, WebSocket lifecycle, and
# every GLB load attributed to the code that asked for it.
ENGINE=webkit node scripts/play-mobile-repro.mjs "https://three.ws/play" 120000
```

The mobile harness is the one that catches memory regressions. It reports total transferred bytes grouped by path, so a change that starts re-downloading avatars shows up as a jump in the `/avatars/*` and `/r2-proxy/*` rows rather than as a mysterious crash report weeks later.
