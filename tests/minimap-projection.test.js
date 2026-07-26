// Shared HUD minimap (src/game/hud/minimap.js) projection math. The radar
// rotates the world under a fixed player arrow; worldFromScreen() is the new
// inverse /walk's tap-to-set-waypoint runs through, so the two mappings must
// round-trip exactly for any viewer pose. Tested via prototype calls on a bare
// pose object: the math needs no DOM, and node has no canvas.

import { describe, it, expect } from 'vitest';
import { Minimap } from '../src/game/hud/minimap.js';

function fake(viewer, { size = 184, range = 16 } = {}) {
	return { size, range, viewer };
}

const project = (f, x, z) => Minimap.prototype._project.call(f, x, z);
const unproject = (f, sx, sy) => Minimap.prototype.worldFromScreen.call(f, sx, sy);

describe('minimap projection', () => {
	it('maps the point the player faces to screen-up', () => {
		for (const yaw of [0, 0.7, Math.PI / 2, -2.3]) {
			const f = fake({ x: 0, z: 0, yaw });
			// walk.js yaw convention: forward = (sin yaw, cos yaw) in the XZ plane.
			const p = project(f, Math.sin(yaw) * 5, Math.cos(yaw) * 5);
			expect(p.sx).toBeCloseTo(0, 8);
			expect(p.sy).toBeLessThan(0); // up on screen
		}
	});

	it('worldFromScreen inverts _project for arbitrary poses', () => {
		const poses = [
			{ x: 0, z: 0, yaw: 0 },
			{ x: 3.2, z: -1.7, yaw: 0.7 },
			{ x: -8, z: 5, yaw: -2.9 },
			{ x: 11, z: 11, yaw: Math.PI },
		];
		const points = [
			[0, 0],
			[4, -3],
			[-7.5, 2.25],
			[10, 10],
		];
		for (const viewer of poses) {
			const f = fake(viewer);
			const c = f.size / 2;
			for (const [wx, wz] of points) {
				const p = project(f, wx, wz);
				// worldFromScreen takes CSS px from the map's top-left corner.
				const back = unproject(f, c + p.sx, c + p.sy);
				expect(back.x).toBeCloseTo(wx, 8);
				expect(back.z).toBeCloseTo(wz, 8);
			}
		}
	});

	it('the map centre unprojects to the viewer position', () => {
		const f = fake({ x: -4.5, z: 9.1, yaw: 1.3 });
		const c = f.size / 2;
		const back = unproject(f, c, c);
		expect(back.x).toBeCloseTo(-4.5, 8);
		expect(back.z).toBeCloseTo(9.1, 8);
	});

	it('scales with range: the rim is `range` metres from the viewer', () => {
		const f = fake({ x: 0, z: 0, yaw: 0 }, { size: 184, range: 16 });
		const back = unproject(f, f.size / 2, 0); // top edge, straight ahead
		const dist = Math.hypot(back.x, back.z);
		expect(dist).toBeCloseTo(16, 6);
	});
});
