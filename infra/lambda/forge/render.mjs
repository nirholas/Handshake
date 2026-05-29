// Zero-dependency software 3D renderer → PNG, for social-card preview images.
//
// No GPU, no canvas lib: we project the forged mesh with a fixed studio camera,
// shade it (diffuse + rim + per-vertex color), z-buffer the triangles into an
// RGBA framebuffer over a branded gradient, then encode a PNG by hand using
// Node's built-in zlib for the IDAT stream. Used by GET /api/og?seed=… so a
// shared link unfurls on X / iMessage / Discord with the actual sculpture.

import { deflateSync } from 'node:zlib';
import { forgeRaw } from './forge.mjs';

// ── CRC32 (PNG chunk checksums) ──────────────────────────────────────────────
const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();
function crc32(buf) {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length, 0);
	const typeBuf = Buffer.from(type, 'ascii');
	const body = Buffer.concat([typeBuf, data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body), 0);
	return Buffer.concat([len, body, crc]);
}
function encodePng(width, height, rgba) {
	// Prefix each scanline with filter byte 0 (none).
	const stride = width * 4;
	const raw = Buffer.alloc((stride + 1) * height);
	for (let y = 0; y < height; y++) {
		raw[y * (stride + 1)] = 0;
		rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // color type RGBA
	ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk('IHDR', ihdr),
		pngChunk('IDAT', deflateSync(raw, { level: 6 })),
		pngChunk('IEND', Buffer.alloc(0)),
	]);
}

// ── Vector helpers ───────────────────────────────────────────────────────────
function rotateY(x, y, z, a) { const c = Math.cos(a), s = Math.sin(a); return [c * x + s * z, y, -s * x + c * z]; }
function rotateX(x, y, z, a) { const c = Math.cos(a), s = Math.sin(a); return [x, c * y - s * z, s * y + c * z]; }

// ── Render ───────────────────────────────────────────────────────────────────
export function renderCardPng(seed, { width = 1200, height = 630, res = 90 } = {}) {
	const { mesh, traits } = forgeRaw(seed, res);
	const { positions, normals, colors, indices, vCount } = mesh;
	const { finish } = traits._p;

	const rgba = Buffer.alloc(width * height * 4);
	const zbuf = new Float32Array(width * height).fill(Infinity);

	// Branded background: vertical gradient + soft radial glow in the finish hue.
	const [gr, gg, gb] = hslToRgb(finish.hue + traits._p.hueShift, finish.sat * 0.7, 0.5);
	const cxg = width * 0.62, cyg = height * 0.42, glowR = height * 0.85;
	for (let y = 0; y < height; y++) {
		const tY = y / height;
		const topR = 12, topG = 14, topB = 22, botR = 5, botG = 6, botB = 10;
		for (let x = 0; x < width; x++) {
			const d = Math.hypot(x - cxg, y - cyg) / glowR;
			const glow = Math.max(0, 1 - d) ** 2 * 0.5;
			const i = (y * width + x) * 4;
			rgba[i] = Math.min(255, (topR + (botR - topR) * tY) + gr * 255 * glow);
			rgba[i + 1] = Math.min(255, (topG + (botG - topG) * tY) + gg * 255 * glow);
			rgba[i + 2] = Math.min(255, (topB + (botB - topB) * tY) + gb * 255 * glow);
			rgba[i + 3] = 255;
		}
	}

	// Project verts with a fixed 3/4 studio angle (model is centered, maxDim≈2).
	const yaw = 0.7, pitch = -0.45;
	const scale = height * 0.34; // world→pixel
	const ox = width * 0.5, oy = height * 0.5;
	const sx = new Float32Array(vCount), sy = new Float32Array(vCount), sz = new Float32Array(vCount);
	const nx = new Float32Array(vCount), ny = new Float32Array(vCount), nz = new Float32Array(vCount);
	for (let v = 0; v < vCount; v++) {
		let [x, y, z] = rotateX(...rotateY(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2], yaw), pitch);
		sx[v] = ox + x * scale;
		sy[v] = oy - y * scale;
		sz[v] = z;
		let [a, b, c] = rotateX(...rotateY(normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2], yaw), pitch);
		nx[v] = a; ny[v] = b; nz[v] = c;
	}

	// Lighting
	const L = (() => { const v = [0.4, 0.7, 0.6]; const m = Math.hypot(...v); return [v[0] / m, v[1] / m, v[2] / m]; })();
	const emiss = finish.glow ? finish.emissive : 0;

	// Rasterize triangles with a z-buffer.
	for (let t = 0; t < indices.length; t += 3) {
		const i0 = indices[t], i1 = indices[t + 1], i2 = indices[t + 2];
		const x0 = sx[i0], y0 = sy[i0], x1 = sx[i1], y1 = sy[i1], x2 = sx[i2], y2 = sy[i2];
		const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
		const maxX = Math.min(width - 1, Math.ceil(Math.max(x0, x1, x2)));
		const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
		const maxY = Math.min(height - 1, Math.ceil(Math.max(y0, y1, y2)));
		if (minX > maxX || minY > maxY) continue;
		const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
		if (area === 0) continue;
		const inv = 1 / area;
		for (let py = minY; py <= maxY; py++) {
			for (let px = minX; px <= maxX; px++) {
				const fx = px + 0.5, fy = py + 0.5;
				let w0 = ((x1 - fx) * (y2 - fy) - (x2 - fx) * (y1 - fy)) * inv;
				let w1 = ((x2 - fx) * (y0 - fy) - (x0 - fx) * (y2 - fy)) * inv;
				let w2 = 1 - w0 - w1;
				if (w0 < 0 || w1 < 0 || w2 < 0) continue;
				const z = w0 * sz[i0] + w1 * sz[i1] + w2 * sz[i2];
				const zi = py * width + px;
				if (z >= zbuf[zi]) continue;
				zbuf[zi] = z;
				// interpolate normal + color
				let n0 = w0 * nx[i0] + w1 * nx[i1] + w2 * nx[i2];
				let n1 = w0 * ny[i0] + w1 * ny[i1] + w2 * ny[i2];
				let n2 = w0 * nz[i0] + w1 * nz[i1] + w2 * nz[i2];
				const nlen = Math.hypot(n0, n1, n2) || 1; n0 /= nlen; n1 /= nlen; n2 /= nlen;
				const diff = Math.max(0, n0 * L[0] + n1 * L[1] + n2 * L[2]);
				const rim = Math.pow(1 - Math.max(0, n2), 2.2) * 0.6; // facing-away glow edge
				const shade = 0.22 + 0.85 * diff + rim;
				const cr = colors[i0 * 4] * w0 + colors[i1 * 4] * w1 + colors[i2 * 4] * w2;
				const cg = colors[i0 * 4 + 1] * w0 + colors[i1 * 4 + 1] * w1 + colors[i2 * 4 + 1] * w2;
				const cb = colors[i0 * 4 + 2] * w0 + colors[i1 * 4 + 2] * w1 + colors[i2 * 4 + 2] * w2;
				const i = zi * 4;
				rgba[i] = Math.min(255, cr * shade + cr * emiss * 0.25);
				rgba[i + 1] = Math.min(255, cg * shade + cg * emiss * 0.25);
				rgba[i + 2] = Math.min(255, cb * shade + cb * emiss * 0.25);
				rgba[i + 3] = 255;
			}
		}
	}

	const { _p, ...pub } = traits;
	return { png: encodePng(width, height, rgba), traits: pub };
}

// local copy (render is self-contained; mirrors forge.mjs)
function hslToRgb(h, s, l) {
	h = ((h % 360) + 360) % 360 / 360;
	const a = s * Math.min(l, 1 - l);
	const f = (n) => { const k = (n + h * 12) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
	return [f(0), f(8), f(4)];
}
