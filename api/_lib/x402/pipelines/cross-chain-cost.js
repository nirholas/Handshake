// api/_lib/x402/pipelines/cross-chain-cost.js
//
// Cross-Chain Payment Cost Comparison (USE: Finance) — measures the real,
// all-in cost of moving an identical $0.001 USDC payment on Solana vs Base and
// tracks the gas premium between the two networks over time.
//
// A run()-style registry entry (autonomous-registry.js → `cross-chain-cost-comparison`).
// Every tick the autonomous loop calls run(ctx). It:
//
//   1. Probes a real $0.001 402-gated three.ws endpoint (/api/x402/model-check)
//      for the live multi-network challenge. model-check advertises the SAME
//      X402_MAX_AMOUNT_REQUIRED amount on every network, so the Solana and Base
//      accepts quote an identical $0.001 — the comparison is apples to apples.
//   2. Confirms BOTH a Solana (exact, USDC) and a Base (exact, eip155:8453, USD
//      Coin) route are advertised in that single challenge. A missing route means
//      that network can't be priced this tick.
//   3. Settles a REAL $0.001 USDC payment on Solana (the only network with a
//      configured autonomous outbound keypair) via payX402(), then reads the
//      ACTUAL on-chain transaction fee (meta.fee, lamports) for that settlement.
//      That lamport fee is the true Solana network gas cost of the transfer.
//   4. Prices the equivalent Base settlement from LIVE on-chain data — the
//      current Base gas price (viem getGasPrice over the Base RPC) multiplied by
//      the documented gas units a USDC ERC-3009 transferWithAuthorization burns.
//      Base outbound settlement is not attempted because no autonomous EVM
//      signing wallet is provisioned (same boundary the circuit breaker hits);
//      the day one is configured, a real Base settle drops in here without
//      touching the loop. The gas number itself is real, live network data —
//      not a mock.
//   5. Converts both gas costs to USD with live SOL/ETH prices (CoinGecko),
//      computes total cost (amount + gas) per network and the gas premium ratio
//      (base_gas_usd / solana_gas_usd), picks the cheapest network, and upserts
//      the snapshot into `cross_chain_cost_comparison` (an append-only time
//      series). The loop records the paid Solana settlement to x402_autonomous_log.
//
// Downstream consumer: GET /api/x402/network-cost reads cross_chain_cost_comparison
// for the latest snapshot + a rolling gas-premium average and surfaces the
// recommended (cheapest) settlement network — used to steer users to the cheaper
// rail and to inform default-network pricing.
//
// No mocks. The Solana cost is a real settled transaction's on-chain fee; the
// Base cost is the live Base gas price × a documented protocol gas constant; the
// USD conversion uses live market prices. The loop owns recording, cooldown, and
// daily-spend accounting; this module owns the probe, the settlement, the
// cross-network cost measurement, and the value extraction/storage.

import { createPublicClient } from 'viem';
import { base } from 'viem/chains';
import { fetchWithTimeout, payX402 } from '../pay.js';
import { evmTransport } from '../../evm/rpc.js';
import { env } from '../../env.js';

const NET_SOLANA_PREFIX = 'solana';
const NET_BASE = 'eip155:8453';

// The probe/settle target: the cheapest idempotent, side-effect-free $0.001
// 402-gated endpoint on the platform. model-check inspects a public GLB; a
// settled pay has no economic side effect beyond the transfer, so an hourly
// cost-probe leaves no junk behind (unlike booking a dance tip). A stable public
// canary avatar keeps the inspected resource deterministic across runs.
const PROBE_PATH = '/api/x402/model-check';
const CANARY_AVATAR = 'xbot.glb';

// Solana's per-signature base fee is a fixed protocol constant (5000 lamports).
// The x402 transfer is co-signed by the buyer and the facilitator fee payer
// (2 signatures) plus a negligible priority fee. Used only as a labelled
// fallback when the settled tx can't be read back in time — the real measured
// meta.fee is always preferred and flagged fee_source='onchain'.
const LAMPORTS_PER_SIGNATURE = 5000;
const SOLANA_TX_SIGNERS = 2;
const LAMPORTS_PER_SOL = 1_000_000_000;

// Gas a USDC ERC-3009 transferWithAuthorization settlement burns on Base. USDC's
// transferWithAuthorization lands in the ~65–90k range; 75k is a conservative
// mid-point and is the unit the facilitator's settle tx is metered at. Env-
// overridable so a measured value can replace the constant without a deploy.
const BASE_USDC_SETTLE_GAS = Number(process.env.X402_BASE_USDC_SETTLE_GAS || 75_000);

let _schemaReady = false;
async function ensureSchema(sql) {
	if (_schemaReady) return;
	await sql`
		CREATE TABLE IF NOT EXISTS cross_chain_cost_comparison (
			id                  bigserial PRIMARY KEY,
			run_id              uuid,
			amount_atomic       bigint,
			solana_advertised   boolean NOT NULL DEFAULT false,
			base_advertised     boolean NOT NULL DEFAULT false,
			solana_settled      boolean NOT NULL DEFAULT false,
			solana_tx           text,
			solana_fee_lamports bigint,
			solana_fee_source   text,
			solana_gas_usd      numeric(20,10),
			base_gas_price_wei  bigint,
			base_gas_units      bigint,
			base_gas_usd        numeric(20,10),
			sol_price_usd       numeric(20,8),
			eth_price_usd       numeric(20,8),
			amount_usd          numeric(20,10),
			solana_total_usd    numeric(20,10),
			base_total_usd      numeric(20,10),
			gas_premium_ratio   numeric(20,6),
			cheapest_network    text,
			checked_at          timestamptz DEFAULT now()
		)
	`;
	_schemaReady = true;
}

async function persist(sql, log, row) {
	try {
		await ensureSchema(sql);
		await sql`
			INSERT INTO cross_chain_cost_comparison
				(run_id, amount_atomic, solana_advertised, base_advertised,
				 solana_settled, solana_tx, solana_fee_lamports, solana_fee_source,
				 solana_gas_usd, base_gas_price_wei, base_gas_units, base_gas_usd,
				 sol_price_usd, eth_price_usd, amount_usd, solana_total_usd,
				 base_total_usd, gas_premium_ratio, cheapest_network, checked_at)
			VALUES
				(${row.run_id}, ${row.amount_atomic}, ${row.solana_advertised},
				 ${row.base_advertised}, ${row.solana_settled}, ${row.solana_tx || null},
				 ${row.solana_fee_lamports ?? null}, ${row.solana_fee_source || null},
				 ${row.solana_gas_usd ?? null}, ${row.base_gas_price_wei ?? null},
				 ${row.base_gas_units ?? null}, ${row.base_gas_usd ?? null},
				 ${row.sol_price_usd ?? null}, ${row.eth_price_usd ?? null},
				 ${row.amount_usd ?? null}, ${row.solana_total_usd ?? null},
				 ${row.base_total_usd ?? null}, ${row.gas_premium_ratio ?? null},
				 ${row.cheapest_network || null}, now())
		`;
	} catch (err) {
		log?.warn?.('cross_chain_cost_persist_failed', { message: err?.message });
	}
}

// Live SOL + ETH USD prices through the platform's shared price helpers: SOL
// from the canonical 60s-cached spot module, ETH from the coin-price failover
// chain. Both legs are fetched in parallel and both degrade to null on failure,
// so a dead price source blanks the USD columns rather than crashing the
// comparison — the gas units and raw fees are still recorded either way.
async function fetchNativePrices() {
	const [{ solPriceUsd }, { fetchCoinPriceUsdOrNull }] = await Promise.all([
		import('../../sol-price.js'),
		import('../../market-fallbacks.js'),
	]);
	const [sol, eth] = await Promise.all([
		solPriceUsd().catch(() => 0),
		fetchCoinPriceUsdOrNull('ethereum'),
	]);
	return {
		sol: sol > 0 ? sol : null,
		eth: Number.isFinite(eth) && eth > 0 ? eth : null,
	};
}

// Read the actual on-chain fee (lamports) the settled Solana transfer paid.
// Confirmed txs can lag a beat behind the settle response, so retry a few times
// before falling back to the deterministic protocol fee.
async function readSolanaFee(conn, txSig, log) {
	if (!txSig) return { lamports: LAMPORTS_PER_SIGNATURE * SOLANA_TX_SIGNERS, source: 'estimated' };
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			const tx = await conn.getParsedTransaction(txSig, {
				maxSupportedTransactionVersion: 0,
				commitment: 'confirmed',
			});
			const fee = tx?.meta?.fee;
			if (Number.isFinite(fee) && fee > 0) return { lamports: Number(fee), source: 'onchain' };
		} catch (err) {
			log?.warn?.('cross_chain_cost_fee_read_retry', { attempt, message: err?.message });
		}
		await new Promise((res) => setTimeout(res, 1500));
	}
	// Tx not yet indexed — use the deterministic fee structure (2 signers).
	return { lamports: LAMPORTS_PER_SIGNATURE * SOLANA_TX_SIGNERS, source: 'estimated' };
}

// Live Base gas price (wei) via the platform's failover Base RPC transport.
async function fetchBaseGasPriceWei(log) {
	try {
		const client = createPublicClient({
			chain: base,
			transport: evmTransport(8453, { primaryUrl: env.BASE_RPC_URL }),
		});
		const wei = await client.getGasPrice();
		return Number.isFinite(Number(wei)) && Number(wei) > 0 ? BigInt(wei) : null;
	} catch (err) {
		log?.warn?.('cross_chain_cost_base_gas_failed', { message: err?.message });
		return null;
	}
}

function round(n, dp = 10) {
	if (n == null || !Number.isFinite(n)) return null;
	const f = 10 ** dp;
	return Math.round(n * f) / f;
}

/**
 * Cross-chain cost comparison executor.
 *
 * @param {object} ctx — supplied by the autonomous loop:
 *   { origin, buyer, conn, blockhash, mintInfo, remainingCap, sql, log, runId }
 * @returns outcome recorded by the loop to x402_autonomous_log:
 *   { success, amountAtomic, txSig, network, responseData, signalData,
 *     valueExtracted, errorMsg, note }
 */
export async function run(ctx) {
	const { origin, buyer, conn, blockhash, mintInfo, remainingCap, sql, log, runId } = ctx;
	const endpointUrl = `${origin}${PROBE_PATH}?url=${encodeURIComponent(`${origin}/avatars/${CANARY_AVATAR}`)}`;

	// Wallet guard (defence in depth — the loop pre-flights the keypair).
	if (!buyer) {
		await persist(sql, log, { run_id: runId, amount_atomic: null, solana_advertised: false, base_advertised: false, solana_settled: false, cheapest_network: null });
		return {
			success: false, amountAtomic: 0, txSig: null, network: 'multi',
			signalData: { skipped: true, reason: 'wallet_unconfigured' },
			errorMsg: 'wallet_unconfigured', note: 'wallet_unconfigured', skipped: true,
		};
	}

	// ── Step 1: probe for the live multi-network challenge ─────────────────────
	let challenge;
	try {
		const probe = await fetchWithTimeout(endpointUrl, {
			method: 'GET',
			headers: { 'user-agent': 'threews-x402-cross-chain-cost/1.0' },
		});
		if (probe.status !== 402) {
			const errorMsg = `probe_not_402:http_${probe.status}`;
			await persist(sql, log, { run_id: runId, amount_atomic: null, solana_advertised: false, base_advertised: false, solana_settled: false, cheapest_network: null });
			return { success: false, amountAtomic: 0, txSig: null, network: 'multi', signalData: { reason: errorMsg }, errorMsg, note: errorMsg };
		}
		challenge = probe.body;
	} catch (err) {
		const errorMsg = `probe_failed:${err?.message || 'network'}`;
		await persist(sql, log, { run_id: runId, amount_atomic: null, solana_advertised: false, base_advertised: false, solana_settled: false, cheapest_network: null });
		return { success: false, amountAtomic: 0, txSig: null, network: 'multi', signalData: { reason: errorMsg }, errorMsg, note: errorMsg };
	}

	// ── Step 2: confirm both network routes are advertised ─────────────────────
	const accepts = Array.isArray(challenge?.accepts) ? challenge.accepts : [];
	const solAccept = accepts.find(
		(a) => typeof a?.network === 'string' && a.network.startsWith(NET_SOLANA_PREFIX) && a?.extra?.feePayer,
	) || null;
	const baseAccept = accepts.find((a) => a?.network === NET_BASE) || null;
	const solanaAdvertised = !!solAccept;
	const baseAdvertised = !!baseAccept;

	const amountAtomicQuoted = Number(solAccept?.amount ?? baseAccept?.amount ?? 0) || 0;
	const amountUsd = amountAtomicQuoted / 1e6;

	// ── Step 3: settle the real $0.001 payment on Solana, read its on-chain fee ─
	let amountAtomic = 0;
	let txSig = null;
	let solanaSettled = false;
	let settleErr = null;
	if (solAccept) {
		try {
			const r = await payX402({
				url: endpointUrl,
				method: 'GET',
				buyer, conn, blockhash, mintInfo,
				remainingCap: remainingCap ?? Infinity,
				userAgent: 'threews-x402-cross-chain-cost/1.0',
			});
			solanaSettled = !!r.paid;
			amountAtomic = r.paid ? (r.amountAtomic || 0) : 0;
			txSig = r.txSig || null;
			if (!r.paid) settleErr = r.errorMsg || `settle_status_${r.status || 0}`;
		} catch (err) {
			settleErr = `settle_threw:${err?.message || 'unknown'}`;
		}
	} else {
		settleErr = 'no_solana_route';
	}

	// ── Step 4: measure the cost of each network ───────────────────────────────
	const [prices, baseGasWei, solFee] = await Promise.all([
		fetchNativePrices(),
		baseAdvertised ? fetchBaseGasPriceWei(log) : Promise.resolve(null),
		solanaSettled ? readSolanaFee(conn, txSig, log) : Promise.resolve(null),
	]);

	const solFeeLamports = solFee?.lamports ?? null;
	const solFeeSource = solFee?.source ?? null;
	const solanaGasUsd = (solFeeLamports != null && prices.sol != null)
		? (solFeeLamports / LAMPORTS_PER_SOL) * prices.sol
		: null;

	const baseGasUnits = baseAdvertised ? BASE_USDC_SETTLE_GAS : null;
	const baseGasEth = (baseGasWei != null && baseGasUnits != null)
		? Number(baseGasWei) * baseGasUnits / 1e18
		: null;
	const baseGasUsd = (baseGasEth != null && prices.eth != null) ? baseGasEth * prices.eth : null;

	const solanaTotalUsd = (solanaGasUsd != null) ? amountUsd + solanaGasUsd : null;
	const baseTotalUsd = (baseGasUsd != null) ? amountUsd + baseGasUsd : null;
	const gasPremiumRatio = (baseGasUsd != null && solanaGasUsd != null && solanaGasUsd > 0)
		? baseGasUsd / solanaGasUsd
		: null;

	let cheapestNetwork = null;
	if (solanaTotalUsd != null && baseTotalUsd != null) {
		cheapestNetwork = baseTotalUsd < solanaTotalUsd ? 'base' : 'solana';
	} else if (solanaTotalUsd != null) {
		cheapestNetwork = 'solana';
	} else if (baseTotalUsd != null) {
		cheapestNetwork = 'base';
	}

	// ── Step 5: persist the snapshot (downstream: /api/x402/network-cost) ──────
	const row = {
		run_id: runId,
		amount_atomic: amountAtomicQuoted || null,
		solana_advertised: solanaAdvertised,
		base_advertised: baseAdvertised,
		solana_settled: solanaSettled,
		solana_tx: txSig,
		solana_fee_lamports: solFeeLamports,
		solana_fee_source: solFeeSource,
		solana_gas_usd: round(solanaGasUsd),
		base_gas_price_wei: baseGasWei != null ? Number(baseGasWei) : null,
		base_gas_units: baseGasUnits,
		base_gas_usd: round(baseGasUsd),
		sol_price_usd: prices.sol,
		eth_price_usd: prices.eth,
		amount_usd: round(amountUsd),
		solana_total_usd: round(solanaTotalUsd),
		base_total_usd: round(baseTotalUsd),
		gas_premium_ratio: round(gasPremiumRatio, 6),
		cheapest_network: cheapestNetwork,
	};
	await persist(sql, log, row);

	const signalData = {
		amount_usd: round(amountUsd),
		solana_settled: solanaSettled,
		solana_gas_usd: round(solanaGasUsd),
		base_gas_usd: round(baseGasUsd),
		gas_premium_ratio: round(gasPremiumRatio, 6),
		cheapest_network: cheapestNetwork,
		base_gas_price_gwei: baseGasWei != null ? round(Number(baseGasWei) / 1e9, 4) : null,
		solana_fee_source: solFeeSource,
	};

	const note = cheapestNetwork
		? `cheapest=${cheapestNetwork} premium=${gasPremiumRatio != null ? gasPremiumRatio.toFixed(2) + 'x' : 'n/a'}`
		: (settleErr || 'no_cost_data');

	log?.info?.('cross_chain_cost_complete', { run_id: runId, ...signalData, tx: txSig });

	return {
		// success = the real Solana settlement (the pipeline's core paid work)
		// landed. A transient price-feed/RPC gap that leaves a cost figure null
		// doesn't retroactively fail a payment that settled on-chain — the snapshot
		// is still persisted and the next tick re-measures. amountAtomic reflects
		// only the on-chain Solana spend so the loop's accounting is exact.
		success: solanaSettled,
		amountAtomic,
		txSig,
		network: 'solana:mainnet',
		responseData: { challenge_resource: challenge?.resource || endpointUrl, ...row },
		signalData,
		valueExtracted: signalData,
		errorMsg: solanaSettled ? null : (settleErr || 'settle_failed'),
		note,
	};
}

export const CROSS_CHAIN_COST_PROBE = Object.freeze({ path: PROBE_PATH, canary: CANARY_AVATAR });
