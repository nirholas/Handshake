// @vitest-environment jsdom
/**
 * EmbodimentStage (apps-sdk/embodiment/embodiment-stage.js), the main export of
 * the apps-sdk surface, exercised on its real core paths.
 *
 * Only the four boundaries a headless test genuinely cannot provide are replaced:
 * the WebGL renderer, OrbitControls, the GLTF loader/decoders, and the animation
 * manager (whose clip fetches hit the network). Everything the stage actually
 * decides is the shipped implementation: the rig-mode gate, the emotion
 * classifier, the text-viseme lip-sync envelope, the mouth/face morph binding,
 * and the chain-state → visuals mapping. So an assertion here is an assertion
 * about production behavior, not about a stand-in.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
	/** Per-test GLTFLoader.loadAsync behavior. */
	loadAsync: async () => { throw new Error('no fixture installed'); },
	/** Per-test getDecoders() behavior (the stage degrades to a bare loader if it throws). */
	decoders: async () => { throw new Error('decoders unavailable in test env'); },
	/** The AnimationManager the stage constructed, so tests can read its call log. */
	anim: null,
	/** Whether the rig reports canonical-clip support. */
	canonical: true,
}));

vi.mock('three', async (importOriginal) => {
	const three = await importOriginal();
	// A headless stand-in for the one class that needs a GPU context. Everything
	// else in the scene graph (Group, Box3, Mesh, materials) stays real three.
	class HeadlessWebGLRenderer {
		constructor() {
			this.domElement = document.createElement('canvas');
			this.renderCount = 0;
			this.disposed = false;
		}
		setSize(w, height) { this.size = { w, h: height }; }
		setPixelRatio(r) { this.pixelRatio = r; }
		render() { this.renderCount += 1; }
		dispose() { this.disposed = true; }
	}
	return { ...three, WebGLRenderer: HeadlessWebGLRenderer };
});

vi.mock('three/addons/loaders/GLTFLoader.js', () => ({
	GLTFLoader: class {
		setDRACOLoader() {}
		setKTX2Loader() {}
		setMeshoptDecoder() {}
		loadAsync(url) { return h.loadAsync(url); }
	},
}));

vi.mock('three/addons/controls/OrbitControls.js', () => ({
	OrbitControls: class {
		constructor() {
			this.target = { set: () => {} };
			this.updates = 0;
		}
		update() { this.updates += 1; }
		dispose() { this.disposed = true; }
	},
}));

vi.mock('../src/shared/cinematic-render.js', () => ({
	detectQualityTier: () => 'high',
	applyCinematicDefaults: () => {},
	loadEnvironment: async () => null,
}));

vi.mock('../src/viewer/internal.js', () => ({
	getDecoders: () => h.decoders(),
}));

vi.mock('../src/animation-manager.js', () => ({
	AnimationManager: class {
		constructor() {
			this.calls = { attach: [], defs: [], ensureLoaded: [], play: [], crossfade: [], overlay: [], stopOverlay: 0, update: 0 };
			h.anim = this;
		}
		attach(model, opts) { this.calls.attach.push({ model, opts }); }
		supportsCanonicalClips() { return h.canonical; }
		setAnimationDefs(defs) { this.calls.defs.push(defs); }
		async ensureLoaded(name) { this.calls.ensureLoaded.push(name); return true; }
		async play(name) { this.calls.play.push(name); }
		async crossfadeTo(name) { this.calls.crossfade.push(name); }
		async playOverlay(name, opts) { this.calls.overlay.push({ name, opts }); }
		stopOverlay() { this.calls.stopOverlay += 1; }
		update() { this.calls.update += 1; }
	},
}));

const { EmbodimentStage } = await import('../apps-sdk/embodiment/embodiment-stage.js');
const THREE = await import('three');

// ── fixtures ────────────────────────────────────────────────────────────────

const ARKIT_MORPHS = ['jawOpen', 'mouthSmileLeft', 'mouthSmileRight', 'mouthFunnel', 'browInnerUp', 'eyeBlinkLeft'];

/** A humanoid rig the canonicalizer can map: enough mixamo bones + ARKit face morphs. */
function humanoidModel() {
	const root = new THREE.Group();
	const boneNames = [
		'mixamorig:Hips', 'mixamorig:Spine', 'mixamorig:Head', 'mixamorig:Neck',
		'mixamorig:LeftArm', 'mixamorig:RightArm', 'mixamorig:LeftUpLeg', 'mixamorig:RightUpLeg',
		'mixamorig:LeftFoot', 'mixamorig:RightFoot', 'mixamorig:Jaw',
	];
	const bones = boneNames.map((name) => {
		const bone = new THREE.Bone();
		bone.name = name;
		root.add(bone);
		return bone;
	});

	// A real skinned body: skinIndex/skinWeight attributes and a bound skeleton,
	// so bounding-box framing walks the same path it does on a shipped GLB.
	const geometry = new THREE.BoxGeometry(0.5, 1.7, 0.3);
	const vertices = geometry.attributes.position.count;
	const skinIndex = new Uint16Array(vertices * 4);
	const skinWeight = new Float32Array(vertices * 4);
	for (let i = 0; i < vertices; i += 1) skinWeight[i * 4] = 1;
	geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
	geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4));

	const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial());
	mesh.name = 'Body';
	mesh.morphTargetDictionary = Object.fromEntries(ARKIT_MORPHS.map((n, i) => [n, i]));
	mesh.morphTargetInfluences = new Array(ARKIT_MORPHS.length).fill(0);
	root.add(mesh);
	root.updateMatrixWorld(true);
	mesh.bind(new THREE.Skeleton(bones));
	return root;
}

/** A non-humanoid prop: renderable, but nothing the baked clips could drive. */
function propModel() {
	const root = new THREE.Group();
	const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
	mesh.name = 'Prop';
	root.add(mesh);
	return root;
}

const MANIFEST = [
	{ name: 'idle', url: '/animations/idle.glb' },
	{ name: 'av-waiting', url: '/animations/av-waiting.glb' },
	{ name: 'xbot-sad-pose', url: '/animations/xbot-sad-pose.glb' },
	{ name: 'av-joy', url: '/animations/av-joy.glb' },
	{ name: 'wave', url: '/animations/wave.glb' },
	{ name: 'not-used-by-the-stage', url: '/animations/other.glb' },
];

// ── harness ─────────────────────────────────────────────────────────────────

let container;
let stage;
let clock; // controlled seconds-since-origin, in ms (performance.now units)

/** Advance the animation loop by `n` real rAF frames. */
function frames(n = 1) {
	return new Promise((resolve) => {
		let left = n;
		const step = () => (--left <= 0 ? resolve() : requestAnimationFrame(step));
		requestAnimationFrame(step);
	});
}

beforeEach(() => {
	container = document.createElement('div');
	Object.defineProperty(container, 'clientWidth', { value: 480, configurable: true });
	Object.defineProperty(container, 'clientHeight', { value: 640, configurable: true });
	document.body.appendChild(container);

	clock = 1000;
	vi.spyOn(performance, 'now').mockImplementation(() => clock);

	h.canonical = true;
	h.anim = null;
	h.decoders = async () => { throw new Error('decoders unavailable in test env'); };
	h.loadAsync = async () => ({ scene: humanoidModel() });

	vi.stubGlobal('fetch', vi.fn(async (url) => {
		if (String(url).includes('/animations/manifest.json')) {
			return { ok: true, json: async () => MANIFEST };
		}
		throw new Error(`unexpected fetch: ${url}`);
	}));
});

afterEach(() => {
	stage?.destroy();
	stage = null;
	container.remove();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

// ── tests ───────────────────────────────────────────────────────────────────

describe('EmbodimentStage: mount', () => {
	it('mounts an accessible canvas into the host and starts in the loading state', () => {
		const states = [];
		stage = new EmbodimentStage(container, { onState: (s) => states.push(s) });
		const canvas = container.querySelector('canvas');
		expect(canvas).not.toBeNull();
		expect(canvas.getAttribute('role')).toBe('img');
		expect(canvas.getAttribute('aria-label')).toBe('Interactive 3D agent');
		expect(stage.state).toBe('loading');
		expect(states).toEqual([]);
	});

	it('sizes the renderer to the host box and survives a host callback that throws', async () => {
		stage = new EmbodimentStage(container, { onState: () => { throw new Error('host blew up'); } });
		expect(stage.renderer.size).toEqual({ w: 480, h: 640 });
		expect(() => stage.listening()).not.toThrow();
		await frames(2);
		expect(stage.renderer.renderCount).toBeGreaterThan(0);
	});

	it('paints a solid background when one is requested and stays transparent otherwise', () => {
		stage = new EmbodimentStage(container, { background: '#101018' });
		expect(stage.scene.background).not.toBeNull();
		stage.destroy();
		stage = new EmbodimentStage(container, { background: 'transparent' });
		expect(stage.scene.background).toBeNull();
	});
});

describe('EmbodimentStage: loadPersona', () => {
	it('drives a humanoid rig from the baked clip library', async () => {
		const states = [];
		stage = new EmbodimentStage(container, { onState: (s, d) => states.push([s, d]) });
		const ok = await stage.loadPersona({ glbUrl: 'https://three.ws/avatars/xbot.glb', name: 'Scout', personaId: 'p_1' });

		expect(ok).toBe(true);
		expect(stage.state).toBe('idle');
		expect(states.map(([s]) => s)).toEqual(['loading', 'idle']);

		const [, idleDetail] = states.at(-1);
		expect(idleDetail.name).toBe('Scout');
		expect(idleDetail.rig).toBe('canonical');
		expect(idleDetail.rigReason).toBeTruthy();
		expect(idleDetail.hasMouthMorphs).toBe(true);
		expect(idleDetail.hasFaceMorphs).toBe(true);

		expect(h.anim.calls.attach[0].opts).toEqual({ avatarId: 'p_1', avatarUrl: 'https://three.ws/avatars/xbot.glb' });
		expect(h.anim.calls.play).toContain('idle');
	});

	it('registers only the clips it uses and preloads every base idle before first paint', async () => {
		stage = new EmbodimentStage(container);
		await stage.loadPersona({ glbUrl: 'a.glb', name: 'Scout' });

		const registered = h.anim.calls.defs.at(-1).map((d) => d.name);
		expect(registered).not.toContain('not-used-by-the-stage');
		expect(registered).toContain('idle');
		// A crossfade to an unloaded idle would flash the bind pose, so each one
		// the manifest carries is loaded up front.
		expect(h.anim.calls.ensureLoaded).toEqual(expect.arrayContaining(['idle', 'av-waiting', 'xbot-sad-pose']));
	});

	it('falls back to the alive-idle for a rig the baked clips cannot drive', async () => {
		h.loadAsync = async () => ({ scene: propModel() });
		const states = [];
		stage = new EmbodimentStage(container, { onState: (s, d) => states.push([s, d]) });

		expect(await stage.loadPersona({ glbUrl: 'prop.glb', name: 'Cube' })).toBe(true);
		const [, detail] = states.at(-1);
		expect(detail.rig).toBe('fallback');
		expect(detail.rigReason).toContain('SkinnedMesh');
		expect(h.anim.calls.play).toEqual([]);

		// The body must still move: the root bobs and yaws off the frame clock.
		const before = stage.root.rotation.y;
		clock += 900;
		await frames(2);
		expect(stage.root.rotation.y).not.toBe(before);
	});

	it('honors the live AnimationManager gate even when the bone names look canonical', async () => {
		h.canonical = false;
		stage = new EmbodimentStage(container);
		await stage.loadPersona({ glbUrl: 'a.glb', name: 'Scout' });
		expect(h.anim.calls.play).toEqual([]);
		expect(h.anim.calls.defs).toEqual([]);
	});

	it('surfaces a designed error when the GLB cannot be fetched', async () => {
		h.loadAsync = async () => { throw new Error('404 Not Found'); };
		const states = [];
		stage = new EmbodimentStage(container, { onState: (s, d) => states.push([s, d]) });

		expect(await stage.loadPersona({ glbUrl: 'gone.glb', name: 'Scout' })).toBe(false);
		expect(stage.state).toBe('error');
		const [, detail] = states.at(-1);
		expect(detail.message).toBe('Could not load this avatar.');
		expect(detail.cause).toContain('404 Not Found');
	});

	it('surfaces a designed error when the file carries no renderable scene', async () => {
		h.loadAsync = async () => ({ scenes: [] });
		const states = [];
		stage = new EmbodimentStage(container, { onState: (s, d) => states.push([s, d]) });

		expect(await stage.loadPersona({ glbUrl: 'empty.glb' })).toBe(false);
		expect(states.at(-1)[1].message).toBe('This file has no renderable scene.');
	});

	it('still loads an uncompressed GLB when the decoder modules are unavailable', async () => {
		// h.decoders throws by default, exercising the documented bare-loader degrade.
		stage = new EmbodimentStage(container);
		expect(await stage.loadPersona({ glbUrl: 'a.glb', name: 'Scout' })).toBe(true);
		expect(stage.state).toBe('idle');
	});

	it('wires every decoder when they are available', async () => {
		const wired = [];
		h.decoders = async () => ({
			dracoLoader: { tag: 'draco' },
			ktx2Loader: { tag: 'ktx2', detectSupport: () => wired.push('detectSupport') },
			meshoptDecoder: { tag: 'meshopt' },
		});
		stage = new EmbodimentStage(container);
		expect(await stage.loadPersona({ glbUrl: 'a.glb' })).toBe(true);
		expect(wired).toContain('detectSupport');
	});

	it('swaps bodies without leaking the previous one into the scene', async () => {
		stage = new EmbodimentStage(container);
		await stage.loadPersona({ glbUrl: 'a.glb', name: 'One' });
		const first = stage._model;
		await stage.loadPersona({ glbUrl: 'b.glb', name: 'Two' });
		expect(stage._model).not.toBe(first);
		expect(stage.root.children).not.toContain(first);
	});

	it('keeps rendering when the animation manifest is unreachable', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
		stage = new EmbodimentStage(container);
		expect(await stage.loadPersona({ glbUrl: 'a.glb', name: 'Scout' })).toBe(true);
		expect(stage.state).toBe('idle');
		expect(h.anim.calls.defs).toEqual([]);
	});
});

describe('EmbodimentStage: conversational turns', () => {
	beforeEach(async () => {
		stage = new EmbodimentStage(container);
		await stage.loadPersona({ glbUrl: 'a.glb', name: 'Scout' });
	});

	it('ignores an empty reply instead of entering a speaking state with nothing to say', async () => {
		await stage.speak({ text: '   ' });
		expect(stage.state).toBe('idle');
	});

	it('classifies the reply, gestures, and lip-syncs the actual text', async () => {
		const shapes = [];
		vi.spyOn(stage.mouth, 'setMouthShape').mockImplementation((s) => shapes.push(s));

		let detail = null;
		stage.onState = (s, d) => { if (s === 'speaking') detail = d; };
		await stage.speak({ text: 'I found it, this is amazing!' });

		expect(stage.state).toBe('speaking');
		// Classified by the real emotion module, then expressed as a body gesture
		// layered over the neutral idle so a morph-less rig still emotes.
		expect(detail.emotion).toBe('joy');
		expect(detail.gesture).toBe('av-joy');
		expect(h.anim.calls.crossfade).toContain('idle');
		expect(h.anim.calls.overlay.at(-1)).toMatchObject({ name: 'av-joy', opts: { upperBodyOnly: true } });

		clock += 120;
		await frames(4);
		expect(shapes.some((s) => s.open > 0)).toBe(true);
	});

	it('honors an explicitly requested emotion and gesture over the classifier', async () => {
		let detail = null;
		stage.onState = (s, d) => { if (s === 'speaking') detail = d; };
		await stage.speak({ text: 'Anything at all.', emotion: 'joy', intensity: 0.9, gesture: 'wave' });
		expect(detail.emotion).toBe('joy');
		expect(detail.gesture).toBe('wave');
		expect(h.anim.calls.overlay.at(-1)).toMatchObject({ name: 'wave', opts: { upperBodyOnly: true, loop: false } });
	});

	it('settles back to idle when the line finishes', async () => {
		await stage.speak({ text: 'Short line.' });
		expect(stage.state).toBe('speaking');
		clock += 60_000; // past any clamped envelope duration
		await frames(3);
		expect(stage.state).toBe('idle');
	});

	it('speaks this turn\'s reply through the text lane when audio playback is refused', async () => {
		// A chat panel blocks autoplay routinely; the mouth must not go dead.
		class BlockedAudio {
			constructor() { this.currentTime = 0; this.ended = false; }
			play() { return Promise.reject(new Error('NotAllowedError: autoplay blocked')); }
			pause() {}
			addEventListener() {}
		}
		vi.stubGlobal('Audio', BlockedAudio);
		expect(stage.a2f.hasCoverage()).toBe(true);

		const shapes = [];
		vi.spyOn(stage.mouth, 'setMouthShape').mockImplementation((s) => shapes.push(s));

		await stage.speak({
			text: 'Found you. Walk with me.',
			audioUrl: 'https://three.ws/tts/line.mp3',
			visemeTrack: { fps: 30, blendShapeNames: ['jawOpen'], frames: [{ t: 0, w: [0] }, { t: 0.4, w: [1] }] },
		});

		expect(stage.state).toBe('speaking');
		clock += 120;
		await frames(4);
		expect(shapes.some((s) => s.open > 0)).toBe(true);
	});

	it('samples the viseme track against playback when the audio does start', async () => {
		const played = [];
		class PlayingAudio {
			constructor(url) { this.url = url; this.currentTime = 0.2; this.ended = false; }
			play() { played.push(this.url); return Promise.resolve(); }
			pause() {}
			addEventListener() {}
		}
		vi.stubGlobal('Audio', PlayingAudio);
		const a2fUpdate = vi.spyOn(stage.a2f, 'update');

		await stage.speak({
			text: 'Found you.',
			audioUrl: 'https://three.ws/tts/line.mp3',
			visemeTrack: { fps: 30, blendShapeNames: ['jawOpen'], frames: [{ t: 0, w: [0] }, { t: 0.4, w: [1] }] },
		});

		expect(played).toEqual(['https://three.ws/tts/line.mp3']);
		await frames(2);
		expect(a2fUpdate).toHaveBeenCalledWith(0.2);
	});

	it('shows an attentive listening beat and a thinking beat', () => {
		stage.listening();
		expect(stage.state).toBe('listening');
		stage.thinking();
		expect(stage.state).toBe('thinking');
		expect(h.anim.calls.crossfade).toContain('idle');
	});

	it('never lets a listening or thinking beat cut off a line mid-sentence', async () => {
		await stage.speak({ text: 'Let me finish this sentence.' });
		stage.listening();
		stage.thinking();
		expect(stage.state).toBe('speaking');
	});
});

describe('EmbodimentStage: chain state', () => {
	beforeEach(() => {
		stage = new EmbodimentStage(container);
	});

	it('rings the body with the reputation aura and returns the resolved visuals', () => {
		const visuals = stage.setChainState({
			visual: { reputation_tier: 'eminent', holdings_tier: 'gold', muted: false, verified_name: 'scout.sol' },
		});
		expect(visuals.aura.tier).toBe('eminent');
		expect(visuals.cosmetic.tier).toBe('gold');
		expect(visuals.nameplate).toBe('scout.sol');
		expect(stage._auraRing.visible).toBe(true);
		expect(stage._auraMat.opacity).toBeCloseTo(visuals.aura.intensity, 5);
	});

	it('dims the stage for an unfunded wallet and restores it exactly when funded', () => {
		const base = { ...stage._baseLightIntensity };
		stage.setChainState({ visual: { reputation_tier: 'eminent', holdings_tier: 'none', muted: true } });
		expect(stage.keyLight.intensity).toBeLessThan(base.key);
		expect(stage.keyLight.intensity).toBeGreaterThan(0);

		stage.setChainState({ visual: { reputation_tier: 'eminent', holdings_tier: 'gold', muted: false } });
		expect(stage.keyLight.intensity).toBeCloseTo(base.key, 6);
		expect(stage.ambient.intensity).toBeCloseTo(base.ambient, 6);
		expect(stage.rimLight.intensity).toBeCloseTo(base.rim, 6);
	});

	it('clears back to the undecorated baseline on a failed or absent identity read', () => {
		stage.setChainState({ visual: { reputation_tier: 'eminent', holdings_tier: 'gold' } });
		const visuals = stage.setChainState(null);
		expect(visuals.aura.tier).toBe('unranked');
		expect(visuals.muted).toBe(false);
		expect(stage.keyLight.intensity).toBeCloseTo(stage._baseLightIntensity.key, 6);
	});
});

describe('EmbodimentStage: teardown', () => {
	it('stops the frame loop, drops the canvas, and is safe to call twice', async () => {
		stage = new EmbodimentStage(container);
		await stage.loadPersona({ glbUrl: 'a.glb', name: 'Scout' });
		await frames(2);
		const renderer = stage.renderer;
		expect(renderer.renderCount).toBeGreaterThan(0);

		stage.destroy();
		const settled = renderer.renderCount;
		await frames(3);
		expect(renderer.renderCount).toBe(settled);
		expect(renderer.disposed).toBe(true);
		expect(container.querySelector('canvas')).toBeNull();
		expect(() => stage.destroy()).not.toThrow();
		stage = null;
	});
});
