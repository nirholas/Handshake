// three.ws native launchpad — curve economics, in one place.
//
// The native lane runs on Meteora's Dynamic Bonding Curve (DBC) program with
// three.ws as the on-chain "partner": we define the curve config, collect the
// platform's share of trading fees, and every pool created under our config
// key belongs to the three.ws launchpad.
//
// Curve design (v1, SOL-quoted, pump-parity graduation):
//   - 1B supply, 6 decimals, immutable metadata authority (no rug lever)
//   - starts at ~28 SOL market cap, graduates at ~410 SOL market cap
//     (≈85 SOL raised on the curve — the same shape traders already know)
//   - 1% trading fee in SOL, split 50/50 creator / three.ws, plus Meteora's
//     volatility-scaled dynamic fee on top during spikes
//   - graduates to DAMM v2 with 100% of LP permanently locked (50 creator /
//     50 platform) — the pool can never be pulled, both sides earn LP fees
//     forever
//   - 1% migration fee on the raised SOL, split 50/50 creator / three.ws
//
// The partner config account is created once per network by
// scripts/native-launchpad-create-config.mjs and pinned via env:
//   NATIVE_LAUNCH_CONFIG_KEY          (mainnet config pubkey)
//   NATIVE_LAUNCH_CONFIG_KEY_DEVNET   (devnet config pubkey)
//   NATIVE_LAUNCH_FEE_WALLET          (platform fee claimer + leftover receiver)

import { env } from '../env.js';

export const NATIVE_LANE = {
	id: 'native',
	label: 'three.ws launchpad',
	quote: 'SOL',
	totalSupply: 1_000_000_000,
	decimals: 6,
	initialMarketCapSol: 28,
	migrationMarketCapSol: 410,
	// buildCurveWithMarketCap resolves this to ~85.12 SOL for the params above;
	// kept here as display metadata only — the on-chain config is authoritative.
	graduationSolApprox: 85,
	tradeFeeBps: 100,
	creatorTradeFeePercent: 50, // % of the trade fee that goes to the coin creator
	migrationFeePercent: 1,
	creatorMigrationFeePercent: 50,
	lpLockedPercent: 100,
};

// Params for buildCurveWithMarketCap(). Enum values are inlined as numbers so
// this module stays importable without pulling the SDK (the SDK is only
// loaded lazily by dbc.js); dbc.js asserts them against the real enums.
export function curveBuildParams() {
	return {
		token: {
			tokenType: 0, // TokenType.SPLToken
			tokenBaseDecimal: NATIVE_LANE.decimals, // TokenDecimal.SIX
			tokenQuoteDecimal: 9, // TokenDecimal.NINE (SOL)
			tokenAuthorityOption: 1, // TokenAuthorityOption.Immutable
			totalTokenSupply: NATIVE_LANE.totalSupply,
			leftover: 0,
		},
		fee: {
			baseFeeParams: {
				baseFeeMode: 0, // BaseFeeMode.FeeSchedulerLinear (flat: start == end)
				feeSchedulerParam: {
					startingFeeBps: NATIVE_LANE.tradeFeeBps,
					endingFeeBps: NATIVE_LANE.tradeFeeBps,
					numberOfPeriod: 0,
					totalDuration: 0,
				},
			},
			dynamicFeeEnabled: true,
			collectFeeMode: 0, // CollectFeeMode.QuoteToken (fees accrue in SOL)
			creatorTradingFeePercentage: NATIVE_LANE.creatorTradeFeePercent,
			poolCreationFee: 0,
			enableFirstSwapWithMinFee: true, // creator's own first buy pays the minimum fee
		},
		migration: {
			migrationOption: 1, // MigrationOption.MET_DAMM_V2
			migrationFeeOption: 2, // MigrationFeeOption.FixedBps100 (1% fee on the graduated pool)
			migrationFee: {
				feePercentage: NATIVE_LANE.migrationFeePercent,
				creatorFeePercentage: NATIVE_LANE.creatorMigrationFeePercent,
			},
		},
		liquidityDistribution: {
			partnerPermanentLockedLiquidityPercentage: 50,
			partnerLiquidityPercentage: 0,
			creatorPermanentLockedLiquidityPercentage: 50,
			creatorLiquidityPercentage: 0,
		},
		lockedVesting: {
			totalLockedVestingAmount: 0,
			numberOfVestingPeriod: 0,
			cliffUnlockAmount: 0,
			totalVestingDuration: 0,
			cliffDurationFromMigrationTime: 0,
		},
		activationType: 0, // ActivationType.Slot
		initialMarketCap: NATIVE_LANE.initialMarketCapSol,
		migrationMarketCap: NATIVE_LANE.migrationMarketCapSol,
	};
}

export function configKeyFor(network) {
	return network === 'devnet'
		? env.NATIVE_LAUNCH_CONFIG_KEY_DEVNET || null
		: env.NATIVE_LAUNCH_CONFIG_KEY || null;
}

export function feeWallet() {
	return env.NATIVE_LAUNCH_FEE_WALLET || null;
}

// Public, cacheable description of the lane — served by /api/launchpad/config
// and rendered by the launch UI so the fee story on the page can never drift
// from the config that actually launched the coin.
export function laneInfo(network = 'mainnet') {
	return {
		lane: NATIVE_LANE.id,
		label: NATIVE_LANE.label,
		network,
		config_key: configKeyFor(network),
		quote: NATIVE_LANE.quote,
		total_supply: NATIVE_LANE.totalSupply,
		decimals: NATIVE_LANE.decimals,
		initial_market_cap_sol: NATIVE_LANE.initialMarketCapSol,
		migration_market_cap_sol: NATIVE_LANE.migrationMarketCapSol,
		graduation_sol_approx: NATIVE_LANE.graduationSolApprox,
		trade_fee_bps: NATIVE_LANE.tradeFeeBps,
		fee_split: {
			creator_percent: NATIVE_LANE.creatorTradeFeePercent,
			platform_percent: 100 - NATIVE_LANE.creatorTradeFeePercent,
		},
		migration_fee_percent: NATIVE_LANE.migrationFeePercent,
		lp_locked_percent: NATIVE_LANE.lpLockedPercent,
		graduates_to: 'Meteora DAMM v2 (LP permanently locked, creator keeps earning LP fees)',
	};
}
