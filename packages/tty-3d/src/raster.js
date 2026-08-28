// A z-buffered software triangle rasterizer.
//
// There is no GPU here on purpose. The whole point of this package is that it
// runs anywhere a Node process runs: a laptop, a CI job, a Cloud Run container
// with no display, an SSH session. So everything is scanline work on typed
// arrays, sized to a terminal rather than a monitor, which is what makes it
// fast enough to animate: a 120x64 framebuffer is 7,680 pixels, three orders
// of magnitude less fill than a 1080p frame.

import { mat4LookAt, mat4Multiply, mat4Perspective, normalize } from './math.js';
import { poseModel, transformPrimitive } from './model.js';

export function createFramebuffer(width, height) {
	return {
		width,
		height,
		color: new Float32Array(width * height * 3),
		depth: new Float32Array(width * height),
		coverage: new Uint8Array(width * height),
	};
}

export function clearFramebuffer(fb) {
	fb.color.fill(0);
	fb.depth.fill(Infinity);
	fb.coverage.fill(0);
	return fb;
}

/** World-space bounds of the model in its current pose. */
export function poseBounds(model) {
	const min = [Infinity, Infinity, Infinity];
	const max = [-Infinity, -Infinity, -Infinity];
	for (const prim of model.primitives) {
		const p = transformPrimitive(model, prim).outPositions;
		for (let i = 0; i < p.length; i += 3) {
			for (let k = 0; k < 3; k += 1) {
				const v = p[i + k];
				if (v < min[k]) min[k] = v;
				if (v > max[k]) max[k] = v;
			}
		}
	}
	if (!Number.isFinite(min[0])) return { min: [-1, -1, -1], max: [1, 1, 1] };
	return { min, max };
}

/**
 * Framing that holds still while an animation plays.
 *
 * Auto-framing off the current frame's bounds is the obvious approach and it
 * looks terrible: the silhouette changes every frame, so the camera breathes.
 * Unioning every frame instead is worse on anything with root motion, which is
 * most walk cycles: the union is a corridor as long as the character walks, and
 * fitting that corridor shrinks the character to a speck at the end of it. That
 * was measured, not guessed, on public/avatars/cesium-man.glb.
 *
 * So the two halves are separated. The RADIUS is fixed, taken as the largest
 * any single frame needs, which keeps the subject a constant size. The CENTER is
 * recomputed per frame, which keeps a character that walks from leaving the
 * shot. Together: no breathing, no drift.
 */
export function computeFraming(model, animation, samples = 12) {
	let halfHeight = 0;
	let halfWidth = 0;
	const take = () => {
		const b = poseBounds(model);
		halfHeight = Math.max(halfHeight, (b.max[1] - b.min[1]) / 2);
		// Worst case across a full turntable: the model presents its X extent at
		// one yaw and its Z extent a quarter turn later, so framing for the larger
		// of the two is what stops a shoulder-width character from being clipped
		// halfway through the spin.
		halfWidth = Math.max(halfWidth, (b.max[0] - b.min[0]) / 2, (b.max[2] - b.min[2]) / 2);
	};
	if (!animation) {
		poseModel(model, null, 0);
		take();
	} else {
		for (let i = 0; i < samples; i += 1) {
			poseModel(model, animation, (animation.duration * i) / samples);
			take();
		}
	}
	return { halfHeight: Math.max(1e-4, halfHeight), halfWidth: Math.max(1e-4, halfWidth) };
}

/** Centre of the model in whatever pose it currently holds. */
export function poseCenter(model) {
	const b = poseBounds(model);
	return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
}

const KEY_LIGHT = normalize([-0.4, 0.75, 0.9]);
const FILL_LIGHT = normalize([0.7, 0.1, 0.35]);

/**
 * Rasterize the model into `fb`.
 *
 * @param {object} fb            framebuffer from createFramebuffer
 * @param {object} model         loaded model
 * @param {object} opts
 * @param {number} opts.yaw      camera azimuth, radians
 * @param {number} opts.pitch    camera elevation, radians
 * @param {number} opts.zoom     1 fits the model, >1 moves closer
 * @param {object} opts.framing  fixed framing extents from computeFraming
 * @param {number[]} opts.center world-space point to look at
 * @param {number[]} opts.tint   optional rgb multiplier in 0..1
 */
export function renderToFramebuffer(fb, model, opts) {
	const { yaw = 0, pitch = 0.05, zoom = 1, tint = [1, 1, 1] } = opts;
	clearFramebuffer(fb);

	const center = opts.center ?? poseCenter(model);
	const framing = opts.framing ?? computeFraming(model, null);

	const fov = Math.PI / 4;
	// Terminal cells are about twice as tall as they are wide and the half-block
	// already doubles vertical resolution, so framebuffer pixels are square and
	// the aspect correction is just width over height.
	const aspect = fb.width / fb.height;
	const halfV = Math.tan(fov / 2);
	const halfH = halfV * aspect;

	// Fit height and width independently rather than fitting a bounding sphere.
	// A sphere around a human figure is dominated by its diagonal and wastes
	// roughly a third of the frame on empty space above and below the subject.
	// Then push back by the half width, because perspective magnifies whichever
	// part of the model is nearest the camera and a flat fit clips it.
	const fitDistance = Math.max(framing.halfHeight / halfV, framing.halfWidth / halfH) * 1.02 + framing.halfWidth * 0.5;
	const radius = Math.max(framing.halfHeight, framing.halfWidth);
	const distance = fitDistance / Math.max(0.2, zoom);

	const eye = [
		center[0] + distance * Math.cos(pitch) * Math.sin(yaw),
		center[1] + distance * Math.sin(pitch),
		center[2] + distance * Math.cos(pitch) * Math.cos(yaw),
	];
	const view = mat4LookAt(eye, center, [0, 1, 0]);
	const proj = mat4Perspective(fov, aspect, Math.max(1e-3, distance - radius * 2), distance + radius * 4);
	const viewProj = mat4Multiply(proj, view);

	const clip = new Float64Array(4);
	const sx = new Float64Array(3), sy = new Float64Array(3), sz = new Float64Array(3);
	const nx = new Float64Array(3), ny = new Float64Array(3), nz = new Float64Array(3);

	for (const prim of model.primitives) {
		const { outPositions: P, outNormals: N, indices, color } = transformPrimitive(model, prim);

		for (let t = 0; t < indices.length; t += 3) {
			let behind = false;
			for (let v = 0; v < 3; v += 1) {
				const o = indices[t + v] * 3;
				const x = P[o], y = P[o + 1], z = P[o + 2];
				clip[0] = viewProj[0] * x + viewProj[4] * y + viewProj[8] * z + viewProj[12];
				clip[1] = viewProj[1] * x + viewProj[5] * y + viewProj[9] * z + viewProj[13];
				clip[2] = viewProj[2] * x + viewProj[6] * y + viewProj[10] * z + viewProj[14];
				clip[3] = viewProj[3] * x + viewProj[7] * y + viewProj[11] * z + viewProj[15];
				// Whole-triangle rejection instead of near-plane clipping. A triangle
				// straddling the eye is rare at a fit-to-frame distance, and dropping
				// it costs one facet where clipping would cost a per-frame allocation.
				if (clip[3] <= 1e-6) { behind = true; break; }
				const inv = 1 / clip[3];
				sx[v] = (clip[0] * inv * 0.5 + 0.5) * fb.width;
				sy[v] = (1 - (clip[1] * inv * 0.5 + 0.5)) * fb.height;
				sz[v] = clip[2] * inv;
				nx[v] = N[o]; ny[v] = N[o + 1]; nz[v] = N[o + 2];
			}
			if (behind) continue;

			const area = (sx[1] - sx[0]) * (sy[2] - sy[0]) - (sx[2] - sx[0]) * (sy[1] - sy[0]);
			// Backface culling by winding. Two-sided materials exist, but a closed
			// avatar body doubles its fill cost for pixels it will never show.
			if (area >= -1e-9) continue;

			const minX = Math.max(0, Math.floor(Math.min(sx[0], sx[1], sx[2])));
			const maxX = Math.min(fb.width - 1, Math.ceil(Math.max(sx[0], sx[1], sx[2])));
			const minY = Math.max(0, Math.floor(Math.min(sy[0], sy[1], sy[2])));
			const maxY = Math.min(fb.height - 1, Math.ceil(Math.max(sy[0], sy[1], sy[2])));
			if (minX > maxX || minY > maxY) continue;

			const invArea = 1 / area;
			for (let py = minY; py <= maxY; py += 1) {
				const cy = py + 0.5;
				for (let px = minX; px <= maxX; px += 1) {
					const cx = px + 0.5;
					const w0 = ((sx[1] - cx) * (sy[2] - cy) - (sx[2] - cx) * (sy[1] - cy)) * invArea;
					if (w0 < 0) continue;
					const w1 = ((sx[2] - cx) * (sy[0] - cy) - (sx[0] - cx) * (sy[2] - cy)) * invArea;
					if (w1 < 0) continue;
					const w2 = 1 - w0 - w1;
					if (w2 < 0) continue;

					const depth = w0 * sz[0] + w1 * sz[1] + w2 * sz[2];
					const idx = py * fb.width + px;
					if (depth >= fb.depth[idx]) continue;
					fb.depth[idx] = depth;
					fb.coverage[idx] = 1;

					let vnx = w0 * nx[0] + w1 * nx[1] + w2 * nx[2];
					let vny = w0 * ny[0] + w1 * ny[1] + w2 * ny[2];
					let vnz = w0 * nz[0] + w1 * nz[1] + w2 * nz[2];
					const len = Math.hypot(vnx, vny, vnz) || 1;
					vnx /= len; vny /= len; vnz /= len;

					const key = Math.max(0, vnx * KEY_LIGHT[0] + vny * KEY_LIGHT[1] + vnz * KEY_LIGHT[2]);
					const fill = Math.max(0, vnx * FILL_LIGHT[0] + vny * FILL_LIGHT[1] + vnz * FILL_LIGHT[2]);
					// Rim term: the silhouette is the only cue for shape at this
					// resolution, so faces turning away from the camera get lifted
					// rather than crushed to black. Without it a terminal render of a
					// dark model reads as an unreadable blob.
					const facing = Math.abs(vnz);
					const rim = Math.pow(1 - Math.min(1, facing), 3) * 0.55;
					const lit = 0.16 + key * 0.82 + fill * 0.22 + rim;

					const o = idx * 3;
					fb.color[o] = Math.min(1, color[0] * lit * tint[0]);
					fb.color[o + 1] = Math.min(1, color[1] * lit * tint[1]);
					fb.color[o + 2] = Math.min(1, color[2] * lit * tint[2]);
				}
			}
		}
	}
	return fb;
}
