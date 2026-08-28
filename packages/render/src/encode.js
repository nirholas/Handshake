/**
 * Image encoders with no native dependency.
 * -----------------------------------------
 * PNG for stills and APNG for animation, both written straight from RGBA with
 * node's zlib. APNG rather than GIF on purpose: GIF would quantize a rendered
 * avatar to 256 colours and hard-edge its alpha, while APNG keeps the full
 * 24-bit render and the soft contact shadow, and every current browser plays it.
 */

import zlib from 'node:zlib';

const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	CRC_TABLE[n] = c;
}

function crc32(buf) {
	let c = -1;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ -1) >>> 0;
}

function chunk(type, data) {
	const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
	const out = Buffer.allocUnsafe(body.length + 8);
	out.writeUInt32BE(data.length, 0);
	body.copy(out, 4);
	out.writeUInt32BE(crc32(body), out.length - 4);
	return out;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function ihdr(width, height) {
	const data = Buffer.alloc(13);
	data.writeUInt32BE(width, 0);
	data.writeUInt32BE(height, 4);
	data[8] = 8; // bit depth
	data[9] = 6; // truecolour with alpha
	return chunk('IHDR', data);
}

/** Filter scanlines with the Paeth predictor and deflate the result. */
function compressScanlines({ width, height, data }, level) {
	const stride = width * 4;
	const raw = Buffer.allocUnsafe((stride + 1) * height);
	let pos = 0;
	for (let y = 0; y < height; y++) {
		raw[pos++] = 4; // Paeth
		const row = y * stride;
		const prev = row - stride;
		for (let x = 0; x < stride; x++) {
			const value = data[row + x];
			const left = x >= 4 ? data[row + x - 4] : 0;
			const up = y > 0 ? data[prev + x] : 0;
			const upLeft = y > 0 && x >= 4 ? data[prev + x - 4] : 0;
			const p = left + up - upLeft;
			const pa = Math.abs(p - left);
			const pb = Math.abs(p - up);
			const pc = Math.abs(p - upLeft);
			const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
			raw[pos++] = (value - predictor) & 0xff;
		}
	}
	return zlib.deflateSync(raw, { level });
}

/**
 * Encode one RGBA frame as PNG.
 * @param {{width:number,height:number,data:Uint8ClampedArray}} frame
 */
export function encodePng(frame, { level = 6 } = {}) {
	return Buffer.concat([
		SIGNATURE,
		ihdr(frame.width, frame.height),
		chunk('IDAT', compressScanlines(frame, level)),
		chunk('IEND', Buffer.alloc(0)),
	]);
}

function fcTL(sequence, width, height, delayNum, delayDen) {
	const data = Buffer.alloc(26);
	data.writeUInt32BE(sequence, 0);
	data.writeUInt32BE(width, 4);
	data.writeUInt32BE(height, 8);
	data.writeUInt32BE(0, 12); // x offset
	data.writeUInt32BE(0, 16); // y offset
	data.writeUInt16BE(delayNum, 20);
	data.writeUInt16BE(delayDen, 22);
	data[24] = 0; // dispose: none
	data[25] = 0; // blend: source
	return chunk('fcTL', data);
}

/**
 * Encode a frame list as an animated PNG.
 * @param {Array<{width:number,height:number,data:Uint8ClampedArray}>} frames
 */
export function encodeApng(frames, { fps = 24, loops = 0, level = 6 } = {}) {
	if (!frames.length) throw new Error('encodeApng needs at least one frame');
	const { width, height } = frames[0];
	const delayDen = 1000;
	const delayNum = Math.max(1, Math.round(delayDen / fps));

	const parts = [SIGNATURE, ihdr(width, height)];
	const actl = Buffer.alloc(8);
	actl.writeUInt32BE(frames.length, 0);
	actl.writeUInt32BE(loops, 4);
	parts.push(chunk('acTL', actl));

	let sequence = 0;
	for (let i = 0; i < frames.length; i++) {
		const frame = frames[i];
		if (frame.width !== width || frame.height !== height) {
			throw new Error('every APNG frame must share the first frame size');
		}
		parts.push(fcTL(sequence++, width, height, delayNum, delayDen));
		const compressed = compressScanlines(frame, level);
		if (i === 0) {
			parts.push(chunk('IDAT', compressed));
		} else {
			const fdat = Buffer.allocUnsafe(compressed.length + 4);
			fdat.writeUInt32BE(sequence++, 0);
			compressed.copy(fdat, 4);
			parts.push(chunk('fdAT', fdat));
		}
	}
	parts.push(chunk('IEND', Buffer.alloc(0)));
	return Buffer.concat(parts);
}
