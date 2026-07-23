// Scene-graph composer — merges a forged Diorama (objects + ground + lighting)
// into ONE glTF 2.0 binary using @gltf-transform, so a text-composed world
// exports as a single GLB with every object as a named, selectable node —
// ready to drop into Scene Studio (/scene?model=…) or any other glTF-aware app.
//
// Reuses the same NodeIO + mergeDocuments pattern as api/_lib/bake.js (avatar
// appearance baking), but for a whole scene instead of a rig: each forged
// object's GLB is merged in and re-parented under a named group node at its
// diorama position/rotation/scale (mirroring src/diorama/renderer.js's
// fitGltfScene footprint-normalization so the exported file matches what the
// live diorama shows), plus a real ground disc (tinted per the diorama's
// ground/palette) and a KHR_lights_punctual sun + fill light tuned to the
// diorama's mood. The output needs no viewer-side reconstruction: open it
// anywhere and the world reads the same.
//
// Partial failure is a first-class outcome, not an error path: objects that
// never forged (still 'pending'/'forging') or failed are reported back in
// `skipped` and simply omitted from the graph — the export always returns the
// best real scene it can build from what exists.

import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRLightsPunctual } from '@gltf-transform/extensions';
import { mergeDocuments, prune, dedup, unpartition } from '@gltf-transform/functions';
import * as THREE from 'three';
import { MOOD_LIGHT, ISLAND_RADIUS, normalizeDiorama } from '../../src/diorama/schema.js';
import { fetchSafePublicUrlPinned } from './ssrf-guard.js';

// Matches TARGET_FOOTPRINT in src/diorama/renderer.js — keeps a forged object's
// on-screen size in the exported GLB identical to the live diorama stage.
const TARGET_FOOTPRINT = 1.4;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_SOURCE_GLB_BYTES = 64 * 1024 * 1024;

let _ioPromise = null;
async function sharedIO() {
	if (_ioPromise) return _ioPromise;
	_ioPromise = (async () => {
		const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
		// Forged GLBs are plain (uncompressed) by default, but a saved diorama may
		// reference a caller-requested draco/meshopt variant or a user-uploaded
		// asset — register both decoders so every real-world source reads cleanly.
		try {
			const { MeshoptDecoder, MeshoptEncoder } = await import('meshoptimizer');
			await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready]);
			io.registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
		} catch (err) {
			console.warn('[scene-graph-compose] meshopt dependency unavailable:', err?.message);
		}
		try {
			const d = await import('draco3dgltf');
			const draco3d = d.default ?? d;
			io.registerDependencies({
				'draco3d.decoder': await draco3d.createDecoderModule(),
				'draco3d.encoder': await draco3d.createEncoderModule(),
			});
		} catch (err) {
			console.warn('[scene-graph-compose] draco dependency unavailable:', err?.message);
		}
		return io;
	})();
	return _ioPromise;
}

/**
 * Compose a diorama's forged objects + ground + lighting into one GLB.
 *
 * @param {object} dioramaInput — an untrusted Diorama-shaped object (see
 *   src/diorama/schema.js). Only objects with status:'ready' and a glbUrl are
 *   placed; the rest are reported in `skipped` for a graceful partial export.
 * @returns {Promise<{
 *   bytes: Uint8Array,
 *   exportedCount: number,
 *   totalCount: number,
 *   skipped: {id:string, label:string, reason:string}[],
 * }>}
 */
export async function composeSceneGlb(dioramaInput) {
	const { ok, diorama, errors } = normalizeDiorama(dioramaInput);
	if (!ok) {
		throw Object.assign(new Error(`invalid diorama: ${errors.join(', ')}`), { code: 'invalid_diorama' });
	}

	const ready = diorama.objects.filter((o) => o.status === 'ready' && o.glbUrl);
	const skipped = diorama.objects
		.filter((o) => !(o.status === 'ready' && o.glbUrl))
		.map((o) => ({ id: o.id, label: o.label, reason: o.status === 'failed' ? 'forge_failed' : 'not_forged' }));

	if (ready.length === 0) {
		throw Object.assign(
			new Error('No forged objects to export — every object failed or is still pending.'),
			{ code: 'nothing_to_export' },
		);
	}

	const io = await sharedIO();
	const doc = new Document();
	const buffer = doc.createBuffer('scene');
	const root = doc.getRoot();
	const asset = root.getAsset();
	asset.generator = `${asset.generator || ''} / three.ws diorama scene-composer @gltf-transform`.trim();
	asset.extras = {
		title: diorama.title,
		prompt: diorama.prompt,
		mood: diorama.mood,
		ground: diorama.ground,
		island: diorama.island,
		palette: diorama.palette,
		source: 'https://three.ws/diorama',
		exportedAt: new Date().toISOString(),
	};

	const scene = doc.createScene(diorama.title || 'Diorama');
	root.setDefaultScene(scene);

	scene.addChild(buildGroundNode(doc, buffer, diorama));
	for (const light of buildLightNodes(doc, diorama)) scene.addChild(light);

	const objectsGroup = doc.createNode('Objects');
	scene.addChild(objectsGroup);

	let exportedCount = 0;
	for (const obj of ready) {
		try {
			const objBytes = await fetchGlb(obj.glbUrl);
			const objDoc = await io.readBinary(objBytes);
			const objScene = objDoc.getRoot().getDefaultScene() || objDoc.getRoot().listScenes()[0] || null;
			const rootSources = objScene
				? objScene.listChildren()
				: objDoc.getRoot().listNodes().filter((n) => !n.getParentNode());
			if (!rootSources.length) {
				skipped.push({ id: obj.id, label: obj.label, reason: 'empty_glb' });
				continue;
			}

			const map = mergeDocuments(doc, objDoc);
			const mergedRoots = rootSources.map((n) => map.get(n)).filter(Boolean);
			if (!mergedRoots.length) {
				skipped.push({ id: obj.id, label: obj.label, reason: 'merge_failed' });
				continue;
			}
			// mergeDocuments copies every one of the source's own Scene entries into
			// the target root too. We only want its nodes (already re-parented into
			// `raw` below) — an empty leftover Scene fails glTF validation
			// (EMPTY_ENTITY) and is otherwise dead weight, so drop it right away.
			if (objScene) {
				const mergedScene = map.get(objScene);
				if (mergedScene) mergedScene.dispose();
			}

			const raw = doc.createNode(`${obj.label} (source)`);
			for (const n of mergedRoots) raw.addChild(n);

			const { min, max } = safeBounds(raw);
			const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
			const footprint = Math.max(size[0], size[2]) || Math.max(size[0], size[1], size[2]) || 1;
			const norm = (TARGET_FOOTPRINT / footprint) * (obj.scale || 1);
			const center = [(min[0] + max[0]) / 2, min[1], (min[2] + max[2]) / 2];
			raw.setTranslation([-center[0], -center[1], -center[2]]);

			const wrapper = doc
				.createNode(obj.label || obj.prompt || `Object ${exportedCount + 1}`)
				.setTranslation([obj.position[0], obj.position[1] || 0, obj.position[2]])
				.setRotation(yawQuaternion(obj.rotationY || 0))
				.setScale([norm, norm, norm]);
			wrapper.addChild(raw);
			wrapper.setExtras({ objectId: obj.id, prompt: obj.prompt, sourceGlb: obj.glbUrl });

			objectsGroup.addChild(wrapper);
			exportedCount++;
		} catch (err) {
			console.warn(`[scene-graph-compose] object "${obj.id}" failed to merge:`, err?.message);
			skipped.push({ id: obj.id, label: obj.label, reason: 'fetch_or_merge_error' });
		}
	}

	if (exportedCount === 0) {
		throw Object.assign(new Error('Every forged object failed to merge into the scene.'), {
			code: 'nothing_to_export',
		});
	}

	try {
		await doc.transform(unpartition(), prune(), dedup());
	} catch (err) {
		console.warn('[scene-graph-compose] cleanup transform failed, writing unoptimized:', err?.message);
		await doc.transform(unpartition());
	}

	const bytes = await io.writeBinary(doc);
	return { bytes, exportedCount, totalCount: diorama.objects.length, skipped };
}

// ── Ground ───────────────────────────────────────────────────────────────

function buildGroundNode(doc, buffer, diorama) {
	const segments = 48;
	const radius = ISLAND_RADIUS;
	const vertCount = segments + 2;
	const positions = new Float32Array(vertCount * 3);
	const normals = new Float32Array(vertCount * 3);
	const uvs = new Float32Array(vertCount * 2);

	normals[1] = 1;
	uvs[0] = 0.5;
	uvs[1] = 0.5;
	for (let i = 0; i <= segments; i++) {
		const a = (i / segments) * Math.PI * 2;
		const x = Math.cos(a) * radius;
		const z = Math.sin(a) * radius;
		const vi = (i + 1) * 3;
		positions[vi] = x;
		positions[vi + 1] = 0;
		positions[vi + 2] = z;
		normals[vi + 1] = 1;
		const ui = (i + 1) * 2;
		uvs[ui] = 0.5 + Math.cos(a) * 0.5;
		uvs[ui + 1] = 0.5 + Math.sin(a) * 0.5;
	}
	const indices = new Uint16Array(segments * 3);
	for (let i = 0; i < segments; i++) {
		indices[i * 3] = 0;
		indices[i * 3 + 1] = i + 1;
		indices[i * 3 + 2] = i + 2;
	}

	const position = doc.createAccessor('ground-position').setType('VEC3').setArray(positions).setBuffer(buffer);
	const normal = doc.createAccessor('ground-normal').setType('VEC3').setArray(normals).setBuffer(buffer);
	const uv = doc.createAccessor('ground-uv').setType('VEC2').setArray(uvs).setBuffer(buffer);
	const index = doc.createAccessor('ground-index').setType('SCALAR').setArray(indices).setBuffer(buffer);

	const rgb = hexToLinearRgb(diorama.palette.ground) || [0.5, 0.6, 0.4];
	const material = doc
		.createMaterial('Ground')
		.setBaseColorFactor([rgb[0], rgb[1], rgb[2], 1])
		.setRoughnessFactor(diorama.ground === 'water' ? 0.15 : diorama.ground === 'snow' ? 0.7 : 0.95)
		.setMetallicFactor(0);

	const primitive = doc
		.createPrimitive()
		.setAttribute('POSITION', position)
		.setAttribute('NORMAL', normal)
		.setAttribute('TEXCOORD_0', uv)
		.setIndices(index)
		.setMaterial(material);

	const mesh = doc.createMesh('Ground').addPrimitive(primitive);
	return doc.createNode('Ground').setMesh(mesh);
}

// ── Lighting ─────────────────────────────────────────────────────────────

function buildLightNodes(doc, diorama) {
	const ext = doc.createExtension(KHRLightsPunctual);
	const moodKey = MOOD_LIGHT[diorama.mood] ? diorama.mood : 'day';
	const ml = MOOD_LIGHT[moodKey];
	const accent = hexToLinearRgb(diorama.palette.accent) || [1, 0.9, 0.7];
	const white = [1, 1, 1];

	const elev = clamp(ml.sunElevation, -0.2, 1) * (Math.PI / 2);
	const az = Math.PI * 0.25;
	const dist = 14;
	const sunPos = [Math.cos(elev) * Math.cos(az) * dist, Math.max(3, Math.sin(elev) * dist + 6), Math.cos(elev) * Math.sin(az) * dist];

	const sun = ext
		.createLight('Sun')
		.setType('directional')
		.setIntensity(Math.max(0.4, ml.sunIntensity) * 2.5)
		.setColor(lerpRgb(white, accent, 0.35));
	const sunNode = doc
		.createNode('Sun')
		.setExtension('KHR_lights_punctual', sun)
		.setTranslation(sunPos)
		.setRotation(directionQuaternion(sunPos));

	const fill = ext
		.createLight('Fill Light')
		.setType('point')
		.setIntensity(Math.max(0.15, ml.ambient) * 6)
		.setColor(accent)
		.setRange(ISLAND_RADIUS * 3.2);
	const fillNode = doc
		.createNode('Fill Light')
		.setExtension('KHR_lights_punctual', fill)
		.setTranslation([-ISLAND_RADIUS * 0.6, 3, ISLAND_RADIUS * 0.6]);

	return [sunNode, fillNode];
}

// ── Fetch ────────────────────────────────────────────────────────────────

async function fetchGlb(url) {
	if (!/^https?:\/\//i.test(url)) {
		throw new Error(`refusing non-http glbUrl: ${url}`);
	}
	// glbUrl is caller-controlled (diorama objects arrive in the POST body, and
	// the same surface is reachable via the export_scene MCP tool), so the fetch
	// goes through the pinned SSRF guard: full DNS validation, IP pinned at
	// connect, every redirect hop re-validated. Otherwise a crafted diorama
	// turns the export endpoint into a blind SSRF from the Cloud Run network.
	const res = await fetchSafePublicUrlPinned(
		url,
		{ signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
		{ maxBytes: MAX_SOURCE_GLB_BYTES },
	);
	if (!res.ok) throw new Error(`GLB fetch failed: HTTP ${res.status}`);
	return new Uint8Array(await res.arrayBuffer());
}

// ── Math helpers ─────────────────────────────────────────────────────────

function yawQuaternion(rotationY) {
	const half = rotationY / 2;
	return [0, Math.sin(half), 0, Math.cos(half)];
}

// Orients a node so its local -Z axis (the KHR_lights_punctual directional
// convention) points from `pos` toward the scene origin.
function directionQuaternion(pos) {
	const from = new THREE.Vector3(0, 0, -1);
	const to = new THREE.Vector3(-pos[0], -pos[1], -pos[2]).normalize();
	const q = new THREE.Quaternion().setFromUnitVectors(from, to);
	return [q.x, q.y, q.z, q.w];
}

function safeBounds(node) {
	// getBounds walks meshes only; a node with non-mesh children (e.g. an
	// avatar's skeleton-only subtree) can legitimately report an empty box.
	// Fall back to a unit cube around the origin so normalization never divides
	// by zero for a pathological source GLB.
	try {
		const box = new THREE.Box3();
		accumulateBounds(node, new THREE.Matrix4(), box);
		if (box.isEmpty()) throw new Error('empty bounds');
		return { min: [box.min.x, box.min.y, box.min.z], max: [box.max.x, box.max.y, box.max.z] };
	} catch {
		return { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] };
	}
}

// Minimal recursive AABB accumulation over a gltf-transform Node's mesh
// primitives, purely from POSITION accessor bounds — avoids pulling the full
// `getBounds` world-space machinery (which expects a Document attached to a
// Scene) for a node we're deliberately keeping detached during normalization.
function accumulateBounds(node, matrix, box) {
	const t = node.getTranslation();
	const r = node.getRotation();
	const s = node.getScale();
	const local = new THREE.Matrix4().compose(
		new THREE.Vector3(...t),
		new THREE.Quaternion(...r),
		new THREE.Vector3(...s),
	);
	const world = matrix.clone().multiply(local);

	const mesh = node.getMesh();
	if (mesh) {
		for (const prim of mesh.listPrimitives()) {
			const pos = prim.getAttribute('POSITION');
			if (!pos) continue;
			const arr = pos.getArray();
			const v = new THREE.Vector3();
			for (let i = 0; i < arr.length; i += 3) {
				v.set(arr[i], arr[i + 1], arr[i + 2]).applyMatrix4(world);
				box.expandByPoint(v);
			}
		}
	}
	for (const child of node.listChildren()) accumulateBounds(child, world, box);
}

function hexToLinearRgb(hex) {
	if (typeof hex !== 'string' || !/^#[0-9a-f]{6}$/i.test(hex)) return null;
	const n = parseInt(hex.slice(1), 16);
	return [srgbToLinear(((n >> 16) & 0xff) / 255), srgbToLinear(((n >> 8) & 0xff) / 255), srgbToLinear((n & 0xff) / 255)];
}

function srgbToLinear(c) {
	return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function lerpRgb(a, b, t) {
	return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function clamp(v, lo, hi) {
	return Math.min(hi, Math.max(lo, v));
}
