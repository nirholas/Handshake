# Sign language: avatars that sign

three.ws avatars can communicate in American Sign Language. Words with a sign are signed, on one or both hands; everything else is fingerspelled. It runs everywhere an avatar performs, including signed chat replies on the platform's conversational surfaces.

> Studio usage (the Spell box, exports, share links) is covered in [Animation Studio](./animation-studio.md). This page covers the system: the engines, the chat integration, and the roadmap.

## What works today

- **Fingerspell any word or number.** All 26 ASL letter handshapes, the number handshapes 0–9, the traced J and Z motions, and the double-letter bounce, compiled on-device into a standard animation clip that plays on any rigged avatar with finger bones. Try it at [/pose](https://three.ws/pose), or share a spelled word: `https://three.ws/pose?spell=HELLO`.
- **Signed chat replies.** In the [/app](https://three.ws/app) agent chat, the 🤟 button in the chat header turns on sign-language mode: the avatar signs every assistant reply. Embedders get the same with one attribute on the web component:

```html
<agent-3d agent-id="your-agent" chat sign-language></agent-3d>
```

- **Sign INTO the chat with your camera.** The 🎥 button in the agent chat opens your webcam with a mirrored self-view: fingerspell at the camera, click again, and the transcription lands in the message box for review before sending. Landmarks are extracted in your browser (MediaPipe Holistic), so video never leaves your device — only pose coordinates go to the recognizer ([workers/model-asl-recognition](../workers/model-asl-recognition), the Kaggle-2023 1st-place fingerspelling model; Apache-2.0 weights, CC BY 4.0 corpus). Expect a 10–20% character error rate on webcam fingerspelling; the chat model is robust to it.
- **A lexical sign vocabulary.** Common words are SIGNED, not spelled: `HELLO`, `THANK`, `HAPPY`, `SORRY`, `HELP`, `LOVE`, `WANT`, `YALL` and the rest of [`src/sign-dictionary.js`](../src/sign-dictionary.js), two-handed where the sign is two-handed. Browse and play the whole vocabulary at [/sign-language](https://three.ws/sign-language). A word with no sign fingerspells, in the same clip, with no seam.
- **Motion capture with hands.** The video-to-motion worker tracks 21 landmarks per hand and solves all 30 finger joints, so a video of a real signer becomes a retargetable animation clip — the path for growing the vocabulary from real signers.

## How it works

Signing is a spatial language. A sign is a handshape, a place on or in front of the body, and a movement between places — never a list of joint angles. The stack is built that way, as dependency-free JavaScript modules:

- [`src/sign-rig.js`](../src/sign-rig.js) — kinematics for the canonical skeleton. It **measures** the reference rig (bone axes, bone lengths, each hand's palm and thumb-side directions, the parent chain) from the generated bind pose in `src/animation-canonical-rest.js` rather than assuming a convention, then offers forward kinematics (`Pose`) and a two-bone arm IK (`solveArm`) that puts a wrist at a POINT with a natural elbow. Assuming the convention instead of measuring it is what once left the signing arm pointing behind the avatar's back.
- [`src/sign-handshapes.js`](../src/sign-handshapes.js) — the handshape catalogue: A–Z, 0–9, and the named shapes with no letter (`CLAW`, `FLAT_O`, `BENT_B`, `OPEN_8`, `ILY`). Each is per-finger curl, splay, and a thumb preset.
- [`src/sign-clip.js`](../src/sign-clip.js) — the authoring layer: a resting signer to start and end from, `posePhase()` to solve one phase of a sign, and `SignTimeline` to string phases together with eased transitions, a breathing idle, and clip output.
- [`src/sign-dictionary.js`](../src/sign-dictionary.js) — the vocabulary. Each sign lists its phases; `both:` poses two hands from one description because places and directions are body-relative, so the non-dominant hand mirrors for free.
- [`src/fingerspelling.js`](../src/fingerspelling.js) — the manual alphabet. The hand sits in front of the dominant shoulder at jaw height, palm to the reader, and only the handshape changes between letters, which is what makes fingerspelling readable. `buildFingerspellingClip('HELLO')` returns the same `AnimationClip` JSON document the animation library serves.
- [`src/sign-speech.js`](../src/sign-speech.js) — the signed counterpart of text-to-speech. `compileUtterance(text, { signs })` splits text into words, resolves each against a sign dictionary (lexical clips), fingerspells the misses, and concatenates everything into one continuous clip. `SignSpeaker` drives an avatar's `AnimationManager` like a TTS engine:

```js
import { SignSpeaker } from './sign-speech.js';

// The built-in vocabulary is the default: known words sign, the rest spell.
const speaker = new SignSpeaker({ manager: viewer.animationManager });
const { signed, spelled } = await speaker.speak('happy to meet you');
// signed  → ['HAPPY', 'MEET', 'YOU']
// spelled → ['TO']
```

Pass `signs: null` for spelling only, or your own lookup to override the vocabulary. Every clip is upper-body: signing never writes the root translation, so it can never move the avatar off the floor.

Adding a sign is a data change. Describe its phases and assert where the hands land:

```js
// src/sign-dictionary.js
WELCOME: {
  gloss: 'Open palm sweeps in toward the body, inviting.',
  phases: [
    { t: 0.32, right: { shape: 'FLAT', at: { anchor: 'sternum', out: 0.22, up: -0.04, forward: 0.30 },
                        fingers: ['forward', 'out'], palm: 'up' }, head: { turn: -4 } },
    { t: 0.34, right: { shape: 'FLAT', at: { anchor: 'sternum', out: 0.02, up: -0.06, forward: 0.22 },
                        fingers: ['forward', 'in'], palm: 'up' }, head: { nod: 4 }, hold: 0.18 },
  ],
},
```

Anchors (`forehead`, `nose`, `chin`, `mouth`, `sternum`, `belly`, `shoulder`, `hip`) are measured off the reference skeleton, and offsets are metres: `out` away from the midline, `in` toward it, `forward` toward the person reading. Directions take the same words. Because a sign is described anatomically, the same entry reads correctly on a tall avatar, a short one, and either hand.

Chat surfaces integrate through `AgentAvatar.setSignLanguage(true)`: the avatar layer already receives every assistant reply (the protocol `SPEAK` event), so signing rides the same event with no per-surface plumbing. Rigs without finger bones are refused with an explanation rather than signing wrong.

## Honest scope

The vocabulary is a core set of citation-form signs, strung together in English word order. That is signed English, not ASL grammar: real ASL reorders sentences, inflects verbs through space, and carries grammar on the face. The signs here are authored from standard descriptions, not captured from a specific signer, so they read as clear citation forms rather than as any individual's signing. Words with no entry are fingerspelled letter by letter. Non-manual markers are limited to head and torso movement, because the reference avatar carries no facial blendshapes.

None of this replaces a human interpreter. It makes an avatar legible to signers instead of silent.

## Roadmap

1. **Captured signs** — clips from real signers (commissioned, community capture through [Motion Swap](https://three.ws/motion-swap), permissively licensed video) replacing authored entries word by word, through the same dictionary interface.
2. **Word-level sign recognition** — the current recognizer reads fingerspelling; a 250-sign vocabulary model (MIT architecture retrained on the CC BY 4.0 PopSign corpus) will let common signs be recognized directly.
3. **Non-manual markers** — eyebrow and mouth blendshape tracks alongside the hand tracks, on avatars that carry the morph targets.
4. **Standalone package** — the engines are platform-free by design and will ship as an npm package plus reference integration.

## Related

- [Animation Studio](./animation-studio.md) — the Spell box, exports, and share links
- [docs/animations.md](./animations.md) — clip formats and the retarget engine
- [Motion Swap](https://three.ws/motion-swap) — video motion capture, including hands
