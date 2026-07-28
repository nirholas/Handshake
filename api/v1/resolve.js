// GET /api/v1/resolve — free, keyless name resolution across ENS + SNS.
//
// Wraps the platform's existing resolvers instead of reimplementing them:
//   - .eth (ENS)  → ethers `resolveName` / `lookupAddress` via the shared EVM
//     failover provider (api/_lib/evm/rpc.js `evmFallbackProvider`) — the same
//     RPC chain api/agents/ens/[name].js already resolves ENS names through.
//   - .sol (SNS)  → `resolveSnsName` / `reverseLookupAddress` from
//     src/solana/sns.js — the exact module api/sns.js and api/sns-subdomain.js
//     already share. No Bonfida call is reimplemented here.
//
// Forward: ?name=<x>.eth | ?name=<x>.sol  → { name, chain, address, source }
// Reverse: ?address=<addr>[&chain=ethereum|solana] → { address, chain, name, source }
//   Reverse only runs the direction the underlying resolver already supports —
//   ethers' lookupAddress for ENS, SNS's getFavoriteDomain for SNS — both of
//   which the wrapped modules above already implement, so no half-built
//   placeholder direction is exposed.
//
// A miss is a 404 `not_found`, never a 500. An unsupported suffix/address
// format is a 400 naming the two supported suffixes/chains. Public, keyless,
// 30 req/min per IP (api/_lib/rate-limit.js `resolveIp`), 5-minute edge cache
// on hits (misses are never cached).

import { defineEndpoint, fail } from '../_lib/gateway.js';
import { rateLimited } from '../_lib/http.js';
import { limits } from '../_lib/rate-limit.js';
import { isValidSolanaAddress, isValidEvmAddress } from '../_lib/validate.js';
import { resolveSnsName, reverseLookupAddress } from '../../src/solana/sns.js';
import { evmFallbackProvider } from '../_lib/evm/rpc.js';
import { env } from '../_lib/env.js';

const ENS_RE = /^(?:[a-z0-9-]+\.)*[a-z0-9-]+\.eth$/i;
const SOL_NAME_RE = /^[a-z0-9-]{1,63}\.sol$/i;
const HIT_CACHE_CONTROL = 'public, max-age=300, s-maxage=300, stale-while-revalidate=60';
// ENS resolution is 2+ sequential eth_calls (resolver lookup, then resolve),
// each independently failing over across the endpoint list. 5s starved the
// chain when the lead endpoint rate-limited; 8s with a 1.2s stall lets three
// endpoints get a real shot per call. Hits are edge-cached, so the budget only
// costs on misses.
const ENS_TIMEOUT_MS = 8000;

// Ethereum mainnet (chainId 1) — ENS is a mainnet-only registry. Pin the
// operator's mainnet RPC first (same as api/agents/ens/[name].js) so prod
// never leads with a rate-limited public endpoint.
async function ensProvider() {
	return evmFallbackProvider(1, { primaryUrl: env.MAINNET_RPC_URL, stallTimeout: 1200 });
}

async function withEnsTimeout(promise, label) {
	const timeout = new Promise((_, reject) =>
		setTimeout(() => reject(new Error(`${label}_timeout`)), ENS_TIMEOUT_MS),
	);
	return Promise.race([promise, timeout]);
}

async function resolveForward(rawName, res) {
	const name = rawName.toLowerCase();

	if (ENS_RE.test(name)) {
		let address;
		try {
			const provider = await ensProvider();
			address = await withEnsTimeout(provider.resolveName(name), 'ens');
		} catch (err) {
			fail(
				503,
				'ens_unavailable',
				err?.message === 'ens_timeout'
					? 'ENS resolution timed out — retry shortly'
					: 'ENS resolution failed — retry shortly',
			);
		}
		if (!address) fail(404, 'not_found', `${name} did not resolve to an Ethereum address`);
		res.setHeader('cache-control', HIT_CACHE_CONTROL);
		return { name, chain: 'ethereum', address, source: 'ens' };
	}

	if (SOL_NAME_RE.test(name)) {
		const address = await resolveSnsName(name);
		if (!address) fail(404, 'not_found', `${name} did not resolve to a Solana address`);
		res.setHeader('cache-control', HIT_CACHE_CONTROL);
		return { name, chain: 'solana', address, source: 'sns' };
	}

	fail(
		400,
		'unsupported_suffix',
		'name must end in .eth (ENS) or .sol (SNS) — no other suffix is supported',
	);
}

async function resolveReverse(rawAddress, chainHint, res) {
	const isEvm = isValidEvmAddress(rawAddress);
	const isSol = isValidSolanaAddress(rawAddress);

	if (!isEvm && !isSol) {
		fail(400, 'validation_error', 'address must be a 0x… Ethereum address or a base58 Solana address');
	}
	if (chainHint && chainHint !== 'ethereum' && chainHint !== 'solana') {
		fail(400, 'validation_error', 'chain must be "ethereum" or "solana" when passed');
	}
	if (chainHint === 'ethereum' && !isEvm) {
		fail(400, 'validation_error', 'address is not a valid Ethereum address for chain=ethereum');
	}
	if (chainHint === 'solana' && !isSol) {
		fail(400, 'validation_error', 'address is not a valid Solana address for chain=solana');
	}

	if (isEvm) {
		let name;
		try {
			const provider = await ensProvider();
			name = await withEnsTimeout(provider.lookupAddress(rawAddress), 'ens_reverse');
		} catch (err) {
			fail(
				503,
				'ens_unavailable',
				err?.message === 'ens_reverse_timeout'
					? 'ENS reverse resolution timed out — retry shortly'
					: 'ENS reverse resolution failed — retry shortly',
			);
		}
		if (!name) fail(404, 'not_found', `${rawAddress} has no primary ENS name`);
		res.setHeader('cache-control', HIT_CACHE_CONTROL);
		return { address: rawAddress, chain: 'ethereum', name, source: 'ens' };
	}

	const name = await reverseLookupAddress(rawAddress);
	if (!name) fail(404, 'not_found', `${rawAddress} has no primary SNS domain`);
	res.setHeader('cache-control', HIT_CACHE_CONTROL);
	return { address: rawAddress, chain: 'solana', name, source: 'sns' };
}

export default defineEndpoint({
	name: 'v1.resolve',
	method: 'GET',
	auth: 'public',
	handler: async ({ res, query, ip }) => {
		// Dedicated per-IP budget on top of the gateway's shared apiV1 burst guard:
		// both ENS and SNS resolution fan out to real upstreams (RPC / Bonfida) on
		// a cache miss, so this caps a scripted enumeration flood.
		const rl = await limits.resolveIp(ip);
		if (!rl.success) return rateLimited(res, rl, 'name resolution is capped at 30 requests/min per IP');

		const rawName = typeof query.name === 'string' ? query.name.trim() : '';
		const rawAddress = typeof query.address === 'string' ? query.address.trim() : '';
		const chainHint = typeof query.chain === 'string' ? query.chain.trim().toLowerCase() : '';

		if (rawName && rawAddress) {
			fail(400, 'validation_error', 'pass either ?name or ?address, not both');
		}
		if (rawName) return resolveForward(rawName, res);
		if (rawAddress) return resolveReverse(rawAddress, chainHint, res);

		fail(
			400,
			'validation_error',
			'pass ?name=<x>.eth or ?name=<x>.sol to resolve a name, or ?address=<addr> to reverse-resolve one',
		);
	},
});
