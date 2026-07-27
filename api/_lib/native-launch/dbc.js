// Meteora Dynamic Bonding Curve wrapper for the three.ws native launchpad.
//
// Lazy-loads the DBC SDK (same pattern as api/_lib/pump.js lazy-loads the
// pump SDKs) and reuses the pump facade's connection + unsigned-tx plumbing
// so both lanes share RPC selection, rotation, and priority-fee behavior.

import { getConnection, buildUnsignedTxBase64, solanaPubkey, txProgramIds } from '../pump.js';
import { curveBuildParams, configKeyFor, NATIVE_LANE } from './config.js';

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

// The pool address is deterministic from (quote=WSOL, baseMint, config), so
// derive it instead of scanning with getPoolByBaseMint — that helper needs
// getProgramAccounts, which several RPC tiers block outright.
export async function derivePool({ network = 'mainnet', mint } = {}) {
	const { deriveDbcPoolAddress } = await sdk();
	const { NATIVE_MINT } = await import('@solana/spl-token');
	const configKey = requireConfigKey(network);
	return deriveDbcPoolAddress(NATIVE_MINT, solanaPubkey(mint), solanaPubkey(configKey));
}

async function fetchPool({ network, mint }) {
	const client = await getDbcClient({ network });
	const pool = await derivePool({ network, mint });

	// getPool decodes the anchor account as `{ poolState: VirtualPool }`; older
	// SDK builds returned the state flat. Accept both so an SDK bump can't
	// silently break every read surface.
	const raw = await client.state.getPool(pool);
	const account = raw?.poolState ?? raw;
	if (!account?.config) {
		throw Object.assign(new Error('no native pool for mint'), {
			status: 404,
			code: 'pool_not_found',
		});
	}
	// `account` is the flat state (field reads); `wrapped` is the shape
	// swapQuote() expects, which dereferences virtualPool.poolState.
	const wrapped = raw?.poolState ? raw : { poolState: account };
	return { client, pool, account, wrapped };
}

// Live pool snapshot for the detail/quote surfaces.
// Throws { status: 404, code: 'pool_not_found' } when the mint has no pool.
export async function getPoolState({ network = 'mainnet', mint } = {}) {
	const { client, pool, account } = await fetchPool({ network, mint });
	const [progress, threshold] = await Promise.all([
		client.state.getPoolQuoteTokenCurveProgress(pool),
		client.state.getPoolMigrationQuoteThreshold(pool),
	]);
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
export async function quoteBuy({ network = 'mainnet', mint, solIn, slippageBps = 100 } = {}) {
	const BN = (await import('bn.js')).default;
	const { client, pool, account, wrapped } = await fetchPool({ network, mint });
	const config = await client.state.getPoolConfig(account.config);
	const slot = await getConnection({ network }).getSlot();
	// client.pool.swapQuote takes a params object; the module-level swapQuote
	// export is positional — use the client so an argument-order change in the
	// SDK can't silently mis-price a quote.
	const quote = client.pool.swapQuote({
		virtualPool: wrapped,
		config,
		swapBaseForQuote: false,
		amountIn: new BN(Math.round(solIn * 1e9)),
		slippageBps,
		hasReferral: false,
		eligibleForFirstSwapWithMinFee: false,
		currentPoint: new BN(slot),
	});
	const lamports = (v) => Number((v ?? 0).toString()) / 1e9;
	const tokens = (v) => Number((v ?? 0).toString()) / 10 ** NATIVE_LANE.decimals;
	return {
		pool: pool.toBase58(),
		sol_in: solIn,
		slippage_bps: slippageBps,
		tokens_out: tokens(quote.outputAmount),
		min_tokens_out: tokens(quote.minimumAmountOut ?? quote.outputAmount),
		trading_fee_sol: lamports(quote.tradingFee),
		protocol_fee_sol: lamports(quote.protocolFee),
	};
}
