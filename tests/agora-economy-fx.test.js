// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as THREE from 'three';

// The deliverable loader is the one piece of EconomyFx that reaches the network.
// We drive it directly so the completion moment (coin flow, reward label, rep
// tick, plinth model, and above all the DISPOSAL of a retired model) is
// verifiable without a live GLB fetch. The models handed back are real
// THREE.Object3D graphs, so the disposal assertions exercise the real traversal.
const loadCalls = [];
vi.mock('three/addons/loaders/GLTFLoader.js', () => ({
	GLTFLoader: class {
		setDRACOLoader() {}
		setMeshoptDecoder() {}
		loadAsync(url) {
			let resolve;
			const promise = new Promise((r) => { resolve = r; });
			loadCalls.push({ url, resolve });
			return promise;
		}
	},
}));
vi.mock('../src/game/avatar-rig.js', () => ({
	dracoLoader: {},
	meshoptReady: Promise.resolve(null),
}));

const { EconomyFx } = await import('../src/agora/economy-fx.js');

// A loaded deliverable: one mesh with a geometry, material and a texture map,
// i.e. every handle EconomyFx is responsible for releasing.
function fakeGltf(name) {
	const geometry = new THREE.BoxGeometry(1, 1, 1);
	const map = new THREE.Texture();
	const material = new THREE.MeshStandardMaterial({ map });
	const mesh = new THREE.Mesh(geometry, material);
	mesh.name = name;
	const scene = new THREE.Group();
	scene.add(mesh);
	return {
		gltf: { scene },
		spies: {
			geometry: vi.spyOn(geometry, 'dispose'),
			material: vi.spyOn(material, 'dispose'),
			map: vi.spyOn(map, 'dispose'),
		},
	};
}

// showDeliverable awaits the meshopt decoder before it reaches loadAsync, so the
// pending load only appears after the microtask queue drains.
const tick = () => new Promise((r) => setTimeout(r, 0));

function makeFx(overrides = {}) {
	const scene = new THREE.Scene();
	const root = document.createElement('div');
	document.body.appendChild(root);
	const fx = new EconomyFx({
		scene, root,
		worldToScreen: () => ({ x: 10, y: 10, visible: true }),
		reducedMotion: false,
		focusOn: vi.fn(),
		boardPosition: new THREE.Vector3(0, 0, -6),
		...overrides,
	});
	return { fx, scene, root };
}

beforeEach(() => {
	loadCalls.length = 0;
	document.body.innerHTML = '';
});

describe('EconomyFx deliverable plinth', () => {
	it('mounts a loaded GLB on the plinth and lights it', async () => {
		const { fx } = makeFx();
		const p = fx.showDeliverable('https://cdn.test/model.glb');
		await tick();
		const { gltf } = fakeGltf('a');
		loadCalls[0].resolve(gltf);
		await p;

		expect(fx._plinthModelHolder.children).toHaveLength(1);
		expect(fx._spotLight.intensity).toBeGreaterThan(0);
	});

	it('disposes the loser when two deliverables load concurrently', async () => {
		// Two completions land back-to-back; both loads are already in flight. Only
		// the newest may mount, and the other must be released, or it stays
		// parented to the plinth, invisible to every later retire, and leaks.
		const { fx } = makeFx();
		const first = fx.showDeliverable('https://cdn.test/first.glb');
		const second = fx.showDeliverable('https://cdn.test/second.glb');
		await tick();
		expect(loadCalls).toHaveLength(2);

		const a = fakeGltf('first');
		const b = fakeGltf('second');
		// The second request resolves first, then the stale first arrives late.
		loadCalls[1].resolve(b.gltf);
		await second;
		loadCalls[0].resolve(a.gltf);
		await first;

		expect(fx._plinthModelHolder.children).toHaveLength(1);
		expect(fx._plinthModelHolder.children[0].children[0].name).toBe('second');
		expect(a.spies.geometry).toHaveBeenCalled();
		expect(a.spies.material).toHaveBeenCalled();
		expect(a.spies.map).toHaveBeenCalled();
		expect(b.spies.geometry).not.toHaveBeenCalled();
	});

	it('disposes the previous deliverable when a new one replaces it', async () => {
		const { fx } = makeFx();
		const p1 = fx.showDeliverable('https://cdn.test/one.glb');
		await tick();
		const a = fakeGltf('one');
		loadCalls[0].resolve(a.gltf);
		await p1;

		const p2 = fx.showDeliverable('https://cdn.test/two.glb');
		await tick();
		const b = fakeGltf('two');
		loadCalls[1].resolve(b.gltf);
		await p2;

		expect(a.spies.geometry).toHaveBeenCalled();
		expect(fx._plinthModelHolder.children).toHaveLength(1);
		expect(b.spies.geometry).not.toHaveBeenCalled();
	});

	it('drops a load that arrives after dispose instead of resurrecting the plinth', async () => {
		const { fx } = makeFx();
		const p = fx.showDeliverable('https://cdn.test/late.glb');
		await tick();
		fx.dispose();
		const late = fakeGltf('late');
		loadCalls[0].resolve(late.gltf);
		await p;

		expect(fx._plinthModelHolder.children).toHaveLength(0);
		expect(late.spies.geometry).toHaveBeenCalled();
	});

	it('ignores a non-GLB deliverable without touching the plinth', async () => {
		const { fx } = makeFx();
		await expect(fx.showDeliverable('https://cdn.test/report.pdf')).resolves.toBe(false);
		expect(loadCalls).toHaveLength(0);
	});
});

describe('EconomyFx completion moment', () => {
	it('waits for the payout instead of flying an unlabelled arc', () => {
		// The labour engine's `completed_task` carries the deliverable and the rep
		// move but no amount; the paired `earned` carries the label. A completion
		// on its own must not throw coins with nothing written on them.
		const { fx, scene, root } = makeFx();
		const before = scene.children.length;
		fx.onCompletion({
			workerPos: new THREE.Vector3(3, 0, 2),
			rewardLabel: null,
			narrative: 'Sol wrote a 1,600-char brief and proved it; reputation 5400 → 5500.',
		});

		expect(scene.children.length).toBe(before);
		const labels = [...root.querySelectorAll('.agora-econ-float')].map((el) => el.textContent);
		expect(labels.some((t) => t.includes('rep 5400 → 5500'))).toBe(true);
		expect(labels.some((t) => t.startsWith('+'))).toBe(false);
	});

	it('flows coins with the amount when the payout lands', () => {
		const { fx, scene, root } = makeFx();
		const before = scene.children.length;
		fx.onPayout({ workerPos: new THREE.Vector3(3, 0, 2), rewardLabel: '0.001 SOL · devnet' });

		expect(scene.children.length).toBeGreaterThan(before);
		const labels = [...root.querySelectorAll('.agora-econ-float')].map((el) => el.textContent);
		expect(labels).toContain('+0.001 SOL · devnet');
	});

	it('lands a payout on the plinth when the earner is not in the crowd', () => {
		const { fx, scene } = makeFx();
		const before = scene.children.length;
		fx.onPayout({ workerPos: null, rewardLabel: '5 $THREE' });
		expect(scene.children.length).toBeGreaterThan(before);
	});

	it('flows coins to the worker and floats the real reward label', () => {
		const { fx, scene, root } = makeFx();
		const before = scene.children.length;
		fx.onCompletion({
			workerPos: new THREE.Vector3(3, 0, 2),
			rewardLabel: '25,000 $THREE',
			narrative: 'Vector Smith completed a Sculptor job; reputation 14 → 19.',
		});

		expect(scene.children.length).toBeGreaterThan(before); // coins in flight
		const labels = [...root.querySelectorAll('.agora-econ-float')].map((el) => el.textContent);
		expect(labels).toContain('+25,000 $THREE');
		// The rep tick reads the delta out of the engine's real narrative wording.
		expect(labels.some((t) => t.includes('rep 14 → 19'))).toBe(true);
	});

	it('never invents a reputation move the narrative does not carry', () => {
		const { fx, root } = makeFx();
		fx.onCompletion({
			workerPos: new THREE.Vector3(1, 0, 1),
			rewardLabel: '5 $THREE',
			narrative: 'Vector Smith earned 5 $THREE.',
		});
		const labels = [...root.querySelectorAll('.agora-econ-float')].map((el) => el.textContent);
		expect(labels.some((t) => t.includes('rep'))).toBe(false);
	});

	it('swaps the coin flight for a calm paid pulse under reduced motion', () => {
		const { fx, scene, root } = makeFx({ reducedMotion: true });
		const before = scene.children.length;
		fx.onPayout({ workerPos: new THREE.Vector3(2, 0, 2), rewardLabel: '9 $THREE' });

		expect(scene.children.length).toBe(before); // no coin meshes added
		const labels = [...root.querySelectorAll('.agora-econ-float')].map((el) => el.textContent);
		expect(labels).toContain('$THREE paid');
	});

	it('retires coins and labels so a long session does not accumulate them', () => {
		const { fx, scene, root } = makeFx();
		const before = scene.children.length;
		fx.onPayout({ workerPos: new THREE.Vector3(1, 0, 1), rewardLabel: '1 $THREE' });
		// Run past the coin flight and the label TTL.
		for (let i = 0; i < 200; i++) fx.update(1 / 60);

		expect(scene.children.length).toBe(before);
		expect(root.querySelectorAll('.agora-econ-float')).toHaveLength(0);
	});

	it('dispose() removes the plinth group and releases its geometry', () => {
		const { fx, scene } = makeFx();
		const spy = vi.spyOn(fx._plinthDisposables[0], 'dispose');
		fx.dispose();
		expect(spy).toHaveBeenCalled();
		expect(scene.children).not.toContain(fx._plinthGroup);
	});
});
