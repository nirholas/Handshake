// Moods are procedural motion: a pure function of time that returns a pose.
//
// No rig is required. A triangle soup cannot play a skinned clip, so every
// mood is expressed with whole-body motion the eye already reads as intent:
// a slow sway is idle, a tilt is thinking, a bounce is joy, a rapid shake is
// an error. Each function takes seconds since the mood began and returns the
// pose delta the rasterizer applies on top of the base yaw.

/** @typedef {(t: number) => import('./raster.js').Pose} Motion */

/** @type {Record<string, { motion: Motion, label: string }>} */
export const MOODS = {
	idle: {
		label: 'idle',
		motion: (t) => ({
			yaw: 0.22 * Math.sin(t * 0.6),
			y: 0.012 * Math.sin(t * 2.1),
			scale: 1 + 0.006 * Math.sin(t * 2.1),
		}),
	},
	spin: {
		label: 'turntable',
		motion: (t) => ({ yaw: t * 0.9, y: 0.01 * Math.sin(t * 2) }),
	},
	think: {
		label: 'thinking',
		motion: (t) => ({
			yaw: 0.35 * Math.sin(t * 0.45) + 0.18,
			pitch: -0.08 + 0.04 * Math.sin(t * 0.9),
			roll: 0.11 * Math.sin(t * 0.5),
			y: 0.02 * Math.sin(t * 1.3),
		}),
	},
	work: {
		label: 'working',
		motion: (t) => ({
			yaw: 0.06 * Math.sin(t * 3.2),
			pitch: 0.05 + 0.03 * Math.sin(t * 9.5),
			y: 0.018 * Math.sin(t * 9.5),
		}),
	},
	talk: {
		label: 'talking',
		motion: (t) => ({
			yaw: 0.1 * Math.sin(t * 1.7),
			pitch: 0.07 * Math.sin(t * 3.4),
			y: 0.03 * Math.abs(Math.sin(t * 6.5)),
			scale: 1 + 0.01 * Math.sin(t * 6.5),
		}),
	},
	happy: {
		label: 'happy',
		motion: (t) => ({
			yaw: 0.3 * Math.sin(t * 3.6),
			roll: 0.07 * Math.sin(t * 3.6),
			y: 0.13 * Math.abs(Math.sin(t * 3.6)),
			scale: 1 + 0.03 * Math.abs(Math.sin(t * 3.6)),
		}),
	},
	attention: {
		label: 'needs you',
		motion: (t) => ({
			yaw: 0.12 * Math.sin(t * 2.4),
			y: 0.05 * Math.abs(Math.sin(t * 4.8)),
			scale: 1 + 0.07 * (0.5 + 0.5 * Math.sin(t * 6)),
		}),
	},
	error: {
		label: 'error',
		motion: (t) => ({
			yaw: 0.16 * Math.sin(t * 22),
			roll: 0.05 * Math.sin(t * 19),
			pitch: 0.05,
		}),
	},
	sleep: {
		label: 'asleep',
		motion: (t) => ({
			pitch: 0.28 + 0.02 * Math.sin(t * 1.1),
			y: -0.06 + 0.012 * Math.sin(t * 1.1),
			scale: 1 + 0.008 * Math.sin(t * 1.1),
		}),
	},
};

export const MOOD_NAMES = Object.keys(MOODS);

export function isMood(name) {
	return Object.prototype.hasOwnProperty.call(MOODS, name);
}

/**
 * Blend from one mood to another over `blendMs` so a hook-driven switch never
 * pops. Returns a pose for the given wall-clock time.
 *
 * @param {{ name: string, since: number }} current
 * @param {{ name: string, since: number } | null} previous
 * @param {number} now  ms
 * @param {number} [blendMs]
 */
export function poseAt(current, previous, now, blendMs = 450) {
	const cur = MOODS[current.name] ? MOODS[current.name].motion((now - current.since) / 1000) : {};
	if (!previous || !MOODS[previous.name]) return cur;
	const k = Math.min(1, (now - current.since) / blendMs);
	if (k >= 1) return cur;
	const prev = MOODS[previous.name].motion((now - previous.since) / 1000);
	const e = k * k * (3 - 2 * k);
	const mix = (key, def = 0) => (prev[key] ?? def) * (1 - e) + (cur[key] ?? def) * e;
	return {
		yaw: mix('yaw'),
		pitch: mix('pitch'),
		roll: mix('roll'),
		x: mix('x'),
		y: mix('y'),
		scale: mix('scale', 1),
	};
}
