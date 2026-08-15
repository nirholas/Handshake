// /walk day/night cycle (src/walk-day-night.js): the /play world clock driving
// /walk's lighting rig. Pins the contract the surface relies on: outdoor-only
// arming, the immediate snap on setEnvironment (no noon flash at night), the
// authored daytime anchors at noon, the cool low-light floor at midnight, the
// east-to-west sun arc, and the AR pause.

import { describe, it, expect, beforeEach } from 'vitest';
import { AmbientLight, DirectionalLight, HemisphereLight } from 'three';
import { createWalkDayNight } from '../src/walk-day-night.js';
import { DEFAULT_CYCLE_MS } from '../src/shared/world-clock.js';

const NOON = DEFAULT_CYCLE_MS * 0.5;
const MIDNIGHT = 0;
const SUNRISE = DEFAULT_CYCLE_MS * 0.25;
const SUNSET = DEFAULT_CYCLE_MS * 0.75;

const OUTDOOR = Object.freeze({
	name: 'park',
	kind: 'outdoor',
	sky: { top: '#3f87c8', bottom: '#bfe3f5' },
	light: {
		ambient: { color: '#fff7e6', intensity: 0.5 },
		hemi: { sky: '#a8d8ea', ground: '#3a5a28', intensity: 0.75 },
		sun: { color: '#fff2d2', intensity: 1.7, direction: [5, 9, 6] },
	},
	envIntensity: 0.85,
});

const INDOOR = Object.freeze({ ...OUTDOOR, name: 'gallery', kind: 'indoor' });

function makeRig() {
	const ambientLight = new AmbientLight(0xffffff, 0.55);
	const hemi = new HemisphereLight(0xbcd6ff, 0x202830, 0.6);
	const sun = new DirectionalLight(0xffffff, 1.4);
	const scene = { environmentIntensity: 1 };
	const stageEl = { style: {} };
	const cycle = createWalkDayNight({ ambientLight, hemi, sun, scene, stageEl });
	return { ambientLight, hemi, sun, scene, stageEl, cycle };
}

describe('walk day/night cycle', () => {
	let rig;
	beforeEach(() => {
		rig = makeRig();
	});

	it('stays disarmed for indoor environments and leaves the rig alone', () => {
		rig.cycle.setEnvironment(INDOOR);
		expect(rig.cycle.isEnabled()).toBe(false);
		expect(rig.cycle.update(NOON)).toBeNull();
		expect(rig.sun.intensity).toBe(1.4); // untouched construction default
		expect(rig.stageEl.style.background).toBeUndefined();
	});

	it('arms for outdoor environments and snaps the rig immediately', () => {
		rig.cycle.setEnvironment(OUTDOOR);
		expect(rig.cycle.isEnabled()).toBe(true);
		// setEnvironment ran update(Date.now(), force) internally: the rig is no
		// longer at its construction defaults and the sky gradient is painted.
		expect(typeof rig.stageEl.style.background).toBe('string');
		expect(rig.stageEl.style.background).toContain('radial-gradient');
	});

	// These two assert an exact sky string, so they force the write. The sky
	// paint is throttled (walk-day-night.js): update() only repaints once skyMix
	// has moved more than 0.005 since the last paint, and setEnvironment() seeds
	// that mark from the REAL clock, because it snaps the rig to the actual time
	// of day. A test that then jumps to an authored time can land inside that
	// epsilon of whatever time it really is, so the sky painted during setup
	// survives the jump and the assertion reads a near-miss blend
	// (`#050610 ... #1a233c` instead of night). Measured against the 480s world
	// cycle that is a 3160ms window for midnight and 1760ms for noon: 1.03% of
	// runs, which is exactly the kind of flake nobody can reproduce on demand.
	// Forcing pins the time-to-sky mapping these tests are actually about; the
	// throttle itself stays covered by the dusk sweep and the determinism case.
	it('renders the authored daytime anchors at noon', () => {
		rig.cycle.setEnvironment(OUTDOOR);
		const day = rig.cycle.update(NOON, true);
		expect(day).toBeCloseTo(1, 5);
		expect(rig.sun.intensity).toBeCloseTo(1.7, 5);
		expect(rig.hemi.intensity).toBeCloseTo(0.75, 5);
		expect(rig.ambientLight.intensity).toBeCloseTo(0.5, 5);
		expect(rig.scene.environmentIntensity).toBeCloseTo(0.85, 5);
		// Noon sky is pixel-identical to the authored one applySky() paints.
		expect(rig.stageEl.style.background).toBe(
			'radial-gradient(120% 90% at 50% 18%, #3f87c8 0%, #bfe3f5 72%) #bfe3f5',
		);
	});

	it('drops to the cool low-light floor at midnight, never black', () => {
		rig.cycle.setEnvironment(OUTDOOR);
		const day = rig.cycle.update(MIDNIGHT, true);
		expect(day).toBeCloseTo(0, 5);
		expect(rig.sun.intensity).toBeCloseTo(0.07, 5);
		expect(rig.hemi.intensity).toBeCloseTo(0.12, 5);
		expect(rig.ambientLight.intensity).toBeCloseTo(0.1, 5);
		expect(rig.scene.environmentIntensity).toBeCloseTo(0.85 * 0.16, 5);
		expect(rig.stageEl.style.background).toContain('#05060f'); // night sky top
	});

	it('arcs the sun east to west: opposite horizontal signs at sunrise vs sunset', () => {
		rig.cycle.setEnvironment(OUTDOOR);
		rig.cycle.update(SUNRISE);
		const riseX = rig.sun.position.x;
		const riseZ = rig.sun.position.z;
		rig.cycle.update(SUNSET);
		expect(Math.sign(rig.sun.position.x)).toBe(-Math.sign(riseX));
		expect(Math.sign(rig.sun.position.z)).toBe(-Math.sign(riseZ));
		expect(riseX).not.toBe(0);
	});

	it('lingers on a warm dusk instead of flipping day to night', () => {
		// The sky crossfade runs on a wider curve than the light levels, so the
		// stretch either side of sunset is visibly graduated rather than a
		// switch. Sample across dusk and require several distinct skies.
		rig.cycle.setEnvironment(OUTDOOR);
		const skies = new Set();
		for (let p = 0.68; p <= 0.86; p += 0.01) {
			rig.cycle.update(DEFAULT_CYCLE_MS * p);
			skies.add(rig.stageEl.style.background);
		}
		expect(skies.size).toBeGreaterThan(6);
	});

	it('keeps the ground dark at dawn even while the sky is already colouring', () => {
		rig.cycle.setEnvironment(OUTDOOR);
		// Just before sunrise: the horizon has warmed but the sun has not risen,
		// so the scene must still be lit like night, not like day.
		const day = rig.cycle.update(DEFAULT_CYCLE_MS * 0.21);
		expect(day).toBeLessThan(0.1);
		expect(rig.sun.intensity).toBeLessThan(0.3);
		// The sky, on the wider curve, has already left pure night behind.
		expect(rig.stageEl.style.background).not.toContain('#05060f');
	});

	it('is deterministic: two independent instances agree exactly', () => {
		const a = makeRig();
		const b = makeRig();
		a.cycle.setEnvironment(OUTDOOR);
		b.cycle.setEnvironment(OUTDOOR);
		const t = 1_700_000_123_456;
		a.cycle.update(t);
		b.cycle.update(t);
		expect(a.sun.intensity).toBe(b.sun.intensity);
		expect(a.sun.position.toArray()).toEqual(b.sun.position.toArray());
		expect(a.stageEl.style.background).toBe(b.stageEl.style.background);
	});

	it('pauses for AR (no writes) and resumes with a forced snap', () => {
		rig.cycle.setEnvironment(OUTDOOR);
		rig.cycle.update(NOON);
		const noonSun = rig.sun.intensity;
		rig.cycle.setPaused(true);
		expect(rig.cycle.update(MIDNIGHT)).toBeNull();
		expect(rig.sun.intensity).toBe(noonSun); // untouched while paused
		rig.cycle.setPaused(false);
		expect(rig.cycle.update(MIDNIGHT, true)).toBeCloseTo(0, 5);
		expect(rig.sun.intensity).toBeCloseTo(0.07, 5);
	});

	it('disarms on dispose', () => {
		rig.cycle.setEnvironment(OUTDOOR);
		rig.cycle.dispose();
		expect(rig.cycle.isEnabled()).toBe(false);
		expect(rig.cycle.update(NOON)).toBeNull();
	});
});
