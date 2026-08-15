import { Connection, PublicKey } from '@solana/web3.js';

// `@bonfida/spl-name-service` re-exports a huge tree and trips Vercel's
// function bundler on cold start when statically imported by serverless
// endpoints. Load it on demand inside each call so the dispatcher modules
// (e.g. /api/portfolio, /api/pump-fun-mcp) don't pay the cost up front.
//
// Note: we used to import the CJS entry directly (`.../dist/cjs/index.js`)
// to skip ESM init, but Vite 7 enforces the package's `exports` map and
// rejects that subpath. The bare package import works under both the dev
// bundler and Vercel because the dynamic import keeps it lazy.

// Server-side: prefer SOLANA_RPC_URL (typically Helius). Browser-side: route
// through our same-origin proxy because public mainnet-beta 403s most origins.
const DEFAULT_RPC_URL =
	(typeof process !== 'undefined' && process.env?.SOLANA_RPC_URL) ||
	(typeof window !== 'undefined' && window.location?.origin
		? `${window.location.origin}/api/solana-rpc`
		: 'https://three.ws/api/solana-rpc');

async function makeConnection() {
	// On the server, route SNS lookups through the failover Connection: a raw
	// Connection on the keyless public RPC 429s under shared load and triggers
	// web3.js's "Server responded with 429 … Retrying after 500ms" backoff loop
	// (the source of the /api/sns retry noise in the logs). The failover
	// Connection rotates the public endpoint → Ankr → keyed providers and fails
	// fast instead of retry-looping a rate-limited lane. In the browser,
	// DEFAULT_RPC_URL is our same-origin /api/solana-rpc proxy, which already
	// fails over server-side, so a plain Connection is correct there.
	if (typeof window === 'undefined') {
		try {
			const { solanaConnection } = await import('../../api/_lib/solana/connection.js');
			return solanaConnection({ url: DEFAULT_RPC_URL, network: 'mainnet', commitment: 'confirmed' });
		} catch {
			/* fall back to a plain Connection if the failover helper can't load */
		}
	}
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
		const pk = await resolve(await makeConnection(), stripSol(name));
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
		const { reverse, stale } = await getFavoriteDomain(await makeConnection(), owner);
		// A stale favorite is a domain the wallet no longer owns; showing it
		// would attribute someone else's name to this address.
		if (stale) return null;
		return reverse.endsWith('.sol') ? reverse : `${reverse}.sol`;
	} catch {
		return null;
	}
}

const SOL_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
// Bare label, dotted subdomain (`nich.threews`), or either with a `.sol` suffix.
const SOL_NAME_RE = /^[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})*(?:\.sol)?$/i;

// Bonfida's hosted SNS index. Enumerating every domain a wallet holds is a
// scan the on-chain program can't answer in one RPC call, so the index is the
// only practical source for it. Reads are public and unauthenticated.
const SNS_INDEX_API = 'https://sns-api.bonfida.com';
// A whale wallet can hold thousands of domains; the caller wants a name list to
// show, not a dump. Cap it and say so in the payload.
const OWNER_DOMAINS_CAP = 100;

function withSolSuffix(label) {
	const name = String(label || '').trim();
	if (!name) return null;
	return name.endsWith('.sol') ? name : `${name}.sol`;
}

async function snsIndexJson(path, timeoutMs) {
	const res = await fetch(`${SNS_INDEX_API}${path}`, {
		headers: { accept: 'application/json' },
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!res.ok) return null;
	return res.json();
}

/**
 * Every `.sol` domain a wallet holds, plus its favorite domain, from the Bonfida
 * SNS index. Both halves are best-effort: an index outage degrades to an empty
 * list and a null favorite rather than failing the resolution that asked for it.
 *
 * @param {string} owner - base58-encoded wallet public key
 * @param {{ timeoutMs?: number, limit?: number }} [opts]
 * @returns {Promise<{ allDomains: string[], favoriteDomain: string|null, truncated: boolean }>}
 */
export async function snsOwnerDomains(owner, opts = {}) {
	const addr = String(owner || '').trim();
	const empty = { allDomains: [], favoriteDomain: null, truncated: false };
	if (!SOL_ADDRESS_RE.test(addr)) return empty;
	const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 6000;
	const limit = Number.isFinite(opts.limit) ? Math.max(1, opts.limit) : OWNER_DOMAINS_CAP;

	const [domainsBody, favBody] = await Promise.all([
		snsIndexJson(`/v2/user/domains/${addr}`, timeoutMs).catch(() => null),
		snsIndexJson(`/v2/user/fav-domains/${addr}`, timeoutMs).catch(() => null),
	]);

	const rawList = domainsBody?.[addr] ?? domainsBody?.data?.[addr] ?? [];
	const names = (Array.isArray(rawList) ? rawList : [])
		.map((d) => withSolSuffix(typeof d === 'string' ? d : d?.domain || d?.name))
		.filter(Boolean)
		.sort((a, b) => a.localeCompare(b));

	const favRaw = favBody?.[addr] ?? favBody?.data?.[addr] ?? null;

	return {
		allDomains: names.slice(0, limit),
		favoriteDomain: withSolSuffix(favRaw),
		truncated: names.length > limit,
	};
}

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
