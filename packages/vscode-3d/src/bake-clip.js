// Write an animation clip into a GLB.
//
// The viewer retargets a library clip onto the open model's skeleton and hands
// back a three.js AnimationClip as JSON. This module turns that into real glTF
// animation samplers and channels on the model's nodes with glTF-Transform, so
// the saved file plays the clip in any engine, not just this viewer. Runs in the
// extension host; nothing leaves the machine.

import { WebIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

/** three.js track property -> glTF channel path and element size. */
const PATHS = Object.freeze({
	position: { path: 'translation', type: 'VEC3', size: 3 },
	quaternion: { path: 'rotation', type: 'VEC4', size: 4 },
	scale: { path: 'scale', type: 'VEC3', size: 3 },
});

/** three.js InterpolateDiscrete / InterpolateLinear / InterpolateSmooth. */
const INTERPOLATION = Object.freeze({ 2300: 'STEP', 2301: 'LINEAR', 2302: 'LINEAR' });

/**
 * GLTFLoader renames every node before an animation can bind to it, so track
 * names carry the sanitised form. Mirrors three's PropertyBinding.sanitizeNodeName.
 */
export function sanitizeNodeName(name) {
	return String(name || '')
		.replace(/\s/g, '_')
		.replace(/[\[\].:/]/g, '');
}

/**
 * Parse a three.js track name into its node and property.
 * "Hips.quaternion" -> { node: "Hips", property: "quaternion" }
 * Morph-target and indexed tracks return null: they have no node channel.
 */
export function parseTrackName(name) {
	const match = /^(.+)\.(position|quaternion|scale)$/.exec(String(name || ''));
	if (!match) return null;
	return { node: match[1], property: match[2] };
}

async function createIO() {
	await MeshoptDecoder.ready;
	await MeshoptEncoder.ready;
	return new WebIO()
		.registerExtensions(ALL_EXTENSIONS)
		.registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
}

/**
 * Add (or replace) an animation on a GLB.
 *
 * @param {Uint8Array} bytes the model
 * @param {{ name?: string, duration?: number, tracks: Array<{ name: string, type: string, times: number[], values: number[], interpolation?: number }> }} clipJson
 *   the output of THREE.AnimationClip.toJSON on the retargeted clip
 * @param {{ name?: string }} [opts] animation name; defaults to the clip's
 * @returns {Promise<{ bytes: Uint8Array, channels: number, dropped: string[], name: string }>}
 */
export async function writeClipIntoGlb(bytes, clipJson, opts = {}) {
	if (!Array.isArray(clipJson?.tracks) || !clipJson.tracks.length) {
		throw new Error('the clip has no tracks to write');
	}
	const io = await createIO();
	const doc = await io.readBinary(bytes);
	const root = doc.getRoot();
	const name = String(opts.name || clipJson.name || 'clip').trim() || 'clip';

	const nodes = new Map();
	for (const node of root.listNodes()) {
		const key = sanitizeNodeName(node.getName());
		if (key && !nodes.has(key)) nodes.set(key, node);
	}

	for (const existing of root.listAnimations()) {
		if (existing.getName() === name) existing.dispose();
	}

	const buffer = root.listBuffers()[0] || doc.createBuffer();
	const animation = doc.createAnimation(name);
	const dropped = [];
	let channels = 0;

	for (const track of clipJson.tracks) {
		const parsed = parseTrackName(track.name);
		const spec = parsed && PATHS[parsed.property];
		const node = parsed && (nodes.get(parsed.node) || nodes.get(sanitizeNodeName(parsed.node)));
		if (!spec || !node) {
			dropped.push(track.name);
			continue;
		}
		const times = Float32Array.from(track.times);
		const values = Float32Array.from(track.values);
		if (!times.length || values.length !== times.length * spec.size) {
			dropped.push(track.name);
			continue;
		}
		const input = doc.createAccessor(`${name}/${track.name}/in`).setType('SCALAR').setArray(times).setBuffer(buffer);
		const output = doc.createAccessor(`${name}/${track.name}/out`).setType(spec.type).setArray(values).setBuffer(buffer);
		const sampler = doc
			.createAnimationSampler()
			.setInput(input)
			.setOutput(output)
			.setInterpolation(INTERPOLATION[track.interpolation] || 'LINEAR');
		const channel = doc.createAnimationChannel().setSampler(sampler).setTargetNode(node).setTargetPath(spec.path);
		animation.addSampler(sampler).addChannel(channel);
		channels++;
	}

	if (!channels) {
		animation.dispose();
		throw new Error('none of the clip tracks matched a node in this model');
	}

	return { bytes: await io.writeBinary(doc), channels, dropped, name };
}
