// Meteora Dynamic Bonding Curve wrapper for the three.ws native launchpad.
//
// Lazy-loads the DBC SDK (same pattern as api/_lib/pump.js lazy-loads the
// pump SDKs) and reuses the pump facade's connection + unsigned-tx plumbing
// so both lanes share RPC selection, rotation, and priority-fee behavior.

import { getConnection, buildUnsignedTxBase64, solanaPubkey, txProgramIds } from '../pump.js';
import { curveBuildParams, configKeyFor } from './config.js';

let _sdk = null;
async function sdk() {
	if (!_sdk) _sdk = await import('@meteora-ag/dynamic-bonding-curve-sdk');
	return _sdk;
}

export const DBC_PROGRAM_ID = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';

const clients = new Map(); // network -> DynamicBondingCurveClient

export async function getDbcClient({ network = 'mainnet' } = {}) {
	if (!clients.has(network)) {
		const { DynamicBondingCurveClient } = await sdk();
		clients.set(network, new DynamicBondingCurveClient(getConnection({ network }), 'confirmed'));
	}
	return clients.get(network);
}

// The full ConfigParameters for the three.ws curve, built through the SDK so
// the numbers in config.js are always run through Meteora's own validators.
export async function buildThreeWsCurveConfig() {
	const { buildCurveWithMarketCap } = await sdk();
	return buildCurveWithMarketCap(curveBuildParams());
}

export function requireConfigKey(network) {
	const key = configKeyFor(network);
	if (!key) {
		throw Object.assign(
			new Error(
				`native launchpad config not deployed on ${network} — run scripts/native-launchpad-create-config.mjs and set ${
					network === 'devnet' ? 'NATIVE_LAUNCH_CONFIG_KEY_DEVNET' : 'NATIVE_LAUNCH_CONFIG_KEY'
				}`,
			),
			{ status: 503, code: 'lane_not_configured' },
		);
	}
	return key;
}

// Unsigned create-pool (+ optional first buy) transaction, base64. The base
// mint keypair and the payer wallet both sign client-side — the server never
// holds user keys, matching the pump lane's prep/confirm custody model.
export async function buildCreatePoolTx({
	network = 'mainnet',
	payer, // pays gas + funds the first buy
	creator, // on-chain pool creator (fee recipient)
	baseMint,
	name,
	symbol,
	uri,
	solBuyIn = 0,
} = {}) {
	const configKey = requireConfigKey(network);
	const client = await getDbcClient({ network });
	const { deriveDbcPoolAddress } = await sdk();
	const BN = (await import('bn.js')).default;

	const payerPk = solanaPubkey(payer);
	const creatorPk = solanaPubkey(creator);
	const mintPk = solanaPubkey(baseMint);
	const configPk = solanaPubkey(configKey);
	if (!payerPk || !creatorPk || !mintPk) {
		throw Object.assign(new Error('invalid pubkey'), { status: 400, code: 'validation_error' });
	}

	const tx = await client.creator.createPoolWithFirstBuy({
		createPoolParam: {
			name,
			symbol,
			uri,
			payer: payerPk,
			poolCreator: creatorPk,
			config: configPk,
			baseMint: mintPk,
		},
		firstBuyParam:
			solBuyIn > 0
				? {
						buyer: payerPk,
						buyAmount: new BN(Math.round(solBuyIn * 1e9)),
						minimumAmountOut: new BN(1),
						referralTokenAccount: null,
					}
				: undefined,
	});

	// WSOL is the quote side of every SOL-paired DBC pool.
	const { NATIVE_MINT } = await import('@solana/spl-token');
	const pool = deriveDbcPoolAddress(NATIVE_MINT, mintPk, configPk);

	const txBase64 = await buildUnsignedTxBase64({
		network,
		payer: payerPk,
		instructions: tx.instructions,
	});
	return { txBase64, pool: pool.toBase58(), configKey };
}

// True when a confirmed tx actually invoked the DBC program — same guard the
// pump lane applies before recording a launch (see txInvokesPumpProgram).
export function txInvokesDbcProgram(tx) {
	return txProgramIds(tx).has(DBC_PROGRAM_ID);
}

// Live pool snapshot for the detail/quote surfaces.
// Throws { status: 404, code: 'pool_not_found' } when the mint has no pool.
export async function getPoolState({ network = 'mainnet', mint } = {}) {
	const client = await getDbcClient({ network });
	const found = await client.state.getPoolByBaseMint(solanaPubkey(mint));
	if (!found) {
		throw Object.assign(new Error('no native pool for mint'), {
			status: 404,
			code: 'pool_not_found',
		});
	}
	const pool = found.publicKey;
	const [progress, threshold] = await Promise.all([
		client.state.getPoolQuoteTokenCurveProgress(pool),
		client.state.getPoolMigrationQuoteThreshold(pool),
	]);
	const account = found.account;
	return {
		pool: pool.toBase58(),
		config: account.config.toBase58(),
		creator: account.creator.toBase58(),
		migrated: Number(account.isMigrated ?? 0) === 1,
		curve_progress: progress, // 0..1
		migration_quote_threshold_sol: Number(threshold.toString()) / 1e9,
		quote_reserve_sol: Number(account.quoteReserve.toString()) / 1e9,
	};
}

// Buy quote against the live curve: `solIn` SOL -> tokens out (pre-slippage).
export async function quoteBuy({ network = 'mainnet', mint, solIn } = {}) {
	const client = await getDbcClient({ network });
	const { swapQuote } = await sdk();
	const BN = (await import('bn.js')).default;

	const found = await client.state.getPoolByBaseMint(solanaPubkey(mint));
	if (!found) {
		throw Object.assign(new Error('no native pool for mint'), {
			status: 404,
			code: 'pool_not_found',
		});
	}
	const config = await client.state.getPoolConfig(found.account.config);
	const slot = await getConnection({ network }).getSlot();
	const quote = swapQuote({
		virtualPool: found.account,
		config,
		swapBaseForQuote: false,
		amountIn: new BN(Math.round(solIn * 1e9)),
		slippageBps: 0,
		hasReferral: false,
		currentPoint: new BN(slot),
	});
	return {
		pool: found.publicKey.toBase58(),
		sol_in: solIn,
		tokens_out: Number(quote.amountOut.toString()) / 10 ** 6,
		min_tokens_out: Number((quote.minimumAmountOut ?? quote.amountOut).toString()) / 10 ** 6,
		trading_fee_sol: Number((quote.fee?.trading ?? 0).toString()) / 1e9,
	};
}
