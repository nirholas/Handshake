import { Connection, PublicKey } from '@solana/web3.js';

// `@bonfida/spl-name-service` re-exports a huge tree and trips Vercel's
// function bundler on cold start when statically imported by serverless
// endpoints. Load it on demand inside each call so the dispatcher modules
// (e.g. /api/portfolio, /api/pump-fun-mcp) don't pay the cost up front.

// Server-side: prefer SOLANA_RPC_URL (typically Helius). Browser-side: route
// through our same-origin proxy because public mainnet-beta 403s most origins.
const DEFAULT_RPC_URL =
	(typeof process !== 'undefined' && process.env?.SOLANA_RPC_URL) ||
	(typeof window !== 'undefined' && window.location?.origin
		? `${window.location.origin}/api/solana-rpc`
		: 'https://three.ws/api/solana-rpc');

function makeConnection() {
	return new Connection(DEFAULT_RPC_URL, 'confirmed');
}

function stripSol(name) {
	return name.endsWith('.sol') ? name.slice(0, -4) : name;
}

/**
 * Forward lookup: .sol domain name → owner wallet address (base58) or null.
 * @param {string} name - e.g. 'bonfida.sol' or 'bonfida'
 * @returns {Promise<string|null>}
 */
export async function resolveSnsName(name) {
	try {
		const { resolve } = await import('@bonfida/spl-name-service');
		const pk = await resolve(makeConnection(), stripSol(name));
		return pk.toBase58();
	} catch {
		return null;
	}
}

/**
 * Reverse lookup: wallet address (base58) → primary .sol domain name or null.
 * @param {string} addr - base58-encoded wallet public key
 * @returns {Promise<string|null>}
 */
export async function reverseLookupAddress(addr) {
	try {
		const { getFavoriteDomain } = await import('@bonfida/spl-name-service');
		const owner = new PublicKey(addr);
		const { reverse } = await getFavoriteDomain(makeConnection(), owner);
		return reverse.endsWith('.sol') ? reverse : `${reverse}.sol`;
	} catch {
		return null;
	}
}

const SOL_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
// Bare label, dotted subdomain (`nich.threews`), or either with a `.sol` suffix.
const SOL_NAME_RE = /^[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})*(?:\.sol)?$/i;

/**
 * Resolve a user-supplied Solana recipient string to a base58 address.
 *
 * Accepts:
 *   - a raw base58 address (returned as-is)
 *   - a .sol domain name with or without the suffix (resolved via SNS)
 *
 * @param {string} input
 * @returns {Promise<{ address: string|null, resolved_from: string|null }>}
 */
export async function resolveSolanaRecipient(input) {
	const trimmed = String(input || '').trim();
	if (SOL_ADDRESS_RE.test(trimmed)) {
		return { address: trimmed, resolved_from: null };
	}
	if (SOL_NAME_RE.test(trimmed)) {
		const bare = trimmed.toLowerCase().replace(/\.sol$/, '');
		const address = await resolveSnsName(bare);
		if (address && SOL_ADDRESS_RE.test(address)) {
			return { address, resolved_from: `${bare}.sol` };
		}
	}
	return { address: null, resolved_from: null };
}
