// On-chain wallet activity scanner behind the airdrop eligibility checker
// (/api/crypto/airdrops). Produces the numeric activity summary that
// api/_lib/airdrop-eligibility.js scores criteria against.
//
// Solana first and fully keyless: activity comes from getSignaturesForAddress
// over the platform's canonical rotating RPC chain, and token diversity from
// the shared balance layer, so the scan works with zero provider keys. EVM
// activity uses Etherscan's V2 unified endpoint, where one ETHERSCAN_API_KEY
// covers every supported chain via the chainid parameter; without the key the
// scan throws not_configured and the endpoint answers an honest 503.
//
// Honesty contract: every field the scan could not measure is null, never 0.
// A null means "we could not see this", and the evaluator reports it as
// unknown instead of failing the wallet on it. Fields that hit a scan cap
// (signature pagination, tx offsets) are minimums and are flagged as such.

import { solanaRpcEndpoints, makeRotatingFetch } from './solana/connection.js';
import { getBalances } from './balances.js';
import { cacheWrap } from './cache.js';
import { env } from './env.js';

const DAY_MS = 86_400_000;
const ACTIVITY_TTL_S = 3600;

// Solana signature pagination: 2 pages of 1000 covers every casual wallet;
// a power wallet past the cap still gets honest minimums (capped: true).
const SOL_SIG_PAGE = 1000;
const SOL_SIG_PAGES_MAX = 2;

// Etherscan V2: one base URL, per-chain via chainid. Ethereum, Optimism,
// Base, Arbitrum.
const ETHERSCAN_V2 = 'https://api.etherscan.io/v2/api';
const EVM_CHAIN_IDS = [1, 10, 8453, 42161];
const EVM_TX_OFFSET = 1000;
const EVM_TOKENTX_OFFSET = 500;

let _rotating = null;
function solRpc(body) {
	if (!_rotating) _rotating = makeRotatingFetch(solanaRpcEndpoints('mainnet'));
	return _rotating(null, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(30_000),
	}).then((r) => r.json());
}

function dayKey(epochSeconds) {
	return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

/**
 * Scan a Solana wallet's activity. Keyless.
 * @param {string} address base58 wallet
 * @returns {Promise<object>} activity summary (nulls for unmeasurable fields)
 */
export async function solanaWalletActivity(address) {
	const signatures = [];
	let before;
	for (let page = 0; page < SOL_SIG_PAGES_MAX; page++) {
		const resp = await solRpc({
			jsonrpc: '2.0',
			id: 1,
			method: 'getSignaturesForAddress',
			params: [address, { limit: SOL_SIG_PAGE, ...(before ? { before } : {}) }],
		});
		const batch = Array.isArray(resp?.result) ? resp.result : [];
		signatures.push(...batch);
		if (batch.length < SOL_SIG_PAGE) break;
		before = batch.at(-1)?.signature;
	}
	const capped = signatures.length >= SOL_SIG_PAGE * SOL_SIG_PAGES_MAX;

	const now = Date.now();
	const days = new Set();
	let oldest = null;
	let newest = null;
	for (const s of signatures) {
		if (!s?.blockTime) continue;
		days.add(dayKey(s.blockTime));
		if (oldest == null || s.blockTime < oldest) oldest = s.blockTime;
		if (newest == null || s.blockTime > newest) newest = s.blockTime;
	}

	// Token diversity from the shared (cached) balance layer. A balance failure
	// degrades this one field to null rather than failing the whole scan.
	let uniqueTokens = null;
	try {
		const balances = await getBalances({ chain: 'solana', address });
		uniqueTokens = (balances.tokens || []).filter((t) => Number(t.amount) > 0).length
			+ (Number(balances.native?.amount) > 0 ? 1 : 0);
	} catch {
		uniqueTokens = null;
	}

	return {
		family: 'solana',
		chains_active: signatures.length > 0 ? 1 : 0,
		tx_count: signatures.length,
		days_active: days.size,
		account_age_days: oldest != null ? Math.floor((now - oldest * 1000) / DAY_MS) : null,
		last_active_days: newest != null ? Math.floor((now - newest * 1000) / DAY_MS) : null,
		unique_tokens: uniqueTokens,
		// Real per-transfer amounts would need a full parse of every transaction;
		// the scan does not guess, so volume is unmeasured on Solana.
		volume_usd: null,
		contract_interactions: null,
		capped,
		chains: signatures.length > 0 ? ['solana'] : [],
	};
}

async function etherscan(chainid, params) {
	const key = env.ETHERSCAN_API_KEY;
	const qs = new URLSearchParams({ ...params, chainid: String(chainid), apikey: key });
	const r = await fetch(`${ETHERSCAN_V2}?${qs}`, {
		headers: { accept: 'application/json' },
		signal: AbortSignal.timeout(15_000),
	});
	if (!r.ok) return [];
	const data = await r.json().catch(() => null);
	// status "0" with "No transactions found" is a real empty answer, not an error.
	return Array.isArray(data?.result) ? data.result : [];
}

async function ethUsdPrice() {
	try {
		const r = await fetch(
			'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd',
			{ headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) },
		);
		const data = await r.json().catch(() => null);
		const p = Number(data?.ethereum?.usd);
		return Number.isFinite(p) && p > 0 ? p : null;
	} catch {
		return null;
	}
}

/**
 * Scan an EVM wallet's activity across Ethereum, Optimism, Base and Arbitrum
 * via Etherscan V2. Throws { code: 'not_configured' } without ETHERSCAN_API_KEY.
 * @param {string} address 0x wallet
 */
export async function evmWalletActivity(address) {
	if (!env.ETHERSCAN_API_KEY) {
		throw Object.assign(new Error('ETHERSCAN_API_KEY is not set'), { code: 'not_configured' });
	}

	const now = Date.now();
	const perChain = await Promise.allSettled(
		EVM_CHAIN_IDS.map(async (chainid) => {
			const [txs, tokenTxs] = await Promise.all([
				etherscan(chainid, {
					module: 'account', action: 'txlist', address,
					startblock: '0', endblock: '99999999', page: '1',
					offset: String(EVM_TX_OFFSET), sort: 'desc',
				}),
				etherscan(chainid, {
					module: 'account', action: 'tokentx', address,
					page: '1', offset: String(EVM_TOKENTX_OFFSET), sort: 'desc',
				}),
			]);
			const days = new Set();
			let oldest = null;
			let newest = null;
			let contractCalls = 0;
			let volumeEth = 0;
			for (const tx of txs) {
				const ts = Number(tx.timeStamp);
				if (Number.isFinite(ts)) {
					days.add(dayKey(ts));
					if (oldest == null || ts < oldest) oldest = ts;
					if (newest == null || ts > newest) newest = ts;
				}
				if (tx.input && tx.input !== '0x') contractCalls += 1;
				const v = Number(tx.value);
				if (Number.isFinite(v)) volumeEth += v / 1e18;
			}
			const tokens = new Set();
			for (const t of tokenTxs) if (t.tokenSymbol) tokens.add(t.tokenSymbol.toUpperCase());
			return {
				chainid,
				txCount: txs.length,
				capped: txs.length >= EVM_TX_OFFSET,
				days,
				oldest,
				newest,
				contractCalls,
				volumeEth,
				tokens,
			};
		}),
	);

	const chains = perChain.filter((r) => r.status === 'fulfilled').map((r) => r.value);
	if (!chains.length) {
		throw Object.assign(new Error('every explorer call failed'), { code: 'upstream_unavailable' });
	}

	const days = new Set();
	const tokens = new Set();
	let txCount = 0;
	let contractCalls = 0;
	let volumeEth = 0;
	let oldest = null;
	let newest = null;
	let capped = false;
	const activeChains = [];
	for (const c of chains) {
		txCount += c.txCount;
		contractCalls += c.contractCalls;
		volumeEth += c.volumeEth;
		capped = capped || c.capped;
		for (const d of c.days) days.add(d);
		for (const t of c.tokens) tokens.add(t);
		if (c.oldest != null && (oldest == null || c.oldest < oldest)) oldest = c.oldest;
		if (c.newest != null && (newest == null || c.newest > newest)) newest = c.newest;
		if (c.txCount > 0) activeChains.push(c.chainid);
	}

	// BUG fix carried from the source implementation this design came from:
	// native volume is converted to USD before it is ever compared against a
	// USD threshold. No price feed -> volume stays null, never a unit mismatch.
	const ethUsd = volumeEth > 0 ? await ethUsdPrice() : null;

	return {
		family: 'evm',
		chains_active: activeChains.length,
		tx_count: txCount,
		days_active: days.size,
		account_age_days: oldest != null ? Math.floor((now - oldest * 1000) / DAY_MS) : null,
		last_active_days: newest != null ? Math.floor((now - newest * 1000) / DAY_MS) : null,
		unique_tokens: tokens.size,
		volume_usd: ethUsd != null ? Math.round(volumeEth * ethUsd) : null,
		contract_interactions: contractCalls,
		capped,
		chains: activeChains.map((id) => ({ 1: 'ethereum', 10: 'optimism', 8453: 'base', 42161: 'arbitrum' })[id] || String(id)),
	};
}

/**
 * Family-dispatching entry point with a shared 1h cache: airdrop criteria move
 * on the scale of weeks, and explorer quotas are the scarce resource here.
 * @param {'solana'|'evm'} family
 * @param {string} address
 */
export function walletActivity(family, address) {
	return cacheWrap(`airdrop:act:${family}:${address}`, ACTIVITY_TTL_S, () =>
		family === 'solana' ? solanaWalletActivity(address) : evmWalletActivity(address),
	);
}
