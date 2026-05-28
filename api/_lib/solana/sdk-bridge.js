// Read-side wrappers around @nirholas/pump-sdk for bonding-curve pricing.
// Ported from pumpkit @pumpkit/core/src/solana/sdk-bridge.ts.
//
// All helpers accept a @solana/web3.js Connection and a PublicKey mint, and
// return null on missing-account / sdk errors so callers can render "no curve"
// without try/catch boilerplate.

import { PublicKey } from '@solana/web3.js';

let _sdkPromise = null;
async function loadSdk() {
	if (!_sdkPromise) _sdkPromise = import('@nirholas/pump-sdk');
	return _sdkPromise;
}

let _bnPromise = null;
async function loadBN() {
	if (!_bnPromise) _bnPromise = import('bn.js').then((m) => m.default || m);
	return _bnPromise;
}

function toPubkey(mint) {
	return mint instanceof PublicKey ? mint : new PublicKey(String(mint));
}

async function fetchState(connection, mint) {
	const { OnlinePumpSdk } = await loadSdk();
	const sdk = new OnlinePumpSdk(connection);
	const [global, feeConfig, bondingCurve] = await Promise.all([
		sdk.fetchGlobal(),
		sdk.fetchFeeConfig(),
		sdk.fetchBondingCurve(mint),
	]);
	const mintSupply = bondingCurve.tokenTotalSupply.sub(bondingCurve.virtualTokenReserves);
	return { sdk, global, feeConfig, bondingCurve, mintSupply };
}

export async function getTokenPrice(connection, mint) {
	try {
		const pk = toPubkey(mint);
		const { getTokenPrice: sdkGetTokenPrice } = await loadSdk();
		const { global, feeConfig, bondingCurve, mintSupply } = await fetchState(connection, pk);
		return sdkGetTokenPrice({ global, feeConfig, mintSupply, bondingCurve });
	} catch (err) {
		console.warn('[sdk-bridge] getTokenPrice failed: %s', String(err).slice(0, 120));
		return null;
	}
}

export async function getGraduationProgress(connection, mint) {
	try {
		const pk = toPubkey(mint);
		const { OnlinePumpSdk, getGraduationProgress: sdkGetGrad } = await loadSdk();
		const sdk = new OnlinePumpSdk(connection);
		const [global, bondingCurve] = await Promise.all([
			sdk.fetchGlobal(),
			sdk.fetchBondingCurve(pk),
		]);
		return sdkGetGrad(global, bondingCurve);
	} catch (err) {
		console.warn('[sdk-bridge] getGraduationProgress failed: %s', String(err).slice(0, 120));
		return null;
	}
}

export async function getBuyQuote(connection, mint, solAmount) {
	try {
		const pk = toPubkey(mint);
		const BN = await loadBN();
		const amount = solAmount instanceof BN ? solAmount : new BN(String(solAmount));
		const {
			getBuyTokenAmountFromSolAmount,
			calculateBuyPriceImpact,
		} = await loadSdk();
		const { global, feeConfig, bondingCurve, mintSupply } = await fetchState(connection, pk);
		const tokens = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply, bondingCurve, amount });
		const impact = calculateBuyPriceImpact({ global, feeConfig, mintSupply, bondingCurve, solAmount: amount });
		return { tokens, priceImpact: impact.impactBps / 100 };
	} catch (err) {
		console.warn('[sdk-bridge] getBuyQuote failed: %s', String(err).slice(0, 120));
		return null;
	}
}

export async function getSellQuote(connection, mint, tokenAmount) {
	try {
		const pk = toPubkey(mint);
		const BN = await loadBN();
		const amount = tokenAmount instanceof BN ? tokenAmount : new BN(String(tokenAmount));
		const {
			getSellSolAmountFromTokenAmount,
			calculateSellPriceImpact,
		} = await loadSdk();
		const { global, feeConfig, bondingCurve, mintSupply } = await fetchState(connection, pk);
		const sol = getSellSolAmountFromTokenAmount({ global, feeConfig, mintSupply, bondingCurve, amount });
		const impact = calculateSellPriceImpact({ global, feeConfig, mintSupply, bondingCurve, tokenAmount: amount });
		return { sol, priceImpact: impact.impactBps / 100 };
	} catch (err) {
		console.warn('[sdk-bridge] getSellQuote failed: %s', String(err).slice(0, 120));
		return null;
	}
}

export async function getBondingCurveState(connection, mint) {
	try {
		const pk = toPubkey(mint);
		const { OnlinePumpSdk } = await loadSdk();
		const sdk = new OnlinePumpSdk(connection);
		const bc = await sdk.fetchBondingCurve(pk);
		return {
			virtualTokenReserves: bc.virtualTokenReserves.toString(),
			virtualSolReserves: bc.virtualSolReserves.toString(),
			realTokenReserves: bc.realTokenReserves.toString(),
			realSolReserves: bc.realSolReserves.toString(),
			tokenTotalSupply: bc.tokenTotalSupply.toString(),
			complete: Boolean(bc.complete),
			creator: bc.creator.toBase58(),
			isMayhemMode: Boolean(bc.isMayhemMode),
		};
	} catch (err) {
		console.warn('[sdk-bridge] getBondingCurveState failed: %s', String(err).slice(0, 120));
		return null;
	}
}
