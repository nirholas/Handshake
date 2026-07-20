// agent-mm — live market reads for the market-maker engine.
//
// Every value is REAL on-chain or derived-from-on-chain data: price comes from a
// live bonding-curve quote (pre-graduation) or the canonical AMM pool reserves
// (post-graduation); inventory is the agent wallet's actual token balance; live
// volume comes from the same multi-source market feed the rest of the platform
// uses. A source that can't be read returns null and the engine stays honest —
// it never acts on absent data (and never paints a tape it can't measure).

import { getPumpTradeClient, getAmmPoolState, getConnection } from '../../api/_lib/pump.js';
import { fetchTokenMarketData } from '../../api/_lib/market/token-market.js';
import { solUsdPrice } from '../../api/_lib/avatar-wallet.js';
import { PublicKey } from '@solana/web3.js';
import {
	getAssociatedTokenAddressSync, getMint,
	TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

// pump.fun mints: fixed 1,000,000,000 supply, 6 decimals.
const TOTAL_SUPPLY_TOKENS = 1_000_000_000;
const TOKEN_DECIMALS = 6;
const SOL = 1_000_000_000;
// A tiny reference buy → near-spot marginal price with negligible impact.
const REF_LAMPORTS = 1_000_000n; // 0.001 SOL

/**
 * Live price + graduation state for a mint. price_sol is SOL per whole token.
 * Routes off the bonding curve, falling back to the canonical AMM pool once the
 * coin has graduated. Returns null on any quote failure so the engine treats it
 * as "skip this sweep", never as a price of 0.
 *
 * @returns {Promise<{ price_sol:number, graduated:boolean } | null>}
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
		const price_sol = (Number(REF_LAMPORTS) / SOL) / tokensOut;
		return { price_sol, graduated: false };
	} catch (err) {
		if (err?.name === 'CoinGraduatedError' || err?.code === 'CoinGraduated') {
			return quoteMarketAmm({ network, mint });
		}
		return null;
	}
}

// Price off live AMM pool reserves (post-graduation). price = quote/base, where
// quote is the EFFECTIVE reserve (vault balance + the pool's virtual quote
// reserves). Pricing off the raw vault balance alone under-states the price on
// any launchpad coin, which since 2026-07-20 carries non-zero virtual reserves.
async function quoteMarketAmm({ network, mint }) {
	try {
		const state = await getAmmPoolState({ network, mint });
		const base = Number(state.baseReserve.toString()) / 10 ** TOKEN_DECIMALS;
		const quote = Number(state.effectiveQuoteReserve.toString()) / SOL;
		if (!(base > 0) || !(quote > 0)) return null;
		return { price_sol: quote / base, graduated: true };
	} catch {
		return null;
	}
}

/**
 * Live token holding for an owner — the MM's managed inventory. Returns whole +
 * raw base-unit balance + decimals, or null if the owner holds none / the mint
 * can't be read.
 */
export async function getHolding({ network, mint, owner }) {
	if (!owner) return null;
	const conn = getConnection({ network });
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

/** Live SOL balance (lamports) of an owner. Null on RPC failure. */
export async function getSolBalanceLamports({ network, owner }) {
	try {
		const conn = getConnection({ network });
		return BigInt(await conn.getBalance(new PublicKey(owner), 'confirmed'));
	} catch {
		return null;
	}
}

/**
 * Live market volume in lamports over the given window — the denominator for the
 * anti-manipulation volume cap. Derived from the multi-source market feed's 24h
 * volume (USD), scaled to the window and converted to lamports at the live SOL
 * price. Returns null when volume can't be read; the engine then refuses to act
 * on anything larger than a tiny conservative slice (it never paints a tape it
 * can't measure).
 *
 * @returns {Promise<bigint|null>} lamports of volume in the window
 */
export async function getWindowVolumeLamports({ mint, windowSeconds }) {
	let md;
	try { md = await fetchTokenMarketData(mint); } catch { return null; }
	const vol24hUsd = Number(md?.volume_24h);
	if (!Number.isFinite(vol24hUsd) || vol24hUsd <= 0) return null;
	let solUsd;
	try { solUsd = await solUsdPrice(); } catch { return null; }
	if (!(solUsd > 0)) return null;
	const windowUsd = vol24hUsd * (windowSeconds / 86_400);
	const windowSol = windowUsd / solUsd;
	const lamports = BigInt(Math.max(0, Math.round(windowSol * SOL)));
	return lamports;
}

export { TOTAL_SUPPLY_TOKENS, TOKEN_DECIMALS, SOL };
