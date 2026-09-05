// The viewer retargets a library clip onto the open rig and hands the result to
// the host to bake. This runs that same pair of calls in Node against the
// committed reference avatar, so the round trip is proven without a browser:
// canonical clip -> retargetClipToObject -> AnimationClip.toJSON -> writeClipIntoGlb.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AnimationClip } from 'three';
import { WebIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { retargetClipToObject } from '../../../src/animation-retarget.js';
import { parseGltfJson, buildBoneGraph } from '../../../tests/_helpers/glb-bone-graph.js';
import { writeClipIntoGlb } from '../src/bake-clip.js';

const CZ = new URL('../../../public/avatars/cz.glb', import.meta.url);

/** A short clip on the canonical skeleton, the way every library clip is authored. */
function canonicalClip() {
	const q = (t) => [0, Math.sin(t / 2), 0, Math.cos(t / 2)];
	return {
		name: 'test-turn',
		duration: 1,
		tracks: [
			{ name: 'Hips.position', type: 'vector', times: [0, 1], values: [0, 1.0, 0, 0, 1.02, 0] },
			{ name: 'Hips.quaternion', type: 'quaternion', times: [0, 0.5, 1], values: [...q(0), ...q(0.4), ...q(0.8)] },
			{ name: 'Spine.quaternion', type: 'quaternion', times: [0, 1], values: [...q(0), ...q(0.1)] },
			{ name: 'LeftArm.quaternion', type: 'quaternion', times: [0, 1], values: [...q(0), ...q(0.3)] },
			{ name: 'RightArm.quaternion', type: 'quaternion', times: [0, 1], values: [...q(0), ...q(-0.3)] },
			{ name: 'Head.quaternion', type: 'quaternion', times: [0, 1], values: [...q(0), ...q(0.2)] },
		],
	};
}

test('a canonical clip retargets onto cz.glb and the result bakes into the file', async () => {
	const bytes = new Uint8Array(readFileSync(CZ));
	const { root } = buildBoneGraph(parseGltfJson(bytes));
	const clip = AnimationClip.parse(canonicalClip());
	const result = retargetClipToObject(clip, root);
	assert.ok(result.clip, `retarget refused the clip (coverage ${result.coverage})`);
	assert.equal(result.coverage, 1, 'every bone the clip drives exists on the reference rig');

	const json = AnimationClip.toJSON(result.clip);
	assert.ok(json.tracks.length >= 6);
	const baked = await writeClipIntoGlb(bytes, json, { name: 'test-turn' });
	assert.equal(baked.channels, json.tracks.length);
	assert.deepEqual(baked.dropped, []);

	await MeshoptDecoder.ready;
	const io = new WebIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
	const doc = await io.readBinary(baked.bytes);
	const anim = doc.getRoot().listAnimations().find((a) => a.getName() === 'test-turn');
	const targets = new Set(anim.listChannels().map((c) => c.getTargetNode().getName()));
	for (const bone of ['Hips', 'Spine', 'LeftArm', 'RightArm', 'Head']) assert.ok(targets.has(bone), `${bone} channel missing`);
});

test('a clip that drives bones the rig does not have is refused with its coverage', () => {
	const bytes = new Uint8Array(readFileSync(CZ));
	const { root } = buildBoneGraph(parseGltfJson(bytes));
	const clip = AnimationClip.parse({
		name: 'alien',
		duration: 1,
		tracks: [
			{ name: 'Tentacle1.quaternion', type: 'quaternion', times: [0], values: [0, 0, 0, 1] },
			{ name: 'Tentacle2.quaternion', type: 'quaternion', times: [0], values: [0, 0, 0, 1] },
			{ name: 'Hips.quaternion', type: 'quaternion', times: [0], values: [0, 0, 0, 1] },
		],
	});
	const result = retargetClipToObject(clip, root);
	assert.equal(result.clip, null);
	assert.ok(result.coverage < 0.5);
	assert.equal(result.total, 3);
});
