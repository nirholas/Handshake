// Canonical ENS resolution for the platform: one implementation, one round trip.
//
// Every ENS call site used to build its own ethers provider and call
// `resolveName` / `lookupAddress` with its own timeout (8s in /api/v1/resolve,
// 5s in the x402 identity-claim verifier, 3s in /api/agents/ens/:name). That
// pattern has two problems, and together they took ENS resolution down in
// production on 2026-07-29:
//
//   1. ethers' resolveName is a WALK, not a call: registry lookup, then
//      resolver address, then supportsInterface, then addr(). Four sequential
//      round trips, each independently failing over across the endpoint list.
//   2. The endpoint list led with an operator override that Cloudflare
//      bot-walls with a 403, so every one of those round trips paid for a
//      guaranteed failure first.
//
// Measured on the keyless public endpoints (how production runs, with no
// Alchemy key on the service): the walk took 9.7-12.4s and blew every budget
// above. The ENS Universal Resolver answers the same question in ONE eth_call:
// 269ms forward, 234ms reverse, and a name that does not exist comes back as a
// clean miss instead of a timeout. It also handles wildcard and CCIP-read
// resolution, which the hand-rolled walk got wrong.
//
// Misses and failures are different answers and are reported differently:
// a miss RETURNS null ("this name has no address"), a failure THROWS
// ("we could not ask"). Call sites that only care whether they got an address
// can catch and coalesce; call sites that owe the caller an accurate status
// code (404 vs 503) keep the distinction.

import { createPublicClient } from 'viem';
import { mainnet } from 'viem/chains';
import { normalize } from 'viem/ens';
import { evmTransport } from './rpc.js';
import { env } from '../env.js';

// One eth_call per direction, so the budget buys failover across endpoints
// rather than sequential protocol round trips. Each endpoint gets its own
// slice before the transport moves on.
const DEFAULT_TIMEOUT_MS = 8000;
const ENDPOINT_TIMEOUT_MS = 2500;

/** viem client on the Universal Resolver, over the shared failover transport. */
function ensClient(endpointTimeoutMs = ENDPOINT_TIMEOUT_MS) {
	return createPublicClient({
		chain: mainnet, // ENS is a mainnet-only registry
		transport: evmTransport(1, {
			primaryUrl: env.MAINNET_RPC_URL,
			timeout: endpointTimeoutMs,
			retryCount: 0, // failing over to the next endpoint beats retrying a bad one
		}),
	});
}

function withDeadline(promise, ms, label) {
	let timer;
	const deadline = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label}_timeout`)), ms);
	});
	return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Forward ENS resolution: name -> checksummed address.
 *
 * @param {string} name           e.g. "vitalik.eth"
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=8000] Overall budget for the lookup.
 * @returns {Promise<string|null>} the address, or null when the name resolves
 *   to nothing (a miss, not an error).
 * @throws when no endpoint could answer, so callers can tell "does not exist"
 *   apart from "could not check".
 */
export async function ensResolveAddress(name, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
	const normalized = normalize(String(name).trim().toLowerCase());
	return withDeadline(ensClient().getEnsAddress({ name: normalized }), timeoutMs, 'ens');
}

/**
 * Reverse ENS resolution: address -> primary name.
 *
 * Note this is the address owner's self-declared primary name. viem verifies
 * the forward record matches before returning it, so a spoofed reverse record
 * resolves to null rather than a name the address does not actually own.
 *
 * @param {string} address        0x-prefixed EVM address
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=8000]
 * @returns {Promise<string|null>} the primary name, or null when there is none.
 * @throws when no endpoint could answer.
 */
export async function ensLookupName(address, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
	return withDeadline(ensClient().getEnsName({ address }), timeoutMs, 'ens_reverse');
}
