/**
 * Pluggable IPFS pinning abstraction.
 *
 * @typedef {object} Pinner
 * @property {function(Blob|Uint8Array, {name?: string, wrapInDir?: boolean, onProgress?: function(number): void}=): Promise<{cid: string, size: number}>} pinBlob
 * @property {function(Array<{path: string, data: Blob|Uint8Array}>, {onProgress?: function(number): void}=): Promise<{cid: string, size: number}>} pinDirectory
 * @property {function(string): Promise<void>} unpin
 */

import { Web3StoragePinner } from './web3-storage.js';
import { FilebasePinner } from './filebase.js';
import { PinataPinner } from './pinata.js';
import { MemoryPinner, NullDevPinner } from './null-dev.js';

const PROVIDERS = ['web3-storage', 'filebase', 'pinata', 'memory'];

/** @type {Pinner|null} */
let _defaultPinner = null;
let _autoFallbackWarned = false;

/**
 * Build a Pinner from a config object.
 *
 * @param {object} config
 * @param {'web3-storage'|'filebase'|'pinata'|'memory'|'null-dev'} [config.provider='web3-storage']
 *   'null-dev' is accepted as a back-compat alias for 'memory'.
 * @param {string} [config.token]         API key / JWT for web3-storage or pinata
 * @param {string} [config.accessKeyId]   Filebase S3 access key
 * @param {string} [config.secretAccessKey] Filebase S3 secret key
 * @param {string} [config.bucket]        Filebase bucket name
 * @returns {Pinner}
 */
export function createPinner(config = {}) {
	const { provider = 'web3-storage', ...opts } = config;
	switch (provider) {
		case 'web3-storage':
			return new Web3StoragePinner(opts);
		case 'filebase':
			return new FilebasePinner(opts);
		case 'pinata':
			return new PinataPinner(opts);
		case 'memory':
		case 'null-dev':
			return new MemoryPinner(opts);
		default:
			throw new Error(
				`Unknown pinning provider "${provider}". Supported: ${PROVIDERS.join(', ')}`,
			);
	}
}

/**
 * Get the process-wide default pinner.
 *
 * Initialisation order:
 *  1. Explicitly set via setPinner()
 *  2. window.__agent3dPinner (Pinner instance or config object)
 *  3. MemoryPinner — emits a one-time warning so it's never an accidental
 *     production default. CIDs are real IPFS content-addresses, but the
 *     bytes only live in this process and won't resolve from public gateways.
 *
 * @returns {Pinner}
 */
export function getPinner() {
	if (_defaultPinner) return _defaultPinner;

	if (typeof window !== 'undefined' && window.__agent3dPinner) {
		const cfg = window.__agent3dPinner;
		_defaultPinner = typeof cfg.pinBlob === 'function' ? cfg : createPinner(cfg);
		return _defaultPinner;
	}

	if (!_autoFallbackWarned) {
		_autoFallbackWarned = true;
		console.warn(
			'[pinning] No pinner configured — falling back to in-memory pinner. ' +
				'CIDs are real but content is local-only. ' +
				'Set window.__agent3dPinner or call setPinner() with a real provider for production.',
		);
	}
	_defaultPinner = new MemoryPinner();
	return _defaultPinner;
}

/**
 * Set the process-wide default pinner.
 * @param {Pinner} pinner
 */
export function setPinner(pinner) {
	_defaultPinner = pinner;
}

export { Web3StoragePinner, FilebasePinner, PinataPinner, MemoryPinner, NullDevPinner };
