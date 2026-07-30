// @three-ws/sign-language — public entry.
// =========================================
// Re-exports the platform's American Sign Language engine from the monorepo
// source; the publish build bundles everything into dist/index.mjs, so npm
// consumers get one standalone module with ZERO runtime dependencies (no
// three.js, no DOM, no network). It runs in a browser, in Node, and in a test
// runner identically.
//
//   1. speak      — text in, one continuous signed AnimationClip out. Known
//                   words sign from the lexicon, the rest fingerspell, in a
//                   single utterance with no seam between them.
//   2. spell      — the manual alphabet: A-Z, 0-9, the traced J and Z, and the
//                   double-letter bounce.
//   3. lexicon    — the sign vocabulary, each entry a set of phases described
//                   anatomically (handshape, place on the body, movement).
//   4. author     — the layer signs are written in: handshapes, body anchors,
//                   contact solving, non-manual (facial) markers, timelines.
//   5. kinematics — the canonical-skeleton math the rest is solved on: forward
//                   kinematics, two-bone arm IK, and hand geometry.
//
// Clips come out as the same clip-JSON document three.ws's animation library
// serves, so they retarget onto any humanoid rig with finger bones.

// ── 1. speak ───────────────────────────────────────────────────────────────
export { SignSpeaker, compileUtterance, estimateDuration, utteranceWords, CHAT_TIMING } from '../../../src/sign-speech.js';

// ── 2. spell ───────────────────────────────────────────────────────────────
export {
	LETTER_SHAPES,
	DEFAULT_TIMING,
	buildFingerspellingClip,
	letterPose,
	normalizeWord,
} from '../../../src/fingerspelling.js';

// ── 3. lexicon ─────────────────────────────────────────────────────────────
export {
	SIGNS,
	SIGNABLE_WORDS,
	DEFAULT_SIGN_TIMING,
	buildSignClip,
	lookupSign,
	signGloss,
	signLookup,
} from '../../../src/sign-dictionary.js';

// ── 4. author ──────────────────────────────────────────────────────────────
export { HANDSHAPES, HANDSHAPE_NAMES, applyHandshape, handshapeLocals } from '../../../src/sign-handshapes.js';

export {
	SIGNING_BONES,
	FACE_MARKERS,
	SignTimeline,
	direction,
	faceWeights,
	mirrorPhase,
	neutralPose,
	place,
	poseHand,
	posePhase,
	restingPose,
} from '../../../src/sign-clip.js';

// ── 5. kinematics ──────────────────────────────────────────────────────────
export {
	ANCHORS,
	FINGERS,
	FINGER_JOINTS,
	Pose,
	anchorPoint,
	boneAxis,
	boneLength,
	fingerBones,
	fingerTip,
	handPartOffset,
	handPoint,
	hasBone,
	parentOf,
	restLocal,
	restPos,
	restWorld,
	signPoint,
	solveArm,
	wristPosition,
} from '../../../src/sign-rig.js';
