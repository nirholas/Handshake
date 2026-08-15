# @three-ws/sign-language

American Sign Language for 3D avatars. Compile text into one continuous signed animation clip: words the lexicon knows are signed from anatomical descriptions (handshape, place on the body, movement), everything else fingerspells with the manual alphabet, and non-manual facial markers ride along. Zero runtime dependencies: no three.js, no DOM, no network. The same module runs in a browser, in Node, and in a test runner.

This package is the published build of the engine that powers [three.ws/sign-language](https://three.ws/sign-language) and the `/docs/sign-language` feature. Clips come out as the same clip-JSON document the three.ws animation library serves, so they retarget onto any humanoid rig with finger bones.

## Install

```bash
npm i @three-ws/sign-language
```

## Compile a sentence

```js
import { compileUtterance, signLookup, signGloss } from '@three-ws/sign-language';

const signs = signLookup({ dominant: 'Right' });
const { clip, signed, spelled } = compileUtterance('happy to meet you', { signs });

console.log(signed);            // words signed from the lexicon
console.log(spelled);           // words that fingerspelled instead
console.log(signGloss('happy')); // human-readable description of the sign
console.log(clip.duration, clip.tracks.length);
```

`clip` is a plain three.js `AnimationClip` JSON document. Parse it with `AnimationClip.parse(clip)` in a three.js app, or feed it to the three.ws animation pipeline as-is.

A runnable version of this lives in [example/compile-utterance.mjs](example/compile-utterance.mjs):

```bash
node example/compile-utterance.mjs "happy to meet you"
```

## Speak alongside chat

`SignSpeaker` sequences utterances for a live conversation (chat replies, captions) with the pacing constants in `CHAT_TIMING`, and `estimateDuration` / `utteranceWords` let a UI plan ahead without compiling:

```js
import { SignSpeaker, estimateDuration } from '@three-ws/sign-language';

// `manager` is anything with { injectClip(name, clip, opts), playOnce(name, opts) }:
// the three.ws AnimationManager, or a thin adapter over your own player.
const speaker = new SignSpeaker({ manager, dominant: 'Right' });

console.log(estimateDuration('nice to meet you')); // seconds, before compiling
const { signed, spelled } = await speaker.speak('nice to meet you'); // resolves when the signing ends
speaker.cancel(); // abandon an utterance; a newer speak() supersedes an older one
```

`SignSpeaker` needs a manager: it drives an avatar. To get a clip without one, call `compileUtterance` directly, as above.

## The five layers

The public surface is organised the way the engine is built; import from any layer:

| Layer | Exports | What it is |
| --- | --- | --- |
| speak | `SignSpeaker`, `compileUtterance`, `estimateDuration`, `utteranceWords`, `CHAT_TIMING` | Text in, one continuous signed clip out, with no seam between signed and fingerspelled words |
| spell | `buildFingerspellingClip`, `letterPose`, `LETTER_SHAPES`, `DEFAULT_TIMING`, `normalizeWord` | The manual alphabet: A-Z, 0-9, the traced J and Z, the double-letter bounce |
| lexicon | `SIGNS`, `SIGNABLE_WORDS`, `buildSignClip`, `lookupSign`, `signGloss`, `signLookup`, `DEFAULT_SIGN_TIMING` | The sign vocabulary, each entry a set of phases described anatomically |
| author | `HANDSHAPES`, `applyHandshape`, `SignTimeline`, `place`, `direction`, `poseHand`, `posePhase`, `faceWeights`, `mirrorPhase`, `neutralPose`, `restingPose`, `SIGNING_BONES`, `FACE_MARKERS` | The layer signs are written in: handshapes, body anchors, contact solving, non-manual markers, timelines |
| kinematics | `Pose`, `solveArm`, `anchorPoint`, `fingerBones`, `fingerTip`, `wristPosition`, `restWorld`, `ANCHORS`, `FINGERS`, `FINGER_JOINTS` and friends | Canonical-skeleton math: forward kinematics, two-bone arm IK, hand geometry |

Add a word to the vocabulary by authoring phases in the same anatomical vocabulary `SIGNS` uses and passing your extended lookup to `compileUtterance`; nothing else changes.

## Play a clip on an avatar

On three.ws every humanoid avatar plays these clips natively. In your own three.js app:

```js
import { AnimationClip, AnimationMixer } from 'three';

const parsed = AnimationClip.parse(clip);
const mixer = new AnimationMixer(avatarRoot);
mixer.clipAction(parsed).play();
```

Track names target the canonical Avaturn-style bone set (`Hips`, `RightHand`, `RightHandIndex1`, ...). A rig with different bone names retargets through the three.ws pipeline (`src/glb-canonicalize.js` + `src/animation-retarget.js` in the [monorepo](https://github.com/nirholas/three.ws)), which maps Mixamo, VRM, Daz, MakeHuman and other conventions automatically.

## What this is, and what it is not

Read this before shipping it to users.

This renders **English word order using an ASL lexicon and the manual alphabet**. It does not produce ASL grammar, which has its own syntax, topic-comment structure, spatial reference, and classifier system. A fluent signer will recognise the vocabulary and read the sentence; they will also recognise that it is not native ASL. That is a deliberate, honest limit of a text-driven renderer, not a bug to file.

Practical consequences:

- **Present it alongside text, not instead of it.** It is assistive presentation, not a certified interpreter, and it should never be the only channel for anything that matters (safety information, legal terms, medical instruction).
- **Fingerspelling is the honest fallback.** When a word is not in the lexicon the compiler spells it rather than guessing at a similar sign. A wrong sign reads as a different word; a spelled one reads as a spelled word.
- **Have Deaf signers review anything user-facing.** `signGloss()` returns each sign's plain-English description precisely so a reviewer who does not read code can audit the vocabulary.
- **Non-manual markers carry grammar.** Brow position distinguishes a yes/no question from a wh- question, so stripping the face lanes to save tracks changes meaning rather than just fidelity.

## Development

The package is a thin published surface over the monorepo engine (`src/sign-*.js` at the repo root):

```bash
npm run build    # bundle src re-exports into dist/index.mjs (esbuild, no deps)
npm test         # node --test: guards the published surface + dependency-freeness
npm run example  # compile "happy to meet you" to example/utterance.clip.json
```

Both `npm test` and `npm run example` read `dist/`, so each rebuilds it first
(`pretest` / `preexample`): a fresh clone runs them with no extra step.

Deep engine coverage lives in the monorepo suite (`tests/sign-rig`, `sign-clip`, `sign-dictionary`, `fingerspelling`, `sign-speech`, `sign-goldens`, `sign-linguistics`).

## Related

- Live feature and docs: [three.ws/sign-language](https://three.ws/sign-language), [three.ws/docs/sign-language](https://three.ws/docs/sign-language)
- Tutorial: [Sign with your avatar](https://three.ws/docs/tutorials/sign-with-your-avatar)
- License: [LICENSE](LICENSE)
