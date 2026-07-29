// P3.4 — VRM support in /play.
//
// A VRM file IS a glTF binary, so our existing GLTFLoader parses one already;
// what it does not do on its own is fix VRM 0.x's -Z facing, VRM skinned-mesh
// frustum culling, or MToon's double-sided hair/cloth planes. These tests lock
// the detection (off raw bytes and off a parsed result) and those three fixes,
// plus the integration seam the reference implementation plugs into.

import { describe, it, expect, beforeEach } from 'vitest';
import { Group, Mesh, SkinnedMesh, BoxGeometry, MeshStandardMaterial, DoubleSide, FrontSide } from 'three';
import {
	readGlbJson, vrmVersionOfJson, vrmVersionOfBuffer, vrmVersionOfGltf,
	prepareVrmModel, isVrmUrl, measureModel,
	setVrmPluginFactory, hasVrmPlugin, installVrmPlugin,
	VRM_EXT_0, VRM_EXT_1,
} from '../src/game/vrm-loader.js';

// Build a minimal but REAL GLB container around a glTF JSON chunk, exactly the
// way a .vrm file is laid out on disk (12-byte header + JSON chunk).
function makeGlb(json) {
	const text = new TextEncoder().encode(JSON.stringify(json));
	const pad = (4 - (text.length % 4)) % 4;
	const jsonLen = text.length + pad;
	const total = 12 + 8 + jsonLen;
	const buf = new ArrayBuffer(total);
	const view = new DataView(buf);
	view.setUint32(0, 0x46546c67, true); // 'glTF'
	view.setUint32(4, 2, true);          // version
	view.setUint32(8, total, true);
	view.setUint32(12, jsonLen, true);
	view.setUint32(16, 0x4e4f534a, true); // 'JSON'
	new Uint8Array(buf, 20, text.length).set(text);
	new Uint8Array(buf, 20 + text.length, pad).fill(0x20); // spaces, per spec
	return buf;
}

describe('VRM detection', () => {
	it('reads the glTF JSON chunk out of a real GLB container', () => {
		const json = { asset: { version: '2.0' }, extensionsUsed: ['KHR_materials_unlit'] };
		expect(readGlbJson(makeGlb(json))).toEqual(json);
	});

	it('returns null for bytes that are not a GLB', () => {
		expect(readGlbJson(new ArrayBuffer(8))).toBeNull();
		expect(readGlbJson(new TextEncoder().encode('not a glb at all, really').buffer)).toBeNull();
	});

	it('detects VRM 0.x from the extension key or the used list', () => {
		expect(vrmVersionOfJson({ extensions: { [VRM_EXT_0]: {} } })).toBe(0);
		expect(vrmVersionOfJson({ extensionsUsed: [VRM_EXT_0] })).toBe(0);
	});

	it('detects VRM 1.0 and prefers it over a 0.x compatibility key', () => {
		expect(vrmVersionOfJson({ extensions: { [VRM_EXT_1]: {} } })).toBe(1);
		expect(vrmVersionOfJson({ extensionsUsed: [VRM_EXT_0, VRM_EXT_1] })).toBe(1);
	});

	it('reports null for a plain glTF', () => {
		expect(vrmVersionOfJson({ asset: { version: '2.0' } })).toBeNull();
		expect(vrmVersionOfJson(null)).toBeNull();
	});

	it('detects straight off the file bytes', () => {
		expect(vrmVersionOfBuffer(makeGlb({ extensionsUsed: [VRM_EXT_0] }))).toBe(0);
		expect(vrmVersionOfBuffer(makeGlb({ extensionsUsed: [VRM_EXT_1] }))).toBe(1);
		expect(vrmVersionOfBuffer(makeGlb({ asset: { version: '2.0' } }))).toBeNull();
	});

	it('detects off a parsed GLTFLoader result', () => {
		expect(vrmVersionOfGltf({ parser: { json: { extensionsUsed: [VRM_EXT_0] } } })).toBe(0);
		expect(vrmVersionOfGltf({ userData: { vrm: { meta: { metaVersion: '1' } } } })).toBe(1);
		expect(vrmVersionOfGltf({ parser: { json: {} } })).toBeNull();
	});

	it('recognises a .vrm url with a query or hash after it', () => {
		expect(isVrmUrl('https://three.ws/a.vrm')).toBe(true);
		expect(isVrmUrl('https://three.ws/a.VRM?v=2')).toBe(true);
		expect(isVrmUrl('https://three.ws/a.glb')).toBe(false);
		expect(isVrmUrl(null)).toBe(false);
	});
});

function fakeGltf(version, { skinned = true, transparent = true } = {}) {
	const scene = new Group();
	const material = new MeshStandardMaterial({ transparent });
	material.side = FrontSide;
	const mesh = skinned
		? new SkinnedMesh(new BoxGeometry(1, 1, 1), material)
		: new Mesh(new BoxGeometry(1, 1, 1), material);
	scene.add(mesh);
	const json = version === 0
		? { extensionsUsed: [VRM_EXT_0] }
		: version === 1 ? { extensionsUsed: [VRM_EXT_1] } : { asset: { version: '2.0' } };
	return { scene, parser: { json }, mesh, material };
}

describe('prepareVrmModel', () => {
	beforeEach(() => setVrmPluginFactory(null));

	it('is a no-op for a plain glTF', () => {
		const gltf = fakeGltf(null);
		const before = gltf.scene.rotation.y;
		expect(prepareVrmModel(gltf)).toEqual({ vrm: false, version: null, plugin: false });
		expect(gltf.scene.rotation.y).toBe(before);
		expect(gltf.mesh.frustumCulled).toBe(true);
	});

	it('turns a VRM 0.x model around so it faces the same way as every other avatar', () => {
		const gltf = fakeGltf(0);
		const res = prepareVrmModel(gltf);
		expect(res).toMatchObject({ vrm: true, version: 0 });
		expect(gltf.scene.rotation.y).toBeCloseTo(Math.PI, 6);
	});

	it('leaves a VRM 1.0 model facing forward already', () => {
		const gltf = fakeGltf(1);
		expect(prepareVrmModel(gltf)).toMatchObject({ vrm: true, version: 1 });
		expect(gltf.scene.rotation.y).toBe(0);
	});

	it('opts VRM skinned meshes out of frustum culling so limbs stop flickering', () => {
		const gltf = fakeGltf(1);
		prepareVrmModel(gltf);
		expect(gltf.mesh.frustumCulled).toBe(false);
	});

	it('makes transparent MToon-style planes double-sided so hair is not full of holes', () => {
		const gltf = fakeGltf(1, { transparent: true });
		prepareVrmModel(gltf);
		expect(gltf.material.side).toBe(DoubleSide);
	});

	it('leaves opaque materials one-sided', () => {
		const gltf = fakeGltf(1, { transparent: false });
		prepareVrmModel(gltf);
		expect(gltf.material.side).toBe(FrontSide);
	});

	it('hands VRM 0.x rotation to the reference implementation when one is installed', () => {
		const rotated = [];
		setVrmPluginFactory(() => ({}), { VRMUtils: { rotateVRM0: (v) => rotated.push(v), combineSkeletons: () => {} } });
		const gltf = fakeGltf(0);
		gltf.userData = { vrm: { meta: {} } };
		const res = prepareVrmModel(gltf);
		expect(res.plugin).toBe(true);
		expect(rotated).toHaveLength(1);
		// The library owns the rotation now: we must not double-apply it.
		expect(gltf.scene.rotation.y).toBe(0);
	});
});

describe('the @pixiv/three-vrm integration seam', () => {
	beforeEach(() => setVrmPluginFactory(null));

	it('reports honestly that no reference implementation is wired', () => {
		expect(hasVrmPlugin()).toBe(false);
		const loader = { registered: [], register(fn) { this.registered.push(fn); } };
		expect(installVrmPlugin(loader)).toBe(false);
		expect(loader.registered).toHaveLength(0);
	});

	it('registers the plugin on a loader exactly once', () => {
		setVrmPluginFactory((parser) => ({ parser }));
		const loader = { registered: [], register(fn) { this.registered.push(fn); } };
		expect(installVrmPlugin(loader)).toBe(true);
		expect(installVrmPlugin(loader)).toBe(true);
		expect(loader.registered).toHaveLength(1);
		expect(hasVrmPlugin()).toBe(true);
	});
});

describe('measureModel', () => {
	it('reports height and largest extent', () => {
		const g = new Group();
		g.add(new Mesh(new BoxGeometry(2, 4, 1), new MeshStandardMaterial()));
		const { height, extent } = measureModel(g);
		expect(height).toBeCloseTo(4, 5);
		expect(extent).toBeCloseTo(4, 5);
	});
});
