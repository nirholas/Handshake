/**
 * MemoryPinner — content-addressed in-memory pinner.
 *
 * No network calls, no credentials needed. Computes the real CIDv1 raw-codec
 * + sha2-256 multihash for the bytes — so the CID it returns is verifiable
 * IPFS content-addressing. The bytes themselves are kept in an in-memory Map
 * for the session, retrievable via memoryFetch(cid).
 *
 * The CID is real IPFS, but the storage is local-only — if you publish the
 * CID and the consumer's gateway hasn't seen those bytes, they won't resolve.
 * Use a real pinning provider (web3-storage, pinata, filebase) for any
 * content that needs to be retrievable outside this process.
 */

import { CID } from 'multiformats/cid';
import * as raw from 'multiformats/codecs/raw';
import { sha256 } from 'multiformats/hashes/sha2';

/** @type {Map<string, Uint8Array>} */
const _store = new Map();

async function _toBytes(blob) {
	return blob instanceof Uint8Array ? blob : new Uint8Array(await blob.arrayBuffer());
}

async function _realCid(bytes) {
	const digest = await sha256.digest(bytes);
	return CID.create(1, raw.code, digest).toString();
}

export class MemoryPinner {
	/**
	 * @param {Blob|Uint8Array} blob
	 * @returns {Promise<{cid: string, size: number}>}
	 */
	async pinBlob(blob, _opts = {}) {
		const bytes = await _toBytes(blob);
		const cid = await _realCid(bytes);
		_store.set(cid, bytes);
		return { cid, size: bytes.length };
	}

	/**
	 * Pins each file under its CID and an index keyed by dirCid. Resolve
	 * individual files with memoryFetch(dirCid, 'path/to/file').
	 *
	 * @param {Array<{path: string, data: Blob|Uint8Array}>} files
	 * @returns {Promise<{cid: string, size: number}>}
	 */
	async pinDirectory(files, _opts = {}) {
		const index = {};
		let totalSize = 0;

		for (const { path, data } of files) {
			const bytes = await _toBytes(data);
			const cid = await _realCid(bytes);
			_store.set(cid, bytes);
			index[path] = cid;
			totalSize += bytes.length;
		}

		const indexBytes = new TextEncoder().encode(JSON.stringify(index));
		const dirCid = await _realCid(indexBytes);
		// Store both the index JSON and a sentinel suffix so memoryFetch can
		// distinguish "fetch the index" from "fetch a file inside the dir".
		_store.set(dirCid, indexBytes);
		_store.set(dirCid + '/\x00index', indexBytes);
		return { cid: dirCid, size: totalSize };
	}

	/**
	 * Remove pinned content from the in-memory store.
	 * @param {string} cid
	 */
	async unpin(cid) {
		_store.delete(cid);
		_store.delete(cid + '/\x00index');
	}
}

/**
 * Fetch content pinned by MemoryPinner.
 *
 * @param {string} cid        A CID returned by pinBlob or pinDirectory
 * @param {string} [path]     File path within a pinned directory
 * @returns {Uint8Array|null}
 */
export function memoryFetch(cid, path) {
	if (!path) return _store.get(cid) ?? null;

	const indexBytes = _store.get(cid + '/\x00index');
	if (!indexBytes) return null;
	const index = JSON.parse(new TextDecoder().decode(indexBytes));
	const fileCid = index[path];
	return fileCid ? (_store.get(fileCid) ?? null) : null;
}

/** Wipe the entire in-memory store (useful between tests). */
export function memoryClear() {
	_store.clear();
}

// Back-compat aliases — keep external import sites unbroken while callers
// migrate. The shape and behaviour are unchanged; only the names improved
// and the CIDs are now real IPFS content-addresses instead of fake.
export { MemoryPinner as NullDevPinner };
export { memoryFetch as nullDevFetch };
export { memoryClear as nullDevClear };
