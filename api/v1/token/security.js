// GET /api/v1/token/security — free, on-chain rug/risk facts for any Solana token.
//
// The one question every trading agent asks before touching a token: "is this a
// rug?" This endpoint answers it with FACTS, not an invented score — mint/freeze
// authority status, holder concentration, liquidity depth, and pair age, composed
// into one report the agent weighs itself.
//
// Sources (all keyless / already-configured, composed — never proxied raw):
//   • Solana RPC (api/_lib/solana/connection.js failover chain):
//       - getAccountInfo(mint, jsonParsed) → mintAuthority, freezeAuthority,
//         supply, decimals (works for both spl-token and spl-token-2022 mints).
//       - getTokenLargestAccounts(mint)    → top-holder concentration.
//   • DexScreener (api/_lib/token-market.js `fetchTokenMarket`) → liquidity USD,
//     the deepest pair's label, and its creation time.
//
// Honest degradation: each section resolves independently. A partial upstream
// failure nulls only that section and names what answered in `sources`; the call
// succeeds if ANY section resolved and returns 503 only when every source failed.
// A well-formed Solana address that no source can resolve (no on-chain mint, no
// market) returns 404. EVM `0x…` input returns 400 — this endpoint is Solana-only.

import { defineEndpoint, fail } from '../../_lib/gateway.js';
import { rateLimited } from '../../_lib/http.js';
import { limits } from '../../_lib/rate-limit.js';
import { isValidSolanaAddress, isValidEvmAddress } from '../../_lib/validate.js';
import { fetchTokenMarket } from '../../_lib/token-market.js';
import { solanaRpcEndpoints, makeRotatingFetch } from '../../_lib/solana/connection.js';

// Budget for ONE JSON-RPC read across the WHOLE failover chain, not per
// endpoint. makeRotatingFetch bounds each attempt itself (10s) and composes the
// caller's signal with AbortSignal.any, so a caller cap below that bound spends
// the entire budget on the first endpoint and every rotation after it aborts
// instantly: at 8s a read that hit one slow lane logged "all 9 endpoints failed
// this request" and answered 503, while a retry seconds later succeeded. Sized
// to cover a couple of real attempts, matching the wallet-activity lane.
const RPC_TIMEOUT_MS = 25_000;
const DAY_MS = 86_400_000;

// One JSON-RPC call across the platform's failover chain. Resolves with the raw
// `{ result }` / `{ error }` envelope (a JSON-RPC error like "not a Token mint" is
// a soft "this section has no data", not a transport failure) and rejects only
// when every endpoint in the chain is down — which is how the caller tells an
// answered-but-empty source (→ degrade / 404) from a genuinely failed one (→ 503).
async function rpcCall(rpcFetch, method, params) {
	const resp = await rpcFetch(null, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
		signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
	});
	const body = await resp.json();
	// The rotation can answer an idempotent read from the last body a lane
	// returned when every lane is down, marking it with x-solana-rpc-stale. That
	// is the right trade for a balance chip; it is the wrong one here. Mint and
	// freeze authority and holder concentration are the whole point of a security
	// verdict, and a remembered copy of them presented as live would tell a
	// caller a token is clean at the exact moment we cannot see the chain.
	const stale = resp.headers?.get?.('x-solana-rpc-stale') != null;
	// A JSON-RPC envelope is always an object, but never let the marker itself be
	// the thing that throws on a malformed body.
	return body && typeof body === 'object' ? Object.assign(body, { __stale: stale }) : { result: undefined, __stale: stale };
}

// Round a base-unit part/total ratio to a 2-decimal percentage. Number() on the
// raw base-unit strings is exact enough for a percentage (supply tops out around
// 1e15, well under 2^53), and 2-decimal rounding absorbs any low-digit drift.
function pctOf(part, total) {
	if (!total || !Number.isFinite(total) || total <= 0) return null;
	const p = Number(part);
	if (!Number.isFinite(p)) return null;
	return Math.round((p / total) * 10000) / 100;
}

// Parse a getAccountInfo(jsonParsed) result into the authority/supply/decimals
// section. Returns null when the account isn't an initialized SPL/-2022 mint —
// either it doesn't exist (value === null) or it's some other account type. In
// SPL, a null authority means it was revoked (nobody can mint/freeze anymore).
export function parseMintAccount(result) {
	const value = result?.value;
	if (!value) return null;
	const parsed = value.data?.parsed;
	if (!parsed || parsed.type !== 'mint') return null;
	const info = parsed.info || {};
	const mintAuth = info.mintAuthority ?? null;
	const freezeAuth = info.freezeAuthority ?? null;
	return {
		mint_authority: { revoked: mintAuth === null, address: mintAuth },
		freeze_authority: { revoked: freezeAuth === null, address: freezeAuth },
		supply: typeof info.supply === 'string' ? info.supply : (info.supply ?? null),
		decimals: Number.isInteger(info.decimals) ? info.decimals : null,
	};
}

// Parse getTokenLargestAccounts + the mint supply into a concentration section.
// getTokenLargestAccounts returns up to the 20 largest token accounts; we report
// the cumulative share of the top 1 / 5 / 10 against total supply, and how many
// accounts we sampled. Percentages are null when supply is unknown (can't divide)
// but holders_sampled is still reported — an honest partial.
export function parseTopHolders(accounts, supplyRaw) {
	if (!Array.isArray(accounts) || accounts.length === 0) return null;
	const total = supplyRaw != null ? Number(supplyRaw) : null;
	const amt = (n) => accounts.slice(0, n).reduce((s, a) => s + Number(a?.amount || 0), 0);
	return {
		top1_pct: total ? pctOf(accounts[0]?.amount, total) : null,
		top5_pct: total ? pctOf(amt(5), total) : null,
		top10_pct: total ? pctOf(amt(10), total) : null,
		holders_sampled: accounts.length,
	};
}

// Project a fetchTokenMarket() result onto the liquidity section. null when the
// token has no indexed pair (DexScreener returned nothing).
export function parseLiquidity(market) {
	if (!market) return null;
	return {
		usd: market.liquidity_usd ?? null,
		largest_pair: market.pair_label ?? null,
		pair_created_at: market.pair_created_at ?? null,
	};
}

// Derive the factual flags. Every flag is a hard, observable condition — never a
// judgement — and is emitted ONLY when its inputs are present, so a null section
// never fabricates (or silently suppresses a real) signal.
export function buildFlags({ mint, holders, liquidity }, now) {
	const flags = [];
	if (mint) {
		if (mint.mint_authority.revoked === false) flags.push('mint_authority_active');
		if (mint.freeze_authority.revoked === false) flags.push('freeze_authority_active');
	}
	if (holders) {
		if (holders.top1_pct != null && holders.top1_pct > 20) flags.push('top1_holder_over_20pct');
		if (holders.top10_pct != null && holders.top10_pct > 80) flags.push('top10_holders_over_80pct');
	}
	if (liquidity) {
		if (liquidity.usd != null && liquidity.usd < 10_000) flags.push('liquidity_under_10k');
		if (liquidity.pair_created_at != null && now - liquidity.pair_created_at < DAY_MS) {
			flags.push('pair_younger_than_24h');
		}
	}
	return flags;
}

/**
 * Compose the full security report from the (already-resolved) upstream inputs.
 * Pure + exported so every section, flag, and the sources array can be pinned in
 * tests against captured real shapes without touching the network.
 *
 * @param {object} args
 * @param {string} args.address
 * @param {{ answered: boolean, result?: any }} args.account   getAccountInfo outcome
 * @param {{ answered: boolean, result?: any }} args.largest   getTokenLargestAccounts outcome
 * @param {{ answered: boolean, data?: any }} args.market      fetchTokenMarket outcome
 * @param {number} [now]
 * @returns {{ resolved: boolean, allFailed: boolean, body: object }}
 */
export function buildSecurityReport({ address, account, largest, market }, now = Date.now()) {
	const mint = account.answered ? parseMintAccount(account.result) : null;
	const holders = largest.answered
		? parseTopHolders(largest.result?.value, mint?.supply)
		: null;
	const liquidity = market.answered ? parseLiquidity(market.data) : null;

	const sources = [];
	if (mint || holders) sources.push('solana-rpc');
	if (liquidity) sources.push('dexscreener');

	const flags = buildFlags({ mint, holders, liquidity }, now);

	const body = {
		address,
		chain: 'solana',
		mint_authority: mint ? mint.mint_authority : { revoked: null, address: null },
		freeze_authority: mint ? mint.freeze_authority : { revoked: null, address: null },
		supply: mint ? mint.supply : null,
		decimals: mint ? mint.decimals : null,
		top_holders: holders || {
			top1_pct: null,
			top5_pct: null,
			top10_pct: null,
			holders_sampled: null,
		},
		liquidity: liquidity || { usd: null, largest_pair: null, pair_created_at: null },
		flags,
		sources,
		ts: now,
	};

	return {
		resolved: Boolean(mint || holders || liquidity),
		allFailed: !account.answered && !largest.answered && !market.answered,
		body,
	};
}

export default defineEndpoint({
	name: 'v1.token.security',
	method: 'GET',
	auth: 'public',
	handler: async ({ res, query, ip }) => {
		const address = typeof query.address === 'string' ? query.address.trim() : '';
		if (!address) fail(400, 'validation_error', '"address" query parameter is required');

		// EVM is a deliberate, honest 400 rather than a half-built passthrough: the
		// on-chain facts here (SPL mint/freeze authority, getTokenLargestAccounts) are
		// Solana concepts with no EVM equivalent in this reader.
		if (isValidEvmAddress(address)) {
			fail(400, 'unsupported_chain', 'this endpoint checks Solana tokens only (for now). Pass a base58 Solana mint address, not an EVM 0x address');
		}
		if (!isValidSolanaAddress(address)) {
			fail(400, 'validation_error', '"address" must be a base58 Solana mint address');
		}

		// Public, keyless per-IP quota on top of the gateway's shared budget: the RPC
		// + DexScreener reads are cheap and edge-cached, but this caps a scripted
		// enumeration flood against the shared upstreams.
		const rl = await limits.tokenSecurityIp(ip);
		if (!rl.success) {
			return rateLimited(res, rl, 'token security checks are capped at 20/min per IP');
		}

		const rpcFetch = makeRotatingFetch(solanaRpcEndpoints('mainnet'));
		const [acct, largest, mkt] = await Promise.allSettled([
			rpcCall(rpcFetch, 'getAccountInfo', [address, { encoding: 'jsonParsed', commitment: 'confirmed' }]),
			rpcCall(rpcFetch, 'getTokenLargestAccounts', [address, { commitment: 'confirmed' }]),
			fetchTokenMarket(address),
		]);

		// A stale-served read counts as "did not answer": the caller gets the same
		// honest 503 it would get if the lane had simply refused, instead of a
		// security report quietly assembled out of remembered on-chain state.
		const answered = (settled) => settled.status === 'fulfilled' && !settled.value?.__stale;

		const { resolved, allFailed, body } = buildSecurityReport({
			address,
			account: { answered: answered(acct), result: answered(acct) ? acct.value?.result : undefined },
			largest: { answered: answered(largest), result: answered(largest) ? largest.value?.result : undefined },
			market: { answered: mkt.status === 'fulfilled', data: mkt.value },
		});

		if (resolved) {
			// Public, cacheable read — 60s at the edge. Set before returning so the
			// gateway's secure-by-default no-store doesn't override it.
			res.setHeader('cache-control', 'public, max-age=60, s-maxage=60, stale-while-revalidate=30');
			return body;
		}

		// Nothing resolved: distinguish "every source failed" (transient — retry)
		// from "sources answered but this isn't a resolvable token" (client input).
		if (allFailed) {
			fail(503, 'sources_unavailable', 'token security sources are unavailable right now, retry shortly');
		}
		fail(404, 'not_found', 'no on-chain mint or market could be resolved for this address, check the mint');
	},
});
