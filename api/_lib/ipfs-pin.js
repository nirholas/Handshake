/**
 * IPFS transport helper: the single entry point for putting bytes on IPFS and
 * for reading them back out of the public gateway network.
 *
 * Pump.fun's own frontend pins coin images and metadata JSON to IPFS (via
 * Pinata) and points the on-chain `uri` at `https://ipfs.io/ipfs/{cid}`.
 * Matching that flow keeps three.ws launches indistinguishable from native
 * ones to wallets, explorers, and aggregators that fetch the metadata.
 *
 * Provider order mirrors api/pinning/[action].js: Pinata (preferred),
 * web3.storage (fallback). When neither is configured, returns null so callers
 * fall back to R2 HTTPS hosting, a valid metadata URI but not a CID.
 */

import { fetchUpstream } from './upstream-fetch.js';

const PINATA_FILE_ENDPOINT = 'https://api.pinata.cloud/pinning/pinFileToIPFS';
const WEB3_STORAGE_ENDPOINT = 'https://api.web3.storage/upload';

/** @returns {string} the public IPFS gateway URL pump.fun uses for a CID. */
export function ipfsGatewayUrl(cid) {
	return `https://ipfs.io/ipfs/${cid}`;
}

/**
 * Gateways tried when reading content-addressed bytes back off IPFS.
 *
 * Two properties matter and they pull in opposite directions, so the list
 * carries both kinds. The public gateways come first because verification is
 * only meaningful if it does not route through us or our vendor. The pinning
 * provider's own gateway comes last as the guaranteed-complete copy: a freshly
 * pinned CID takes minutes to hours to propagate across the DHT, and until it
 * does the public gateways answer 504 for a document that is perfectly pinned.
 *
 * Deliberately absent: cloudflare-ipfs.com and cf-ipfs.com (Cloudflare retired
 * both in 2024, so they fail DNS, see src/ipfs.js) and flk-ipfs.xyz (no longer
 * accepting connections). A dead host in a fallback chain is worse than no
 * fallback: it burns the retry budget and reports a network error as a miss.
 */
export const IPFS_READ_GATEWAYS = [
	'https://ipfs.io/ipfs/',
	'https://dweb.link/ipfs/',
	'https://w3s.link/ipfs/',
	'https://gateway.pinata.cloud/ipfs/',
];

// Sized against measured cold reads of a freshly pinned manifest: the provider
// gateway answered in 6 to 12 seconds across repeated samples. A 15s budget put
// the slowest of those within 3s of being cut off and reported as unretrievable,
// which is the one outcome this path must not produce for a document that is
// genuinely pinned. Because the gateways race, this budget is only ever paid in
// full when every one of them fails.
const GATEWAY_TIMEOUT_MS = 25000;

/**
 * Fetch a CID from every gateway at once and take the first usable answer.
 *
 * Concurrent on purpose. Walking the list serially makes the slowest gateway
 * the floor on every read: a cold CID that one gateway serves in 6s would sit
 * behind two 15s timeouts first, and a caller that gave up at 30s would call a
 * retrievable document unretrievable.
 *
 * @param {string} cid
 * @param {object} [opts]
 * @param {number} [opts.maxBytes=1048576] reject bodies larger than this
 * @param {string[]} [opts.gateways] override the gateway list (tests)
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{text:string, gateway:string}>}
 * @throws {Error & {code:'gateway_unreachable'}} when no gateway serves it
 */
export async function fetchFromGateways(cid, { maxBytes = 1024 * 1024, gateways, timeoutMs } = {}) {
	const list = gateways?.length ? gateways : IPFS_READ_GATEWAYS;
	const budget = timeoutMs || GATEWAY_TIMEOUT_MS;
	const failures = [];

	const attempt = async (gateway) => {
		const url = `${gateway}${cid}`;
		const resp = await fetch(url, {
			redirect: 'follow',
			headers: { accept: 'application/json' },
			signal: AbortSignal.timeout(budget),
		});
		if (!resp.ok) throw new Error(`${resp.status}`);
		if (Number(resp.headers.get('content-length') || 0) > maxBytes) throw new Error('too_large');
		const text = await resp.text();
		if (text.length > maxBytes) throw new Error('too_large');
		return { text, gateway: url };
	};

	// Promise.any resolves on the first fulfilment and only rejects once every
	// attempt has failed, which is exactly the semantics wanted here.
	try {
		return await Promise.any(
			list.map((gateway) =>
				attempt(gateway).catch((err) => {
					failures.push(`${gateway} ${err?.message || 'error'}`);
					throw err;
				}),
			),
		);
	} catch {
		throw Object.assign(new Error(`no IPFS gateway served ${cid}: ${failures.join('; ')}`), {
			code: 'gateway_unreachable',
		});
	}
}

// Bounded so a hung provider cannot hold an interactive request (persona save
// pins inline) open until the platform's own request timeout fires. A pin is
// content-addressed, so a second attempt after a network failure is safe: the
// same bytes yield the same CID. Each provider carries its own breaker so a
// dead host fails fast and the chain moves on instead of paying the deadline
// on every request during its outage.
const PIN_TIMEOUT_MS = 30_000;
const PIN_ATTEMPTS = 2;

async function pinViaPinata(buf, filename) {
	const form = new FormData();
	form.append('file', new Blob([buf]), filename);
	const resp = await fetchUpstream(PINATA_FILE_ENDPOINT, {
		method: 'POST',
		headers: { Authorization: `Bearer ${process.env.PINATA_JWT}` },
		body: form,
	}, { name: 'ipfs:pinata', timeoutMs: PIN_TIMEOUT_MS, attempts: PIN_ATTEMPTS, okWhen: () => true });
	if (!resp.ok) {
		const detail = await resp.text().catch(() => '');
		throw Object.assign(new Error(`Pinata error ${resp.status}`), { status: 502, detail });
	}
	const data = await resp.json();
	return { cid: data.IpfsHash, provider: 'pinata' };
}

async function pinViaWeb3Storage(buf, filename) {
	const resp = await fetchUpstream(WEB3_STORAGE_ENDPOINT, {
		method: 'POST',
		headers: { Authorization: `Bearer ${process.env.WEB3_STORAGE_TOKEN}`, 'X-NAME': filename },
		body: buf,
	}, { name: 'ipfs:web3.storage', timeoutMs: PIN_TIMEOUT_MS, attempts: PIN_ATTEMPTS, okWhen: () => true });
	if (!resp.ok) {
		const detail = await resp.text().catch(() => '');
		throw Object.assign(new Error(`Web3.Storage error ${resp.status}`), { status: 502, detail });
	}
	const data = await resp.json();
	return { cid: data.cid, provider: 'web3.storage' };
}

/** True when at least one IPFS pinning provider is configured. */
export function ipfsPinningConfigured() {
	return Boolean(process.env.PINATA_JWT || process.env.WEB3_STORAGE_TOKEN);
}

/**
 * Pin a buffer to IPFS through every configured provider in order (Pinata,
 * then web3.storage) until one answers with a CID. A provider that is down,
 * rate limited, or past its deadline is logged and the next rung is tried; the
 * error thrown when the whole chain fails carries the last rung's status and
 * detail so the caller reports the true cause.
 *
 * @param {Buffer} buf
 * @param {string} filename
 * @returns {Promise<{cid: string, uri: string, provider: string} | null>}
 *   the pinned CID + gateway URI, or null when no provider is configured.
 */
export async function pinToIPFS(buf, filename) {
	const rungs = [];
	if (process.env.PINATA_JWT) rungs.push(pinViaPinata);
	if (process.env.WEB3_STORAGE_TOKEN) rungs.push(pinViaWeb3Storage);
	if (!rungs.length) return null;
	let lastErr;
	for (const rung of rungs) {
		try {
			const { cid, provider } = await rung(buf, filename);
			return { cid, uri: ipfsGatewayUrl(cid), provider };
		} catch (err) {
			lastErr = err;
			if (rungs.length > 1) console.warn(`[ipfs-pin] ${filename}: ${err?.message || err}; trying next provider`);
		}
	}
	throw lastErr;
}

/**
 * Pin a JSON document (metadata, manifests) through the same provider chain.
 *
 * @param {object} doc
 * @param {string} filename
 * @returns {Promise<{cid: string, uri: string, provider: string} | null>}
 */
export function pinJsonToIPFS(doc, filename) {
	return pinToIPFS(Buffer.from(JSON.stringify(doc), 'utf-8'), filename);
}
