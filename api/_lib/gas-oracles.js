// Keyless-first EVM gas price oracle chain.
//
// One question, three rungs, zero required credentials:
//
//   1. Blocknative Gas API (api.blocknative.com/gasprices/blockprices):
//      probabilistic next-block estimates. Works KEYLESS at a lower rate
//      limit; an optional BLOCKNATIVE_API_KEY raises it (sent as the raw
//      `Authorization: <key>` header per Blocknative's docs, no Bearer
//      prefix).
//   2. Owlracle (api.owlracle.info/v4/<network>/gas): history-derived speed
//      tiers across many EVM networks. Keyless guest access with a shared
//      guest quota (a burned quota answers 403, which fails soft here); an
//      optional OWLRACLE_API_KEY (passed as the documented `apikey` query
//      param) gets a private quota.
//   3. Etherscan V2 gas oracle (module=gastracker&action=gasoracle):
//      Ethereum mainnet only. Uses the same ETHERSCAN_API_KEY /
//      api.etherscan.io/v2/api pattern as x402/identity-claim-verify.js;
//      also answers keyless at 1 req/5s, so the rung stays live either way.
//
// Every rung fails SOFT on its own timeout: a down/blocked/quota-starved
// provider costs one bounded fetch and the chain moves on. Rungs that do not
// serve the requested chain are skipped entirely (Etherscan is mainnet-only;
// Owlracle/Blocknative coverage is declared per chain below).
//
// The normalized shape every rung maps into:
//   {
//     chain, chainId, unit: 'gwei',
//     baseFee,                        // current/suggested base fee, gwei (null if the source has none)
//     tiers: {                        // cheapest → most aggressive
//       safe:     { maxFeePerGas, maxPriorityFeePerGas },
//       standard: { maxFeePerGas, maxPriorityFeePerGas },
//       fast:     { maxFeePerGas, maxPriorityFeePerGas },
//     },
//     source,                         // 'blocknative' | 'owlracle' | 'etherscan'
//     ts,
//   }

import { env } from './env.js';

const BLOCKNATIVE_URL = 'https://api.blocknative.com/gasprices/blockprices';
const OWLRACLE_URL = 'https://api.owlracle.info/v4';
// Etherscan V2 unified multichain API, same base as x402/identity-claim-verify.js.
const ETHERSCAN_V2 = 'https://api.etherscan.io/v2/api';

// Per-rung fetch budget. Gas answers are only useful fresh, so a slow rung is
// treated as a dead rung: cheaper to fall through than to wait.
const RUNG_TIMEOUT_MS = 3500;

// Optional per-provider keys. These two are not yet declared in env.js (that
// file is shared config owned elsewhere); read them with the same trim-or-
// undefined semantics as env.js's cred()/opt() helpers so a dashboard paste
// with a trailing newline never poisons a header or query param.
function optionalKey(name) {
	const v = process.env[name];
	if (v == null) return undefined;
	const t = String(v).trim();
	return t || undefined;
}

// ── Chain registry ──────────────────────────────────────────────────────────
// Which rungs serve which chain, plus the identifier each provider expects.
//   blocknative: EVM chainId passed as ?chainid= (only chains Blocknative's
//                Gas API serves; it 4xx's fast on others, but declaring
//                coverage keeps the chain honest and the logs quiet).
//   owlracle:    the network code in /v4/<network>/gas. Verified live:
//                eth/base/bsc/poly/arb/opt answer keyless; avax/ftm/cro/
//                linea/movr/one are valid networks behind the guest quota.
//   etherscan:   gastracker gas oracle, Ethereum mainnet only.
const CHAINS = {
	ethereum: { chainId: 1, blocknative: true, owlracle: 'eth', etherscan: true },
	base: { chainId: 8453, blocknative: true, owlracle: 'base' },
	bsc: { chainId: 56, blocknative: true, owlracle: 'bsc' },
	polygon: { chainId: 137, blocknative: true, owlracle: 'poly' },
	arbitrum: { chainId: 42161, blocknative: true, owlracle: 'arb' },
	optimism: { chainId: 10, blocknative: true, owlracle: 'opt' },
	avalanche: { chainId: 43114, blocknative: true, owlracle: 'avax' },
	linea: { chainId: 59144, blocknative: true, owlracle: 'linea' },
	fantom: { chainId: 250, owlracle: 'ftm' },
	cronos: { chainId: 25, owlracle: 'cro' },
	moonriver: { chainId: 1285, owlracle: 'movr' },
	harmony: { chainId: 1666600000, owlracle: 'one' },
};

// Accepted spellings → canonical chain key. Numeric chainIds resolve too, so
// callers holding an eip155 id never need a name table of their own.
const ALIASES = {
	eth: 'ethereum',
	mainnet: 'ethereum',
	bnb: 'bsc',
	binance: 'bsc',
	poly: 'polygon',
	matic: 'polygon',
	arb: 'arbitrum',
	op: 'optimism',
	opt: 'optimism',
	avax: 'avalanche',
	ftm: 'fantom',
	cro: 'cronos',
	movr: 'moonriver',
	one: 'harmony',
};

/**
 * Resolve a user-supplied chain string (name, alias, or numeric chainId,
 * optionally `eip155:`-prefixed) to a canonical chain key, or null.
 * @param {string|number} input
 * @returns {string|null}
 */
export function resolveGasChain(input) {
	const raw = String(input ?? '').trim().toLowerCase().replace(/^eip155:/, '');
	if (!raw) return null;
	if (CHAINS[raw]) return raw;
	if (ALIASES[raw]) return ALIASES[raw];
	if (/^\d+$/.test(raw)) {
		const id = Number(raw);
		for (const [key, meta] of Object.entries(CHAINS)) {
			if (meta.chainId === id) return key;
		}
	}
	return null;
}

/**
 * Supported chains with the oracle rungs that serve each; powers the
 * endpoint's discovery/error copy and keeps docs derivable, never hand-listed.
 * @returns {Array<{chain: string, chainId: number, sources: string[]}>}
 */
export function listGasChains() {
	return Object.entries(CHAINS).map(([chain, meta]) => ({
		chain,
		chainId: meta.chainId,
		sources: rungsFor(chain).map((r) => r.source),
	}));
}

// Round to 4 decimal places: gwei values below 0.0001 are noise for fee
// estimation, and it keeps L2 sub-gwei fees readable without float dust.
function gwei(n) {
	const v = Number(n);
	if (!Number.isFinite(v)) return null;
	return Math.round(v * 10_000) / 10_000;
}

function tier(maxFeePerGas, maxPriorityFeePerGas) {
	return { maxFeePerGas: gwei(maxFeePerGas), maxPriorityFeePerGas: gwei(maxPriorityFeePerGas) };
}

async function fetchJson(fetchImpl, url, { headers } = {}) {
	const res = await fetchImpl(url, {
		headers: { accept: 'application/json', ...headers },
		signal: AbortSignal.timeout(RUNG_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`http_${res.status}`);
	return res.json();
}

// ── Rung 1: Blocknative ─────────────────────────────────────────────────────
// Response: { unit:'gwei', blockPrices: [{ baseFeePerGas, estimatedPrices:
// [{ confidence, price, maxPriorityFeePerGas, maxFeePerGas }, …] }] }.
// Confidence levels run 99/95/90/80/70; we map fast=highest, safe=lowest,
// standard=nearest to 90 so a trimmed-down response still yields three tiers.
async function fromBlocknative(chainKey, meta, fetchImpl) {
	const key = optionalKey('BLOCKNATIVE_API_KEY');
	const data = await fetchJson(fetchImpl, `${BLOCKNATIVE_URL}?chainid=${meta.chainId}`, {
		headers: key ? { authorization: key } : {},
	});
	const block = Array.isArray(data?.blockPrices) ? data.blockPrices[0] : null;
	const prices = Array.isArray(block?.estimatedPrices) ? block.estimatedPrices : [];
	const usable = prices.filter((p) => Number.isFinite(Number(p?.maxFeePerGas)));
	if (usable.length === 0) throw new Error('no_estimated_prices');

	const byConfDesc = [...usable].sort((a, b) => Number(b.confidence) - Number(a.confidence));
	const fast = byConfDesc[0];
	const safe = byConfDesc[byConfDesc.length - 1];
	const standard = [...usable].sort(
		(a, b) => Math.abs(Number(a.confidence) - 90) - Math.abs(Number(b.confidence) - 90),
	)[0];

	return {
		chain: chainKey,
		chainId: meta.chainId,
		unit: 'gwei',
		baseFee: gwei(block?.baseFeePerGas),
		tiers: {
			safe: tier(safe.maxFeePerGas, safe.maxPriorityFeePerGas),
			standard: tier(standard.maxFeePerGas, standard.maxPriorityFeePerGas),
			fast: tier(fast.maxFeePerGas, fast.maxPriorityFeePerGas),
		},
		source: 'blocknative',
		ts: Date.now(),
	};
}

// ── Rung 2: Owlracle ────────────────────────────────────────────────────────
// Response: { speeds: [{ acceptance, maxFeePerGas, maxPriorityFeePerGas,
// baseFee, estimatedFee }, …] } with speeds ascending by acceptance
// (slow → standard → fast → instant). We take the first three as
// safe/standard/fast; the acceptance:1 "instant" tier prices in outlier
// spikes and would overpay every routine transaction.
async function fromOwlracle(chainKey, meta, fetchImpl) {
	const key = optionalKey('OWLRACLE_API_KEY');
	const qs = key ? `?apikey=${encodeURIComponent(key)}` : '';
	const data = await fetchJson(fetchImpl, `${OWLRACLE_URL}/${meta.owlracle}/gas${qs}`);
	const speeds = (Array.isArray(data?.speeds) ? data.speeds : []).filter((s) =>
		Number.isFinite(Number(s?.maxFeePerGas)),
	);
	if (speeds.length === 0) throw new Error('no_speeds');

	const safe = speeds[0];
	const standard = speeds[Math.min(1, speeds.length - 1)];
	const fast = speeds[Math.min(2, speeds.length - 1)];
	const baseFee = [standard, safe, fast].map((s) => Number(s?.baseFee)).find(Number.isFinite);

	return {
		chain: chainKey,
		chainId: meta.chainId,
		unit: 'gwei',
		baseFee: gwei(baseFee),
		tiers: {
			safe: tier(safe.maxFeePerGas, safe.maxPriorityFeePerGas),
			standard: tier(standard.maxFeePerGas, standard.maxPriorityFeePerGas),
			fast: tier(fast.maxFeePerGas, fast.maxPriorityFeePerGas),
		},
		source: 'owlracle',
		ts: Date.now(),
	};
}

// ── Rung 3: Etherscan V2 gas oracle (Ethereum mainnet only) ─────────────────
// Response result: { SafeGasPrice, ProposeGasPrice, FastGasPrice,
// suggestBaseFee }: legacy-style TOTAL gas prices in gwei. The priority fee
// per tier is recovered as (total - suggestBaseFee), floored at 0. Works
// keyless at 1 req/5s; ETHERSCAN_API_KEY (already provisioned for the
// identity-claim verifier) lifts that.
async function fromEtherscan(chainKey, meta, fetchImpl) {
	const key = env.ETHERSCAN_API_KEY;
	const url =
		`${ETHERSCAN_V2}?chainid=${meta.chainId}&module=gastracker&action=gasoracle` +
		(key ? `&apikey=${encodeURIComponent(key)}` : '');
	const data = await fetchJson(fetchImpl, url);
	const r = data?.result;
	if (data?.status !== '1' || !r || !Number.isFinite(Number(r.SafeGasPrice))) {
		// Etherscan reports rate-limiting and bad params as status "0" with the
		// detail in `result` (a string); surface it as the failure reason.
		throw new Error(typeof r === 'string' ? r.slice(0, 120) : 'bad_gasoracle_response');
	}
	const baseFee = Number(r.suggestBaseFee);
	const t = (total) => {
		const totalNum = Number(total);
		const priority = Number.isFinite(baseFee) ? Math.max(0, totalNum - baseFee) : null;
		return tier(totalNum, priority);
	};
	return {
		chain: chainKey,
		chainId: meta.chainId,
		unit: 'gwei',
		baseFee: gwei(baseFee),
		tiers: { safe: t(r.SafeGasPrice), standard: t(r.ProposeGasPrice), fast: t(r.FastGasPrice) },
		source: 'etherscan',
		ts: Date.now(),
	};
}

function rungsFor(chainKey) {
	const meta = CHAINS[chainKey];
	const rungs = [];
	if (meta.blocknative) rungs.push({ source: 'blocknative', run: fromBlocknative });
	if (meta.owlracle) rungs.push({ source: 'owlracle', run: fromOwlracle });
	if (meta.etherscan) rungs.push({ source: 'etherscan', run: fromEtherscan });
	return rungs;
}

/**
 * Get a normalized gas estimate for a chain, trying Blocknative → Owlracle →
 * Etherscan (skipping rungs that do not serve the chain). Each rung fails
 * soft on error/timeout; the first success wins.
 *
 * @param {string|number} chain  Chain name, alias, or numeric chainId.
 * @param {{ fetchImpl?: typeof fetch }} [opts]  Injectable fetch for tests.
 * @returns {Promise<object>} the normalized estimate (shape at top of file)
 * @throws {Error} code 'unsupported_chain' for an unknown chain; code
 *   'gas_sources_unavailable' (with `.attempts` naming each rung's failure)
 *   when every serving rung failed.
 */
export async function getGasEstimate(chain, { fetchImpl = fetch } = {}) {
	const chainKey = resolveGasChain(chain);
	if (!chainKey) {
		throw Object.assign(new Error(`unsupported chain: ${chain}`), { code: 'unsupported_chain' });
	}
	const meta = CHAINS[chainKey];
	const attempts = [];
	for (const rung of rungsFor(chainKey)) {
		try {
			return await rung.run(chainKey, meta, fetchImpl);
		} catch (err) {
			attempts.push({ source: rung.source, error: err?.message || String(err) });
		}
	}
	throw Object.assign(new Error(`all gas oracles failed for ${chainKey}`), {
		code: 'gas_sources_unavailable',
		attempts,
	});
}
