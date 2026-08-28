/**
 * Texture decoding and mip pyramids.
 * ----------------------------------
 * PNG is decoded in-process with zlib (no native dependency), which covers
 * most glTF avatar textures. JPEG and everything else goes through sharp when
 * it is installed. A texture that cannot be decoded is reported as null and
 * the renderer falls back to the material's base colour factor.
 *
 * Every decoded texture carries a box-filtered mip pyramid. The rasterizer
 * picks a level per triangle from its UV-area to screen-area ratio, which is
 * what keeps a 2048px skin texture from boiling into noise on a 96px avatar.
 */

import zlib from 'node:zlib';

// Cache the promise, not a resolved flag: decodeImage is called concurrently
// for every texture in a model, and a flag would hand the losers of that race
// an undefined module while the winner is still awaiting the import.
let sharpPromise;

function loadSharp() {
	if (!sharpPromise) {
		sharpPromise = import('sharp').then(
			(mod) => mod.default || mod,
			() => null,
		);
	}
	return sharpPromise;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function isPng(bytes) {
	if (bytes.length < 8) return false;
	for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_MAGIC[i]) return false;
	return true;
}

function paethPredictor(a, b, c) {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	if (pa <= pb && pa <= pc) return a;
	if (pb <= pc) return b;
	return c;
}

/** Minimal PNG decoder: 8-bit greyscale, RGB, palette and alpha variants. */
export function decodePng(bytes) {
	if (!isPng(bytes)) return null;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let offset = 8;
	let width = 0;
	let height = 0;
	let bitDepth = 8;
	let colorType = 6;
	let interlace = 0;
	let palette = null;
	let transparency = null;
	const idat = [];

	while (offset + 8 <= bytes.length) {
		const length = view.getUint32(offset);
		const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
		const start = offset + 8;
		if (type === 'IHDR') {
			width = view.getUint32(start);
			height = view.getUint32(start + 4);
			bitDepth = bytes[start + 8];
			colorType = bytes[start + 9];
			interlace = bytes[start + 12];
		} else if (type === 'PLTE') {
			palette = bytes.subarray(start, start + length);
		} else if (type === 'tRNS') {
			transparency = bytes.subarray(start, start + length);
		} else if (type === 'IDAT') {
			idat.push(bytes.subarray(start, start + length));
		} else if (type === 'IEND') {
			break;
		}
		offset = start + length + 4;
	}

	if (!width || !height || bitDepth !== 8 || interlace !== 0) return null;

	const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
	if (!channels) return null;
	if (colorType === 3 && !palette) return null;

	const raw = zlib.inflateSync(Buffer.concat(idat.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))));
	const stride = width * channels;
	const pixels = new Uint8Array(height * stride);

	let pos = 0;
	for (let y = 0; y < height; y++) {
		const filter = raw[pos++];
		const rowStart = y * stride;
		const prevStart = rowStart - stride;
		for (let x = 0; x < stride; x++) {
			const value = raw[pos + x];
			const left = x >= channels ? pixels[rowStart + x - channels] : 0;
			const up = y > 0 ? pixels[prevStart + x] : 0;
			const upLeft = y > 0 && x >= channels ? pixels[prevStart + x - channels] : 0;
			let out;
			switch (filter) {
				case 0: out = value; break;
				case 1: out = value + left; break;
				case 2: out = value + up; break;
				case 3: out = value + ((left + up) >> 1); break;
				case 4: out = value + paethPredictor(left, up, upLeft); break;
				default: return null;
			}
			pixels[rowStart + x] = out & 0xff;
		}
		pos += stride;
	}

	const rgba = new Uint8Array(width * height * 4);
	for (let i = 0, n = width * height; i < n; i++) {
		const s = i * channels;
		const d = i * 4;
		if (colorType === 0) {
			rgba[d] = rgba[d + 1] = rgba[d + 2] = pixels[s];
			rgba[d + 3] = 255;
		} else if (colorType === 4) {
			rgba[d] = rgba[d + 1] = rgba[d + 2] = pixels[s];
			rgba[d + 3] = pixels[s + 1];
		} else if (colorType === 2) {
			rgba[d] = pixels[s];
			rgba[d + 1] = pixels[s + 1];
			rgba[d + 2] = pixels[s + 2];
			rgba[d + 3] = 255;
		} else if (colorType === 6) {
			rgba[d] = pixels[s];
			rgba[d + 1] = pixels[s + 1];
			rgba[d + 2] = pixels[s + 2];
			rgba[d + 3] = pixels[s + 3];
		} else {
			const idx = pixels[s];
			rgba[d] = palette[idx * 3];
			rgba[d + 1] = palette[idx * 3 + 1];
			rgba[d + 2] = palette[idx * 3 + 2];
			rgba[d + 3] = transparency && idx < transparency.length ? transparency[idx] : 255;
		}
	}
	return { width, height, data: rgba };
}

/**
 * Decode an encoded texture into RGBA. `maxSize` caps the working resolution:
 * a 4096px skin atlas costs 64 MB of RGBA and buys nothing at avatar scale.
 */
export async function decodeImage(bytes, mimeType, { maxSize = 1024 } = {}) {
	let decoded = null;
	if (isPng(bytes)) {
		try {
			decoded = decodePng(bytes);
		} catch {
			decoded = null;
		}
	}
	if (!decoded) {
		const sharp = await loadSharp();
		if (!sharp) return null;
		try {
			const pipeline = sharp(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), {
				failOn: 'none',
				limitInputPixels: 32768 * 32768,
			});
			const meta = await pipeline.metadata();
			const scale = Math.max(meta.width || 1, meta.height || 1) > maxSize;
			const out = await (scale ? pipeline.resize({ width: maxSize, height: maxSize, fit: 'inside' }) : pipeline)
				.ensureAlpha()
				.raw()
				.toBuffer({ resolveWithObject: true });
			decoded = {
				width: out.info.width,
				height: out.info.height,
				data: new Uint8Array(out.data.buffer, out.data.byteOffset, out.data.byteLength),
			};
		} catch {
			return null;
		}
	}
	if (!decoded) return null;
	if (Math.max(decoded.width, decoded.height) > maxSize) decoded = downscaleTo(decoded, maxSize);
	void mimeType;
	return decoded;
}

function downscaleTo(image, maxSize) {
	let current = image;
	while (Math.max(current.width, current.height) > maxSize && current.width > 1 && current.height > 1) {
		current = halveImage(current);
	}
	return current;
}

/** Box-filter an image down to half size in each axis (odd sizes clamp). */
export function halveImage({ width, height, data }) {
	const w = Math.max(1, width >> 1);
	const h = Math.max(1, height >> 1);
	const out = new Uint8Array(w * h * 4);
	for (let y = 0; y < h; y++) {
		const y0 = Math.min(height - 1, y * 2);
		const y1 = Math.min(height - 1, y * 2 + 1);
		for (let x = 0; x < w; x++) {
			const x0 = Math.min(width - 1, x * 2);
			const x1 = Math.min(width - 1, x * 2 + 1);
			const a = (y0 * width + x0) * 4;
			const b = (y0 * width + x1) * 4;
			const c = (y1 * width + x0) * 4;
			const d = (y1 * width + x1) * 4;
			const o = (y * w + x) * 4;
			for (let k = 0; k < 4; k++) {
				out[o + k] = (data[a + k] + data[b + k] + data[c + k] + data[d + k] + 2) >> 2;
			}
		}
	}
	return { width: w, height: h, data: out };
}

/** Build a mip chain down to 1x1. Level 0 is the source image. */
export function buildMipmaps(image) {
	const levels = [image];
	let current = image;
	while (current.width > 1 || current.height > 1) {
		current = halveImage(current);
		levels.push(current);
	}
	return levels;
}
