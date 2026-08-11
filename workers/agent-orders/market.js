// agent-orders — live market signals for order evaluation.
//
// Every value here is REAL on-chain or derived-from-on-chain data: prices come
// from a live bonding-curve / AMM quote, market cap from the curve, smart-money
// from the reputation graph, dev-dump + graduation from the coin-intel table.
// Nothing is simulated. A source that can't be read returns null and the caller
// stays honest (it never fires an order on absent data).

import { getPumpTradeClient, getAmmPoolState } from '../../api/_lib/pump.js';
import { solUsdPrice } from '../../api/_lib/avatar-wallet.js';
import { getSmartMoneyForMint } from '../../api/_lib/smart-money.js';
import { sql } from '../../api/_lib/db.js';
import { PublicKey } from '@solana/web3.js';
import {
	getAssociatedTokenAddressSync, getMint,
	TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

// pump.fun mints: fixed 1,000,000,000 supply, 6 decimals.
const TOTAL_SUPPLY_TOKENS = 1_000_000_000;
const TOKEN_DECIMALS = 6;
// A tiny reference buy → near-spot marginal price with negligible impact.
const REF_LAMPORTS = 1_000_000n; // 0.001 SOL

/**
 * Live price + market cap for a mint. price_sol is SOL per whole token; mcap_sol
 * is that price × the fixed supply. Routes off the bonding curve, falling back to
 * the canonical AMM pool once the coin has graduated. Returns null on any quote
 * failure so the caller treats it as "skip this sweep", never as a price of 0.
 *
 * @returns {Promise<{ price_sol:number, mcap_sol:number, graduated:boolean } | null>}
 */
export async function quoteMarket({ network, mint }) {
	let ctx;
	try { ctx = await getPumpTradeClient({ network }); } catch { return null; }
	const mintPk = new ctx.web3.PublicKey(mint);
	try {
		const q = await ctx.client.quoteForBuy({ mint: mintPk, quoteAmount: new ctx.BN(REF_LAMPORTS.toString()), slippagePct: 0 });
		const baseOut = Number(q.expectedBaseTokens.toString());
		if (!(baseOut > 0)) return null;
		const tokensOut = baseOut / 10 ** TOKEN_DECIMALS;
		const price_sol = (Number(REF_LAMPORTS) / 1e9) / tokensOut;
		return { price_sol, mcap_sol: price_sol * TOTAL_SUPPLY_TOKENS, graduated: false };
	} catch (err) {
		if (err?.name === 'CoinGraduatedError' || err?.code === 'CoinGraduated') {
			return quoteMarketAmm({ network, mint });
		}
		return null;
	}
}

// Price off the live AMM pool reserves (post-graduation). price = quote/base,
// where quote is the EFFECTIVE reserve (vault balance + the pool's virtual quote
// reserves). Using the raw vault balance alone under-states both price and the
// mcap derived from it on launchpad coins.
async function quoteMarketAmm({ network, mint }) {
	try {
		const state = await getAmmPoolState({ network, mint });
		const base = Number(state.baseReserve.toString()) / 10 ** TOKEN_DECIMALS;
		const quote = Number(state.effectiveQuoteReserve.toString()) / 1e9;
		if (!(base > 0) || !(quote > 0)) return null;
		const price_sol = quote / base;
		return { price_sol, mcap_sol: price_sol * TOTAL_SUPPLY_TOKENS, graduated: true };
	} catch {
		return null;
	}
}

/**
 * Compute the live signal map an order's trigger needs. `need` is the set of
 * signal keys to resolve (price/mcap are always resolved since every price
 * trigger and most conditions use them). Each lookup degrades to null on failure.
 *
 * @param {object} o
 * @param {string} o.network
 * @param {string} o.mint
 * @param {string[]} [o.need]            extra signals (smart_money_score, dev_dump, …)
 * @param {number|null} [o.referencePrice]  baseline metric for price_change_pct
 * @param {string} [o.metric]            which metric price_change_pct is measured in
 * @returns {Promise<{ market: object|null, signals: object }>}
 */
export async function getSignals({ network, mint, need = [], referencePrice = null, metric = 'mcap_usd' }) {
	const market = await quoteMarket({ network, mint });
	const signals = {
		price_sol: market?.price_sol ?? null,
		mcap_sol: market?.mcap_sol ?? null,
		mcap_usd: null,
		graduated: market?.graduated ?? null,
		smart_money_score: null,
		dev_dump: null,
		price_change_pct: null,
	};

	const wants = new Set(need);
	// mcap_usd is needed whenever the metric is USD or a condition references it.
	if (market && (metric === 'mcap_usd' || wants.has('mcap_usd'))) {
		try { signals.mcap_usd = market.mcap_sol * (await solUsdPrice()); } catch { signals.mcap_usd = null; }
	}

	if (wants.has('smart_money_score')) {
		try {
			const sm = await getSmartMoneyForMint(mint, network);
			signals.smart_money_score = sm?.computed ? Number(sm.smart_money_score) : null;
		} catch { signals.smart_money_score = null; }
	}

	if (wants.has('dev_dump')) {
		try {
			const [row] = await sql`SELECT dev_sold, risk_flags FROM pump_coin_intel WHERE mint = ${mint}`;
			if (row) signals.dev_dump = row.dev_sold === true || (Array.isArray(row.risk_flags) && row.risk_flags.includes('dev_dumped'));
		} catch { signals.dev_dump = null; }
	}

	// price_change_pct vs the metric value captured when the order was created.
	// Always resolved when a baseline exists: the owner-facing order row shows it
	// whether or not a condition references the signal.
	if (referencePrice != null && market) {
		const cur = metricValue(market, signals, metric);
		if (cur != null && referencePrice > 0) signals.price_change_pct = ((cur - referencePrice) / referencePrice) * 100;
	}

	return { market, signals };
}

/** Pull the metric value (price_sol | mcap_sol | mcap_usd) out of a signal set. */
export function metricValue(market, signals, metric) {
	if (!market) return null;
	if (metric === 'price_sol') return market.price_sol;
	if (metric === 'mcap_sol') return market.mcap_sol;
	if (metric === 'mcap_usd') return signals.mcap_usd;
	return null;
}

/**
 * Live token holding for an owner. Sizes percentage sells (sell N% of the bag)
 * and supplies the mint decimals that convert a raw `size_tokens` order into the
 * whole-token amount the trade path expects. Returns whole-token + raw
 * base-unit balance + decimals, or null if the
 * owner holds none / the mint can't be read. Mirrors the resolveHolding logic the
 * trade endpoint uses so a percentage sell is priced against the same balance.
 */
export async function getHolding({ network, mint, owner }) {
	if (!owner) return null;
	let ctx;
	try { ctx = await getPumpTradeClient({ network }); } catch { return null; }
	const conn = ctx.connection;
	const mintPk = new PublicKey(mint);
	const ownerPk = new PublicKey(owner);
	let mintAcc;
	try { mintAcc = await conn.getAccountInfo(mintPk); } catch { return null; }
	if (!mintAcc) return null;
	const tokenProgramId = mintAcc.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
	let decimals;
	try { decimals = (await getMint(conn, mintPk, 'confirmed', tokenProgramId)).decimals; } catch { return null; }
	const ata = getAssociatedTokenAddressSync(mintPk, ownerPk, false, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID);
	let raw = 0n;
	try { raw = BigInt((await conn.getTokenAccountBalance(ata)).value.amount); } catch { raw = 0n; }
	const whole = Number(raw) / 10 ** decimals;
	return { whole, raw, decimals };
}

export { TOTAL_SUPPLY_TOKENS, TOKEN_DECIMALS };
