// Load a GLB into the flat, typed-array form the rasterizer wants.
//
// Parsing is delegated to @gltf-transform/core rather than hand-rolled: it is
// the reference glTF I/O implementation, it already understands the extension
// soup real avatars ship with, and a bespoke parser here would be a permanent
// liability for zero gain. What this module owns is the part gltf-transform
// deliberately does not do: turning a scene graph into skinned world-space
// triangles at a point in time.
//
// EXT_meshopt_compression is not optional. Most three.ws avatars ship with it,
// and a reader that skips the decoder does not fail loudly, it reads garbage
// vertex data. The decoder is registered unconditionally.

import { NodeIO, WebIO, getBounds } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { mat4FromTRS, mat4Identity, mat4Multiply, mat4NormalMatrix, mulDir, mulPoint, normalize, slerp } from './math.js';

const DEFAULT_COLOR = [0.82, 0.84, 0.9];

async function makeIO(Ctor) {
	await MeshoptDecoder.ready;
	const io = new Ctor().registerExtensions(ALL_EXTENSIONS).registerDependencies({
		'meshopt.decoder': MeshoptDecoder,
	});
	return io;
}

/** Read a GLB from bytes. Accepts ArrayBuffer, Uint8Array, or Buffer. */
export async function loadModelFromBytes(bytes) {
	const io = await makeIO(WebIO);
	const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	return buildModel(await io.readBinary(u8));
}

/** Read a GLB or glTF from the filesystem. */
export async function loadModelFromFile(path) {
	const io = await makeIO(NodeIO);
	return buildModel(await io.read(path));
}

function materialColor(material) {
	if (!material) return DEFAULT_COLOR;
	const base = material.getBaseColorFactor();
	if (!base) return DEFAULT_COLOR;
	const [r, g, b, a] = base;
	// A fully transparent material is almost always a hidden helper plane or an
	// eyelash card; drawing it opaque would paste a grey rectangle over the face.
	if (a !== undefined && a < 0.05) return null;
	return [r, g, b];
}

function collectNodes(doc) {
	const root = doc.getRoot();
	const scene = root.getDefaultScene() ?? root.listScenes()[0] ?? null;
	const nodes = [];
	const index = new Map();

	const visit = (node, parent) => {
		const id = nodes.length;
		index.set(node, id);
		nodes.push({
			id,
			parent,
			node,
			restT: Float64Array.from(node.getTranslation()),
			restR: Float64Array.from(node.getRotation()),
			restS: Float64Array.from(node.getScale()),
			local: new Float64Array(16),
			world: new Float64Array(16),
		});
		for (const child of node.listChildren()) visit(child, id);
	};

	const roots = scene ? scene.listChildren() : root.listNodes().filter((n) => !n.listParents().some((p) => p.propertyType === 'Node'));
	for (const node of roots) visit(node, -1);
	return { nodes, index };
}

function buildModel(doc) {
	const { nodes, index } = collectNodes(doc);
	const primitives = [];

	for (const entry of nodes) {
		const mesh = entry.node.getMesh();
		if (!mesh) continue;
		const skin = entry.node.getSkin();

		let jointNodes = null;
		let inverseBind = null;
		if (skin) {
			// NOT filtered. JOINTS_0 indexes into this list positionally, so dropping
			// an unresolvable joint shifts every joint after it and rigs the mesh to
			// the wrong bones. A hole is kept as -1 and handled at skin time.
			jointNodes = skin.listJoints().map((j) => {
				const id = index.get(j);
				return id === undefined ? -1 : id;
			});
			const ibmAccessor = skin.getInverseBindMatrices();
			inverseBind = ibmAccessor ? Float64Array.from(ibmAccessor.getArray()) : null;
		}

		for (const prim of mesh.listPrimitives()) {
			// Mode 4 is TRIANGLES. Points, lines, strips and fans exist in the wild
			// but never in an avatar body; skipping them is honest, and a strip
			// silently rasterized as a triangle soup would render as shredded mesh.
			if (prim.getMode() !== 4) continue;
			const position = prim.getAttribute('POSITION');
			if (!position) continue;
			const color = materialColor(prim.getMaterial());
			if (!color) continue;

			const positions = Float32Array.from(position.getArray());
			const normalAttr = prim.getAttribute('NORMAL');
			const indicesAccessor = prim.getIndices();
			const count = positions.length / 3;
			const indices = indicesAccessor
				? Uint32Array.from(indicesAccessor.getArray())
				: Uint32Array.from({ length: count }, (_, i) => i);

			const joints = skin ? prim.getAttribute('JOINTS_0') : null;
			const weights = skin ? prim.getAttribute('WEIGHTS_0') : null;

			primitives.push({
				nodeId: entry.id,
				color,
				positions,
				normals: normalAttr ? Float32Array.from(normalAttr.getArray()) : deriveNormals(positions, indices),
				indices,
				jointNodes: joints && weights ? jointNodes : null,
				inverseBind: joints && weights ? inverseBind : null,
				joints: joints ? Uint16Array.from(joints.getArray()) : null,
				weights: weights ? Float32Array.from(weights.getArray()) : null,
				// Scratch buffers, reused every frame so a 60 fps turntable does not
				// allocate two arrays per primitive per frame.
				outPositions: new Float32Array(positions.length),
				outNormals: new Float32Array(positions.length),
				poseStamp: -1,
			});
		}
	}

	const animations = doc.getRoot().listAnimations().map((anim) => ({
		name: anim.getName() || 'clip',
		duration: anim.listChannels().reduce((max, ch) => {
			const input = ch.getSampler()?.getInput();
			if (!input) return max;
			const arr = input.getArray();
			return Math.max(max, arr.length ? arr[arr.length - 1] : 0);
		}, 0),
		channels: anim.listChannels().map((ch) => {
			const sampler = ch.getSampler();
			const target = ch.getTargetNode();
			return {
				nodeId: target ? index.get(target) : undefined,
				path: ch.getTargetPath(),
				interpolation: sampler?.getInterpolation() ?? 'LINEAR',
				times: sampler?.getInput() ? Float32Array.from(sampler.getInput().getArray()) : new Float32Array(0),
				values: sampler?.getOutput() ? Float32Array.from(sampler.getOutput().getArray()) : new Float32Array(0),
			};
		}).filter((ch) => ch.nodeId !== undefined && ch.times.length > 0),
	})).filter((a) => a.duration > 0 && a.channels.length > 0);

	const bbox = getBounds(doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0]);

	return {
		nodes,
		primitives,
		animations,
		poseStamp: 0,
		bounds: bbox ? { min: bbox.min.slice(), max: bbox.max.slice() } : { min: [-1, -1, -1], max: [1, 1, 1] },
		triangleCount: primitives.reduce((n, p) => n + p.indices.length / 3, 0),
		skinned: primitives.some((p) => p.joints),
	};
}

/** Flat face normals for a primitive that shipped without a NORMAL attribute. */
function deriveNormals(positions, indices) {
	const normals = new Float32Array(positions.length);
	for (let i = 0; i < indices.length; i += 3) {
		const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
		const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
		const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
		const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
		for (const o of [a, b, c]) {
			normals[o] += nx; normals[o + 1] += ny; normals[o + 2] += nz;
		}
	}
	for (let i = 0; i < normals.length; i += 3) {
		const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
		normals[i] /= len; normals[i + 1] /= len; normals[i + 2] /= len;
	}
	return normals;
}

/** Sample one animation channel at time t into `out`. */
export function sampleChannel(channel, t, out) {
	const { times, values, interpolation, path } = channel;
	const stride = path === 'rotation' ? 4 : 3;
	const n = times.length;
	const clamped = Math.min(Math.max(t, times[0]), times[n - 1]);

	let hi = 1;
	while (hi < n && times[hi] < clamped) hi += 1;
	const lo = Math.max(0, hi - 1);
	hi = Math.min(hi, n - 1);

	const span = times[hi] - times[lo];
	const alpha = span > 0 ? (clamped - times[lo]) / span : 0;

	// CUBICSPLINE stores [inTangent, value, outTangent] per key. Reading its
	// middle triple and interpolating linearly is a visible but tiny error at
	// terminal resolution; reading it as if it were LINEAR would read tangents
	// as values and throw the limb across the screen.
	const cubic = interpolation === 'CUBICSPLINE';
	const base = (i) => (cubic ? (i * 3 + 1) : i) * stride;
	const loBase = base(lo), hiBase = base(hi);

	if (interpolation === 'STEP') {
		for (let i = 0; i < stride; i += 1) out[i] = values[loBase + i];
		return out;
	}
	if (path === 'rotation') {
		return slerp(
			values.subarray(loBase, loBase + 4),
			values.subarray(hiBase, hiBase + 4),
			alpha,
			out,
		);
	}
	for (let i = 0; i < stride; i += 1) {
		out[i] = values[loBase + i] + (values[hiBase + i] - values[loBase + i]) * alpha;
	}
	return out;
}

const scratchQuat = new Float64Array(4);
const scratchVec = new Float64Array(3);

/** Pose every node for `animation` at `time`, then recompute world matrices. */
export function poseModel(model, animation, time) {
	// Bumped so transformPrimitive can skip vertices it already transformed for
	// this pose. The camera needs the posed bounds before rasterizing, so every
	// frame would otherwise skin the whole mesh twice.
	model.poseStamp = (model.poseStamp ?? 0) + 1;
	for (const entry of model.nodes) {
		entry.curT = entry.restT;
		entry.curR = entry.restR;
		entry.curS = entry.restS;
	}

	if (animation) {
		const t = animation.duration > 0 ? time % animation.duration : 0;
		for (const channel of animation.channels) {
			const entry = model.nodes[channel.nodeId];
			if (!entry) continue;
			if (channel.path === 'rotation') {
				entry.curR = Float64Array.from(sampleChannel(channel, t, scratchQuat));
			} else if (channel.path === 'translation') {
				entry.curT = Float64Array.from(sampleChannel(channel, t, scratchVec));
			} else if (channel.path === 'scale') {
				entry.curS = Float64Array.from(sampleChannel(channel, t, scratchVec));
			}
		}
	}

	for (const entry of model.nodes) {
		mat4FromTRS(entry.curT, entry.curR, entry.curS, entry.local);
		if (entry.parent === -1) entry.world.set(entry.local);
		else mat4Multiply(model.nodes[entry.parent].world, entry.local, entry.world);
	}
	return model;
}

const jointMatrixScratch = [];

/**
 * Write world-space positions and normals for one primitive into its scratch
 * buffers, applying linear blend skinning when the primitive is rigged.
 */
export function transformPrimitive(model, prim) {
	if (prim.poseStamp === model.poseStamp) return prim;
	prim.poseStamp = model.poseStamp;
	const { positions, normals, outPositions, outNormals } = prim;
	const node = model.nodes[prim.nodeId];
	const count = positions.length / 3;
	const p = [0, 0, 0];
	const nrm = [0, 0, 0];

	if (!prim.joints || !prim.jointNodes) {
		const world = node.world;
		const normalMat = mat4NormalMatrix(world);
		for (let i = 0; i < count; i += 1) {
			const o = i * 3;
			mulPoint(world, positions[o], positions[o + 1], positions[o + 2], p);
			outPositions[o] = p[0]; outPositions[o + 1] = p[1]; outPositions[o + 2] = p[2];
			mulDir(normalMat, normals[o], normals[o + 1], normals[o + 2], nrm);
			normalize(nrm);
			outNormals[o] = nrm[0]; outNormals[o + 1] = nrm[1]; outNormals[o + 2] = nrm[2];
		}
		return prim;
	}

	// glTF defines the skinning matrix as
	//   inverse(meshNodeWorld) * jointWorld * inverseBind
	// and then says the result is transformed by meshNodeWorld again, so the two
	// cancel exactly and the skinned vertex is simply jointWorld * inverseBind * v.
	// Applying the leading inverse WITHOUT re-applying meshNodeWorld afterwards
	// is a real and subtle bug: on a model whose skeleton root carries the
	// Collada Z-up to glTF Y-up rotation (CesiumMan, and every avatar exported
	// through that path) it cancels the up-axis correction and the character
	// renders lying on its back, one third too short. Verified against
	// public/avatars/cesium-man.glb in test/skin.test.js.
	const jointCount = prim.jointNodes.length;
	while (jointMatrixScratch.length < jointCount) jointMatrixScratch.push(new Float64Array(16));

	for (let j = 0; j < jointCount; j += 1) {
		const nodeId = prim.jointNodes[j];
		const jointEntry = nodeId >= 0 ? model.nodes[nodeId] : null;
		const m = jointMatrixScratch[j];
		if (!jointEntry) { mat4Identity(m); continue; }
		m.set(jointEntry.world);
		if (prim.inverseBind) {
			const ibm = prim.inverseBind.subarray(j * 16, j * 16 + 16);
			mat4Multiply(m, ibm, m);
		}
	}

	const acc = new Float64Array(16);
	for (let i = 0; i < count; i += 1) {
		const o = i * 3, w = i * 4;
		acc.fill(0);
		let total = 0;
		for (let k = 0; k < 4; k += 1) {
			const weight = prim.weights[w + k];
			if (!weight) continue;
			const m = jointMatrixScratch[prim.joints[w + k]];
			if (!m) continue;
			for (let e = 0; e < 16; e += 1) acc[e] += m[e] * weight;
			total += weight;
		}
		// A vertex whose weights sum to zero is unrigged (loose hair cards do this).
		// Falling back to the mesh transform keeps it attached instead of collapsing
		// it onto the origin, which reads as a spike through the model.
		const m = total > 1e-6 ? acc : node.world;
		mulPoint(m, positions[o], positions[o + 1], positions[o + 2], p);
		outPositions[o] = p[0]; outPositions[o + 1] = p[1]; outPositions[o + 2] = p[2];
		mulDir(m, normals[o], normals[o + 1], normals[o + 2], nrm);
		normalize(nrm);
		outNormals[o] = nrm[0]; outNormals[o + 1] = nrm[1]; outNormals[o + 2] = nrm[2];
	}
	return prim;
}
