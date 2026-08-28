// One frame as a string. For READMEs, CI logs, screenshots-in-text, and tests.

import { createFrame, render } from './raster.js';
import { encode, MODES } from './encode.js';
import { MOODS } from './moods.js';

/**
 * @param {import('./load.js').Mesh} mesh
 * @param {{ mode?: 'blocks'|'braille'|'ascii', columns?: number, rows?: number, yaw?: number, pitch?: number, zoom?: number, mood?: string, t?: number }} [opts]
 * @returns {string}
 */
export function snapshot(mesh, opts = {}) {
	const mode = opts.mode && MODES[opts.mode] ? opts.mode : 'blocks';
	const geom = MODES[mode];
	const columns = opts.columns || 60;
	const rows = opts.rows || 30;
	const frame = createFrame(columns * geom.sx, rows * geom.sy);
	const motion = opts.mood && MOODS[opts.mood] ? MOODS[opts.mood].motion(opts.t ?? 0) : {};
	const pose = {
		...motion,
		yaw: (motion.yaw || 0) + (opts.yaw || 0),
		pitch: (motion.pitch || 0) + (opts.pitch || 0),
	};
	render(mesh, frame, pose, { zoom: opts.zoom || 1 });
	return encode(frame, { mode }).join('\n');
}
