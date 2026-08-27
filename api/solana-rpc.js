// Browser-safe Solana JSON-RPC proxy.
//
// Public RPC (api.mainnet-beta.solana.com) returns 403 to many browser
// requests, breaking /studio's launch panel (balance polling, tx send,
// confirmation). This proxy forwards JSON-RPC POSTs to Helius when
// HELIUS_API_KEY is set, otherwise to the public RPC server-side (which
// the Solana Labs nodes don't block from datacentre IPs the same way).
//
// Usage from browser:
//   new Connection('/api/solana-rpc')            -> mainnet
//   new Connection('/api/solana-rpc?net=devnet') -> devnet
//
// Hardening: this proxy fronts a keyed (paid) upstream, so it is rate-limited
// per-IP with a global hourly ceiling and only forwards an allowlist of the
// read/send methods the launch panel needs — never the expensive scan methods
// (getProgramAccounts, getBlock*) that would let an anonymous caller drain the
// upstream quota.

import { cors, method, wrap, readJson, error, rateLimited, reportServerError } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import {
	solanaRpcEndpoints,
	makeRotatingFetch,
	classifyRpcBody,
} from './_lib/solana/connection.js';

// Methods a browser Connection needs to read balances/accounts, build, simulate,
// send, and confirm transactions. Deliberately excludes getProgramAccounts and
// the getBlock* family — heavy scans that have no place in the launch panel and
// are the prime vector for upstream quota abuse.
const ALLOWED_METHODS = new Set([
	'getBalance',
	'getAccountInfo',
	'getMultipleAccounts',
	'getLatestBlockhash',
	'getRecentBlockhash',
	'isBlockhashValid',
	'getFeeForMessage',
	'getMinimumBalanceForRentExemption',
	'getSignatureStatuses',
	'getSignaturesForAddress',
	'getTransaction',
	'sendTransaction',
	'simulateTransaction',
	'getTokenAccountBalance',
	'getTokenAccountsByOwner',
	'getTokenSupply',
	// Inherently bounded — returns at most the top 20 holders of one mint.
	'getTokenLargestAccounts',
	'getEpochInfo',
	'getSlot',
	'getBlockHeight',
	'getGenesisHash',
	'getHealth',
	'getVersion',
]);

// getProgramAccounts is an unbounded scan in the general case — the prime
// vector for draining the keyed upstream — so it is NOT in ALLOWED_METHODS.
// We permit it ONLY when the caller supplies a `filters` array that bounds the
// result set (e.g. a memcmp on a specific mint, as the pump dashboard's bonding
// curve probe does). A filtered, slice-limited query is cheap; a bare scan is
// still refused.
function isBoundedProgramScan(entry) {
	if (entry.method !== 'getProgramAccounts') return false;
	const opts = Array.isArray(entry.params) ? entry.params[1] : null;
	return !!(opts && Array.isArray(opts.filters) && opts.filters.length > 0);
}

// Cap batch requests so a single POST can't fan out into hundreds of upstream
// calls and sidestep the per-request rate limit.
const MAX_BATCH = 10;

// Returns a fetch function that rotates across Helius → Alchemy → Ankr → public,
// skipping any endpoint currently in the process-wide cooldown map (same cooldown
// state shared by solanaConnection() so a quota-dead provider stays skipped).
function upstreamFetch(network) {
	const endpoints = solanaRpcEndpoints(network === 'devnet' ? 'devnet' : 'mainnet');
	return makeRotatingFetch(endpoints);
}

// Validate one or a batch of JSON-RPC payloads. Returns an error code string,
// or null when every entry is a well-formed call to an allowlisted method.
function rejectReason(body) {
	const entries = Array.isArray(body) ? body : [body];
	if (entries.length === 0) return 'empty_request';
	if (entries.length > MAX_BATCH) return 'batch_too_large';
	for (const e of entries) {
		if (!e || typeof e !== 'object') return 'malformed_request';
		if (typeof e.method !== 'string') return 'malformed_request';
		if (ALLOWED_METHODS.has(e.method)) continue;
		if (isBoundedProgramScan(e)) continue; // filtered getProgramAccounts is allowed
		if (e.method === 'getProgramAccounts') return 'unbounded_scan';
		return 'method_not_allowed';
	}
	return null;
}

export default wrap(async function handler(req, res) {
	// Open to any origin: this is a public, unauthenticated, method-allowlisted
	// proxy whose whole job is to be callable from a browser, and the abuse
	// surface is unchanged by CORS (curl never needed it). Opening it lets
	// statically-hosted three.ws surfaces reach mainnet, notably the standalone
	// agent deployer at nirholas.github.io/metaplex-agent-mcp, which otherwise
	// has no mainnet path at all because api.mainnet-beta.solana.com 403s
	// browser origins. The per-IP and global rate limits below still apply.
	if (cors(req, res, { methods: 'POST,OPTIONS', origins: '*', credentials: false })) return;
	if (!method(req, res, ['POST'])) return;

	const ip = clientIp(req);
	const [ipRl, globalRl] = await Promise.all([limits.solanaRpcIp(ip), limits.solanaRpcGlobal()]);
	if (!ipRl.success || !globalRl.success) {
		return rateLimited(res, ipRl, 'too many RPC requests');
	}

	const url = new URL(req.url, 'http://x');
	const network = url.searchParams.get('net') === 'devnet' ? 'devnet' : 'mainnet';

	let body;
	try {
		body = await readJson(req, 200_000);
	} catch (e) {
		return error(res, e.status || 400, 'bad_body', 'failed to read JSON body');
	}

	const reason = rejectReason(body);
	if (reason) {
		const msg =
			reason === 'method_not_allowed'
				? 'this RPC method is not permitted through the proxy'
				: reason === 'unbounded_scan'
					? 'getProgramAccounts requires a bounding `filters` array through this proxy'
					: reason === 'batch_too_large'
						? `batch exceeds ${MAX_BATCH} requests`
						: 'malformed JSON-RPC request';
		const status = reason === 'method_not_allowed' || reason === 'unbounded_scan' ? 403 : 400;
		return error(res, status, reason, msg);
	}

	let upstream;
	try {
		const rotateFetch = upstreamFetch(network);
		upstream = await rotateFetch(null, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		});
	} catch (e) {
		return error(res, 502, 'upstream_error', 'rpc upstream failed');
	}

	const text = await upstream.text();
	// Defense-in-depth: the rotating fetch already validates every body it returns,
	// but never let a malformed payload reach a browser web3.js Connection — it would
	// throw an opaque StructError (or silently mis-read an empty `[]`) instead of a
	// clean error the caller can handle. If the upstream body isn't a well-formed
	// JSON-RPC response, surface an honest 502 keyed to the same JSON-RPC id.
	const classified = classifyRpcBody(text);
	if (classified) {
		const id = Array.isArray(body) ? null : body?.id ?? null;
		// A provider returning a body web3.js can't parse is a real upstream
		// degradation worth seeing. Capture genuine 5xx through the boundary
		// (deduped on the classification reason, so a flapping provider alerts once
		// an hour, not per request) and thread the ref into the JSON-RPC error
		// `data` so a caller can quote it without breaking the strict envelope.
		// Capacity classifications (429) are expected provider backpressure, not a
		// server fault — don't alert on those.
		let ref;
		if ((classified.status ?? 502) >= 500) {
			ref = reportServerError(new Error(`rpc upstream returned an unusable response: ${classified.reason}`), {
				code: 'rpc_upstream_unusable',
				status: 502,
			});
		}
		res.statusCode = 502;
		res.setHeader('content-type', 'application/json; charset=utf-8');
		res.setHeader('cache-control', 'no-store');
		res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: 'rpc upstream returned an unusable response', ...(ref ? { data: { ref } } : {}) } }));
		return;
	}
	res.statusCode = upstream.status;
	res.setHeader('content-type', 'application/json; charset=utf-8');
	res.setHeader('cache-control', 'no-store');
	// The rotation answers an idempotent read from its last-good body when every
	// lane is down (api/_lib/solana/connection.js); pass the age through so a
	// browser can render "as of N minutes ago" instead of trusting it as live.
	const staleMs = upstream.headers.get('x-solana-rpc-stale');
	if (staleMs) {
		res.setHeader('x-solana-rpc-stale', staleMs);
		res.setHeader('access-control-expose-headers', 'x-solana-rpc-stale');
	}
	res.end(text);
});
