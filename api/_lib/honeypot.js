// Honeypot.is: keyless EVM honeypot detector (api.honeypot.is).
//
// Runs a real buy/sell/transfer simulation of the token on a fork of its own
// chain and reports whether holders can actually exit, the effective taxes,
// and the contract-verification posture. This is the one scam signal a
// market-shape read (liquidity, age, order flow) structurally cannot see: a
// token can chart perfectly while its sell path is bricked.
//
// Wired into the generic token security snapshot (api/_lib/token-market.js):
// fetchTokenMarket attaches the report for EVM addresses and buildTokenRisk
// folds it into the risk score. Fails soft to null, never blocks a read.
//
// Endpoint (verified live 2026-08-05, no key, no auth):
//   GET https://api.honeypot.is/v2/IsHoneypot?address=0x..[&chainID=1]
//   -> { token, withToken, summary: { risk, riskLevel, flags },
//        simulationSuccess, honeypotResult: { isHoneypot[, honeypotReason] },
//        simulationResult: { buyTax, sellTax, transferTax, buyGas, sellGas },
//        flags, contractCode: { openSource, rootOpenSource, isProxy,
//        hasProxyCalls }, chain: { id, name, shortName, currency }, router,
//        pair, pairAddress }
//   404 { code: 404, error: "No pairs found" | "Token not found" } when the
//   address has no simulatable market.
// Without chainID the API auto-detects the deployment, but that detection
// misses Base-native tokens (verified live: a Base-only address answers 404
// unpinned and succeeds with chainID=8453), so callers that know the chain
// must pin it.

const HONEYPOT_API = 'https://api.honeypot.is/v2/IsHoneypot';
const FETCH_TIMEOUT_MS = 6000;

// Chains Honeypot.is can simulate, keyed by DexScreener chainId slug.
const CHAIN_IDS = { ethereum: 1, bsc: 56, base: 8453 };

const num = (v) => {
	const n = typeof v === 'string' ? parseFloat(v) : Number(v);
	return Number.isFinite(n) ? n : null;
};

/**
 * Numeric Honeypot.is chain id for a DexScreener chainId slug, or null when
 * Honeypot.is cannot simulate that chain (so callers skip it rather than
 * misattribute a sibling deployment's report).
 *
 * @param {string|null|undefined} dexChainId e.g. 'ethereum', 'base', 'bsc'
 * @returns {number|null}
 */
export function honeypotChainId(dexChainId) {
	return CHAIN_IDS[String(dexChainId || '').toLowerCase()] ?? null;
}

/**
 * Fetch and normalize a Honeypot.is v2 IsHoneypot report for one EVM token.
 *
 * Returns null when the address has no simulatable market (404) or the body
 * is malformed; throws only on transport failure (timeout, DNS), which
 * callers catch to null.
 *
 * @param {string} address EVM 0x token address
 * @param {{ chainId?: number|null, signal?: AbortSignal }} [opts] `chainId`
 *   pins the simulation to one deployment (1 Ethereum, 56 BSC, 8453 Base);
 *   omitted, the API auto-detects (and misses Base-native tokens).
 * @returns {Promise<null | {
 *   address: string,
 *   chain: { id: string|null, name: string|null, short: string|null }|null,
 *   is_honeypot: boolean|null, honeypot_reason: string|null,
 *   risk: string|null, risk_level: number|null, flags: string[],
 *   simulation_success: boolean|null,
 *   buy_tax: number|null, sell_tax: number|null, transfer_tax: number|null,
 *   open_source: boolean|null, is_proxy: boolean|null,
 *   token: { name: string|null, symbol: string|null, decimals: number|null, holders: number|null }|null,
 *   pair_address: string|null, pair_liquidity_usd: number|null,
 *   source: 'honeypot.is',
 * }>}
 */
export async function fetchHoneypot(address, opts = {}) {
	const url = new URL(HONEYPOT_API);
	url.searchParams.set('address', address);
	if (opts.chainId != null) url.searchParams.set('chainID', String(opts.chainId));
	const r = await fetch(url, {
		headers: { accept: 'application/json' },
		signal: opts.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!r.ok) return null;
	const d = await r.json().catch(() => null);
	if (!d || typeof d !== 'object') return null;
	// A real report always carries at least one of these three sections.
	if (!d.honeypotResult && !d.summary && d.simulationSuccess == null) return null;
	const sim = d.simulationResult || {};
	const code = d.contractCode || {};
	// Flags arrive both at the top level and under summary; entries may be
	// plain strings or { flag, description, severity } objects.
	const flags = [
		...(Array.isArray(d.summary?.flags) ? d.summary.flags : []),
		...(Array.isArray(d.flags) ? d.flags : []),
	]
		.map((f) => (typeof f === 'string' ? f : f && typeof f === 'object' ? f.flag || f.name || null : null))
		.filter(Boolean);
	return {
		address,
		chain: d.chain
			? {
				id: d.chain.id != null ? String(d.chain.id) : null,
				name: d.chain.name || null,
				short: d.chain.shortName || null,
			}
			: null,
		is_honeypot: d.honeypotResult?.isHoneypot != null ? Boolean(d.honeypotResult.isHoneypot) : null,
		honeypot_reason: d.honeypotResult?.honeypotReason || null,
		risk: d.summary?.risk || null,
		risk_level: num(d.summary?.riskLevel),
		flags: [...new Set(flags)],
		simulation_success: d.simulationSuccess != null ? Boolean(d.simulationSuccess) : null,
		buy_tax: num(sim.buyTax),
		sell_tax: num(sim.sellTax),
		transfer_tax: num(sim.transferTax),
		open_source: code.openSource != null ? Boolean(code.openSource) : null,
		is_proxy: code.isProxy != null ? Boolean(code.isProxy) : null,
		token: d.token
			? {
				name: d.token.name || null,
				symbol: d.token.symbol || null,
				decimals: num(d.token.decimals),
				holders: num(d.token.totalHolders),
			}
			: null,
		pair_address: d.pairAddress || null,
		pair_liquidity_usd: num(d.pair?.liquidity),
		source: 'honeypot.is',
	};
}
