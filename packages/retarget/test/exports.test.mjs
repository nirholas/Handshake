// @three-ws/retarget: published-surface smoke tests.
// =====================================================
// The engine's deep behavioral coverage lives in the monorepo suite
// (tests/glb-canonicalize.test.js, tests/animation-retarget.test.js,
// tests/animation-upright-invariant.test.js, ~2.8k lines, run by root
// vitest). This file guards the PACKAGE: the bundled dist exposes the full
// export surface and the canonicalizer actually resolves real-world rig
// names. `node --test`, runs against dist/ (build first; prepublishOnly does).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as retarget from '../dist/index.mjs';

test('dist exposes the full engine surface', () => {
	for (const name of [
		'CANONICAL_BONES', 'canonicalizeBoneName', 'canonicalizeJointNodes',
		'canonicalizeArmatureOrientation', 'canonicalizeGLBBones',
		'MIN_COVERAGE', 'canonicalNodeMapFromObject', 'canonicalNodeMapFromRig',
		'canonicalRestMapFromObject', 'canonicalRestMapFromRig',
		'canonicalWorldRestMapFromObject', 'canonicalWorldRestMapFromRig',
		'hipsParentWorldQuat', 'hipRestHeight', 'hipRestLocalHeight',
		'clipHipBaselineY', 'retargetClip', 'retargetClipToRig',
		'retargetClipToObject', 'scaleClipSpeed', 'parseClipJSON',
		'AnimationManager', 'measureHipsTiltDeg',
		'CANONICAL_REST', 'CANONICAL_REST_WORLD',
	]) {
		assert.ok(name in retarget, `missing export: ${name}`);
	}
});

test('canonicalizeBoneName maps the major rig conventions to canonical bones', () => {
	const canon = new Set(retarget.CANONICAL_BONES);
	for (const raw of [
		'mixamorig:LeftArm',        // Mixamo
		'J_Bip_L_UpperArm',         // VRM / VRoid
		'LeftArm',                  // Avaturn / canonical passthrough
	]) {
		const mapped = retarget.canonicalizeBoneName(raw);
		assert.ok(canon.has(mapped), `${raw} → ${mapped} not in CANONICAL_BONES`);
	}
});

test('canonical rest data covers the canonical skeleton', () => {
	assert.ok(retarget.CANONICAL_BONES.length >= 50);
	assert.ok(Object.keys(retarget.CANONICAL_REST).length > 0);
	for (const bone of Object.keys(retarget.CANONICAL_REST)) {
		assert.ok(retarget.CANONICAL_BONES.includes(bone), `rest bone ${bone} not canonical`);
	}
});
