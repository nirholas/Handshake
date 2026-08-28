// A tiny perspective rasterizer over a subpixel grid.
//
// The terminal is the framebuffer. Each character cell is split into subpixels
// by the encoder (1x2 for half-blocks, 2x4 for braille), so the rasterizer
// only ever sees a W x H grid of square-ish pixels and writes RGB + coverage
// into it. Z-buffered scanline fill, back-face culling, a three-light shading
// model (key, fill, rim) tuned to read on both dark and light terminals.
//
// Everything is allocation-free per frame: buffers are reused across calls.

/**
 * @typedef {object} Frame
 * @property {number} width
 * @property {number} height
 * @property {Uint8Array} hit      1 where a triangle covered the subpixel
 * @property {Float32Array} rgb    3 floats per subpixel, linear [0,1]
 * @property {Float32Array} depth  view-space depth per subpixel (smaller = nearer)
 */

/**
 * @typedef {object} Pose
 * @property {number} [yaw]    radians around Y (turntable)
 * @property {number} [pitch]  radians around X
 * @property {number} [roll]   radians around Z
 * @property {number} [x]      translation in model units (unit sphere)
 * @property {number} [y]
 * @property {number} [scale]
 */

const KEY = norm([-0.45, 0.65, 0.62]);
const FILL = norm([0.7, -0.15, 0.55]);
const AMBIENT = 0.22;

function norm(v) {
	const l = Math.hypot(v[0], v[1], v[2]);
	return [v[0] / l, v[1] / l, v[2] / l];
}

/** Allocate a frame for the given subpixel size. */
export function createFrame(width, height) {
	return {
		width,
		height,
		hit: new Uint8Array(width * height),
		rgb: new Float32Array(width * height * 3),
		depth: new Float32Array(width * height),
	};
}

/**
 * Render a mesh into a frame. The frame is cleared first.
 *
 * @param {import('./load.js').Mesh} mesh
 * @param {Frame} frame
 * @param {Pose} [pose]
 * @param {{ fov?: number, distance?: number, zoom?: number }} [camera]
 * @returns {Frame} the same frame, filled
 */
export function render(mesh, frame, pose = {}, camera = {}) {
	const { width: W, height: H, hit, rgb, depth } = frame;
	hit.fill(0);
	depth.fill(Infinity);

	const yaw = pose.yaw || 0, pitch = pose.pitch || 0, roll = pose.roll || 0;
	const scale = pose.scale ?? 1;
	const tx = pose.x || 0, ty = pose.y || 0;
	const cy = Math.cos(yaw), sy = Math.sin(yaw);
	const cp = Math.cos(pitch), sp = Math.sin(pitch);
	const cr = Math.cos(roll), sr = Math.sin(roll);
	// Rotation = Rz(roll) * Rx(pitch) * Ry(yaw), applied to model then camera looks down -Z.
	const r00 = cr * cy + sr * sp * sy, r01 = -sr * cp, r02 = -cr * sy + sr * sp * cy;
	const r10 = sr * cy - cr * sp * sy, r11 = cr * cp, r12 = -sr * sy - cr * sp * cy;
	const r20 = cp * sy, r21 = sp, r22 = cp * cy;

	const distance = camera.distance ?? 3.1;
	const fov = camera.fov ?? 0.62;
	const zoom = camera.zoom ?? 1;
	// Focal length in subpixels: fit the unit sphere vertically with a margin.
	const f = (Math.min(W, H) / 2) / Math.tan(fov / 2) * zoom;
	const cxs = W / 2, cys = H / 2;

	const P = mesh.positions, N = mesh.normals, T = mesh.tints;
	const v = new Float32Array(9); // projected: sx, sy, z per vertex
	for (let t = 0; t < mesh.count; t++) {
		const o = t * 9;
		// Face normal in view space (rotation only).
		const nx0 = N[t * 3], ny0 = N[t * 3 + 1], nz0 = N[t * 3 + 2];
		const nx = r00 * nx0 + r01 * ny0 + r02 * nz0;
		const ny = r10 * nx0 + r11 * ny0 + r12 * nz0;
		const nz = r20 * nx0 + r21 * ny0 + r22 * nz0;
		if (nz <= 0) continue; // facing away from the camera at +Z

		let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
		for (let j = 0; j < 3; j++) {
			const x0 = P[o + j * 3] * scale, y0 = P[o + j * 3 + 1] * scale, z0 = P[o + j * 3 + 2] * scale;
			const x = r00 * x0 + r01 * y0 + r02 * z0 + tx;
			const y = r10 * x0 + r11 * y0 + r12 * z0 + ty;
			const z = distance - (r20 * x0 + r21 * y0 + r22 * z0);
			const inv = f / z;
			const sx = cxs + x * inv;
			const sy2 = cys - y * inv;
			v[j * 3] = sx; v[j * 3 + 1] = sy2; v[j * 3 + 2] = z;
			if (sx < minX) minX = sx; if (sx > maxX) maxX = sx;
			if (sy2 < minY) minY = sy2; if (sy2 > maxY) maxY = sy2;
		}
		if (maxX < 0 || minX >= W || maxY < 0 || minY >= H) continue;

		// Shade once per face: key + fill lambert, rim from the view vector.
		const kd = Math.max(0, nx * KEY[0] + ny * KEY[1] + nz * KEY[2]);
		const fd = Math.max(0, nx * FILL[0] + ny * FILL[1] + nz * FILL[2]);
		const rim = Math.pow(1 - Math.min(1, nz), 3) * 0.35;
		const light = AMBIENT + kd * 0.78 + fd * 0.22;
		const tr = Math.min(1, T[t * 3] * light + rim);
		const tg = Math.min(1, T[t * 3 + 1] * light + rim);
		const tb = Math.min(1, T[t * 3 + 2] * light + rim * 1.15);

		fillTriangle(v, W, H, minX, maxX, minY, maxY, hit, rgb, depth, tr, tg, tb);
	}
	return frame;
}

function fillTriangle(v, W, H, minX, maxX, minY, maxY, hit, rgb, depth, r, g, b) {
	const x0 = v[0], y0 = v[1], z0 = v[2];
	const x1 = v[3], y1 = v[4], z1 = v[5];
	const x2 = v[6], y2 = v[7], z2 = v[8];
	const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
	if (Math.abs(area) < 1e-9) return;
	const invArea = 1 / area;
	const ys = Math.max(0, Math.floor(minY)), ye = Math.min(H - 1, Math.ceil(maxY));
	const xs = Math.max(0, Math.floor(minX)), xe = Math.min(W - 1, Math.ceil(maxX));
	for (let py = ys; py <= ye; py++) {
		const cy = py + 0.5;
		for (let px = xs; px <= xe; px++) {
			const cx = px + 0.5;
			let w0 = ((x1 - cx) * (y2 - cy) - (x2 - cx) * (y1 - cy)) * invArea;
			let w1 = ((x2 - cx) * (y0 - cy) - (x0 - cx) * (y2 - cy)) * invArea;
			let w2 = 1 - w0 - w1;
			if (w0 < 0 || w1 < 0 || w2 < 0) continue;
			const z = w0 * z0 + w1 * z1 + w2 * z2;
			const i = py * W + px;
			if (z >= depth[i]) continue;
			depth[i] = z;
			hit[i] = 1;
			rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b;
		}
	}
}
