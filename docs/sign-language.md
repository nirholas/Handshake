# Sign language: avatars that sign

three.ws avatars can communicate in American Sign Language. Today that means ASL fingerspelling everywhere an avatar performs, and signed chat replies on the platform's conversational surfaces. The system is built in layers so that real lexical signs (captured from human signers) progressively replace fingerspelling word by word as the sign library grows.

> Studio usage (the Spell box, exports, share links) is covered in [Animation Studio](./animation-studio.md). This page covers the system: the engines, the chat integration, and the roadmap.

## What works today

- **Fingerspell any word.** All 26 ASL handshapes, the traced J and Z motions, and the double-letter bounce, compiled on-device into a standard animation clip that plays on any rigged avatar with finger bones. Try it at [/pose](https://three.ws/pose), or share a spelled word: `https://three.ws/pose?spell=HELLO`.
- **Signed chat replies.** In the [/app](https://three.ws/app) agent chat, the 🤟 button in the chat header turns on sign-language mode: the avatar signs every assistant reply. Embedders get the same with one attribute on the web component:

```html
<agent-3d agent-id="your-agent" chat sign-language></agent-3d>
```

- **Motion capture with hands.** The video-to-motion worker tracks 21 landmarks per hand and solves all 30 finger joints, so a video of a real signer becomes a retargetable animation clip. This is the pipeline that will populate the lexical sign dictionary.

## How it works

Two engines, both dependency-free JavaScript modules:

- [`src/fingerspelling.js`](../src/fingerspelling.js) — a parametric ASL hand model. Each letter is defined by per-finger curl, splay, a thumb preset, and wrist orientation, compiled to quaternion tracks on the canonical skeleton. `buildFingerspellingClip('HELLO')` returns the same `AnimationClip` JSON document the animation library serves.
- [`src/sign-speech.js`](../src/sign-speech.js) — the signed counterpart of text-to-speech. `compileUtterance(text, { signs })` splits text into words, resolves each against a sign dictionary (lexical clips), fingerspells the misses, and concatenates everything into one continuous clip. `SignSpeaker` drives an avatar's `AnimationManager` like a TTS engine:

```js
import { SignSpeaker } from './sign-speech.js';

const speaker = new SignSpeaker({ manager: viewer.animationManager });
await speaker.speak('hello world'); // resolves when the signing ends
```

Chat surfaces integrate through `AgentAvatar.setSignLanguage(true)`: the avatar layer already receives every assistant reply (the protocol `SPEAK` event), so signing rides the same event with no per-surface plumbing. Rigs without finger bones are refused with an explanation rather than signing wrong.

## Honest scope

Fingerspelling spells English words letter by letter; it is not grammatical ASL, which has its own grammar and non-manual markers (facial expressions carry meaning). The design principle for the lexical layer: signs come from recordings of real signers, captured through the motion pipeline, never synthesized guesses. That is also why the sign dictionary starts empty rather than shipping approximations.

## Roadmap

1. **Lexical sign dictionary** — captured clips (commissioned signers, community capture through [Motion Swap](https://three.ws/motion-swap), permissively licensed video) served as a `sign-language` library category and fed to `compileUtterance` so common words are signed, not spelled.
2. **Sign recognition** — webcam ASL input transcribed to text for the chat (the reverse direction), so signed conversations work both ways.
3. **Non-manual markers** — eyebrow and mouth blendshape tracks alongside the hand tracks.
4. **Standalone package** — the engines are platform-free by design and will ship as an npm package plus reference integration.

## Related

- [Animation Studio](./animation-studio.md) — the Spell box, exports, and share links
- [docs/animations.md](./animations.md) — clip formats and the retarget engine
- [Motion Swap](https://three.ws/motion-swap) — video motion capture, including hands
