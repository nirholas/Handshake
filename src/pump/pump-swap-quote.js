/**
 * Read-only AMM swap quote using @pump-fun/pump-swap-sdk.
 * No signing, no transaction sending.
 */

import { SOLANA_RPC } from '../erc8004/solana-deploy.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const QUOTE_TTL_MS = 10_000;

// Module cache — loaded once, reused across calls.
let _mods = null;

async function loadMods() {
	if (!_mods) {
		const [amm, web3, BNMod] = await Promise.all([
			import('@pump-fun/pump-swap-sdk'),
			import('@solana/web3.js'),
			import('bn.js'),
		]);
		_mods = { amm, web3, BN: BNMod.default || BNMod };
	}
	return _mods;
}

/**
 * Get a read-only price quote for a pump AMM swap.
 *
 * @param {object}        opts
 * @param {string}        opts.inputMint       Base58 mint address. One side must be wSOL.
 * @param {string}        opts.outputMint      Base58 mint address.
 * @param {number|string} opts.amountIn        Input amount in raw base units (lamports for SOL).
 * @param {number}        [opts.slippageBps=100]
 * @returns {Promise<{amountOut: string, priceImpactBps: number, route: string, expiresAtMs: number}>}
 */
export async function quoteSwap({ inputMint, outputMint, amountIn, slippageBps = 100 }) {
	const { amm, web3, BN } = await loadMods();
	const { canonicalPumpPoolPda, OnlinePumpAmmSdk, buyQuoteInput, sellBaseInput } = amm;
	const { Connection, PublicKey } = web3;

	let inputPk, outputPk;
	try {
		inputPk = new PublicKey(inputMint);
	} catch {
		throw new Error(`Invalid inputMint: ${inputMint}`);
	}
	try {
		outputPk = new PublicKey(outputMint);
	} catch {
		throw new Error(`Invalid outputMint: ${outputMint}`);
	}

	const amountBn = new BN(String(amountIn));

	// wSOL is always the quote token in canonical pump AMM pools.
	let baseMintPk, direction;
	if (inputMint === WSOL) {
		baseMintPk = outputPk;
		direction = 'quoteToBase';
	} else if (outputMint === WSOL) {
		baseMintPk = inputPk;
		direction = 'baseToQuote';
	} else {
		throw new Error(`One of inputMint or outputMint must be wSOL (${WSOL})`);
	}

	const connection = new Connection(SOLANA_RPC.mainnet, 'confirmed');
	const sdk = new OnlinePumpAmmSdk(connection);
	const poolKey = canonicalPumpPoolPda(baseMintPk);

	let state;
	try {
		// SystemProgram as dummy user — user ATAs will be null, which is fine for quoting.
		state = await sdk.swapSolanaState(
			poolKey,
			new PublicKey('11111111111111111111111111111111'),
		);
	} catch (err) {
		throw new Error(`Pool unavailable for ${baseMintPk.toBase58()}: ${err.message}`);
	}

	const { globalConfig, feeConfig, pool, poolBaseAmount, poolQuoteAmount, baseMintAccount } =
		state;
	// pump-swap-sdk takes slippage as a PERCENT (1 = 1%): `1 ± slippage / 100`.
	const slippage = slippageBps / 100;
	// PumpSwap prices against effective quote reserves (raw vault + the pool's
	// virtual_quote_reserves, non-zero on boost pools since 2026-07-20). The SDK
	// adds `virtualQuoteReserves` to `quoteReserve` internally, so pass the raw
	// reserve here; the spot-price baseline below uses the summed value.
	//
	// The virtual figure is a SIGNED i128, so effective depth can be zero or
	// negative: a pool that cannot absorb a trade. Refuse rather than quote it,
	// because the impact math below clamps with Math.max(0, …) and would report
	// such a pool as 0 bps, the most attractive quote we can return.
	const virtualQuoteReserves = new BN((pool.virtualQuoteReserves ?? 0).toString());
	const effectiveQuoteReserve = poolQuoteAmount.add(virtualQuoteReserves);
	if (effectiveQuoteReserve.lten(0)) {
		throw new Error(`Pool ${poolKey.toBase58()} has no tradable quote depth`);
	}
	const shared = {
		slippage,
		baseReserve: poolBaseAmount,
		quoteReserve: poolQuoteAmount,
		virtualQuoteReserves,
		globalConfig,
		baseMintAccount,
		baseMint: pool.baseMint,
		coinCreator: pool.coinCreator,
		creator: pool.creator,
		feeConfig,
	};

	let amountOut, priceImpactBps;

	if (direction === 'quoteToBase') {
		const result = buyQuoteInput({ quote: amountBn, ...shared });
		amountOut = result.base;
		// impact = (execPrice / spotPrice − 1) × 10000
		// execPrice = amountIn / amountOut;  spotPrice = effectiveQuoteReserve / baseReserve
		const num = amountBn.mul(poolBaseAmount);
		const denom = amountOut.mul(effectiveQuoteReserve);
		priceImpactBps = denom.isZero()
			? 0
			: Math.max(0, num.muln(10_000).div(denom).subn(10_000).toNumber());
	} else {
		const result = sellBaseInput({ base: amountBn, ...shared });
		amountOut = result.uiQuote;
		// impact = (1 − execPrice / spotPrice) × 10000
		// spotPrice = effectiveQuoteReserve / baseReserve;  execPrice = amountOut / amountIn
		const spot = effectiveQuoteReserve.mul(amountBn);
		const exec = amountOut.mul(poolBaseAmount);
		priceImpactBps = spot.isZero()
			? 0
			: Math.max(0, spot.sub(exec).muln(10_000).div(spot).toNumber());
	}

	return {
		amountOut: amountOut.toString(),
		priceImpactBps,
		route: poolKey.toBase58(),
		expiresAtMs: Date.now() + QUOTE_TTL_MS,
	};
}
