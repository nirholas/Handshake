// Read-side wrappers around @nirholas/pump-sdk for bonding-curve pricing.
// Ported from pumpkit @pumpkit/core/src/solana/sdk-bridge.ts.
//
// All helpers accept a @solana/web3.js Connection and a PublicKey mint, and
// return null on missing-account / sdk errors so callers can render "no curve"
// without try/catch boilerplate.

import { PublicKey } from '@solana/web3.js';
import { isTransientRpcError } from './connection.js';

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

// "Account does not exist or has no data" is the SDK's signal that a mint has no
// bonding-curve account — the expected, documented result for any non-pump mint
// (USDC, wSOL, a plain SPL token). Callers already turn that into a clean "no
// curve" 404, so it is not a warning-worthy event. Logging it once per poll
// turned a single curve-less mint into thousands of warning lines. Treat it as
// benign and stay quiet; genuine RPC/parse failures still warn below.
function isMissingAccount(err) {
	return /account does not exist|has no data|could not find/i.test(String(err));
}

// Transient RPC *infrastructure* failures — provider rate-limit/quota (429,
// -32429 "max usage reached"), gateway 5xx, or a network blip. These are not
// code faults and are already handled upstream: the RpcFallback connection
// rotates off the throttled provider at the fetch layer (logging a single
// "[solana-rpc] … cooling" line) and the curve/quote endpoints fall back to a
// Jupiter price. Re-warning on every swallowed 429 here is what turned one
// quota-exhausted provider into thousands of duplicate "[sdk-bridge] … 429"
// lines. Stay quiet for these; genuine parse/programming errors still warn.
// The test itself lives with the lane manager, so every caller that has to tell
// "the chain says no" from "we could not ask" shares one definition.
const isTransientRpc = isTransientRpcError;

async function fetchState(connection, mint) {
	const { OnlinePumpSdk } = await loadSdk();
	const sdk = new OnlinePumpSdk(connection);
	const [global, feeConfig, bondingCurve] = await Promise.all([
		sdk.fetchGlobal(),
		sdk.fetchFeeConfig(),
		sdk.fetchBondingCurve(mint),
	]);
	// A graduated coin has virtualTokenReserves = 0 (fully migrated to a DEX).
	// All SDK price/quote helpers divide by this value, so guard here once.
	if (bondingCurve.virtualTokenReserves.isZero()) {
		throw Object.assign(new Error('coin is graduated — no bonding curve price'), { graduated: true });
	}
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
		if (!err?.graduated && !isMissingAccount(err) && !isTransientRpc(err)) {
			console.warn('[sdk-bridge] getTokenPrice failed: %s', String(err).slice(0, 120));
		}
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
		if (!isMissingAccount(err) && !isTransientRpc(err)) {
			console.warn('[sdk-bridge] getGraduationProgress failed: %s', String(err).slice(0, 120));
		}
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
		// Surface the curve's mayhem flag so the buy path can refuse mayhem-mode
		// coins (platform rule: agents only buy regular pump.fun coins, never the
		// high-volatility mayhem variant). Read from chain, never assumed.
		return { tokens, priceImpact: impact.impactBps / 100, isMayhemMode: Boolean(bondingCurve.isMayhemMode) };
	} catch (err) {
		// A graduated coin (no curve) is an expected state — the trade handler
		// re-prices off the AMM pool. Don't log it as a failure.
		if (!err?.graduated && !isMissingAccount(err) && !isTransientRpc(err)) {
			console.warn('[sdk-bridge] getBuyQuote failed: %s', String(err).slice(0, 120));
		}
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
		// Graduated coins re-price off the AMM pool in the trade handler — expected.
		if (!err?.graduated && !isMissingAccount(err) && !isTransientRpc(err)) {
			console.warn('[sdk-bridge] getSellQuote failed: %s', String(err).slice(0, 120));
		}
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
		if (!isMissingAccount(err) && !isTransientRpc(err)) {
			console.warn('[sdk-bridge] getBondingCurveState failed: %s', String(err).slice(0, 120));
		}
		return null;
	}
}
