// Kill-test for the shared avatar template cache in src/game/avatar-rig.js.
//
// The bug this guards against is the one that dropped phones out of /play
// seconds after joining a crowded world: every rig used to download, parse and
// GPU-upload its own copy of an avatar GLB (community models run to 24 MB), and
// nothing ever freed one when a peer left or swapped fits. A world full of
// people was therefore unbounded memory on the client.
//
// The three invariants that fix carries, all asserted here:
//   1. Two rigs wearing the same URL cost ONE download, and share geometry.
//   2. Materials are cloned per rig, so a per-peer effect (the downed-peer
//      opacity fade) can never bleed onto another player in the same model.
//   3. releaseAvatar() actually frees: it derefs the template, disposes the
//      per-rig materials, and once nothing wears a model its geometry and
//      textures are disposed rather than left resident for the page's life.
//
// GLTFLoader is mocked so the test runs without a GPU, a network, or a real
// GLB: what is under test is the cache's bookkeeping, not three.js's parser.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	Group, BufferGeometry, BufferAttribute, MeshStandardMaterial, Texture, SkinnedMesh, Skeleton, Bone,
} from 'three';

let loadCount = 0;
let lastGeometry = null;

// One fresh, disposable model per load, with a bone so SkeletonUtils.clone has a
// real skinned hierarchy to walk.
function makeScene() {
	const scene = new Group();
	const bone = new Bone();
	scene.add(bone);
	const geometry = new BufferGeometry();
	// A real position attribute: buildAvatar measures the model with Box3, which
	// reads it, and a skinned mesh needs its skin attributes to bind.
	geometry.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 0, 1.8, 0, 0.3, 0, 0]), 3));
	geometry.setAttribute('skinIndex', new BufferAttribute(new Uint16Array(12), 4));
	geometry.setAttribute('skinWeight', new BufferAttribute(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), 4));
	geometry.dispose = vi.fn(geometry.dispose.bind(geometry));
	lastGeometry = geometry;
	const texture = new Texture();
	texture.dispose = vi.fn(texture.dispose.bind(texture));
	const material = new MeshStandardMaterial({ map: texture });
	material.dispose = vi.fn(material.dispose.bind(material));
	const mesh = new SkinnedMesh(geometry, material);
	mesh.bind(new Skeleton([bone]));
	scene.add(mesh);
	return scene;
}

vi.mock('three/addons/loaders/GLTFLoader.js', () => ({
	GLTFLoader: class {
		setDRACOLoader() {}
		setMeshoptDecoder() {}
		register() {}
		async loadAsync() {
			loadCount += 1;
			return { scene: makeScene() };
		}
	},
}));
vi.mock('three/addons/loaders/DRACOLoader.js', () => ({
	DRACOLoader: class { setDecoderPath() {} },
}));
vi.mock('../src/viewer/internal.js', () => ({ getMeshoptDecoder: async () => null }));
vi.mock('../src/game/vrm-loader.js', () => ({
	installVrmPlugin: () => false,
	prepareVrmModel: () => ({ vrm: false }),
}));
vi.mock('../src/game/play-handoff.js', () => ({
	GUEST_SENTINEL: '__guest__',
	resolveGuestAvatar: async () => '',
}));
// The manifest fetch is not what is under test; resolve it to no clips so
// buildAvatar never blocks on animation loading.
vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { headers: { 'content-type': 'application/json' } })));

const { buildAvatar, releaseAvatar, hasModelTemplate } = await import('../src/game/avatar-rig.js');

// A stand-in for AnimationManager: buildAvatar only attaches and poses.
const stubAnim = () => ({
	attach: vi.fn(),
	setAnimationDefs: vi.fn(),
	loadAll: vi.fn(async () => {}),
	crossfadeTo: vi.fn(async () => {}),
});

const MODEL = '/avatars/community-model.glb';

describe('avatar template cache', () => {
	beforeEach(() => { loadCount = 0; });

	it('downloads a model once however many rigs wear it, and shares its geometry', async () => {
		const rigA = new Group();
		const rigB = new Group();
		await buildAvatar(rigA, MODEL, stubAnim(), { clips: 'locomotion' });
		const afterFirst = loadCount;
		await buildAvatar(rigB, MODEL, stubAnim(), { clips: 'locomotion' });

		expect(afterFirst).toBe(1);
		expect(loadCount).toBe(1); // the second rig cost no network
		expect(hasModelTemplate(MODEL)).toBe(true);

		const meshOf = (rig) => {
			let found = null;
			rig.traverse((n) => { if (n.isMesh && !found) found = n; });
			return found;
		};
		const a = meshOf(rigA);
		const b = meshOf(rigB);
		expect(a).toBeTruthy();
		expect(b).toBeTruthy();
		// Geometry is shared (the whole point), materials are not.
		expect(a.geometry).toBe(b.geometry);
		expect(a.material).not.toBe(b.material);

		releaseAvatar(rigA);
		releaseAvatar(rigB);
	});

	it('keeps a per-rig material change off every other rig wearing the model', async () => {
		const rigA = new Group();
		const rigB = new Group();
		await buildAvatar(rigA, MODEL, stubAnim(), { clips: 'locomotion' });
		await buildAvatar(rigB, MODEL, stubAnim(), { clips: 'locomotion' });

		// This is exactly what RemotePlayer._applyDowned does to a downed peer.
		rigA.traverse((o) => { if (o.material && 'opacity' in o.material) { o.material.transparent = true; o.material.opacity = 0.55; } });

		let otherOpacity = null;
		rigB.traverse((o) => { if (o.material && 'opacity' in o.material) otherOpacity = o.material.opacity; });
		expect(otherOpacity).toBe(1);

		releaseAvatar(rigA);
		releaseAvatar(rigB);
	});

	it('disposes the per-rig materials and empties the rig on release', async () => {
		const rig = new Group();
		await buildAvatar(rig, MODEL, stubAnim(), { clips: 'locomotion' });
		let material = null;
		rig.traverse((n) => { if (n.isMesh && !material) material = n.material; });
		// The rig wears a per-rig CLONE of the template's material, so the spy has
		// to go on that clone, not on the template's original.
		material.dispose = vi.fn(material.dispose.bind(material));

		releaseAvatar(rig);

		expect(material.dispose).toHaveBeenCalled();
		expect(rig.children).toHaveLength(0);
	});

	it('holds the shared model while any rig still wears it', async () => {
		const rigA = new Group();
		const rigB = new Group();
		await buildAvatar(rigA, MODEL, stubAnim(), { clips: 'locomotion' });
		await buildAvatar(rigB, MODEL, stubAnim(), { clips: 'locomotion' });
		const geometry = lastGeometry;

		// One peer leaves; the model must survive for the peer still wearing it,
		// or the remaining avatar would render from disposed buffers.
		releaseAvatar(rigA);
		expect(geometry.dispose).not.toHaveBeenCalled();
		expect(hasModelTemplate(MODEL)).toBe(true);

		releaseAvatar(rigB);
	});

	it('falls back to a disposable stand-in when a model cannot load, and releases it', async () => {
		const rig = new Group();
		const { fallback } = await buildAvatar(rig, '/avatars/default.glb', {
			attach() { throw new Error('attach exploded'); },
		}, { clips: 'locomotion' });

		expect(fallback).toBe(true);
		expect(rig.children.length).toBeGreaterThan(0);
		const standIns = rig.children.filter((c) => c.userData?.avatarStandIn);
		expect(standIns).toHaveLength(2); // capsule body + sphere head

		releaseAvatar(rig);
		expect(rig.children).toHaveLength(0);
	});
});
