/**
 * A software rasterizer for skinned avatars.
 * ------------------------------------------
 * Scanline triangle fill with a z-buffer, perspective-correct varyings,
 * trilinear texture sampling off CPU mip pyramids, an opaque pass followed by
 * a depth-tested back-to-front transparent pass, a planar projected contact
 * shadow, and a supersampled resolve through an ACES-style tonemap.
 *
 * Everything works on plain typed arrays. There is no GPU, no WebGL context,
 * no canvas and no browser anywhere in this path.
 */

const EPSILON = 1e-6;
const NEAR_W = 1e-4;

const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
	const c = i / 255;
	SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(c) {
	if (c <= 0) return 0;
	if (c >= 1) return 255;
	const v = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
	return Math.max(0, Math.min(255, Math.round(v * 255)));
}

// Narkowicz's ACES fit. Keeps bright skin and emissive highlights from
// clipping to flat white the way a naive clamp does.
function tonemap(x) {
	const a = 2.51;
	const b = 0.03;
	const c = 2.43;
	const d = 0.59;
	const e = 0.14;
	return Math.max(0, Math.min(1, (x * (a * x + b)) / (x * (c * x + d) + e)));
}

function wrapCoord(value, size, mode) {
	if (mode === 'clamp') return Math.max(0, Math.min(size - 1, value));
	if (mode === 'mirror') {
		const period = size * 2;
		let v = ((value % period) + period) % period;
		if (v >= size) v = period - 1 - v;
		return v;
	}
	let v = value % size;
	if (v < 0) v += size;
	return v;
}

function sampleLevel(level, u, v, wrapS, wrapT, out) {
	const { width, height, data } = level;
	const x = u * width - 0.5;
	const y = v * height - 0.5;
	const x0 = Math.floor(x);
	const y0 = Math.floor(y);
	const fx = x - x0;
	const fy = y - y0;
	const xa = wrapCoord(x0, width, wrapS);
	const xb = wrapCoord(x0 + 1, width, wrapS);
	const ya = wrapCoord(y0, height, wrapT);
	const yb = wrapCoord(y0 + 1, height, wrapT);
	const i00 = (ya * width + xa) * 4;
	const i10 = (ya * width + xb) * 4;
	const i01 = (yb * width + xa) * 4;
	const i11 = (yb * width + xb) * 4;
	const w00 = (1 - fx) * (1 - fy);
	const w10 = fx * (1 - fy);
	const w01 = (1 - fx) * fy;
	const w11 = fx * fy;
	for (let k = 0; k < 3; k++) {
		out[k] =
			SRGB_TO_LINEAR[data[i00 + k]] * w00 +
			SRGB_TO_LINEAR[data[i10 + k]] * w10 +
			SRGB_TO_LINEAR[data[i01 + k]] * w01 +
			SRGB_TO_LINEAR[data[i11 + k]] * w11;
	}
	out[3] = (data[i00 + 3] * w00 + data[i10 + 3] * w10 + data[i01 + 3] * w01 + data[i11 + 3] * w11) / 255;
}

const _texA = new Float32Array(4);
const _texB = new Float32Array(4);

/** Trilinear sample across a mip pyramid. `lod` is a continuous mip level. */
export function sampleTexture(mips, lod, u, v, wrapS, wrapT, out) {
	const maxLevel = mips.length - 1;
	const clamped = Math.max(0, Math.min(maxLevel, lod));
	const base = Math.floor(clamped);
	const frac = clamped - base;
	sampleLevel(mips[base], u, v, wrapS, wrapT, _texA);
	if (frac <= 0.001 || base >= maxLevel) {
		out[0] = _texA[0];
		out[1] = _texA[1];
		out[2] = _texA[2];
		out[3] = _texA[3];
		return;
	}
	sampleLevel(mips[base + 1], u, v, wrapS, wrapT, _texB);
	for (let k = 0; k < 4; k++) out[k] = _texA[k] * (1 - frac) + _texB[k] * frac;
}

/** Colour, depth and coverage targets for one supersampled render. */
export class Framebuffer {
	constructor(width, height) {
		this.width = width;
		this.height = height;
		this.color = new Float32Array(width * height * 3);
		this.alpha = new Float32Array(width * height);
		this.depth = new Float32Array(width * height).fill(Infinity);
		this.shadow = new Float32Array(width * height);
	}
}

function lerpVertex(a, b, t, stride) {
	const out = new Float32Array(stride);
	for (let i = 0; i < stride; i++) out[i] = a[i] + (b[i] - a[i]) * t;
	return out;
}

// Vertex layout inside the clipper: clip xyzw, world xyz, normal xyz, uv, rgb.
const V_STRIDE = 15;

function clipNear(tri) {
	const out = [];
	for (let i = 0; i < 3; i++) {
		const current = tri[i];
		const next = tri[(i + 1) % 3];
		const cIn = current[3] > NEAR_W;
		const nIn = next[3] > NEAR_W;
		if (cIn) out.push(current);
		if (cIn !== nIn) {
			const t = (NEAR_W - current[3]) / (next[3] - current[3]);
			out.push(lerpVertex(current, next, t, V_STRIDE));
		}
	}
	if (out.length < 3) return [];
	if (out.length === 3) return [out];
	return [
		[out[0], out[1], out[2]],
		[out[0], out[2], out[3]],
	];
}

/**
 * Draw one triangle. Vertices are packed float arrays in the V_STRIDE layout,
 * already in clip space:
 *   0..3   clip x, y, z, w
 *   4..6   world x, y, z
 *   7..9   world normal x, y, z
 *   10..11 uv
 *   12..14 vertex colour rgb
 */
function drawTriangle(fb, verts, material, ctx) {
	const { width, height } = fb;
	const needsClip = verts[0][3] <= NEAR_W || verts[1][3] <= NEAR_W || verts[2][3] <= NEAR_W;
	const pieces = needsClip ? clipNear(verts) : [verts];

	for (const piece of pieces) {
		const sx = new Float64Array(3);
		const sy = new Float64Array(3);
		const invW = new Float64Array(3);
		const depth = new Float64Array(3);
		for (let i = 0; i < 3; i++) {
			const v = piece[i];
			const iw = 1 / v[3];
			invW[i] = iw;
			sx[i] = (v[0] * iw * 0.5 + 0.5) * width;
			sy[i] = (0.5 - v[1] * iw * 0.5) * height;
			depth[i] = v[2] * iw;
		}

		const area = (sx[1] - sx[0]) * (sy[2] - sy[0]) - (sx[2] - sx[0]) * (sy[1] - sy[0]);
		if (!Number.isFinite(area) || Math.abs(area) < EPSILON) continue;

		// glTF front faces are counter-clockwise in a right-handed, Y-up NDC.
		// Screen space flips Y, so a front face lands here with a NEGATIVE
		// signed area under this cross product. Getting this backwards renders
		// the inside of the mesh: the silhouette still looks right and every
		// normal points away from the camera, which reads as a washed-out
		// rim-lit ghost rather than an obvious error.
		const facing = area < 0 ? 1 : -1;
		if (facing < 0 && !material.doubleSided) continue;

		const minX = Math.max(0, Math.floor(Math.min(sx[0], sx[1], sx[2])));
		const maxX = Math.min(width - 1, Math.ceil(Math.max(sx[0], sx[1], sx[2])));
		const minY = Math.max(0, Math.floor(Math.min(sy[0], sy[1], sy[2])));
		const maxY = Math.min(height - 1, Math.ceil(Math.max(sy[0], sy[1], sy[2])));
		if (minX > maxX || minY > maxY) continue;

		const invArea = 1 / area;

		// Texture level of detail from the UV-area to screen-area ratio. One
		// value per triangle: cheap, and stable enough that a 1k skin atlas
		// stops shimmering when the avatar turns.
		let lod = 0;
		const mips = material.mips;
		if (mips) {
			const u0 = piece[0][10];
			const v0 = piece[0][11];
			const uvArea = Math.abs(
				(piece[1][10] - u0) * (piece[2][11] - v0) - (piece[2][10] - u0) * (piece[1][11] - v0),
			);
			const texels = uvArea * mips[0].width * mips[0].height;
			const pixels = Math.abs(area);
			if (pixels > EPSILON && texels > EPSILON) lod = 0.5 * Math.log2(texels / pixels);
		}

		const color = fb.color;
		const alpha = fb.alpha;
		const depthBuffer = fb.depth;
		const { lights, cameraPos, ambient, texel } = ctx;
		const depthWrite = ctx.depthWrite;
		const blend = ctx.blend;
		const baseFactor = material.baseColorFactor;
		const emissive = material.emissive;
		const roughness = material.roughness;
		const shininess = 2 + 180 * (1 - roughness) * (1 - roughness);
		const specScale = 1 - roughness * 0.85;
		const alphaMode = material.alphaMode;
		const cutoff = material.alphaCutoff;

		for (let py = minY; py <= maxY; py++) {
			const pyc = py + 0.5;
			for (let px = minX; px <= maxX; px++) {
				const pxc = px + 0.5;
				const w0 = ((sx[1] - pxc) * (sy[2] - pyc) - (sx[2] - pxc) * (sy[1] - pyc)) * invArea;
				if (w0 < 0) continue;
				const w1 = ((sx[2] - pxc) * (sy[0] - pyc) - (sx[0] - pxc) * (sy[2] - pyc)) * invArea;
				if (w1 < 0) continue;
				const w2 = 1 - w0 - w1;
				if (w2 < 0) continue;

				const idx = py * width + px;
				const z = w0 * depth[0] + w1 * depth[1] + w2 * depth[2];
				if (z >= depthBuffer[idx]) continue;

				const iw = w0 * invW[0] + w1 * invW[1] + w2 * invW[2];
				if (iw <= 0) continue;
				const persp = 1 / iw;
				const pw0 = w0 * invW[0] * persp;
				const pw1 = w1 * invW[1] * persp;
				const pw2 = w2 * invW[2] * persp;

				let r = baseFactor[0];
				let g = baseFactor[1];
				let b = baseFactor[2];
				let a = baseFactor[3];

				if (mips) {
					const u = pw0 * piece[0][10] + pw1 * piece[1][10] + pw2 * piece[2][10];
					const v = pw0 * piece[0][11] + pw1 * piece[1][11] + pw2 * piece[2][11];
					sampleTexture(mips, lod, u, v, material.wrapS, material.wrapT, texel);
					r *= texel[0];
					g *= texel[1];
					b *= texel[2];
					a *= texel[3];
				}

				if (material.hasVertexColor) {
					r *= pw0 * piece[0][12] + pw1 * piece[1][12] + pw2 * piece[2][12];
					g *= pw0 * piece[0][13] + pw1 * piece[1][13] + pw2 * piece[2][13];
					b *= pw0 * piece[0][14] + pw1 * piece[1][14] + pw2 * piece[2][14];
				}

				if (alphaMode === 'MASK') {
					if (a < cutoff) continue;
					a = 1;
				} else if (alphaMode === 'OPAQUE') {
					a = 1;
				}
				if (a <= 0.003) continue;

				let nx = pw0 * piece[0][7] + pw1 * piece[1][7] + pw2 * piece[2][7];
				let ny = pw0 * piece[0][8] + pw1 * piece[1][8] + pw2 * piece[2][8];
				let nz = pw0 * piece[0][9] + pw1 * piece[1][9] + pw2 * piece[2][9];
				const nlen = Math.hypot(nx, ny, nz) || 1;
				const nscale = facing / nlen;
				nx *= nscale;
				ny *= nscale;
				nz *= nscale;

				const wx = pw0 * piece[0][4] + pw1 * piece[1][4] + pw2 * piece[2][4];
				const wy = pw0 * piece[0][5] + pw1 * piece[1][5] + pw2 * piece[2][5];
				const wz = pw0 * piece[0][6] + pw1 * piece[1][6] + pw2 * piece[2][6];

				let vx = cameraPos[0] - wx;
				let vy = cameraPos[1] - wy;
				let vz = cameraPos[2] - wz;
				const vlen = Math.hypot(vx, vy, vz) || 1;
				vx /= vlen;
				vy /= vlen;
				vz /= vlen;

				let lr = ambient[0];
				let lg = ambient[1];
				let lb = ambient[2];
				for (let li = 0; li < lights.length; li++) {
					const light = lights[li];
					const ndl = nx * light.dir[0] + ny * light.dir[1] + nz * light.dir[2];
					const diffuse = light.wrap ? Math.max(0, (ndl + light.wrap) / (1 + light.wrap)) : Math.max(0, ndl);
					if (diffuse <= 0) continue;
					lr += light.color[0] * diffuse;
					lg += light.color[1] * diffuse;
					lb += light.color[2] * diffuse;

					if (light.specular > 0) {
						let hx = light.dir[0] + vx;
						let hy = light.dir[1] + vy;
						let hz = light.dir[2] + vz;
						const hlen = Math.hypot(hx, hy, hz) || 1;
						hx /= hlen;
						hy /= hlen;
						hz /= hlen;
						const ndh = Math.max(0, nx * hx + ny * hy + nz * hz);
						const spec = ndh ** shininess * light.specular * specScale;
						lr += light.color[0] * spec;
						lg += light.color[1] * spec;
						lb += light.color[2] * spec;
					}
				}

				const ndv = Math.max(0, nx * vx + ny * vy + nz * vz);
				const rim = (1 - ndv) ** 3 * ctx.rimStrength;

				const outR = r * lr + emissive[0] + rim * ctx.rimColor[0];
				const outG = g * lg + emissive[1] + rim * ctx.rimColor[1];
				const outB = b * lb + emissive[2] + rim * ctx.rimColor[2];

				const ci = idx * 3;
				if (blend && a < 1) {
					const inv = 1 - a;
					color[ci] = color[ci] * inv + outR * a;
					color[ci + 1] = color[ci + 1] * inv + outG * a;
					color[ci + 2] = color[ci + 2] * inv + outB * a;
					alpha[idx] = alpha[idx] * inv + a;
				} else {
					color[ci] = outR;
					color[ci + 1] = outG;
					color[ci + 2] = outB;
					alpha[idx] = 1;
				}
				if (depthWrite) depthBuffer[idx] = z;
			}
		}
	}
}

export { drawTriangle, V_STRIDE, linearToSrgb, tonemap, SRGB_TO_LINEAR };
