# Custom avatars 🔴

Every built-in guide is a **skeleton-rigged, lipsync-capable** glTF. This guide
explains what that means, how to bring your own rig, and how to self-host the
catalog.

---

## What makes a good page-agent avatar

The runtime drives three things on your model every frame: **idle motion**,
**blinking**, and **mouth/lipsync**. A model needs the right rig data for those
to work — otherwise you get a frozen, dead-faced statue, which is exactly why the
built-in catalog only ships verified rigs.

Your GLB should have:

| Feature | What the runtime looks for | If missing |
|---------|----------------------------|------------|
| **Skeleton** | A skinned mesh + armature (bones). | Required — no rig, no agent. |
| **Idle clip** | An animation whose name contains `idle`, `breathing`, `stand`, or `rest` (else the first clip). | Falls back to **procedural** breathing + head sway. |
| **Talk clip** | An animation named with `talk`, `talking`, `speak`, `gesture`, or `wave`. | Speaking still works via lipsync/head motion; just no body emphasis. |
| **Visemes** | Oculus/ARKit morph targets: `viseme_aa`, `viseme_E`, `viseme_O`, `viseme_PP`, … (15 total). | Drops to jaw mode. |
| **Jaw morph** | `jawOpen` or `mouthOpen` (used when no full visemes). | Drops to animation-only mouth. |
| **Blink morphs** | `eyeBlinkLeft` / `eyeBlinkRight` / `eyesClosed` / `blink`. | No blinking. |
| **Head bone** | A bone whose name matches `/head/i` (not `headtop`/`end`). | No procedural head sway/nod. |

### The three lipsync tiers

The runtime auto-detects which to use from the morph targets it finds:

1. **`viseme`** *(best)* — the full ARKit set; phoneme-accurate mouth shapes.
   This is what [Ready Player Me](https://readyplayer.me) and most ARKit
   exporters produce.
2. **`jaw`** — a single `jawOpen`/`mouthOpen` morph driven on a speech envelope.
   Good enough to read as "talking."
3. **animation** — no face morphs; the talk body clip + head motion carry the
   speech (typical for Mixamo characters).

> The full ARKit viseme list and detection logic live in
> [`src/lipsync.js`](../src/lipsync.js) — read it if you're authoring a rig and
> want to match the exact target names.

---

## Option A — Self-host the built-in catalog

The simplest customization: keep the nine guides, but serve their GLBs from your
own domain (for offline use, a CDN you control, or air-gapped deploys).

Copy the avatar GLBs to your host, preserving the **filenames** the catalog
expects (`realistic-halfbody.glb`, `selfie-girl.glb`, `xbot.glb`, …), then point
`assetBase` at them:

```js
new PageAgent({ assetBase: 'https://cdn.example.com/guides/' });
```

```html
<page-agent asset-base="https://cdn.example.com/guides/"></page-agent>
```

```js
import { AGENTS } from '@three-ws/page-agent';
// The exact filename each agent expects:
AGENTS.forEach((a) => console.log(a.id, '→', a.file));
```

`assetBase` + `file` is how every default URL is built; an agent's optional
absolute `url` overrides it entirely.

---

## Option B — Drive a single custom avatar yourself

To render *your own* rigged character (not in the catalog) with full control over
the UI, use the building blocks directly. `AvatarStage` will load any rigged GLB
URL; `SpeechNarrator` speaks and lipsyncs against whatever morphs it finds:

```js
import { AvatarStage, SpeechNarrator } from '@three-ws/page-agent';

const stage = new AvatarStage(document.querySelector('#guide'), { background: 'transparent' });
await stage.load('https://three.ws/avatars/realistic-halfbody.glb', { framing: 'upper' });

const narrator = new SpeechNarrator(stage, {
  onCaption: (t) => (captionEl.textContent = t || ''),
});
narrator.setAgent({
  // a minimal RiggedAgent — voice is all the narrator needs
  voice: { lang: 'en-US', rate: 1.0, pitch: 1.0, match: ['samantha', 'aria'] },
});

await narrator.speak("Hi, I'm a fully custom guide.");
```

This is the full advanced path — see [Building blocks](./guide-building-blocks.md)
for the complete walkthrough (custom picker, your own control bar, render hooks).

---

## Verifying your rig

Before shipping a custom GLB, confirm the runtime can drive it. `buildMorphMap`
tells you which lipsync tier your model qualifies for:

```js
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { buildMorphMap } from '@three-ws/page-agent';

const gltf = await new GLTFLoader().loadAsync('https://three.ws/avatars/realistic-halfbody.glb');
const morph = buildMorphMap(gltf.scene);

console.log('lipsync tier:', morph?.mode ?? 'animation (no face morphs)');
console.log('clips:', gltf.animations.map((c) => c.name));
```

- `morph.mode === 'arkit'` → full visemes detected. 🎉
- `morph.mode === 'jaw'` → only a jaw morph; consider adding visemes.
- `null` → no mouth morphs; make sure you have a **talk** clip so speech reads.

Checklist:

- [ ] Loads in a [glTF viewer](https://gltf-viewer.donmccurdy.com/) without errors.
- [ ] Has a skinned mesh + armature.
- [ ] Has an `idle` (or first) clip that loops cleanly.
- [ ] `buildMorphMap` returns `arkit` or `jaw` — **or** the model has a talk clip.
- [ ] Reasonable poly/texture budget (these stream to every visitor).
- [ ] Front-facing at the origin, feet near `y=0`, looking down +Z.

---

## Framing

The camera crop is per-avatar. Choose what flatters your model:

| `framing` | Crop | Use for |
|-----------|------|---------|
| `bust` | Head & shoulders | Realistic faces with great visemes. |
| `upper` | Waist up | Most stylized characters. |
| `full` | Whole body | Expressive/full-body talkers (robots, Mixamo). |

```js
await stage.load(url, { framing: 'full' });
```

---

## Contributing an avatar to the catalog

Want your rig to be one of the built-in guides everyone can pick by id? That's a
welcome contribution. The catalog is a single, well-documented file
([`src/catalog.js`](../src/catalog.js)), and adding an entry is a few lines plus
a verified GLB. See **[CONTRIBUTING → Add an agent](../CONTRIBUTING.md#add-an-agent-to-the-catalog)**
for the checklist (rig verification, voice profile, accent color, tests).

> **Heads up:** the catalog is keyed into an internal lookup at module load, so
> *runtime* mutation of the exported `AGENTS` array won't register a new id with
> `setAgent()`. To add a guide to the picker the supported ways are: contribute
> it to the catalog, or build your own roster with the
> [building blocks](./guide-building-blocks.md).

---

Next: [Building blocks →](./guide-building-blocks.md) ·
[Contributing →](../CONTRIBUTING.md)
