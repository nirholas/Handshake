// EstimatedLighting swap/restore state machine (src/ar/estimated-lighting.js).
//
// The contract: the studio's baked lights and environment are handed to the
// real-world estimate ONLY while the device is actually estimating, and are
// restored byte-for-byte on estimationend and on dispose — a device that never
// estimates, or a session that ends mid-estimate, must never leave the scene
// unlit or double-lit. XREstimatedLight is mocked to a controllable fake so the
// machine is tested without a live WebXR session.

import { beforeEach, describe, expect, it, vi } from 'vitest';

// A minimal stand-in for three's XREstimatedLight: an event target that also
// carries an `environment` texture, exactly the surface the wrapper touches.
class FakeXRLight {
	constructor() {
		this._listeners = {};
		this.environment = { id: 'room-cubemap' };
		this.disposed = false;
	}
	addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
	removeEventListener(type, fn) {
		this._listeners[type] = (this._listeners[type] || []).filter((f) => f !== fn);
	}
	emit(type) { for (const fn of this._listeners[type] || []) fn(); }
	dispose() { this.disposed = true; }
}

let lastLight = null;
vi.mock('three/addons/webxr/XREstimatedLight.js', () => ({
	XREstimatedLight: class {
		constructor() {
			lastLight = new FakeXRLight();
			return lastLight;
		}
	},
}));

const { EstimatedLighting } = await import('../src/ar/estimated-lighting.js');

function makeScene() {
	const added = new Set();
	return {
		environment: { id: 'baked-env' },
		add(o) { added.add(o); },
		remove(o) { added.delete(o); },
		_added: added,
	};
}
const makeLight = (intensity) => ({ intensity, color: { setHex() {} } });
const renderer = { xr: { addEventListener() {} } };

describe('EstimatedLighting', () => {
	beforeEach(() => { lastLight = null; });

	it('leaves the baked lights untouched until estimation starts', () => {
		const scene = makeScene();
		const lights = [makeLight(1), makeLight(1.15)];
		const el = new EstimatedLighting({ renderer, scene, baseLights: lights });
		el.start();
		expect(el.active).toBe(false);
		expect(lights.map((l) => l.intensity)).toEqual([1, 1.15]);
		expect(scene.environment).toEqual({ id: 'baked-env' });
		expect(scene._added.has(lastLight)).toBe(true);
	});

	it('hands the scene to the room on estimationstart', () => {
		const scene = makeScene();
		const lights = [makeLight(1), makeLight(1.15)];
		const el = new EstimatedLighting({ renderer, scene, baseLights: lights });
		el.start();
		lastLight.emit('estimationstart');
		expect(el.active).toBe(true);
		expect(lights.map((l) => l.intensity)).toEqual([0, 0]); // baked lights off
		expect(scene.environment).toEqual({ id: 'room-cubemap' }); // real reflections
	});

	it('fires onChange only on real transitions', () => {
		const scene = makeScene();
		const onChange = vi.fn();
		const el = new EstimatedLighting({ renderer, scene, baseLights: [makeLight(1)], onChange });
		el.start();
		lastLight.emit('estimationstart');
		lastLight.emit('estimationend');
		expect(onChange.mock.calls.map((c) => c[0])).toEqual([true, false]);
	});

	it('restores lights + environment on estimationend', () => {
		const scene = makeScene();
		const lights = [makeLight(1), makeLight(1.15)];
		const el = new EstimatedLighting({ renderer, scene, baseLights: lights });
		el.start();
		lastLight.emit('estimationstart');
		lastLight.emit('estimationend');
		expect(el.active).toBe(false);
		expect(lights.map((l) => l.intensity)).toEqual([1, 1.15]);
		expect(scene.environment).toEqual({ id: 'baked-env' });
	});

	it('restores byte-for-byte on dispose mid-estimate (session ended while lit)', () => {
		const scene = makeScene();
		const lights = [makeLight(1), makeLight(1.15)];
		const el = new EstimatedLighting({ renderer, scene, baseLights: lights });
		el.start();
		lastLight.emit('estimationstart');
		const light = lastLight;
		el.dispose();
		expect(lights.map((l) => l.intensity)).toEqual([1, 1.15]);
		expect(scene.environment).toEqual({ id: 'baked-env' });
		expect(scene._added.has(light)).toBe(false); // removed from scene graph
		expect(light.disposed).toBe(true);
	});

	it('start() is idempotent — a second call adds no second light', () => {
		const scene = makeScene();
		const el = new EstimatedLighting({ renderer, scene, baseLights: [makeLight(1)] });
		el.start();
		const first = lastLight;
		el.start();
		expect(lastLight).toBe(first);
		expect(scene._added.size).toBe(1);
	});
});
