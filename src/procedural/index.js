// Procedural animation layer: runtime IK applied on top of the pre-baked clip
// library, so any humanoid the retargeter can drive also gets living-avatar
// behaviors no baked clip can provide. Every module is a post-animation layer
// with the same contract: construct once per attached model, call update(dt)
// each frame AFTER mixer.update(), and it composes with whatever clip is
// playing without accumulating. Docs: docs/procedural-animation.md.

export { canonicalBoneNodes, firstCanonical } from './canonical-bones.js';
export { solveTwoBoneIK } from './two-bone-ik.js';
export { LookAtController } from './look-at.js';
export { FootPlantController } from './foot-plant.js';
