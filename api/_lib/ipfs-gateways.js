// Multi-gateway reads for content-addressed URIs (ipfs://, ar://).
//
// Every server-side site that resolved `ipfs://` or `ar://` to ONE public
// gateway (ipfs.io, arweave.net) went dark with that gateway: an ERC-8004
// registration lost its name and avatar, a token's off-chain metadata came
// back null, an on-chain agent card failed to load. Content addressing means
// any gateway serves identical bytes, so a read should walk an ordered list
// and take the first answer.
//
// The IPFS list is the one api/_lib/ipfs-pin.js verifies manifests against
// (imported, not copied) plus 4everland, the extra mirror api/img.js races.
// cloudflare-ipfs.com / cf-ipfs.com (retired 2024) and flk-ipfs.xyz (refusing
// connections) are deliberately absent: a dead host in a ladder burns the
// timeout budget and reports a network error as a miss.

import { IPFS_READ_GATEWAYS } from './ipfs-pin.js';
import { fetchFirst } from '../../src/shared/failover-fetch.js';

/** Ordered IPFS gateway prefixes (each ends in `/ipfs/`). */
export const IPFS_GATEWAYS = [...IPFS_READ_GATEWAYS, 'https://4everland.io/ipfs/'];

/** Ordered Arweave gateway prefixes (each ends in `/`). */
export const ARWEAVE_GATEWAYS = [
	'https://arweave.net/',
	'https://ar-io.net/',
	'https://arweave.dev/',
];

const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * Pull the `<cid>/<path?>` portion out of an `ipfs://` URI or any
 * `https://<gateway>/ipfs/<cid>` URL so it can be re-pointed at every gateway.
 * @param {string} uri
 * @returns {string|null}
 */
export function ipfsPath(uri) {
	if (uri.startsWith('ipfs://')) return uri.slice('ipfs://'.length).replace(/^ipfs\//, '') || null;
	const m = /^https?:\/\/[^/]+\/ipfs\/(.+)$/.exec(uri);
	return m ? m[1] : null;
}

/**
 * Ordered https URLs to try for one logical URI. Plain https URLs that are not
 * gateway-addressed come back as a single-element list; anything else (empty,
 * unsupported scheme) is an empty list.
 *
 * @param {string} uri
 * @returns {string[]}
 */
export function gatewayCandidates(uri) {
	const raw = typeof uri === 'string' ? uri.trim() : '';
	if (!raw) return [];
	const cidPath = ipfsPath(raw);
	if (cidPath) return IPFS_GATEWAYS.map((g) => g + cidPath);
	if (raw.startsWith('ar://')) {
		const id = raw.slice('ar://'.length);
		return id ? ARWEAVE_GATEWAYS.map((g) => g + id) : [];
	}
	if (/^https?:\/\//.test(raw)) return [raw];
	return [];
}

/**
 * Walk the candidates with a caller-supplied fetcher (an SSRF-pinned fetch,
 * for example) and return the first result the caller accepts. `attempt`
 * receives one URL and must resolve to a value or throw; a null/undefined
 * result is treated as a miss and the walk continues.
 *
 * @template T
 * @param {string} uri
 * @param {(url: string) => Promise<T>} attempt
 * @param {{ label?: string }} [opts]
 * @returns {Promise<{ value: T, url: string }>}
 */
export async function walkGateways(uri, attempt, { label = 'gateway' } = {}) {
	const urls = gatewayCandidates(uri);
	if (!urls.length) {
		throw Object.assign(new Error(`${label}: unsupported uri`), { code: 'unsupported_uri' });
	}
	const failures = [];
	for (const url of urls) {
		try {
			const value = await attempt(url);
			if (value !== null && value !== undefined) return { value, url };
			failures.push(`${url}: miss`);
		} catch (err) {
			failures.push(`${url}: ${err?.message || err}`);
		}
	}
	throw Object.assign(new Error(`${label}: no gateway served ${uri} (${failures.join('; ')})`), {
		code: 'gateway_unreachable',
		status: 502,
	});
}

/**
 * Fetch a URI across every gateway in order (fetchFirst: per-attempt timeout,
 * per-host cooldown after a failure) and return the response body.
 *
 * @param {string} uri
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.maxBytes=2097152] reject bodies larger than this
 * @param {'json'|'text'} [opts.as='json']
 * @param {Record<string,string>} [opts.headers]
 * @returns {Promise<{ value: any, url: string }>}
 */
export async function fetchFromGateways(uri, { timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = 2 * 1024 * 1024, as = 'json', headers } = {}) {
	const urls = gatewayCandidates(uri);
	if (!urls.length) {
		throw Object.assign(new Error(`gateway: unsupported uri ${uri}`), { code: 'unsupported_uri' });
	}
	const parse = async (res) => {
		if (Number(res.headers.get('content-length') || 0) > maxBytes) throw new Error('too_large');
		const text = await res.text();
		if (text.length > maxBytes) throw new Error('too_large');
		if (as === 'text') return text;
		return JSON.parse(text);
	};
	const providers = urls.map((url) => ({
		name: new URL(url).host,
		url,
		init: { redirect: 'follow', headers: { accept: 'application/json, */*', ...(headers || {}) } },
		parse,
	}));
	const { value, source } = await fetchFirst(providers, { timeoutMs, label: 'ipfs-gateways' });
	return { value, url: urls.find((u) => new URL(u).host === source) || urls[0] };
}
