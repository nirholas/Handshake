// @three-ws/retarget: public entry.
// ===================================
// Re-exports the platform's rig-agnostic humanoid animation engine from the
// monorepo source (the seam walk-sdk's PROMOTION NOTE designates); the publish
// build bundles everything into dist/ so npm consumers get one standalone
// package whose only dependency is their own copy of Three.js.
//
//   1. canonicalize: map any humanoid rig's bone names (Mixamo, Avaturn,
//      VRM/VRoid, VRM 1.0, Daz/Genesis, MakeHuman, Unreal, Blender `.L`,
//      simple `shoulderL` rigs, …) onto the frozen canonical bone set, either
//      on a parsed glTF JSON tree or byte-exactly inside a GLB ArrayBuffer.
//   2. retarget: play any canonical-space AnimationClip on that rig, with
//      rest-pose (A/T-pose) correction, hip up-axis fixes, and coverage gates
//      so a non-humanoid never half-animates.
//   3. drive: the AnimationManager runtime that loads clip libraries,
//      crossfades, layers overlays, and refuses fallen/broken poses.

export {
	CANONICAL_BONES,
	canonicalizeBoneName,
	canonicalizeJointNodes,
	canonicalizeArmatureOrientation,
	canonicalizeGLBBones,
} from '../../../src/glb-canonicalize.js';

export {
	MIN_COVERAGE,
	canonicalNodeMapFromObject,
	canonicalNodeMapFromRig,
	canonicalRestMapFromObject,
	canonicalRestMapFromRig,
	canonicalWorldRestMapFromObject,
	canonicalWorldRestMapFromRig,
	hipsParentWorldQuat,
	hipRestHeight,
	hipRestLocalHeight,
	clipHipBaselineY,
	retargetClip,
	retargetClipToRig,
	retargetClipToObject,
	scaleClipSpeed,
	parseClipJSON,
} from '../../../src/animation-retarget.js';

export { AnimationManager, measureHipsTiltDeg } from '../../../src/animation-manager.js';

export { CANONICAL_REST, CANONICAL_REST_WORLD } from '../../../src/animation-canonical-rest.js';
