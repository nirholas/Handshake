/**
 * A3S container format (`threews.a3s.v1`) - pure, isomorphic, zero-dependency.
 *
 * An A3S file is a single byte stream that holds one 3D asset at several levels
 * of detail, ordered coarsest-first, so that a *prefix* of the file is already a
 * complete renderable asset:
 *
 *   [ 32-byte preamble ][ header JSON ][ layer 0: a valid GLB ][ patch 1 ] ... [ patch N ]
 *
 * The layout is deliberate. Layer 0 is a standalone, spec-valid GLB, so
 * `curl --range 0-<baseEnd> model.a3s | tail -c +<baseOffset+1> > preview.glb`
 * opens in any glTF tool on earth. Every later layer is a patch that adds newly
 * revealed vertices and swaps in a finer index buffer. Because the packer orders
 * the vertex buffer so each level's vertices are a prefix of the next level's,
 * a patch never rewrites bytes the client already holds: it only appends.
 *
 * Reading this module does not pull in a mesh library, a glTF parser, or Node
 * built-ins. It is the one piece both the packer and the browser reader share.
 */

/** Magic bytes at offset 0: "A3S1". */
export const MAGIC = 0x31533341; // 'A','3','S','1' read little-endian as u32
export const MAGIC_STRING = 'A3S1';

/** Fixed size of the preamble, in bytes. */
export const PREAMBLE_BYTES = 32;

/** Format version encoded in the preamble. */
export const FORMAT_VERSION = 1;

/** Version string carried in the header JSON. */
export const VERSION_TAG = 'threews.a3s.v1';

/**
 * How many leading bytes a client should request to be confident it has the
 * preamble, the header, and (for a typical avatar) the whole base layer in a
 * single round trip. Tuned against the platform's avatar corpus.
 */
export const RECOMMENDED_PREFIX_BYTES = 96 * 1024;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Round `n` up to the next multiple of 4, so every chunk stays 4-byte aligned. */
export function align4(n) {
	return (n + 3) & ~3;
}

function asUint8(bytes) {
	if (bytes instanceof Uint8Array) return bytes;
	if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
	throw new TypeError('expected ArrayBuffer or typed array');
}

/**
 * Read the 32-byte preamble. This is all a client needs to know where the
 * header and the base layer live, and it is the only fixed-offset structure in
 * the format.
 *
 * @param {ArrayBuffer|Uint8Array} bytes at least PREAMBLE_BYTES long, starting at file offset 0
 */
export function decodePreamble(bytes) {
	const u8 = asUint8(bytes);
	if (u8.byteLength < PREAMBLE_BYTES) {
		throw new Error(`a3s: need at least ${PREAMBLE_BYTES} bytes to read the preamble, got ${u8.byteLength}`);
	}
	const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
	const magic = view.getUint32(0, true);
	if (magic !== MAGIC) {
		throw new Error('a3s: bad magic, this is not an A3S stream');
	}
	const formatVersion = view.getUint32(4, true);
	if (formatVersion !== FORMAT_VERSION) {
		throw new Error(`a3s: unsupported format version ${formatVersion} (this build reads ${FORMAT_VERSION})`);
	}
	return {
		formatVersion,
		headerOffset: view.getUint32(8, true),
		headerLength: view.getUint32(12, true),
		baseOffset: view.getUint32(16, true),
		baseLength: view.getUint32(20, true),
		layerCount: view.getUint32(24, true),
		totalLength: view.getUint32(28, true),
	};
}

/** Serialise a preamble object back to its 32 bytes. */
export function encodePreamble(p) {
	const out = new Uint8Array(PREAMBLE_BYTES);
	const view = new DataView(out.buffer);
	view.setUint32(0, MAGIC, true);
	view.setUint32(4, FORMAT_VERSION, true);
	view.setUint32(8, p.headerOffset, true);
	view.setUint32(12, p.headerLength, true);
	view.setUint32(16, p.baseOffset, true);
	view.setUint32(20, p.baseLength, true);
	view.setUint32(24, p.layerCount, true);
	view.setUint32(28, p.totalLength, true);
	return out;
}

/**
 * Parse the header JSON out of a byte range that covers it.
 *
 * @param {ArrayBuffer|Uint8Array} bytes a buffer whose index 0 is file offset `baseByteOffset`
 * @param {object} preamble as returned by decodePreamble
 * @param {number} [baseByteOffset] file offset of `bytes[0]` (0 when you passed the file head)
 */
export function decodeHeader(bytes, preamble, baseByteOffset = 0) {
	const u8 = asUint8(bytes);
	const start = preamble.headerOffset - baseByteOffset;
	const end = start + preamble.headerLength;
	if (start < 0 || end > u8.byteLength) {
		throw new Error('a3s: header is outside the supplied byte range, fetch more of the file head');
	}
	const header = JSON.parse(textDecoder.decode(u8.subarray(start, end)));
	if (header.version !== VERSION_TAG) {
		throw new Error(`a3s: unsupported header version ${header.version}`);
	}
	return header;
}

/**
 * Build a complete container from its parts.
 *
 * `header` is written verbatim except for the `layers[].offset` / `length`
 * fields, which are computed here so the header can never disagree with the
 * bytes that follow it. That single-source-of-truth rule is what lets a reader
 * trust the header without re-scanning the payload.
 *
 * @param {object} args
 * @param {object} args.header header JSON minus the layer offsets
 * @param {Uint8Array} args.baseGlb layer 0, a complete valid GLB
 * @param {Uint8Array[]} args.patches layers 1..N, in order
 * @returns {Uint8Array}
 */
export function encodeContainer({ header, baseGlb, patches = [] }) {
	const base = asUint8(baseGlb);
	const patchBytes = patches.map(asUint8);

	// Two passes: the header's byte length depends on the offsets it carries, and
	// the offsets depend on the header's byte length. Encode once with placeholder
	// offsets to learn the length, pad the header to a stable size, then fill in
	// the real offsets. Padding beats iterating to a fixed point.
	const layers = [{ ...header.layers[0] }, ...header.layers.slice(1).map((l) => ({ ...l }))];
	const draft = { ...header, layers };
	for (const layer of layers) {
		layer.offset = 0;
		layer.length = 0;
	}
	const probe = textEncoder.encode(JSON.stringify(draft));
	// Reserve generous slack so the real offsets always fit in the same space.
	const headerCapacity = align4(probe.byteLength + 24 * layers.length + 64);

	const headerOffset = PREAMBLE_BYTES;
	let cursor = align4(headerOffset + headerCapacity);
	const baseOffset = cursor;
	layers[0].offset = baseOffset;
	layers[0].length = base.byteLength;
	cursor = align4(cursor + base.byteLength);
	patchBytes.forEach((p, i) => {
		layers[i + 1].offset = cursor;
		layers[i + 1].length = p.byteLength;
		cursor = align4(cursor + p.byteLength);
	});
	const totalLength = cursor;

	const finalHeader = textEncoder.encode(JSON.stringify(draft));
	if (finalHeader.byteLength > headerCapacity) {
		throw new Error('a3s: header outgrew its reserved capacity');
	}

	const out = new Uint8Array(totalLength);
	out.set(
		encodePreamble({
			headerOffset,
			headerLength: finalHeader.byteLength,
			baseOffset,
			baseLength: base.byteLength,
			layerCount: layers.length,
			totalLength,
		}),
		0,
	);
	out.set(finalHeader, headerOffset);
	out.set(base, baseOffset);
	patchBytes.forEach((p, i) => out.set(p, layers[i + 1].offset));
	return out;
}

/**
 * The byte range a client should request to render layer `level`.
 * Layer 0's range starts at 0 because the client also needs preamble + header.
 */
export function rangeForLayer(header, preamble, level) {
	const layer = header.layers[level];
	if (!layer) throw new Error(`a3s: no layer ${level}`);
	if (level === 0) return { start: 0, end: preamble.baseOffset + preamble.baseLength - 1 };
	return { start: layer.offset, end: layer.offset + layer.length - 1 };
}

/** Format a `Range:` header value for a layer. */
export function rangeHeaderForLayer(header, preamble, level) {
	const { start, end } = rangeForLayer(header, preamble, level);
	return `bytes=${start}-${end}`;
}
