// Holder-distribution composition for the free Crypto Data API
// (/api/crypto/holders).
//
// An agent sizing a position needs one read: how many holders, what the top
// wallets control, and whether concentration is an exit risk. Two real paths,
// never a mock:
//   - Helius DAS `getTokenAccounts` when HELIUS_API_KEY exists — enumerates the
//     token's accounts page by page and aggregates by OWNER wallet, so a whale
//     split across several token accounts still reads as one holder. Full
//     enumeration (within the page cap) also yields the true holder count.
//   - Keyless Solana RPC otherwise — `getTokenLargestAccounts` (top 20 token
//     accounts) + `getMultipleAccounts` to resolve each account's owner +
//     the mint's supply for percentages. A coarse-but-real top-N; the total
//     holder count is unknowable keylessly and reported null, never guessed.
//
// Percentages are against on-chain supply from the same mint read the security
// endpoint uses (parseMintAccount, shared with api/v1/token/security.js).
// The `concentration` verdict is a documented threshold on top10Pct — see
// deriveConcentration; docs/crypto-api.md mirrors the exact numbers.

import { parseMintAccount } from '../v1/token/security.js';
import { solanaRpcEndpoints, makeRotatingFetch } from './solana/connection.js';
import { withDeadline } from './rpc-degrade.js';

// Budget for ONE JSON-RPC read across the WHOLE failover chain, not per
// endpoint. makeRotatingFetch bounds each attempt itself (10s) and composes the
// caller's signal with AbortSignal.any, so a caller cap below that bound spends
// the entire budget on the first endpoint and every rotation after it aborts
// instantly: at 8s a read that hit one slow lane logged "all 9 endpoints failed
// this request" and answered 503, while a retry seconds later succeeded. Sized
// to cover a couple of real attempts, matching the wallet-activity lane.
const RPC_TIMEOUT_MS = 25_000;

// Per-call wall clock for the keyless fan-out (largest accounts, then owner
// resolution). Each read is bounded by RPC_TIMEOUT_MS, but two of them back to
// back after a slow Helius walk could still outlive the gateway; this cap makes
// the caller's upstream_down (and its last-good tier) fire while the response
// can still be delivered.
const KEYLESS_CALL_DEADLINE_MS = 20_000;

// Helius DAS getTokenAccounts pages at up to 1000 accounts; cap the walk so a
// mega-token (millions of accounts) can't burn the invocation. Within the cap
// the holder count is exact; beyond it we report null + a note, never a guess.
const HELIUS_PAGE_LIMIT = 1000;
const HELIUS_MAX_PAGES = 5;

// Documented concentration thresholds on top10Pct (aligned with the security
// reader's top10 > 80 flag so the two surfaces can't contradict each other).
export const CONCENTRATION_HIGH_PCT = 80;
export const CONCENTRATION_MEDIUM_PCT = 50;

export const MAX_LIMIT = 50;
export const DEFAULT_LIMIT = 10;

const num = (v) => {
	const n = typeof v === 'string' ? Number(v) : v;
	return Number.isFinite(n) ? n : null;
};

/** Percentage of raw base-unit `part` against raw `total`, 2 decimals. */
export function pctOfSupply(part, total) {
	const t = num(total);
	const p = num(part);
	if (!t || t <= 0 || p == null) return null;
	return Math.round((p / t) * 10000) / 100;
}

/**
 * Aggregate token accounts by owner into a ranked holder list.
 * @param {Array<{ owner?: string|null, address?: string, amount: string|number }>} accounts
 * @param {string|number|null} supplyRaw
 * @param {number} limit
 */
export function rankHolders(accounts, supplyRaw, limit) {
	if (!Array.isArray(accounts) || !accounts.length) return [];
	const byOwner = new Map();
	for (const a of accounts) {
		const amt = num(a?.amount);
		if (amt == null || amt <= 0) continue;
		// Owner unresolved (RPC couldn't parse the account) → keep the token
		// account address as the key so the balance still counts, honestly labeled.
		const key = a.owner || a.address || 'unknown';
		byOwner.set(key, (byOwner.get(key) || 0) + amt);
	}
	return [...byOwner.entries()]
		.sort((x, y) => y[1] - x[1])
		.slice(0, limit)
		.map(([owner, amount]) => ({
			owner,
			amount,
			pct: pctOfSupply(amount, supplyRaw),
		}));
}

/** Cumulative % of supply held by the top 10 aggregated holders. */
export function top10PctOf(ranked) {
	if (!Array.isArray(ranked) || !ranked.length) return null;
	let sum = 0;
	let any = false;
	for (const h of ranked.slice(0, 10)) {
		if (h.pct == null) continue;
		sum += h.pct;
		any = true;
	}
	return any ? Math.round(sum * 100) / 100 : null;
}

/**
 * The documented threshold rule (mirror any change into docs/crypto-api.md):
 *   high    — top10Pct > 80
 *   medium  — top10Pct > 50
 *   low     — top10Pct ≤ 50
 *   unknown — top10Pct unresolved
 */
export function deriveConcentration(top10Pct) {
	if (top10Pct == null) return 'unknown';
	if (top10Pct > CONCENTRATION_HIGH_PCT) return 'high';
	if (top10Pct > CONCENTRATION_MEDIUM_PCT) return 'medium';
	return 'low';
}

async function rpcCall(rpcFetch, method, params) {
	const resp = await rpcFetch(null, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
		signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
	});
	return resp.json();
}

/**
 * Walk Helius DAS getTokenAccounts for a mint, aggregating by owner. Returns
 * null when no key is configured (caller falls back to keyless RPC).
 * `complete` is true iff every account was enumerated within the page cap —
 * only then is a holder count honest.
 */
export async function heliusHolderWalk(mint, { fetchImpl = fetch } = {}) {
	const key = process.env.HELIUS_API_KEY;
	if (!key) return null;
	const url = `https://mainnet.helius-rpc.com/?api-key=${key}`;
	const accounts = [];
	let complete = false;
	for (let page = 1; page <= HELIUS_MAX_PAGES; page++) {
		let batch;
		try {
			batch = await heliusPage(url, mint, page, fetchImpl);
		} catch (err) {
			// A page that fails mid-walk does not invalidate the pages already in
			// hand: 1000 accounts is far more than any top-N needs, and discarding
			// them dropped the read onto the keyless lane, whose
			// getTokenLargestAccounts most public RPCs refuse. Keep what we have and
			// mark the walk incomplete so the holder COUNT is still withheld.
			if (!accounts.length) throw err;
			console.log(`[crypto-holders] helius walk stopped at page ${page}: ${err.message}`);
			return { accounts, complete: false };
		}
		accounts.push(...batch.map((a) => ({ owner: a.owner || null, address: a.address, amount: a.amount })));
		if (batch.length < HELIUS_PAGE_LIMIT) {
			complete = true;
			break;
		}
	}
	return { accounts, complete };
}

// One page of the walk. Helius answers an exhausted plan with HTTP 200 and the
// plain-text body "max usage reached", so parsing the body as JSON unconditionally
// surfaced a bare SyntaxError with no hint that the key was the problem. Read the
// text first and name what came back.
async function heliusPage(url, mint, page, fetchImpl) {
	const r = await fetchImpl(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: 'holders',
			method: 'getTokenAccounts',
			params: { mint, page, limit: HELIUS_PAGE_LIMIT },
		}),
		signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
	});
	const text = await r.text();
	if (!r.ok) throw new Error(`helius getTokenAccounts ${r.status}: ${text.slice(0, 80)}`);
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		throw new Error(`helius getTokenAccounts: non-JSON response "${text.slice(0, 60)}"`);
	}
	if (json?.error) throw new Error(`helius getTokenAccounts: ${JSON.stringify(json.error).slice(0, 120)}`);
	const batch = json?.result?.token_accounts;
	if (!Array.isArray(batch)) throw new Error('helius getTokenAccounts: malformed response');
	return batch;
}

// Default network dependency bundle — injectable for tests.
export function realHolderDeps() {
	const rpcFetch = makeRotatingFetch(solanaRpcEndpoints('mainnet'));
	return {
		fetchMintAccount: (address) =>
			rpcCall(rpcFetch, 'getAccountInfo', [address, { encoding: 'jsonParsed', commitment: 'confirmed' }]),
		fetchLargestAccounts: (address) =>
			rpcCall(rpcFetch, 'getTokenLargestAccounts', [address, { commitment: 'confirmed' }]),
		fetchAccountOwners: async (tokenAccounts) => {
			const json = await rpcCall(rpcFetch, 'getMultipleAccounts', [tokenAccounts, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
			const values = json?.result?.value;
			if (!Array.isArray(values)) return new Map();
			const owners = new Map();
			values.forEach((v, i) => {
				const owner = v?.data?.parsed?.info?.owner;
				if (owner) owners.set(tokenAccounts[i], owner);
			});
			return owners;
		},
		fetchHelius: (address) => heliusHolderWalk(address),
	};
}

/**
 * Compose the holder-distribution report for one mint.
 *
 * @param {{ address: string, limit?: number }} input
 * @param {ReturnType<typeof realHolderDeps>} [deps]
 * @returns {Promise<
 *   | { status: 'ok', holderCount: number|null, top: Array<{owner,amount,pct}>,
 *       top10Pct: number|null, concentration: string, sources: string[], note?: string }
 *   | { status: 'not_found' }
 *   | { status: 'upstream_down' }
 * >}
 */
export async function composeTokenHolders({ address, limit = DEFAULT_LIMIT }, deps = realHolderDeps()) {
	const capped = Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit) || DEFAULT_LIMIT));

	// The mint read anchors everything: supply for percentages, and existence —
	// a mint that isn't on chain is a not-found regardless of holder sources.
	let mint = null;
	let mintAnswered = false;
	try {
		const acct = await deps.fetchMintAccount(address);
		mintAnswered = true;
		mint = parseMintAccount(acct?.result);
	} catch { /* RPC down — holder paths below may still answer */ }

	if (mintAnswered && !mint) return { status: 'not_found' };

	const supply = mint?.supply ?? null;
	const sources = [];
	let note;

	// Preferred: Helius owner-aggregated walk (exact within the page cap).
	try {
		const helius = await deps.fetchHelius(address);
		if (helius) {
			const owners = new Map();
			for (const a of helius.accounts) {
				if (num(a.amount) > 0) owners.set(a.owner || a.address, true);
			}
			const top = rankHolders(helius.accounts, supply, capped);
			if (top.length || helius.complete) {
				sources.push('helius-das');
				if (mint) sources.push('solana-rpc');
				const top10Pct = top10PctOf(rankHolders(helius.accounts, supply, 10));
				if (!helius.complete) {
					note = `holder count omitted: more than ${HELIUS_MAX_PAGES * HELIUS_PAGE_LIMIT} token accounts — top holders are computed from the first ${HELIUS_MAX_PAGES * HELIUS_PAGE_LIMIT}.`;
				}
				return {
					status: 'ok',
					holderCount: helius.complete ? owners.size : null,
					top,
					top10Pct,
					concentration: deriveConcentration(top10Pct),
					sources,
					...(note ? { note } : {}),
				};
			}
		}
	} catch (err) {
		// Named, not swallowed: an exhausted Helius plan silently demoted every
		// holder read to the keyless lane, which then 503'd roughly one call in
		// three with nothing in the logs pointing at the cause.
		console.log(`[crypto-holders] helius path unavailable, falling back to keyless RPC: ${err.message}`);
	}

	// Keyless: top-20 largest token accounts + owner resolution.
	// `largestAnswered` requires a REAL array answer. A JSON-RPC error envelope
	// (e.g. the public chain throttling getTokenLargestAccounts with "Too many
	// requests") is NOT an answer — counting it as one turned a throttled read
	// into a false "brand-new token, no holders" on live mints.
	let largest = null;
	let largestAnswered = false;
	try {
		const json = await withDeadline(deps.fetchLargestAccounts(address), KEYLESS_CALL_DEADLINE_MS, 'getTokenLargestAccounts');
		if (Array.isArray(json?.result?.value)) {
			largestAnswered = true;
			largest = json.result.value;
		}
	} catch { /* RPC down for this call */ }

	if (largest?.length) {
		let owners = new Map();
		try {
			owners = await withDeadline(deps.fetchAccountOwners(largest.map((a) => a.address)), KEYLESS_CALL_DEADLINE_MS, 'getMultipleAccounts');
		} catch { /* owner resolution is enrichment — top-N stands on account addresses */ }
		const accounts = largest.map((a) => ({
			address: a.address,
			owner: owners.get(a.address) || null,
			amount: a.amount,
		}));
		const top = rankHolders(accounts, supply, capped);
		const top10Pct = top10PctOf(rankHolders(accounts, supply, 10));
		sources.push('solana-rpc');
		return {
			status: 'ok',
			holderCount: null,
			top,
			top10Pct,
			concentration: deriveConcentration(top10Pct),
			sources,
			note: 'keyless path: top holders from the chain\'s 20 largest token accounts; total holder count is not derivable without an indexer key.',
		};
	}

	// Nothing produced holders. Mint answered (token exists) with an empty holder
	// read → a brand-new token with no accounts yet is a valid empty, not an error.
	if (mint && largestAnswered) {
		return {
			status: 'ok',
			holderCount: null,
			top: [],
			top10Pct: null,
			concentration: 'unknown',
			sources: ['solana-rpc'],
			note: 'no token accounts found yet — brand-new or unfunded mint.',
		};
	}

	// Only reachable when the largest-accounts read failed at transport level
	// (a non-mint address already returned not_found above). The token may well
	// exist — report retryable, never a false not-found.
	return { status: 'upstream_down' };
}
