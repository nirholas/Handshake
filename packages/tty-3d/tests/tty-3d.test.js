// Coverage for @three-ws/tty-3d, the terminal 3D renderer core.
//
// The fixtures are the two Khronos sample models this repo already ships:
// cesium-man (one skinned mesh, one walk clip, a skeleton root carrying the
// Collada Z-up to glTF Y-up rotation) and brainstem (many primitives, many
// materials, deep node hierarchy). Between them they cover every path in the
// loader that a real avatar exercises.
//
// Three of these tests exist because the bug they describe actually shipped
// during development and was only caught by rendering a frame and looking at
// it. They are here so it cannot come back silently.

import { describe, it, expect, beforeAll } from 'vitest';
import { resolve } from 'node:path';
import {
	loadModel,
	createRenderer,
	describeModel,
	selectAnimation,
	ColorMode,
	detectColorMode,
	toAnsi256,
	ansi,
} from '../src/index.js';
import { poseModel, transformPrimitive, sampleChannel } from '../src/model.js';
import { computeFraming, poseBounds } from '../src/raster.js';
import { mat4Identity, mat4Multiply, mat4FromTRS, mat4Invert, slerp } from '../src/math.js';
import { framebufferToText } from '../src/term.js';
import { createFramebuffer } from '../src/raster.js';

const root = resolve(import.meta.dirname, '../../..');
const CESIUM = resolve(root, 'public/avatars/cesium-man.glb');
const BRAINSTEM = resolve(root, 'public/avatars/brainstem.glb');

let cesium;
let brainstem;

beforeAll(async () => {
	cesium = await loadModel(CESIUM);
	brainstem = await loadModel(BRAINSTEM);
}, 60_000);

describe('math', () => {
	it('inverts a translate/rotate/scale matrix to within float precision', () => {
		const m = mat4FromTRS([1, 2, 3], [0, 0.3826834, 0, 0.9238795], [2, 2, 2]);
		const id = mat4Multiply(m, mat4Invert(m));
		const identity = mat4Identity();
		for (let i = 0; i < 16; i += 1) expect(id[i]).toBeCloseTo(identity[i], 12);
	});

	it('returns identity rather than NaN for a degenerate matrix', () => {
		// Zero scale on an axis is legal glTF and appears on hidden helper nodes.
		const flat = mat4FromTRS([0, 0, 0], [0, 0, 0, 1], [1, 0, 1]);
		expect(Array.from(mat4Invert(flat))).toEqual(Array.from(mat4Identity()));
	});

	it('multiplies correctly when the output aliases an input', () => {
		// REGRESSION: mat4Multiply(m, ibm, m) used to write into m while still
		// reading m's earlier columns, producing a sheared joint matrix. On screen
		// that was spikes radiating out of every joint.
		const a = mat4FromTRS([1, 2, 3], [0, 0.3826834, 0, 0.9238795], [1.5, 1.5, 1.5]);
		const b = mat4FromTRS([-2, 0.5, 4], [0.7071, 0, 0, 0.7071], [1, 2, 1]);
		const expected = mat4Multiply(a, b);
		const aliased = Float64Array.from(a);
		mat4Multiply(aliased, b, aliased);
		for (let i = 0; i < 16; i += 1) expect(aliased[i]).toBeCloseTo(expected[i], 12);
	});

	it('slerps along the shortest arc and stays normalized', () => {
		const q = slerp([0, 0, 0, 1], [0, 0.7071068, 0, 0.7071068], 0.5);
		expect(Math.hypot(q[0], q[1], q[2], q[3])).toBeCloseTo(1, 10);
		expect(q[1]).toBeCloseTo(0.3826834, 5);
	});
});

describe('loading', () => {
	it('reads a skinned, animated model', () => {
		const info = describeModel(cesium);
		expect(info.skinned).toBe(true);
		expect(info.triangles).toBeGreaterThan(1000);
		expect(info.animations.length).toBeGreaterThan(0);
		expect(info.animations[0].duration).toBeGreaterThan(0);
	});

	it('reads a multi-material model with a deep hierarchy', () => {
		const info = describeModel(brainstem);
		expect(info.primitives).toBeGreaterThan(1);
		expect(info.nodes).toBeGreaterThan(10);
	});

	it('rejects a source that is neither a path, a URL, nor bytes', async () => {
		await expect(loadModel(42)).rejects.toThrow(/path, a URL, or bytes/);
	});
});

describe('animation sampling', () => {
	it('clamps below the first and above the last key', () => {
		const channel = {
			path: 'translation',
			interpolation: 'LINEAR',
			times: new Float32Array([1, 2]),
			values: new Float32Array([0, 0, 0, 10, 0, 0]),
		};
		expect(Array.from(sampleChannel(channel, -5, new Float64Array(3)))).toEqual([0, 0, 0]);
		expect(Array.from(sampleChannel(channel, 99, new Float64Array(3)))).toEqual([10, 0, 0]);
		expect(sampleChannel(channel, 1.5, new Float64Array(3))[0]).toBeCloseTo(5, 6);
	});

	it('holds the previous key for STEP interpolation', () => {
		const channel = {
			path: 'translation',
			interpolation: 'STEP',
			times: new Float32Array([0, 1]),
			values: new Float32Array([0, 0, 0, 10, 0, 0]),
		};
		expect(sampleChannel(channel, 0.9, new Float64Array(3))[0]).toBe(0);
	});

	it('reads the value triple, not the tangents, for CUBICSPLINE', () => {
		// CUBICSPLINE stores [inTangent, value, outTangent] per key. Reading it as
		// if it were LINEAR picks up a tangent as a position and throws the limb
		// across the screen.
		const channel = {
			path: 'translation',
			interpolation: 'CUBICSPLINE',
			times: new Float32Array([0, 1]),
			values: new Float32Array([
				99, 99, 99, 0, 0, 0, 99, 99, 99,
				99, 99, 99, 10, 0, 0, 99, 99, 99,
			]),
		};
		expect(sampleChannel(channel, 0, new Float64Array(3))[0]).toBe(0);
		expect(sampleChannel(channel, 1, new Float64Array(3))[0]).toBe(10);
	});
});

describe('skinning', () => {
	it('produces finite vertices for every frame of a real walk cycle', () => {
		const clip = cesium.animations[0];
		for (let i = 0; i < 8; i += 1) {
			poseModel(cesium, clip, (clip.duration * i) / 8);
			for (const prim of cesium.primitives) {
				const out = transformPrimitive(cesium, prim).outPositions;
				expect(out.every(Number.isFinite)).toBe(true);
			}
		}
	});

	it('keeps a humanoid upright and human-proportioned', () => {
		// REGRESSION: applying inverse(meshNodeWorld) without re-applying
		// meshNodeWorld cancelled the skeleton's Z-up correction and laid the
		// character on its back. Height must dominate both horizontal extents.
		poseModel(cesium, null, 0);
		const b = poseBounds(cesium);
		const height = b.max[1] - b.min[1];
		expect(height).toBeGreaterThan(b.max[0] - b.min[0]);
		expect(height).toBeGreaterThan(b.max[2] - b.min[2]);
	});

	it('does not shift joint indices when a joint cannot be resolved', () => {
		// REGRESSION: filtering unresolvable joints out of the joint list renumbered
		// every joint after the hole, rigging vertices to the wrong bones.
		const skinned = cesium.primitives.find((p) => p.jointNodes);
		expect(skinned).toBeDefined();
		expect(skinned.jointNodes.length * 16).toBe(skinned.inverseBind.length);
		expect(Math.max(...skinned.joints)).toBeLessThan(skinned.jointNodes.length);
	});

	it('caches the transform for a pose and recomputes after a new one', () => {
		poseModel(cesium, null, 0);
		const prim = cesium.primitives[0];
		transformPrimitive(cesium, prim);
		const stamp = prim.poseStamp;
		transformPrimitive(cesium, prim);
		expect(prim.poseStamp).toBe(stamp);
		poseModel(cesium, cesium.animations[0], 0.5);
		transformPrimitive(cesium, prim);
		expect(prim.poseStamp).toBeGreaterThan(stamp);
	});
});

describe('framing', () => {
	it('is stable across an animation with root motion', () => {
		// REGRESSION: unioning every frame's bounds turned a walk cycle into a
		// corridor as long as the character walked, shrinking it to a speck.
		const clip = cesium.animations[0];
		const framing = computeFraming(cesium, clip);
		poseModel(cesium, null, 0);
		const rest = poseBounds(cesium);
		const restHalfHeight = (rest.max[1] - rest.min[1]) / 2;
		expect(framing.halfHeight).toBeGreaterThan(restHalfHeight * 0.8);
		expect(framing.halfHeight).toBeLessThan(restHalfHeight * 2);
	});
});

describe('rendering', () => {
	it('draws the subject into a majority of the frame', () => {
		const renderer = createRenderer(cesium, { width: 60, height: 28, mode: ColorMode.MONO, transparent: true });
		const text = renderer.frame(0.6);
		const lines = text.split('\n');
		expect(lines.length).toBe(28);
		const drawn = lines.filter((l) => l.trim().length > 0).length;
		// A figure that fills under a third of the rows means the camera fit broke.
		expect(drawn / lines.length).toBeGreaterThan(0.45);
	});

	it('produces a different frame as the animation advances', () => {
		const renderer = createRenderer(cesium, { width: 48, height: 22, mode: ColorMode.MONO });
		expect(renderer.frame(0)).not.toBe(renderer.frame(0.7));
	});

	it('is deterministic: the same time renders the same frame', () => {
		const renderer = createRenderer(brainstem, { width: 40, height: 20, mode: ColorMode.MONO });
		expect(renderer.frame(0.3)).toBe(renderer.frame(0.3));
	});

	it('renders a model with no animation at all', () => {
		const renderer = createRenderer(cesium, { width: 40, height: 18, animation: false, mode: ColorMode.MONO });
		expect(renderer.animation).toBeNull();
		expect(renderer.frame(0).replace(/[\s\n]/g, '').length).toBeGreaterThan(0);
	});

	it('clamps the camera pitch so the model cannot flip over the pole', () => {
		const renderer = createRenderer(cesium, { width: 30, height: 14, mode: ColorMode.MONO });
		expect(renderer.setOrbit({ pitch: 99 }).pitch).toBeLessThan(1.6);
		expect(renderer.setOrbit({ pitch: -99 }).pitch).toBeGreaterThan(-1.6);
		expect(renderer.setOrbit({ zoom: 0 }).zoom).toBeGreaterThan(0);
	});
});

describe('animation selection', () => {
	it('matches a clip by name fragment, falls back, and honours false', () => {
		const model = { animations: [{ name: 'idle' }, { name: 'walk-forward' }] };
		expect(selectAnimation(model, 'walk').name).toBe('walk-forward');
		expect(selectAnimation(model, 1).name).toBe('walk-forward');
		expect(selectAnimation(model, 'nope').name).toBe('idle');
		expect(selectAnimation(model, undefined).name).toBe('idle');
		expect(selectAnimation(model, false)).toBeNull();
		expect(selectAnimation({ animations: [] }, 'walk')).toBeNull();
	});
});

describe('terminal output', () => {
	it('emits one text row per two framebuffer rows', () => {
		const fb = createFramebuffer(8, 8);
		expect(framebufferToText(fb, { mode: ColorMode.MONO }).split('\n').length).toBe(4);
	});

	it('leaves uncovered cells blank in transparent mode', () => {
		const fb = createFramebuffer(6, 4);
		const text = framebufferToText(fb, { mode: ColorMode.TRUECOLOR, transparent: true });
		expect(text.replace(/\n/g, '')).toBe(' '.repeat(12));
	});

	it('paints the background where nothing was drawn when not transparent', () => {
		const fb = createFramebuffer(4, 4);
		expect(framebufferToText(fb, { mode: ColorMode.TRUECOLOR })).toContain('48;2;');
	});

	it('does not repeat an escape sequence for an unchanged colour', () => {
		const fb = createFramebuffer(20, 2);
		const row = framebufferToText(fb, { mode: ColorMode.TRUECOLOR });
		// Twenty identical cells, so exactly one foreground and one background set.
		expect(row.match(/38;2;/g)?.length).toBe(1);
		expect(row.match(/48;2;/g)?.length).toBe(1);
	});

	it('maps greys to the xterm grey ramp and colours to the cube', () => {
		expect(toAnsi256(0, 0, 0)).toBe(16);
		expect(toAnsi256(1, 1, 1)).toBe(231);
		expect(toAnsi256(0.5, 0.5, 0.5)).toBeGreaterThanOrEqual(232);
		expect(toAnsi256(1, 0, 0)).toBe(196);
	});

	it('moves the cursor up only for a positive count', () => {
		expect(ansi.up(0)).toBe('');
		expect(ansi.up(3)).toContain('3A');
	});
});

describe('colour detection', () => {
	const stream = { isTTY: true };

	it('honours NO_COLOR above everything else', () => {
		expect(detectColorMode({ NO_COLOR: '1', COLORTERM: 'truecolor' }, stream)).toBe(ColorMode.MONO);
	});

	it('reads COLORTERM for truecolor', () => {
		expect(detectColorMode({ COLORTERM: 'truecolor' }, stream)).toBe(ColorMode.TRUECOLOR);
		expect(detectColorMode({ COLORTERM: '24bit' }, stream)).toBe(ColorMode.TRUECOLOR);
	});

	it('falls back to 256 colour for a plain 256-colour TERM', () => {
		expect(detectColorMode({ TERM: 'xterm-256color' }, stream)).toBe(ColorMode.ANSI256);
	});

	it('is monochrome for a dumb terminal or a pipe', () => {
		expect(detectColorMode({ TERM: 'dumb' }, stream)).toBe(ColorMode.MONO);
		expect(detectColorMode({}, { isTTY: false })).toBe(ColorMode.MONO);
	});

	it('lets the caller force a mode', () => {
		expect(detectColorMode({ THREE_TTY_COLOR: 'mono', COLORTERM: 'truecolor' }, stream)).toBe(ColorMode.MONO);
	});
});
