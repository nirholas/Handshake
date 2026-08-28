# @three-ws/walk

> A diverse, animated 3D avatar that **walks and talks over your web pages** — a corner companion plus a full‑page playground, with a built‑in avatar picker. Powered by [Three.js](https://threejs.org).

Drop a character onto any site. It idles in the corner, turns to follow the
cursor, waves when the visitor navigates, and greets each page. Click it and it
**detaches into a full‑page playground** the visitor can steer with the keyboard
or an on‑screen d‑pad — strolling across the page from a gentle aerial view, or
platforming across your real DOM with gravity and jumps. Walk onto a link and
it opens like a doorway into the next page.

Every visitor can **choose who walks with them** from a built‑in roster of
avatars — a robot mascot, humanoids, photoreal people, a fox, dancers,
showpieces — or you can supply your own GLB. Whatever they pick is animated
correctly whether the rig ships its own clips or needs the shared retargeting
library, so nothing ever freezes in a bind/T‑pose.

This is the engine behind the walking companion on [three.ws](https://three.ws).

---

## Install

```bash
npm install @three-ws/walk three
```

`three` is a **peer dependency** — bring your own copy (>= 0.150).

You also need to serve two sets of assets from your origin (or a CDN you point
`assetBase` at):

- the avatar GLBs the roster references (e.g. `/avatars/*.glb`), and
- the shared animation manifest + clips (`/animations/manifest.json` + clips),
  used to retarget motion onto rigs that ship no locomotion.

> The defaults match the three.ws asset layout. Override them with `assetBase`,
> `apiBase`, and `manifestUrl`, or pass your own `avatars` roster.

Don't want to host the assets? Point both at the three.ws CDN —
`assetBase: 'https://three.ws'` and
`manifestUrl: 'https://three.ws/animations/manifest.json'` (CORS is open).
Relative clip URLs inside the manifest resolve against the **manifest's**
origin, so a cross-origin manifest just works (v0.1.1+).

---

## Quick start

The whole experience, app‑style (auto‑mounts when enabled, honors `?walk=` deep
links, resumes the playground after a "dive"):

```js
import { createWalkCompanion } from '@three-ws/walk';

const walk = createWalkCompanion();
walk.bootstrap();
```

Or drive it yourself:

```js
const walk = createWalkCompanion({ defaultAvatarId: 'fox' });

walk.enable(); // mount the corner companion
walk.openPicker(); // let the visitor choose an avatar
walk.setAvatar('michelle'); // swap the live avatar
walk.disable(); // remove it
```

`createWalkCompanion` is **side‑effect free on import** — nothing touches the
DOM until you call `enable()` or `bootstrap()`.

---

## How avatars are animated

Each roster entry declares a rig strategy so it always moves:

| `rig`      | Used for                                        | How it animates                                                                 |
| ---------- | ----------------------------------------------- | ------------------------------------------------------------------------------- |
| `embedded` | self‑animated or non‑humanoid GLBs (robot, fox) | plays the clips baked into the GLB; falls back to the first clip so it never freezes |
| `shared`   | humanoids with no locomotion (or only a T‑pose) | retargets the shared clip library (`idle`/`walk`/`run`/`wave`/`jump`) onto the rig  |

The same unified loader powers both the corner companion and the playground, so
adding an avatar makes it work everywhere at once.

### Emotes

In the playground, big round buttons pinned to the right edge make the
character **perform on command**: dance, punch (a muay thai combo), backflip,
and wave, with the number keys `1`-`4` as shortcuts. Only emotes the current rig
can actually play get a button: shared rigs resolve them against the animation
manifest (`DEFAULT_EMOTES`, overridable per entry with `emotes`), embedded rigs
match their baked clip names (`Dance`, `Punch`, `Wave`, …). Looping clips
perform one capped pass, then the character settles back into whatever it was
doing. The rail rebuilds automatically when the visitor swaps avatars.

```js
// Give a custom shared-rig avatar its own dance:
{ id: 'mascot', rig: 'shared', asset: '/brand/mascot.glb', source: 'static',
  emotes: { dance: 'av-dance-shuffle' } }

// Or drive emotes programmatically from a loaded controller:
controller.emotes(); // e.g. ['dance', 'punch', 'wave']
controller.playEmote('dance'); // true if it played, false if unsupported
```

### Custom roster

```js
import { createWalkCompanion, WALK_AVATARS } from '@three-ws/walk';

createWalkCompanion({
  avatars: [
    ...WALK_AVATARS,
    {
      id: 'mascot',
      name: 'Our Mascot',
      category: 'Brand',
      asset: '/brand/mascot.glb',
      source: 'static',
      rig: 'shared', // retarget the shared library onto it
      accent: '#ff0066',
    },
  ],
  defaultAvatarId: 'mascot',
}).bootstrap();
```

User‑generated avatars served by a GLB proxy (`/api/avatars/<id>/glb`) work via
`makeApiAvatarEntry(id)` and resolve at runtime — no need to list them.

---

## API

### `createWalkCompanion(options?) → control`

| option            | default                      | description                                              |
| ----------------- | ---------------------------- | -------------------------------------------------------- |
| `avatars`         | `WALK_AVATARS`               | roster shown in the picker and resolvable by id          |
| `defaultAvatarId` | `'robot'`                    | avatar loaded when none is chosen/stored                 |
| `assetBase`       | `''`                         | base prepended to static GLB paths (e.g. a CDN origin)   |
| `apiBase`         | `''`                         | base prepended to the `/api/avatars/<id>/glb` proxy      |
| `manifestUrl`     | `'/animations/manifest.json'`| shared animation manifest                                |
| `excludedRoutes`  | full‑screen 3D routes        | path prefixes where the companion never mounts           |
| `enablePicker`    | `true`                       | show the avatar picker button                            |
| `lookAt`          | `true`                       | companion's chest/neck/head follow the visitor's cursor  |
| `greeting`        | built‑in                     | `(path) => string \| null` to customise the page greeting |
| `docsUrl`         | `null`                       | optional "make your own" link in the picker footer       |
| `storagePrefix`   | `'walk'`                     | localStorage/sessionStorage key prefix                   |

The returned **control** object:

```ts
control.isEnabled(): boolean
control.enable(): void
control.disable(): void
control.toggle(): void
control.setAvatar(idOrEntry): void   // persist + hot-swap the live avatar
control.openPicker(): void
control.announce(message, opts?): Promise<boolean>  // deliver a line in person
control.bootstrap(): void            // app-style auto-mount + ?walk= deep links
control.instance                     // the live companion (or null)
control.config                       // the resolved options, storage keys included
```

### `control.announce(message, options?)`

Deliver a message in person. The companion turns to the visitor, plays a
gesture, and shows the line in its speech bubble. If it is not on screen (the
visitor never turned it on, or closed it) it is summoned silently for this one
message and walks off again afterwards, without flipping the persisted enabled
flag: "off" stays off once the message is delivered.

```js
const walk = createWalkCompanion();

const delivered = await walk.announce('Your model finished rendering', {
  tone: 'alert',
  emote: 'dance',
  actions: [
    { label: 'Open', href: '/creations', title: 'Open your finished model' },
    { label: 'Turn off', onClick: () => muteAnnouncements() },
  ],
});
if (!delivered) showYourOwnToast(); // no WebGL, an iframe, or an excluded route
```

| option    | default    | description                                                        |
| --------- | ---------- | ------------------------------------------------------------------ |
| `hold`    | `7000`     | ms the bubble stays up                                             |
| `tone`    | `'alert'`  | `'alert'` tints the bubble; `'neutral'` is the ambient style       |
| `emote`   | `'wave'`   | gesture on arrival, falling back to a wave on rigs without it      |
| `actions` | none       | up to two links/buttons under the line (`label`, `href`/`onClick`) |
| `avatar`  | none       | deliver as somebody else: a roster id or a `makeGuestAvatarEntry()` entry |

#### Delivering as somebody else

A message from a person lands differently when that person delivers it. Pass
`avatar` and the companion swaps into that body for the length of the message,
then swaps back:

```js
import { createWalkCompanion, makeGuestAvatarEntry } from '@three-ws/walk';

const walk = createWalkCompanion();

await walk.announce('Sarah says she is downstairs and cannot find your door', {
  avatar: makeGuestAvatarEntry('https://three.ws/api/avatars/<id>/glb', { name: 'Sarah' }),
});
// Sarah walks on, says it, and the visitor's own companion is back afterwards.
```

The swap is never persisted: the visitor's chosen avatar is still theirs when
the delivery is over. A guest GLB that fails to load leaves the current body in
place and the line is still delivered, so a missing avatar never costs the
message. This is what powers [the three.ws Companion](https://three.ws/companion),
where each contact has their own body and voice.

Returns `false` when no avatar could be shown, so the caller can fall back to
its own UI. The message is rendered as text, never HTML. A delivery outranks
the companion's ambient chatter: a page greeting cannot overwrite it while it
is on screen. `control.instance.say(text, opts)` and
`control.instance.hideBubble()` drive the same bubble directly when you are
managing the mount yourself.

### Roster helpers

```js
import {
  WALK_AVATARS, DEFAULT_AVATAR_ID, DEFAULT_SHARED_CLIPS,
  getAvatar, defaultAvatar, listCategories,
  makeApiAvatarEntry, resolveAvatarUrl,
} from '@three-ws/walk';
```

### Playground (driven for you by the companion, exported for direct use)

```js
import {
  launchPlayground, exitPlayground, switchPlaygroundMode,
  getPlaygroundMode, shouldDropIn, consumeDropIn, playgroundState,
} from '@three-ws/walk';
```

#### Checkpoint quests

Both movement modes accept an optional checkpoint quest — ordered target
elements the visitor must steer the character to (this is what powers
`@three-ws/tour`'s Explore and Platformer modes). Reaching the active
checkpoint freezes the character and hands control to your `onReach`; call
`resume()` to unfreeze and light up the next one. During a quest the
link-diving mechanic is suppressed, and a live mode switch (the M key / mode
pill, or `switchPlaygroundMode()`) carries the checkpoints and progress across
— only the physics change. `window` fires `walk-playground:mode` with
`{ detail: { mode } }` on every switch.

```js
launchPlayground({
  mode: 'platformer',                        // or 'stroll'
  checkpoints: [{ el: hero }, { el: pricing }, { el: faq }],
  onReach: (i, resume) => narrate(i).then(resume),
  onComplete: () => console.log('all checkpoints found'),
});
```

### Picker UI

```js
import { createAvatarPicker } from '@three-ws/walk';

const picker = createAvatarPicker({
  avatars: WALK_AVATARS,
  currentId: 'robot',
  onSelect: (entry) => console.log('chose', entry.id),
});
picker.show();
```

### Low‑level loader

```js
import { loadWalkAvatar, getAvatar } from '@three-ws/walk';

const { model, controller } = await loadWalkAvatar(getAvatar('xbot'));
scene.add(model);
controller.playEmote('punch'); // one-shot performance, then back to base
// each frame:
controller.setState('walk'); // 'idle' | 'walk' | 'run' | 'jump'
controller.update(dt);
```

---

## URL controls

The companion honours these query params (via `bootstrap()`):

- `?walk=1` — force the companion on
- `?walk=0` — force it off
- `?walk=play` — deep‑link straight into the full‑page playground
- `?avatar=<id>` — load a specific roster avatar (or a user avatar id)

---

## Accessibility & performance

- **One shared WebGL context budget** — the companion and playground never run
  two contexts at once, and the budget coordinates with other Three.js viewers
  on the page so a busy site never hits the browser's context limit.
- **Reduced motion** — respects `prefers-reduced-motion`; the avatar calms to a
  steady idle and page "dives" skip the animation.
- **Keyboard** — playground steers with arrow keys / WASD; the picker is fully
  keyboard‑navigable; every control has a visible focus ring.
- **Lean & lazy** — `createWalkCompanion()` is side‑effect free: no DOM,
  renderer, avatar, or animation work happens until you call `enable()` /
  `bootstrap()`. The full‑page playground is instantiated only on the first
  detach (loaded through a dynamic `import()`), so a page that only ever shows
  the corner companion never runs playground code. On three.ws the playground is
  additionally delivered as its own lazily‑fetched chunk.
- **Never a T‑pose** — a `shared`‑rig avatar whose GLB turns out not to be a
  retargetable humanoid (no skinned skeleton) falls back to its own baked clips,
  then to the default rig — it never freezes in a bind/T‑pose.

---

## License

All rights reserved. See [LICENSE](./LICENSE).
