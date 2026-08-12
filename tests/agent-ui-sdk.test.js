/**
 * @three-ws/agent-ui — core-path tests.
 *
 * Proves the main export surface is real:
 *   1. The documented exports all exist on the source entry point.
 *   2. The animation controller (createAnimator) drives REAL clips parsed
 *      from the production clip JSONs in public/animations/clips/.
 *   3. The DOM-anchor math (worldOfElement), movement tweens (moveTo,
 *      lookAtScreenX, faceFront, standOn), the non-repeating picker, and the
 *      root-motion lock behave as the README documents.
 *   4. The published bundle artifact (dist/index.mjs) builds from this
 *      worktree and exposes the same API.
 *
 * Node has no requestAnimationFrame; a setTimeout-backed shim stands in for
 * the browser clock so the tween loop runs under test.
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const sdkDir = join(repoRoot, 'agent-ui-sdk');

if (typeof globalThis.requestAnimationFrame !== 'function') {
	globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 1);
	globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
}

const sdk = await import(join(sdkDir, 'src/index.js'));

const DOCUMENTED_EXPORTS = [
	'createAgentUI',
	'createRenderer',
	'loadAvatar',
	'createAnimator',
	'lockRootMotion',
	'worldOfElement',
	'moveTo',
	'lookAtScreenX',
	'faceFront',
	'walkTo',
	'standOn',
	'fallOnto',
	'runOff',
	'interceptNavigation',
	'createRandomPicker',
	'caretScreenX',
	'startCaretTracking',
	'dust',
	'impactPulse',
	'proximityShadow',
	'scan',
];

function loadClipJson(name) {
	const raw = readFileSync(join(repoRoot, 'public/animations/clips', `${name}.json`), 'utf8');
	return THREE.AnimationClip.parse(JSON.parse(raw));
}

// Build an object hierarchy whose node names match the clip's track targets,
// so AnimationMixer property bindings resolve against real nodes.
function objectForClips(clips) {
	const root = new THREE.Object3D();
	const seen = new Set();
	for (const clip of Object.values(clips)) {
		for (const track of clip.tracks) {
			const nodeName = track.name.split('.')[0];
			if (seen.has(nodeName)) continue;
			seen.add(nodeName);
			const node = new THREE.Object3D();
			node.name = nodeName;
			root.add(node);
		}
	}
	return root;
}

describe('entry point', () => {
	it('exports every function the README documents', () => {
		for (const name of DOCUMENTED_EXPORTS) {
			expect(typeof sdk[name], name).toBe('function');
		}
	});
});

describe('createAnimator with real production clips', () => {
	let clips;
	beforeAll(() => {
		clips = { idle: loadClipJson('idle'), walk: loadClipJson('walk') };
	});

	it('parses real clip JSONs into AnimationClips with positive durations', () => {
		expect(clips.idle).toBeInstanceOf(THREE.AnimationClip);
		expect(clips.idle.duration).toBeGreaterThan(0.5);
		expect(clips.walk.duration).toBeGreaterThan(0.2);
	});

	it('play() switches currentName and clipDuration() reports the real length', () => {
		const animator = sdk.createAnimator({ object: objectForClips(clips), clips });
		animator.play('idle', { loop: true });
		expect(animator.currentName).toBe('idle');
		expect(animator.clipDuration('idle')).toBeCloseTo(clips.idle.duration, 5);
		expect(animator.clipDuration('walk')).toBeCloseTo(clips.walk.duration, 5);
		expect(animator.clipDuration('nope')).toBe(1.0);

		animator.play('walk', { loop: true });
		expect(animator.currentName).toBe('walk');
	});

	it('a non-looping play fires onComplete after the clip finishes', () => {
		const animator = sdk.createAnimator({ object: objectForClips(clips), clips });
		let completed = false;
		animator.play('walk', { loop: false, onComplete: () => { completed = true; } });
		animator.update(clips.walk.duration + 0.05);
		expect(completed).toBe(true);
	});

	it('hold clamps the final frame instead of resetting', () => {
		const animator = sdk.createAnimator({ object: objectForClips(clips), clips });
		animator.play('walk', { loop: false, hold: true });
		expect(animator.actions.walk.clampWhenFinished).toBe(true);
	});

	it('an unknown clip warns instead of throwing', () => {
		const animator = sdk.createAnimator({ object: objectForClips(clips), clips });
		expect(() => animator.play('ghost')).not.toThrow();
		expect(animator.currentName).toBe(null);
	});
});

describe('lockRootMotion', () => {
	it('clamps the root bone to rest across renders and unlock restores', () => {
		const rootBone = new THREE.Object3D();
		rootBone.name = 'Hips';
		rootBone.position.set(1, 2, 3);
		const renders = [];
		const renderer = { render: (s, c) => renders.push([s, c]) };

		const unlock = sdk.lockRootMotion(renderer, rootBone);
		rootBone.position.set(9, 9, 9); // simulated baked root translation
		renderer.render('scene', 'camera');
		expect(rootBone.position.x).toBe(1);
		expect(rootBone.position.y).toBe(2);
		expect(renders).toHaveLength(1);

		unlock();
		rootBone.position.set(7, 7, 7);
		renderer.render('scene', 'camera');
		expect(rootBone.position.x).toBe(7); // no longer clamped
	});

	it('is a no-op disposer when there is no root bone', () => {
		const renderer = { render() {} };
		const unlock = sdk.lockRootMotion(renderer, null);
		expect(() => unlock()).not.toThrow();
	});
});

describe('worldOfElement anchors', () => {
	const rect = { left: 100, top: 50, width: 200, height: 40, right: 300, bottom: 90 };
	const el = { getBoundingClientRect: () => rect };
	const agent = { domToWorld: (x, y) => ({ x, y }) };

	it.each([
		['top-left', 100, 50],
		['top-right', 300, 50],
		['top-center', 200, 50],
		['center', 200, 70],
		['bottom-center', 200, 90],
		['left-of', 100, 70],
		['right-of', 300, 70],
	])('anchor %s maps the rect correctly', (anchor, x, y) => {
		expect(sdk.worldOfElement(el, agent, { anchor })).toEqual({ x, y });
	});

	it('defaults to top-center and applies pixel offsets', () => {
		expect(sdk.worldOfElement(el, agent)).toEqual({ x: 200, y: 50 });
		expect(sdk.worldOfElement(el, agent, { offsetX: 10, offsetY: -5 })).toEqual({ x: 210, y: 45 });
	});
});

describe('movement behaviors', () => {
	function stubAgent() {
		const played = [];
		return {
			played,
			avatar: { position: { x: 0, y: 0, set(x, y) { this.x = x; this.y = y; } }, rotation: { y: 0 } },
			pixelsPerUnit: 120,
			play: (name, o) => played.push([name, o]),
			domToWorld: (x, y) => ({ x, y }),
			worldToScreen: (x, y) => ({ x, y }),
		};
	}

	it('moveTo tweens the avatar to the target and resolves', async () => {
		const agent = stubAgent();
		await sdk.moveTo(agent, { x: 5, y: 3 }, { duration: 5 });
		expect(agent.avatar.position.x).toBeCloseTo(5);
		expect(agent.avatar.position.y).toBeCloseTo(3);
	});

	it('moveTo resolves immediately with no avatar', async () => {
		await expect(sdk.moveTo({ avatar: null }, { x: 1, y: 1 }, { duration: 5 })).resolves.toBeUndefined();
	});

	it('standOn parks the avatar on the element and plays the idle clip', () => {
		const agent = stubAgent();
		const el = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 120, height: 60, right: 120, bottom: 60 }) };
		sdk.standOn(agent, el);
		expect(agent.avatar.position.x).toBe(60); // top-center of the rect
		expect(agent.avatar.position.y).toBe(0);
		expect(agent.played).toEqual([['idle', { loop: true }]]);
	});

	it('walkTo plays the walk clip, moves, and leaves walk playing', async () => {
		const agent = stubAgent();
		const el = { getBoundingClientRect: () => ({ left: 200, top: 100, width: 40, height: 20, right: 240, bottom: 120 }) };
		await sdk.walkTo(agent, el, { duration: 5 });
		expect(agent.played[0]).toEqual(['walk', { loop: true }]);
		expect(agent.avatar.position.x).toBe(220);
		expect(agent.avatar.position.y).toBe(100);
	});

	it('lookAtScreenX clamps yaw to maxYaw and faceFront returns to zero', async () => {
		const agent = stubAgent();
		await sdk.lookAtScreenX(agent, 100000, { duration: 5 });
		expect(agent.avatar.rotation.y).toBeCloseTo(0.45); // clamped at default maxYaw
		await sdk.lookAtScreenX(agent, -100000, { duration: 5 });
		expect(agent.avatar.rotation.y).toBeCloseTo(-0.45);
		await sdk.faceFront(agent, { duration: 5 });
		expect(agent.avatar.rotation.y).toBeCloseTo(0);
	});
});

describe('createRandomPicker', () => {
	it('never repeats the previous pick', () => {
		const pick = sdk.createRandomPicker(['nod', 'shrug', 'wave']);
		let last = pick();
		for (let i = 0; i < 200; i++) {
			const next = pick();
			expect(['nod', 'shrug', 'wave']).toContain(next);
			expect(next).not.toBe(last);
			last = next;
		}
	});

	it('handles empty and single-element pools', () => {
		expect(sdk.createRandomPicker([])()).toBe(null);
		expect(sdk.createRandomPicker(['only'])()).toBe('only');
	});
});

describe('bundle artifact', () => {
	it('builds via the package build script and exports the documented API', () => {
		execFileSync(process.execPath, [join(sdkDir, 'build.mjs')], { cwd: sdkDir, stdio: 'pipe' });
		return import(join(sdkDir, 'dist/index.mjs')).then((bundle) => {
			for (const name of DOCUMENTED_EXPORTS) {
				expect(typeof bundle[name], name).toBe('function');
			}
		});
	});
});
