/**
 * A3S reader - isomorphic. Runs in a browser against a plain CDN URL, and in
 * Node against bytes you already hold.
 *
 * The reader exists to make the format's one round-trip promise real. Opening a
 * stream issues a single ranged GET for the head of the file, which in practice
 * carries the preamble, the header, and the entire base layer. From that one
 * response the caller already has a complete GLB to render. Everything after is
 * optional refinement the caller pulls when it wants it.
 *
 * No custom server is required anywhere in this path. `Range` is a 1997 HTTP
 * feature that every CDN, object store, and static host already implements.
 */

import { PREAMBLE_BYTES, RECOMMENDED_PREFIX_BYTES, decodeHeader, decodePreamble } from './format.js';

/** A byte source backed by an in-memory buffer. */
export function bytesSource(bytes) {
	const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	return {
		size: u8.byteLength,
		async read(start, end) {
			return u8.subarray(start, Math.min(end + 1, u8.byteLength));
		},
	};
}

/**
 * A byte source backed by HTTP range requests.
 *
 * A server that ignores `Range` and returns 200 with the whole body is handled
 * rather than trusted: the full body is sliced locally so the reader still
 * works, just without the bandwidth saving.
 */
export function httpSource(url, { fetch: fetchImpl = globalThis.fetch, headers = {} } = {}) {
	if (typeof fetchImpl !== 'function') {
		throw new Error('a3s: no fetch implementation available');
	}
	return {
		size: null,
		async read(start, end) {
			const response = await fetchImpl(url, {
				headers: { ...headers, Range: `bytes=${start}-${end}` },
			});
			if (!response.ok) {
				throw new Error(`a3s: ${response.status} ${response.statusText} fetching ${url}`);
			}
			const buffer = new Uint8Array(await response.arrayBuffer());
			if (response.status === 206) return buffer;
			// 200: the host served the whole file, so slice out what was asked for.
			return buffer.subarray(start, Math.min(end + 1, buffer.byteLength));
		},
	};
}

/** Hash bytes with SubtleCrypto, which both modern browsers and Node expose. */
async function sha256Hex(bytes) {
	const subtle = globalThis.crypto?.subtle;
	if (!subtle) return null;
	const view = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
	const digest = await subtle.digest('SHA-256', view);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

export class A3SStream {
	constructor(source, preamble, header, base) {
		this.source = source;
		this.preamble = preamble;
		this.header = header;
		/** @type {Uint8Array} layer 0: a complete, spec-valid GLB */
		this.base = base;
	}

	/**
	 * Open a stream and fetch its base layer in a single request.
	 *
	 * @param {string|Uint8Array|object} target URL, bytes, or a custom source
	 * @param {object} [options]
	 * @param {number} [options.prefixBytes] how much of the head to request
	 * @param {boolean} [options.verify] check the base layer against its recorded hash
	 */
	static async open(target, options = {}) {
		const source =
			typeof target === 'string'
				? httpSource(target, options)
				: target instanceof Uint8Array || target instanceof ArrayBuffer
					? bytesSource(target)
					: target;
		const prefixBytes = options.prefixBytes || RECOMMENDED_PREFIX_BYTES;

		let head = await source.read(0, prefixBytes - 1);
		if (head.byteLength < PREAMBLE_BYTES) {
			throw new Error('a3s: stream is shorter than a preamble');
		}
		const preamble = decodePreamble(head);

		// One more request only if the first guess undershot the head. For the
		// platform's avatar corpus this branch is not taken.
		const needed = preamble.baseOffset + preamble.baseLength;
		if (head.byteLength < needed) {
			head = await source.read(0, needed - 1);
		}
		const header = decodeHeader(head, preamble);
		const base = head.subarray(preamble.baseOffset, preamble.baseOffset + preamble.baseLength);

		if (options.verify) {
			const actual = await sha256Hex(base);
			const expected = header.layers[0].sha256;
			if (actual && expected && actual !== expected) {
				throw new Error('a3s: base layer failed integrity check');
			}
		}
		return new A3SStream(source, preamble, header, base);
	}

	/** Total number of layers, base included. */
	get layerCount() {
		return this.header.layers.length;
	}

	/** Bytes a client must read to render layer `level`, base included. */
	bytesThroughLayer(level) {
		const layer = this.header.layers[level];
		return layer.offset + layer.length;
	}

	/**
	 * Fetch one refinement layer.
	 * @param {number} level 1-based; level 0 is already in `.base`
	 * @param {object} [options]
	 * @param {boolean} [options.verify]
	 * @returns {Promise<{ level: number, descriptor: object, payload: Uint8Array }>}
	 */
	async layer(level, options = {}) {
		const descriptor = this.header.layers[level];
		if (!descriptor) throw new Error(`a3s: no layer ${level}`);
		if (level === 0) return { level, descriptor, payload: this.base };
		const payload = await this.source.read(descriptor.offset, descriptor.offset + descriptor.length - 1);
		if (options.verify) {
			const actual = await sha256Hex(payload);
			if (actual && descriptor.sha256 && actual !== descriptor.sha256) {
				throw new Error(`a3s: layer ${level} failed integrity check`);
			}
		}
		return { level, descriptor, payload };
	}

	/**
	 * Iterate refinement layers coarse to fine, one request at a time, so the
	 * caller can render between layers instead of waiting for all of them.
	 */
	async *layers(options = {}) {
		for (let level = 1; level < this.layerCount; level++) {
			yield await this.layer(level, options);
		}
	}

	/**
	 * Read a patch's chunk as raw bytes, given a descriptor entry that carries
	 * `{ offset, length }` relative to the patch payload.
	 */
	static chunk(payload, entry) {
		return payload.subarray(entry.offset, entry.offset + entry.length);
	}
}
