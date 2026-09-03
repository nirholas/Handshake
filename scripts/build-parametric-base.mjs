// Build the parametric avatar base: public/avatars/parametric-base.glb
//
// Bakes the CC0 MakeHuman/MPFB2 data vendored in avatar-sources/anny (base
// mesh + Mixamo-named rig + skin weights + sparse morph targets) into one
// rigged, morphable GLB:
//
//   - 4 skinned primitives (body, eyes, teeth, tongue) on a 52-bone
//     mixamorig:* skeleton, Y-up meters, feet on the floor, facing +Z. The
//     bone names canonicalize via src/glb-canonicalize.js, so the whole
//     pre-baked clip library plays through src/animation-retarget.js.
//   - A curated set of ~120 identity morphs (nose, ears, mouth, eyes, jaw,
//     cheeks, head shape, neck, body macros, torso, hips, arms, legs) baked
//     as sparse glTF morph targets. The Avatar Studio sculpt panel
//     (src/avatar-sculpt.js) discovers whatever the GLB exposes, so every
//     entry in MORPHS below becomes a working slider with zero UI changes.
//     L/R paired names (earScaleLeft/earScaleRight) collapse to one slider
//     under the panel's mirror lock.
//
// Run: node scripts/build-parametric-base.mjs
// Data provenance and license: avatar-sources/anny/README.md (all CC0).

import { readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, NodeIO } from '@gltf-transform/core';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(ROOT, 'avatar-sources/anny');
const OUT = resolve(ROOT, 'public/avatars/parametric-base.glb');

// MakeHuman units are decimeters; glTF wants meters.
const SCALE = 0.1;

/* ────────────────────────────────────────────────────────────────────────── *
 * Curated morph set. name → weighted recipe of .target files (region/file).
 * decr/incr target pairs become two 0..1 sliders (the sculpt panel has no
 * negative range). Macro sliders are linear blends of MakeHuman phenotype
 * targets (gender averaged where the trait itself is not gendered).
 * ────────────────────────────────────────────────────────────────────────── */

const M = (name, ...files) => ({
	name,
	files: files.map((f) => (Array.isArray(f) ? { file: f[0], scale: f[1] } : { file: f, scale: 1 })),
});

// L/R pair helper: expands to <root>Left + <root>Right from l-/r- target files.
const PAIR = (root, filePattern, ...extra) => [
	M(`${root}Left`, filePattern.replace('{s}', 'l'), ...extra.map((f) => f.replace('{s}', 'l'))),
	M(`${root}Right`, filePattern.replace('{s}', 'r'), ...extra.map((f) => f.replace('{s}', 'r'))),
];

// L+R merged helper: ONE slider that drives both sides. Limb width, depth and
// length reads as a defect when it lands on one arm only, so those collapse
// here instead of expanding through PAIR.
const BOTH = (name, ...patterns) =>
	M(name, ...patterns.flatMap((p) => [p.replace('{s}', 'l'), p.replace('{s}', 'r')]));

const MACRO = 'macrodetails';
// Gender-averaged recipe entries: one target per gender at weight s each.
const g2 = (fn, s = 0.5) => ['female', 'male'].map((g) => [fn(g), s]);
// Ethnicity-averaged recipe entries: one target per ethnicity at weight s each.
const e3 = (fn, s = 1 / 3) => ['african', 'asian', 'caucasian'].map((e) => [fn(e), s]);

const MORPHS = [
	// Nose
	M('noseWider', 'nose/nose-scale-horiz-incr'),
	M('noseNarrower', 'nose/nose-scale-horiz-decr'),
	M('noseLonger', 'nose/nose-scale-vert-incr'),
	M('noseShorter', 'nose/nose-scale-vert-decr'),
	M('noseBigger', 'nose/nose-volume-incr'),
	M('noseSmaller', 'nose/nose-volume-decr'),
	M('noseTipUp', 'nose/nose-point-up'),
	M('noseTipDown', 'nose/nose-point-down'),
	M('noseHump', 'nose/nose-hump-incr'),
	M('noseConcave', 'nose/nose-curve-concave'),
	M('noseNostrilsWider', 'nose/nose-nostrils-width-incr'),
	M('noseNostrilsNarrower', 'nose/nose-nostrils-width-decr'),
	// Mouth
	M('mouthWider', 'mouth/mouth-scale-horiz-incr'),
	M('mouthNarrower', 'mouth/mouth-scale-horiz-decr'),
	M('mouthUpperLipFuller', 'mouth/mouth-upperlip-volume-incr'),
	M('mouthUpperLipThinner', 'mouth/mouth-upperlip-volume-decr'),
	M('mouthLowerLipFuller', 'mouth/mouth-lowerlip-volume-incr'),
	M('mouthLowerLipThinner', 'mouth/mouth-lowerlip-volume-decr'),
	M('mouthCornersUp', 'mouth/mouth-angles-up'),
	M('mouthCornersDown', 'mouth/mouth-angles-down'),
	M('mouthCupidsBow', 'mouth/mouth-cupidsbow-incr'),
	M('mouthDimples', 'mouth/mouth-dimples-in'),
	M('mouthForward', 'mouth/mouth-trans-forward'),
	M('mouthBackward', 'mouth/mouth-trans-backward'),
	// Ears (paired L/R sliders; mirror lock shows one slider per pair)
	...PAIR('earScale', 'ears/{s}-ear-scale-incr'),
	...PAIR('earSmaller', 'ears/{s}-ear-scale-decr'),
	...PAIR('earPointed', 'ears/{s}-ear-shape-pointed'),
	...PAIR('earLobeBigger', 'ears/{s}-ear-lobe-incr'),
	...PAIR('earWingOut', 'ears/{s}-ear-wing-incr'),
	...PAIR('earHigher', 'ears/{s}-ear-trans-up'),
	...PAIR('earLower', 'ears/{s}-ear-trans-down'),
	// Eye sockets (identity, distinct from the ARKit expression morphs)
	...PAIR('eyeBigger', 'eyes/{s}-eye-scale-incr'),
	...PAIR('eyeSmaller', 'eyes/{s}-eye-scale-decr'),
	...PAIR('eyeOuterUp', 'eyes/{s}-eye-corner2-up'),
	...PAIR('eyeOuterDown', 'eyes/{s}-eye-corner2-down'),
	...PAIR('eyeInward', 'eyes/{s}-eye-trans-in'),
	...PAIR('eyeOutward', 'eyes/{s}-eye-trans-out'),
	...PAIR('eyeBags', 'eyes/{s}-eye-bag-incr'),
	// Brows (bone structure, not expression)
	M('browsUp', 'eyebrows/eyebrows-trans-up'),
	M('browsDown', 'eyebrows/eyebrows-trans-down'),
	M('browsAngleUp', 'eyebrows/eyebrows-angle-up'),
	M('browsAngleDown', 'eyebrows/eyebrows-angle-down'),
	// Cheeks
	...PAIR('cheekBones', 'cheek/{s}-cheek-bones-incr'),
	...PAIR('cheekFuller', 'cheek/{s}-cheek-volume-incr'),
	...PAIR('cheekHollow', 'cheek/{s}-cheek-volume-decr'),
	// Jaw and chin
	M('jawWider', 'chin/chin-width-incr'),
	M('jawNarrower', 'chin/chin-width-decr'),
	M('jawChinLonger', 'chin/chin-height-incr'),
	M('jawChinShorter', 'chin/chin-height-decr'),
	M('jawChinPointed', 'chin/chin-triangle'),
	M('jawChinCleft', 'chin/chin-cleft-incr'),
	M('jawChinForward', 'chin/chin-prognathism-incr'),
	M('jawChinBack', 'chin/chin-prognathism-decr'),
	// Head shape
	M('headWider', 'head/head-scale-horiz-incr'),
	M('headNarrower', 'head/head-scale-horiz-decr'),
	M('headTaller', 'head/head-scale-vert-incr'),
	M('headShorter', 'head/head-scale-vert-decr'),
	M('headDeeper', 'head/head-scale-depth-incr'),
	M('headShallower', 'head/head-scale-depth-decr'),
	M('headRound', 'head/head-round'),
	M('headSquare', 'head/head-square'),
	M('headOval', 'head/head-oval'),
	M('foreheadRounder', 'forehead/forehead-nubian-incr'),
	M('foreheadFlatter', 'forehead/forehead-nubian-decr'),
	// Neck
	M('neckThicker', 'neck/neck-scale-horiz-incr', 'neck/neck-scale-depth-incr'),
	M('neckThinner', 'neck/neck-scale-horiz-decr', 'neck/neck-scale-depth-decr'),
	M('neckLonger', 'neck/neck-scale-vert-incr'),
	M('neckShorter', 'neck/neck-scale-vert-decr'),
	// Body macros (phenotype blends). The base mesh IS the neutral phenotype
	// (the universal avg-avg anchors are empty files), so gender comes from the
	// ethnicity-gender-age anchors averaged across ethnicities, and muscle/
	// weight come straight from the universal max/min anchors.
	M('bodyFeminine', ...e3((e) => `${MACRO}/${e}-female-young`)),
	M('bodyMasculine', ...e3((e) => `${MACRO}/${e}-male-young`)),
	M('bodyMuscular', ...g2((g) => `${MACRO}/universal-${g}-young-maxmuscle-averageweight`)),
	M('bodySofter', ...g2((g) => `${MACRO}/universal-${g}-young-minmuscle-averageweight`)),
	M('bodyHeavier', ...g2((g) => `${MACRO}/universal-${g}-young-averagemuscle-maxweight`)),
	M('bodyThinner', ...g2((g) => `${MACRO}/universal-${g}-young-averagemuscle-minweight`)),
	M(
		'bodyOlder',
		...e3((e) => `${MACRO}/${e}-female-old`, 1 / 6),
		...e3((e) => `${MACRO}/${e}-male-old`, 1 / 6),
		...e3((e) => `${MACRO}/${e}-female-young`, -1 / 6),
		...e3((e) => `${MACRO}/${e}-male-young`, -1 / 6),
	),
	M('heightTaller', ...g2((g) => `${MACRO}/height/${g}-young-averagemuscle-averageweight-maxheight`)),
	M('heightShorter', ...g2((g) => `${MACRO}/height/${g}-young-averagemuscle-averageweight-minheight`)),
	// Torso
	M('chestWider', 'torso/torso-scale-horiz-incr'),
	M('chestNarrower', 'torso/torso-scale-horiz-decr'),
	M('chestDeeper', 'torso/torso-scale-depth-incr'),
	M('chestVShape', 'torso/torso-vshape-incr'),
	M('chestPectorals', 'torso/torso-muscle-pectoral-incr'),
	M('waistWider', 'torso/measure-waist-circ-incr'),
	M('waistNarrower', 'torso/measure-waist-circ-decr'),
	M('bustBigger', 'torso/measure-bust-circ-incr'),
	M('bustSmaller', 'torso/measure-bust-circ-decr'),
	M('shouldersWider', 'torso/measure-shoulder-dist-incr'),
	M('shouldersNarrower', 'torso/measure-shoulder-dist-decr'),
	// Stomach, hips, glutes
	M('bellyBigger', 'stomach/stomach-pregnant-incr'),
	M('bellyToned', 'stomach/stomach-tone-incr'),
	M('hipsWider', 'hip/hip-scale-horiz-incr'),
	M('hipsNarrower', 'hip/hip-scale-horiz-decr'),
	M('gluteusBigger', 'buttocks/buttocks-volume-incr'),
	M('gluteusSmaller', 'buttocks/buttocks-volume-decr'),
	// Arms
	M(
		'armsMuscular',
		['arms/l-upperarm-muscle-incr', 1], ['arms/r-upperarm-muscle-incr', 1],
		['arms/l-lowerarm-muscle-incr', 1], ['arms/r-lowerarm-muscle-incr', 1],
		['arms/l-upperarm-shoulder-muscle-incr', 1], ['arms/r-upperarm-shoulder-muscle-incr', 1],
	),
	M(
		'armsThicker',
		['arms/l-upperarm-fat-incr', 1], ['arms/r-upperarm-fat-incr', 1],
		['arms/l-lowerarm-fat-incr', 1], ['arms/r-lowerarm-fat-incr', 1],
	),
	M(
		'armsThinner',
		['arms/l-upperarm-fat-decr', 1], ['arms/r-upperarm-fat-decr', 1],
		['arms/l-lowerarm-fat-decr', 1], ['arms/r-lowerarm-fat-decr', 1],
	),
	M('armsLonger', 'arms/measure-upperarm-length-incr', 'arms/measure-lowerarm-length-incr'),
	M('armsShorter', 'arms/measure-upperarm-length-decr', 'arms/measure-lowerarm-length-decr'),
	// Legs
	M('thighsThicker', ['legs/l-upperleg-fat-incr', 1], ['legs/r-upperleg-fat-incr', 1]),
	M('thighsThinner', ['legs/l-upperleg-fat-decr', 1], ['legs/r-upperleg-fat-decr', 1]),
	M('thighsMuscular', ['legs/l-upperleg-muscle-incr', 1], ['legs/r-upperleg-muscle-incr', 1]),
	M('calvesMuscular', ['legs/l-lowerleg-muscle-incr', 1], ['legs/r-lowerleg-muscle-incr', 1]),
	M('legsLonger', 'legs/upperlegs-height-incr', 'legs/lowerlegs-height-incr'),
	M('legsShorter', 'legs/upperlegs-height-decr', 'legs/lowerlegs-height-decr'),

	/* ── Curation pass 2 (2026-09-03) ────────────────────────────────────────
	 * The vendored MakeHuman set carries far more shape data than pass 1 used.
	 * Everything below comes from targets that were already on disk: face
	 * regions stay per-side (PAIR) because asymmetry is an identity feature,
	 * limbs collapse to one symmetric slider (BOTH) because a one-armed edit is
	 * a bug report, not a look. Targets that only translate a centred feature
	 * sideways (nose-trans-in/out, head-trans-in/out) are deliberately skipped:
	 * they read as "broken face", not as a control.
	 * ──────────────────────────────────────────────────────────────────────── */

	// Nose, continued
	M('noseBridgeWider', 'nose/nose-width1-incr'),
	M('noseBridgeNarrower', 'nose/nose-width1-decr'),
	M('noseMidWider', 'nose/nose-width2-incr'),
	M('noseMidNarrower', 'nose/nose-width2-decr'),
	M('noseBaseWider', 'nose/nose-width3-incr'),
	M('noseBaseNarrower', 'nose/nose-width3-decr'),
	M('noseDeeper', 'nose/nose-scale-depth-incr'),
	M('noseShallower', 'nose/nose-scale-depth-decr'),
	M('noseTipWider', 'nose/nose-point-width-incr'),
	M('noseTipNarrower', 'nose/nose-point-width-decr'),
	M('noseFlaring', 'nose/nose-flaring-incr'),
	M('noseFlaringLess', 'nose/nose-flaring-decr'),
	M('noseNostrilsAngleUp', 'nose/nose-nostrils-angle-up'),
	M('noseNostrilsAngleDown', 'nose/nose-nostrils-angle-down'),
	M('noseBaseUp', 'nose/nose-base-up'),
	M('noseBaseDown', 'nose/nose-base-down'),
	M('noseGreek', 'nose/nose-greek-incr'),
	M('noseConvex', 'nose/nose-curve-convex'),
	M('noseHumpLess', 'nose/nose-hump-decr'),
	M('noseCompressed', 'nose/nose-compression-compress'),
	M('noseForward', 'nose/nose-trans-forward'),
	M('noseBackward', 'nose/nose-trans-backward'),
	M('noseHigher', 'nose/nose-trans-up'),
	M('noseLower', 'nose/nose-trans-down'),
	// Mouth, continued
	M('mouthTaller', 'mouth/mouth-scale-vert-incr'),
	M('mouthShorter', 'mouth/mouth-scale-vert-decr'),
	M('mouthDeeper', 'mouth/mouth-scale-depth-incr'),
	M('mouthShallower', 'mouth/mouth-scale-depth-decr'),
	M('mouthUpperLipWider', 'mouth/mouth-upperlip-width-incr'),
	M('mouthUpperLipNarrower', 'mouth/mouth-upperlip-width-decr'),
	M('mouthLowerLipWider', 'mouth/mouth-lowerlip-width-incr'),
	M('mouthLowerLipNarrower', 'mouth/mouth-lowerlip-width-decr'),
	M('mouthUpperLipTaller', 'mouth/mouth-upperlip-height-incr'),
	M('mouthUpperLipShorter', 'mouth/mouth-upperlip-height-decr'),
	M('mouthLowerLipTaller', 'mouth/mouth-lowerlip-height-incr'),
	M('mouthLowerLipShorter', 'mouth/mouth-lowerlip-height-decr'),
	M('mouthUpperLipMiddleUp', 'mouth/mouth-upperlip-middle-up'),
	M('mouthUpperLipMiddleDown', 'mouth/mouth-upperlip-middle-down'),
	M('mouthLowerLipMiddleUp', 'mouth/mouth-lowerlip-middle-up'),
	M('mouthLowerLipMiddleDown', 'mouth/mouth-lowerlip-middle-down'),
	M('mouthCupidsBowWider', 'mouth/mouth-cupidsbow-width-incr'),
	M('mouthCupidsBowNarrower', 'mouth/mouth-cupidsbow-width-decr'),
	M('mouthPhiltrumDeeper', 'mouth/mouth-philtrum-volume-incr'),
	M('mouthPhiltrumShallower', 'mouth/mouth-philtrum-volume-decr'),
	M('mouthLaughLines', 'mouth/mouth-laugh-lines-out'),
	M('mouthHigher', 'mouth/mouth-trans-up'),
	M('mouthLower', 'mouth/mouth-trans-down'),
	// Ears, continued
	...PAIR('earTaller', 'ears/{s}-ear-scale-vert-incr'),
	...PAIR('earShorter', 'ears/{s}-ear-scale-vert-decr'),
	...PAIR('earRound', 'ears/{s}-ear-shape-round'),
	...PAIR('earSquare', 'ears/{s}-ear-shape-square'),
	...PAIR('earTriangle', 'ears/{s}-ear-shape-triangle'),
	...PAIR('earLobeSmaller', 'ears/{s}-ear-lobe-decr'),
	...PAIR('earFlapMore', 'ears/{s}-ear-flap-incr'),
	...PAIR('earTiltForward', 'ears/{s}-ear-rot-forward'),
	...PAIR('earTiltBack', 'ears/{s}-ear-rot-backward'),
	// Eye sockets, continued
	...PAIR('eyeHigher', 'eyes/{s}-eye-trans-up'),
	...PAIR('eyeLower', 'eyes/{s}-eye-trans-down'),
	...PAIR('eyeInnerUp', 'eyes/{s}-eye-corner1-up'),
	...PAIR('eyeInnerDown', 'eyes/{s}-eye-corner1-down'),
	...PAIR('eyeUpperLidUp', 'eyes/{s}-eye-height1-incr'),
	...PAIR('eyeUpperLidDown', 'eyes/{s}-eye-height1-decr'),
	...PAIR('eyeLowerLidUp', 'eyes/{s}-eye-height3-incr'),
	...PAIR('eyeLowerLidDown', 'eyes/{s}-eye-height3-decr'),
	...PAIR('eyeFoldUp', 'eyes/{s}-eye-eyefold-up'),
	...PAIR('eyeFoldDown', 'eyes/{s}-eye-eyefold-down'),
	...PAIR('eyeEpicanthusIn', 'eyes/{s}-eye-epicanthus-in'),
	...PAIR('eyeEpicanthusOut', 'eyes/{s}-eye-epicanthus-out'),
	...PAIR('eyeDeepSet', 'eyes/{s}-eye-push1-in'),
	...PAIR('eyeProtruding', 'eyes/{s}-eye-push1-out'),
	// Brows, continued
	M('browsForward', 'eyebrows/eyebrows-trans-forward'),
	M('browsBackward', 'eyebrows/eyebrows-trans-backward'),
	// Cheeks, continued
	...PAIR('cheekFlatter', 'cheek/{s}-cheek-bones-decr'),
	...PAIR('cheekInnerFuller', 'cheek/{s}-cheek-inner-incr'),
	...PAIR('cheekInnerHollow', 'cheek/{s}-cheek-inner-decr'),
	...PAIR('cheekHigher', 'cheek/{s}-cheek-trans-up'),
	...PAIR('cheekLower', 'cheek/{s}-cheek-trans-down'),
	// Jaw and chin, continued
	M('jawBonesStronger', 'chin/chin-bones-incr'),
	M('jawBonesSofter', 'chin/chin-bones-decr'),
	M('jawChinProminent', 'chin/chin-prominent-incr'),
	M('jawChinRecessed', 'chin/chin-prominent-decr'),
	M('jawDrop', 'chin/chin-jaw-drop-incr'),
	M('jawChinCleftLess', 'chin/chin-cleft-decr'),
	// Head and forehead, continued
	M('headTriangular', 'head/head-triangular'),
	M('headInvertedTriangular', 'head/head-invertedtriangular'),
	M('headRectangular', 'head/head-rectangular'),
	M('headDiamond', 'head/head-diamond'),
	M('headFuller', 'head/head-fat-incr'),
	M('headLeaner', 'head/head-fat-decr'),
	M('headAged', 'head/head-age-incr'),
	M('headYouthful', 'head/head-age-decr'),
	M('headBackDeeper', 'head/head-back-scale-depth-incr'),
	M('headBackFlatter', 'head/head-back-scale-depth-decr'),
	M('foreheadTaller', 'forehead/forehead-scale-vert-incr'),
	M('foreheadShorter', 'forehead/forehead-scale-vert-decr'),
	M('foreheadForward', 'forehead/forehead-trans-forward'),
	M('foreheadBackward', 'forehead/forehead-trans-backward'),
	M('foreheadTemplesWider', 'forehead/forehead-temple-incr'),
	M('foreheadTemplesNarrower', 'forehead/forehead-temple-decr'),
	// Neck, continued
	M('neckBackDeeper', 'neck/neck-back-scale-depth-incr'),
	M('neckBackFlatter', 'neck/neck-back-scale-depth-decr'),
	M('neckDoubleChin', 'neck/neck-double-incr'),
	M('neckDoubleChinLess', 'neck/neck-double-decr'),
	M('neckForward', 'neck/neck-trans-forward'),
	M('neckBackward', 'neck/neck-trans-backward'),
	// Torso, continued
	M('chestShallower', 'torso/torso-scale-depth-decr'),
	M('chestTaller', 'torso/torso-scale-vert-incr'),
	M('chestShorter', 'torso/torso-scale-vert-decr'),
	M('chestVShapeLess', 'torso/torso-vshape-decr'),
	M('chestPectoralsLess', 'torso/torso-muscle-pectoral-decr'),
	M('torsoLatsWider', 'torso/torso-muscle-dorsi-incr'),
	M('torsoLatsNarrower', 'torso/torso-muscle-dorsi-decr'),
	M('torsoFrontChestWider', 'torso/measure-frontchest-dist-incr'),
	M('torsoFrontChestNarrower', 'torso/measure-frontchest-dist-decr'),
	M('torsoUnderbustWider', 'torso/measure-underbust-circ-incr'),
	M('torsoUnderbustNarrower', 'torso/measure-underbust-circ-decr'),
	// Hips and stomach, continued
	M('hipsCircWider', 'torso/measure-hips-circ-incr'),
	M('hipsCircNarrower', 'torso/measure-hips-circ-decr'),
	M('hipsDeeper', 'hip/hip-scale-depth-incr'),
	M('hipsTaller', 'hip/hip-scale-vert-incr'),
	M('hipsShorter', 'hip/hip-scale-vert-decr'),
	M('hipsWaistUp', 'hip/hip-waist-up'),
	M('hipsWaistDown', 'hip/hip-waist-down'),
	M('bellySmaller', 'stomach/stomach-pregnant-decr'),
	M('bellySoft', 'stomach/stomach-tone-decr'),
	M('bellyNavelUp', 'stomach/stomach-navel-up'),
	M('bellyNavelDown', 'stomach/stomach-navel-down'),
	// Arms, continued (symmetric: one slider drives both sides)
	BOTH('armsUpperWider', 'arms/{s}-upperarm-scale-horiz-incr'),
	BOTH('armsUpperNarrower', 'arms/{s}-upperarm-scale-horiz-decr'),
	BOTH('armsLowerWider', 'arms/{s}-lowerarm-scale-horiz-incr'),
	BOTH('armsLowerNarrower', 'arms/{s}-lowerarm-scale-horiz-decr'),
	BOTH('armsUpperDeeper', 'arms/{s}-upperarm-scale-depth-incr'),
	BOTH('armsLowerDeeper', 'arms/{s}-lowerarm-scale-depth-incr'),
	BOTH('armsUpperTaller', 'arms/{s}-upperarm-scale-vert-incr'),
	BOTH('armsLowerTaller', 'arms/{s}-lowerarm-scale-vert-incr'),
	BOTH('armsLessMuscular', 'arms/{s}-upperarm-muscle-decr', 'arms/{s}-lowerarm-muscle-decr'),
	BOTH('armsShouldersLessMuscular', 'arms/{s}-upperarm-shoulder-muscle-decr'),
	// Legs, continued (symmetric)
	BOTH('legsThighsWider', 'legs/{s}-upperleg-scale-horiz-incr'),
	BOTH('legsThighsNarrower', 'legs/{s}-upperleg-scale-horiz-decr'),
	BOTH('legsCalvesWider', 'legs/{s}-lowerleg-scale-horiz-incr'),
	BOTH('legsCalvesNarrower', 'legs/{s}-lowerleg-scale-horiz-decr'),
	BOTH('legsThighsDeeper', 'legs/{s}-upperleg-scale-depth-incr'),
	BOTH('legsCalvesDeeper', 'legs/{s}-lowerleg-scale-depth-incr'),
	BOTH('legsKneesIn', 'legs/{s}-leg-valgus-incr'),
	BOTH('legsKneesOut', 'legs/{s}-leg-valgus-decr'),
	BOTH('calvesThicker', 'legs/{s}-lowerleg-fat-incr'),
	BOTH('calvesThinner', 'legs/{s}-lowerleg-fat-decr'),
	BOTH('thighsLessMuscular', 'legs/{s}-upperleg-muscle-decr'),
	BOTH('calvesLessMuscular', 'legs/{s}-lowerleg-muscle-decr'),
	M('legsUpperLonger', 'legs/measure-upperleg-height-incr'),
	M('legsUpperShorter', 'legs/measure-upperleg-height-decr'),
	M('legsLowerLonger', 'legs/measure-lowerleg-height-incr'),
	M('legsLowerShorter', 'legs/measure-lowerleg-height-decr'),
	// Phenotype macros, continued: one slider per ethnicity anchor, gender
	// averaged, so a user can dial an ancestry cue without also flipping sex.
	M('bodyAfrican', ...g2((g) => `${MACRO}/african-${g}-young`)),
	M('bodyAsian', ...g2((g) => `${MACRO}/asian-${g}-young`)),
	M('bodyCaucasian', ...g2((g) => `${MACRO}/caucasian-${g}-young`)),];

/* ────────────────────────────────────────────────────────────────────────── *
 * Preflight: a mistyped target path or a duplicated slider name is a typo, and
 * a typo that survives to the bake either throws 900 lines later or silently
 * ships a slider that shadows another. Catch both here, listing everything
 * wrong in one pass instead of failing on the first.
 * ────────────────────────────────────────────────────────────────────────── */

function preflight() {
	const problems = [];
	const seen = new Set();
	for (const { name, files } of MORPHS) {
		if (seen.has(name)) problems.push(`duplicate morph name: ${name}`);
		seen.add(name);
		for (const { file } of files) {
			const abs = resolve(SRC, 'targets', `${file}.target.gz`);
			if (!existsSync(abs)) problems.push(`${name}: missing target file ${file}.target.gz`);
		}
	}
	if (problems.length) {
		throw new Error(`morph table preflight failed:\n  ${problems.join('\n  ')}`);
	}
	return seen.size;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * OBJ parsing (positions in source space, faces per group, v/vt indexing)
 * ────────────────────────────────────────────────────────────────────────── */

function parseObj(text) {
	const positions = [];
	const uvs = [];
	const faces = []; // { group, corners: [[v, vt], ...] }
	let group = '';
	for (const line of text.split('\n')) {
		if (line.startsWith('v ')) {
			const [, x, y, z] = line.split(/\s+/);
			positions.push([+x, +y, +z]);
		} else if (line.startsWith('vt ')) {
			const [, u, v] = line.split(/\s+/);
			uvs.push([+u, +v]);
		} else if (line.startsWith('g ')) {
			group = line.slice(2).trim();
		} else if (line.startsWith('f ')) {
			const corners = line
				.slice(2)
				.trim()
				.split(/\s+/)
				.map((c) => {
					const [v, vt] = c.split('/');
					return [+v - 1, vt ? +vt - 1 : -1];
				});
			faces.push({ group, corners });
		}
	}
	return { positions, uvs, faces };
}

function loadTarget(relPath) {
	const raw = gunzipSync(readFileSync(resolve(SRC, 'targets', `${relPath}.target.gz`)));
	const deltas = new Map(); // origVertexIndex → [dx, dy, dz] in source units
	for (const line of raw.toString('utf8').split('\n')) {
		const t = line.trim();
		if (!t || t.startsWith('#')) continue;
		const [i, dx, dy, dz] = t.split(/\s+/);
		deltas.set(+i, [+dx, +dy, +dz]);
	}
	return deltas;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Budgets. The file size one is obvious. The VRAM one is not, and it is the
 * real ceiling on how many sliders this base can carry: three.js uploads morph
 * targets as an RGBA32F DataArrayTexture with ONE DENSE LAYER PER TARGET
 * (node_modules/three/src/renderers/webgl/WebGLMorphtargets.js), so cost is
 * targets x vertices x 16 bytes whether a slider is at zero or not. Sparse glTF
 * accessors keep the download small; they do nothing for VRAM. Every embed of
 * every avatar built on this base pays it, so it is a shipped-product budget,
 * not a dev-machine one.
 * ────────────────────────────────────────────────────────────────────────── */

const FILE_SIZE_BUDGET_MB = 12;
const MORPH_VRAM_BUDGET_MB = 96;

/** Bytes three.js will allocate for this GLB's morph textures. */
function morphTextureBytes(stats) {
	return stats.reduce((sum, s) => sum + s.verts * s.morphs * 16, 0);
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Build
 * ────────────────────────────────────────────────────────────────────────── */

function main() {
	preflight();
	const obj = parseObj(readFileSync(resolve(SRC, '3dobjs/base.obj'), 'utf8'));
	const vertexGroups = JSON.parse(
		readFileSync(resolve(SRC, 'mesh_metadata/basemesh_vertex_groups.json'), 'utf8'),
	);
	const rig = JSON.parse(readFileSync(resolve(SRC, 'rigs/rig.mixamo.json'), 'utf8'));
	const weightsJson = JSON.parse(readFileSync(resolve(SRC, 'rigs/weights.mixamo.json'), 'utf8'));

	const groupRange = (name) => {
		const ranges = vertexGroups[name];
		if (!ranges) throw new Error(`vertex group missing: ${name}`);
		return ranges; // [[start, end], ...] inclusive
	};
	const groupCentroid = (name) => {
		let sx = 0;
		let sy = 0;
		let sz = 0;
		let n = 0;
		for (const [a, b] of groupRange(name)) {
			for (let i = a; i <= b; i++) {
				const [x, y, z] = obj.positions[i];
				sx += x;
				sy += y;
				sz += z;
				n++;
			}
		}
		return [sx / n, sy / n, sz / n];
	};

	// Floor: the joint-ground cube marks Y of the ground plane under the feet.
	const floorY = groupCentroid('joint-ground')[1] * SCALE;

	// Facing check: the nose must sit forward of the head centroid. MakeHuman
	// exports face +Z; assert rather than assume so a future data refresh that
	// flips convention fails loudly here instead of shipping backwards avatars.
	const mouthZ = groupCentroid('joint-mouth')[2];
	const headZ = groupCentroid('joint-head')[2];
	if (!(mouthZ > headZ)) throw new Error(`unexpected facing: mouth z ${mouthZ} <= head z ${headZ}`);

	const xform = ([x, y, z]) => [x * SCALE, y * SCALE - floorY, z * SCALE];

	/* Submeshes: OBJ group(s) → one skinned primitive each. */
	const SUBMESHES = [
		{ name: 'Body', groups: ['body'], color: [0.72, 0.42, 0.29, 1], rough: 0.85 },
		{ name: 'Eyes', groups: ['helper-l-eye', 'helper-r-eye'], color: [0.18, 0.12, 0.09, 1], rough: 0.25 },
		{ name: 'Teeth', groups: ['helper-upper-teeth', 'helper-lower-teeth'], color: [0.93, 0.91, 0.86, 1], rough: 0.4 },
		{ name: 'Tongue', groups: ['helper-tongue'], color: [0.66, 0.3, 0.28, 1], rough: 0.6 },
	];

	// Per-original-vertex skin influences from the per-bone weight lists.
	const boneNames = Object.keys(rig.bones);
	const boneIndex = new Map(boneNames.map((n, i) => [n, i]));
	const influences = new Map(); // origVertex → [[boneIdx, w], ...]
	for (const [bone, list] of Object.entries(weightsJson.weights)) {
		const bi = boneIndex.get(bone);
		if (bi === undefined) throw new Error(`weights reference unknown bone: ${bone}`);
		for (const [v, w] of list) {
			let arr = influences.get(v);
			if (!arr) influences.set(v, (arr = []));
			arr.push([bi, w]);
		}
	}

	// Resolve morph recipes to per-original-vertex deltas (source units).
	const targetCache = new Map();
	const getTarget = (file) => {
		if (!targetCache.has(file)) targetCache.set(file, loadTarget(file));
		return targetCache.get(file);
	};
	const morphDeltas = MORPHS.map(({ name, files }) => {
		const sum = new Map();
		for (const { file, scale } of files) {
			for (const [v, [dx, dy, dz]] of getTarget(file)) {
				const d = sum.get(v) || [0, 0, 0];
				d[0] += dx * scale;
				d[1] += dy * scale;
				d[2] += dz * scale;
				sum.set(v, d);
			}
		}
		if (!sum.size) throw new Error(`morph resolved to zero deltas: ${name}`);
		return { name, deltas: sum };
	});

	/* glTF document */
	const doc = new Document();
	doc.getRoot().getAsset().generator = 'three.ws build-parametric-base';
	const buffer = doc.createBuffer('data');
	const scene = doc.createScene('ParametricBase');
	const rootNode = doc.createNode('ParametricBase');
	scene.addChild(rootNode);

	// Skeleton: translation-only joints named exactly as the rig declares
	// (mixamorig:*). Bone head positions come from the mesh itself (MEAN of
	// vertex indices or centroid of a joint cube group), so rig and mesh agree
	// by construction. animation-retarget.js's world-delta bind correction
	// handles the identity orientations.
	const headOf = (bone) => {
		const h = bone.head;
		if (h.strategy === 'MEAN') {
			let sx = 0;
			let sy = 0;
			let sz = 0;
			for (const i of h.vertex_indices) {
				const [x, y, z] = obj.positions[i];
				sx += x;
				sy += y;
				sz += z;
			}
			const n = h.vertex_indices.length;
			return xform([sx / n, sy / n, sz / n]);
		}
		if (h.strategy === 'CUBE') return xform(groupCentroid(h.cube_name));
		throw new Error(`unknown joint strategy ${h.strategy}`);
	};

	const jointWorld = new Map(boneNames.map((n) => [n, headOf(rig.bones[n])]));
	const nodes = new Map();
	for (const name of boneNames) nodes.set(name, doc.createNode(name));
	for (const name of boneNames) {
		const parent = rig.bones[name].parent;
		const world = jointWorld.get(name);
		const parentWorld = parent && jointWorld.has(parent) ? jointWorld.get(parent) : [0, 0, 0];
		nodes.get(name).setTranslation([
			world[0] - parentWorld[0],
			world[1] - parentWorld[1],
			world[2] - parentWorld[2],
		]);
		if (parent && nodes.has(parent)) nodes.get(parent).addChild(nodes.get(name));
		else rootNode.addChild(nodes.get(name));
	}

	const ibm = new Float32Array(boneNames.length * 16);
	boneNames.forEach((name, i) => {
		const [x, y, z] = jointWorld.get(name);
		const o = i * 16;
		ibm[o] = 1;
		ibm[o + 5] = 1;
		ibm[o + 10] = 1;
		ibm[o + 15] = 1;
		ibm[o + 12] = -x;
		ibm[o + 13] = -y;
		ibm[o + 14] = -z;
	});
	const ibmAccessor = doc
		.createAccessor('ibm')
		.setType('MAT4')
		.setArray(ibm)
		.setBuffer(buffer);
	const skin = doc.createSkin('ParametricSkin').setInverseBindMatrices(ibmAccessor);
	for (const name of boneNames) skin.addJoint(nodes.get(name));
	skin.setSkeleton(nodes.get(boneNames.find((n) => !rig.bones[n].parent) || 'mixamorig:Hips'));

	const stats = [];
	for (const sub of SUBMESHES) {
		const wanted = new Set(sub.groups);
		// Assemble unique (v, vt) output vertices and triangulated indices.
		const outIndexOf = new Map();
		const origIndex = [];
		const pos = [];
		const uv = [];
		const indices = [];
		const cornerIndex = ([v, vt]) => {
			const key = `${v}/${vt}`;
			let idx = outIndexOf.get(key);
			if (idx === undefined) {
				idx = origIndex.length;
				outIndexOf.set(key, idx);
				origIndex.push(v);
				pos.push(...xform(obj.positions[v]));
				const t = vt >= 0 ? obj.uvs[vt] : [0, 0];
				uv.push(t[0], 1 - t[1]);
			}
			return idx;
		};
		for (const face of obj.faces) {
			if (!wanted.has(face.group)) continue;
			const c = face.corners.map(cornerIndex);
			for (let i = 2; i < c.length; i++) indices.push(c[0], c[i - 1], c[i]);
		}
		if (!indices.length) throw new Error(`submesh has no faces: ${sub.name}`);
		const count = origIndex.length;

		// Smooth normals from triangle accumulation.
		const normal = new Float32Array(count * 3);
		for (let i = 0; i < indices.length; i += 3) {
			const [a, b, c] = [indices[i], indices[i + 1], indices[i + 2]];
			const ax = pos[a * 3];
			const ay = pos[a * 3 + 1];
			const az = pos[a * 3 + 2];
			const ux = pos[b * 3] - ax;
			const uy = pos[b * 3 + 1] - ay;
			const uz = pos[b * 3 + 2] - az;
			const vx = pos[c * 3] - ax;
			const vy = pos[c * 3 + 1] - ay;
			const vz = pos[c * 3 + 2] - az;
			const nx = uy * vz - uz * vy;
			const ny = uz * vx - ux * vz;
			const nz = ux * vy - uy * vx;
			for (const k of [a, b, c]) {
				normal[k * 3] += nx;
				normal[k * 3 + 1] += ny;
				normal[k * 3 + 2] += nz;
			}
		}
		for (let i = 0; i < count; i++) {
			const nx = normal[i * 3];
			const ny = normal[i * 3 + 1];
			const nz = normal[i * 3 + 2];
			const len = Math.hypot(nx, ny, nz) || 1;
			normal[i * 3] = nx / len;
			normal[i * 3 + 1] = ny / len;
			normal[i * 3 + 2] = nz / len;
		}

		// Skinning attributes: top-4 influences, renormalized.
		const joints = new Uint16Array(count * 4);
		const weights = new Float32Array(count * 4);
		for (let i = 0; i < count; i++) {
			const inf = (influences.get(origIndex[i]) || []).slice().sort((a, b) => b[1] - a[1]).slice(0, 4);
			const total = inf.reduce((s, [, w]) => s + w, 0);
			if (!total) throw new Error(`unweighted vertex ${origIndex[i]} in ${sub.name}`);
			inf.forEach(([bi, w], k) => {
				joints[i * 4 + k] = bi;
				weights[i * 4 + k] = w / total;
			});
		}

		const material = doc
			.createMaterial(`Parametric_${sub.name}`)
			.setBaseColorFactor(sub.color)
			.setMetallicFactor(0)
			.setRoughnessFactor(sub.rough);

		const acc = (name, type, array, extra = {}) => {
			const a = doc.createAccessor(name).setType(type).setArray(array).setBuffer(buffer);
			if (extra.sparse) a.setSparse(true);
			return a;
		};
		const prim = doc
			.createPrimitive()
			.setIndices(acc(`${sub.name}-idx`, 'SCALAR', new Uint32Array(indices)))
			.setAttribute('POSITION', acc(`${sub.name}-pos`, 'VEC3', new Float32Array(pos)))
			.setAttribute('NORMAL', acc(`${sub.name}-nrm`, 'VEC3', normal))
			.setAttribute('TEXCOORD_0', acc(`${sub.name}-uv`, 'VEC2', new Float32Array(uv)))
			.setAttribute('JOINTS_0', acc(`${sub.name}-jnt`, 'VEC4', joints))
			.setAttribute('WEIGHTS_0', acc(`${sub.name}-wgt`, 'VEC4', weights))
			.setMaterial(material);

		// Morph targets: only those touching this submesh, as sparse accessors.
		const targetNames = [];
		for (const { name, deltas } of morphDeltas) {
			let touched = 0;
			const arr = new Float32Array(count * 3);
			for (let i = 0; i < count; i++) {
				const d = deltas.get(origIndex[i]);
				if (!d) continue;
				arr[i * 3] = d[0] * SCALE;
				arr[i * 3 + 1] = d[1] * SCALE;
				arr[i * 3 + 2] = d[2] * SCALE;
				touched++;
			}
			if (!touched) continue;
			const target = doc
				.createPrimitiveTarget(name)
				.setAttribute('POSITION', acc(`${sub.name}-m-${name}`, 'VEC3', arr, { sparse: true }));
			prim.addTarget(target);
			targetNames.push(name);
		}

		const mesh = doc.createMesh(sub.name).addPrimitive(prim);
		if (targetNames.length) {
			mesh.setWeights(new Array(targetNames.length).fill(0));
			mesh.setExtras({ targetNames });
		}
		const meshNode = doc.createNode(sub.name).setMesh(mesh).setSkin(skin);
		rootNode.addChild(meshNode);
		stats.push({ name: sub.name, verts: count, tris: indices.length / 3, morphs: targetNames.length });
	}

	const io = new NodeIO();
	io.write(OUT, doc).then(() => {
		const size = statSync(OUT).size;
		console.log(`wrote ${OUT} (${(size / 1024 / 1024).toFixed(2)} MB)`);
		console.log(` joints: ${boneNames.length}, morph sliders: ${MORPHS.length}`);
		for (const s of stats) console.log(` ${s.name}: ${s.verts} verts, ${s.tris} tris, ${s.morphs} morphs`);
		const hips = jointWorld.get('mixamorig:Hips');
		console.log(` hips rest height: ${hips[1].toFixed(3)} m`);
		console.log(` morph texture: ${(morphTextureBytes(stats) / 1024 / 1024).toFixed(1)} MB VRAM (budget ${MORPH_VRAM_BUDGET_MB} MB)`);
		if (size > FILE_SIZE_BUDGET_MB * 1024 * 1024) {
			throw new Error(`output ${(size / 1024 / 1024).toFixed(2)} MB exceeds the ${FILE_SIZE_BUDGET_MB} MB budget; check sparse encoding`);
		}
		const vram = morphTextureBytes(stats) / 1024 / 1024;
		if (vram > MORPH_VRAM_BUDGET_MB) {
			throw new Error(
				`morph targets would need ${vram.toFixed(1)} MB of VRAM, over the ${MORPH_VRAM_BUDGET_MB} MB budget. ` +
					'Every viewer of every avatar on this base pays that, not just the editor. ' +
					'Cut sliders, or land the bake-side identity-morph fold first (specs/PARAMETRIC_AVATAR.md).',
			);
		}
	});
}

main();
