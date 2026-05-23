// GET /api/sns?name=<label>[.sol]      → resolve .sol → owner base58
// GET /api/sns?address=<base58>        → reverse-lookup wallet → primary .sol
//
// Public, rate-limited per IP. Both directions are cached in-process for
// 5 minutes (negative results for 60s) so repeated UX previews don't hammer
// the Bonfida RPC pool. Mainnet only — SNS is not deployed on devnet.

import { cors, error, json, method, wrap } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { resolveSnsName, reverseLookupAddress } from '../src/solana/sns.js';

// Accept a bare label (`nick`), a top-level domain (`nick.sol`), or any depth
// of subdomain (`nich.threews.sol`). Each segment is the SNS label rule:
// 1–63 chars of [a-z0-9-]. SNS itself enforces semantic validity on-chain.
const NAME_RE = /^[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})*(?:\.sol)?$/i;
const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const POSITIVE_TTL_MS = 5 * 60_000;
const NEGATIVE_TTL_MS = 60_000;

const forwardCache = new Map(); // name → { value, expiresAt }
const reverseCache = new Map(); // address → { value, expiresAt }

function getCached(map, key) {
	const hit = map.get(key);
	if (!hit) return undefined;
	if (Date.now() > hit.expiresAt) {
		map.delete(key);
		return undefined;
	}
	return hit.value;
}

function setCached(map, key, value) {
	const ttl = value ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS;
	map.set(key, { value, expiresAt: Date.now() + ttl });
}

function normalizeName(input) {
	const trimmed = String(input || '').trim().toLowerCase();
	if (!NAME_RE.test(trimmed)) return null;
	// Bonfida `resolve()` accepts subdomain dotted form (`nich.threews`) without
	// the `.sol` suffix; strip it once if present.
	return trimmed.endsWith('.sol') ? trimmed.slice(0, -4) : trimmed;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.snsResolve(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const url = new URL(req.url, 'http://x');
	const rawName = url.searchParams.get('name');
	const rawAddr = url.searchParams.get('address');

	if (rawName && rawAddr) {
		return error(res, 400, 'validation_error', 'pass either name or address, not both');
	}

	if (rawName) {
		const bare = normalizeName(rawName);
		if (!bare) return error(res, 400, 'validation_error', 'name must be a [a-z0-9-]{1,63} label or dotted subdomain, optionally ending in .sol');
		const domain = `${bare}.sol`;
		let address = getCached(forwardCache, bare);
		if (address === undefined) {
			address = await resolveSnsName(bare);
			setCached(forwardCache, bare, address);
		}
		if (!address) {
			return json(res, 404, {
				error: 'not_found',
				error_description: `${domain} does not resolve`,
			}, { 'cache-control': 'public, max-age=30' });
		}
		return json(res, 200, { data: { name: domain, address, network: 'solana' } }, {
			'cache-control': 'public, max-age=300',
		});
	}

	if (rawAddr) {
		const addr = rawAddr.trim();
		if (!ADDR_RE.test(addr)) return error(res, 400, 'validation_error', 'address must be a base58 Solana public key');
		let name = getCached(reverseCache, addr);
		if (name === undefined) {
			name = await reverseLookupAddress(addr);
			setCached(reverseCache, addr, name);
		}
		if (!name) {
			return json(res, 404, {
				error: 'not_found',
				error_description: 'no primary .sol domain set for this address',
			}, { 'cache-control': 'public, max-age=30' });
		}
		return json(res, 200, { data: { name, address: addr, network: 'solana' } }, {
			'cache-control': 'public, max-age=300',
		});
	}

	return error(res, 400, 'validation_error', 'pass ?name=foo.sol or ?address=<base58>');
});

// Exported for unit tests. Not part of the public HTTP surface.
export const _internals = { forwardCache, reverseCache, normalizeName };
