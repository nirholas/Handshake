// Baking writes real glTF animation channels into a real avatar. cz.glb is the
// committed reference rig the clip library is authored against, and it ships
// meshopt-compressed, so this also proves the encoder round trip.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WebIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { parseTrackName, sanitizeNodeName, writeClipIntoGlb } from '../src/bake-clip.js';

const CZ = new URL('../../../public/avatars/cz.glb', import.meta.url);

function clip(name = 'test-wave') {
	return {
		name,
		duration: 1,
		tracks: [
			{ name: 'Hips.position', type: 'vector', times: [0, 0.5, 1], values: [0, 1, 0, 0, 1.1, 0, 0, 1, 0] },
			{ name: 'Hips.quaternion', type: 'quaternion', times: [0, 1], values: [0, 0, 0, 1, 0, 0.707, 0, 0.707] },
			{ name: 'LeftArm.quaternion', type: 'quaternion', times: [0, 1], values: [0, 0, 0, 1, 0.1, 0, 0, 0.99], interpolation: 2300 },
			{ name: 'NoSuchBone.quaternion', type: 'quaternion', times: [0], values: [0, 0, 0, 1] },
			{ name: 'Wolf3D_Head.morphTargetInfluences[mouthOpen]', type: 'number', times: [0], values: [1] },
		],
	};
}

test('sanitizeNodeName mirrors what GLTFLoader does to node names', () => {
	assert.equal(sanitizeNodeName('mixamorig:Hips'), 'mixamorigHips');
	assert.equal(sanitizeNodeName('Left Arm.001'), 'Left_Arm001');
	assert.equal(sanitizeNodeName('Hips'), 'Hips');
});

test('parseTrackName splits node and property and rejects non-node tracks', () => {
	assert.deepEqual(parseTrackName('Hips.quaternion'), { node: 'Hips', property: 'quaternion' });
	assert.deepEqual(parseTrackName('Left_Arm001.position'), { node: 'Left_Arm001', property: 'position' });
	assert.equal(parseTrackName('Head.morphTargetInfluences[smile]'), null);
	assert.equal(parseTrackName('nodots'), null);
});

test('a clip becomes glTF channels on the matching nodes and survives a re-read', async () => {
	const bytes = new Uint8Array(readFileSync(CZ));
	const result = await writeClipIntoGlb(bytes, clip(), { name: 'test-wave' });
	assert.equal(result.channels, 3);
	assert.deepEqual(result.dropped, ['NoSuchBone.quaternion', 'Wolf3D_Head.morphTargetInfluences[mouthOpen]']);

	await MeshoptDecoder.ready;
	const io = new WebIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
	const doc = await io.readBinary(result.bytes);
	const anim = doc.getRoot().listAnimations().find((a) => a.getName() === 'test-wave');
	assert.ok(anim, 'the animation was not written');
	const channels = anim.listChannels();
	assert.deepEqual(
		channels.map((c) => `${c.getTargetNode().getName()}:${c.getTargetPath()}`).sort(),
		['Hips:rotation', 'Hips:translation', 'LeftArm:rotation'],
	);
	const step = channels.find((c) => c.getTargetNode().getName() === 'LeftArm').getSampler();
	assert.equal(step.getInterpolation(), 'STEP');
	const hipsPos = channels.find((c) => c.getTargetPath() === 'translation').getSampler();
	assert.equal(hipsPos.getInput().getCount(), 3);
	assert.equal(hipsPos.getOutput().getType(), 'VEC3');
	// The original animation is still there and the meshes still decode.
	assert.ok(doc.getRoot().listAnimations().length >= 2);
	assert.ok(doc.getRoot().listMeshes().length > 0);
});

test('baking the same name again replaces the earlier take', async () => {
	const bytes = new Uint8Array(readFileSync(CZ));
	const once = await writeClipIntoGlb(bytes, clip('take'), { name: 'take' });
	const twice = await writeClipIntoGlb(once.bytes, clip('take'), { name: 'take' });
	await MeshoptDecoder.ready;
	const io = new WebIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
	const doc = await io.readBinary(twice.bytes);
	assert.equal(doc.getRoot().listAnimations().filter((a) => a.getName() === 'take').length, 1);
});

test('a clip whose tracks match nothing is refused, not written as an empty animation', async () => {
	const bytes = new Uint8Array(readFileSync(CZ));
	await assert.rejects(
		writeClipIntoGlb(bytes, { name: 'x', duration: 1, tracks: [{ name: 'Nope.quaternion', type: 'quaternion', times: [0], values: [0, 0, 0, 1] }] }),
		/none of the clip tracks matched/,
	);
	await assert.rejects(writeClipIntoGlb(bytes, { name: 'x', tracks: [] }), /no tracks/);
});
