/**
 * Pinata pinning backend.
 *
 * API docs — https://docs.pinata.cloud/api-reference/endpoint/ipfs/pin-file-to-ipfs
 * Auth:       Authorization: Bearer <JWT>
 *
 * pinBlob:      POST /pinning/pinFileToIPFS  (FormData, single file)
 * pinDirectory: POST /pinning/pinFileToIPFS  (FormData, multiple files + wrapWithDirectory)
 * unpin:        DELETE /pinning/unpin/:cid
 */

import { withRetry, fetchWithProgress, statusError } from './_retry.js';

const BASE = 'https://api.pinata.cloud';

export class PinataPinner {
	/**
	 * @param {object} opts
	 * @param {string} opts.token  Pinata JWT
	 */
	constructor({ token } = {}) {
		this._token = token || '';
	}

	/** @returns {object} */
	_headers() {
		return { Authorization: `Bearer ${this._token}` };
	}

	/**
	 * @param {Blob|Uint8Array} blob
	 * @param {{name?: string, wrapInDir?: boolean, onProgress?: function(number): void}=} opts
	 * @returns {Promise<{cid: string, size: number}>}
	 */
	async pinBlob(blob, opts = {}) {
		const { name = 'upload', wrapInDir = false, onProgress } = opts;
		const form = new FormData();
		const file = blob instanceof Uint8Array ? new Blob([blob]) : blob;
		form.append('file', file, name);
		form.append('pinataMetadata', JSON.stringify({ name }));
		if (wrapInDir) {
			form.append('pinataOptions', JSON.stringify({ wrapWithDirectory: true }));
		}

		const size = blob instanceof Uint8Array ? blob.length : blob.size;

		const res = await withRetry(() =>
			fetchWithProgress(`${BASE}/pinning/pinFileToIPFS`, {
				method: 'POST',
				headers: this._headers(),
				body: form,
				onProgress,
			}).then(async (r) => {
				if (!r.ok) {
					const body = await r.text().catch(() => '');
					throw statusError(r.status, `Pinata upload failed (${r.status}): ${body}`);
				}
				return r;
			}),
		);

		const data = await res.json();
		return { cid: data.IpfsHash, size };
	}

	/**
	 * Upload a set of files as an IPFS directory.
	 * Returns a directory-wrapped CID; individual files resolve as {cid}/{path}.
	 *
	 * @param {Array<{path: string, data: Blob|Uint8Array}>} files
	 * @param {{name?: string, onProgress?: function(number): void}=} opts
	 * @returns {Promise<{cid: string, size: number}>}
	 */
	async pinDirectory(files, opts = {}) {
		const { name = 'directory', onProgress } = opts;
		const form = new FormData();
		let totalSize = 0;

		for (const { path, data } of files) {
			const blob = data instanceof Uint8Array ? new Blob([data]) : data;
			totalSize += blob.size;
			// Pinata treats the filename as the path within the directory
			form.append('file', blob, path);
		}

		form.append('pinataMetadata', JSON.stringify({ name }));
		form.append('pinataOptions', JSON.stringify({ wrapWithDirectory: true }));

		const res = await withRetry(() =>
			fetchWithProgress(`${BASE}/pinning/pinFileToIPFS`, {
				method: 'POST',
				headers: this._headers(),
				body: form,
				onProgress,
			}).then(async (r) => {
				if (!r.ok) {
					const body = await r.text().catch(() => '');
					throw statusError(
						r.status,
						`Pinata directory upload failed (${r.status}): ${body}`,
					);
				}
				return r;
			}),
		);

		const data = await res.json();
		return { cid: data.IpfsHash, size: totalSize };
	}

	/**
	 * @param {string} cid
	 * @returns {Promise<void>}
	 */
	async unpin(cid) {
		const res = await withRetry(() =>
			fetch(`${BASE}/pinning/unpin/${cid}`, {
				method: 'DELETE',
				headers: this._headers(),
				signal: AbortSignal.timeout(15_000),
			}).then(async (r) => {
				if (!r.ok) {
					const body = await r.text().catch(() => '');
					throw statusError(r.status, `Pinata unpin failed (${r.status}): ${body}`);
				}
				return r;
			}),
		);
		return res;
	}
}
