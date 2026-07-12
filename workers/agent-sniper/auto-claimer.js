// agent-sniper — auto-claimer for creator fees on agent-launched coins.
//
// Polls every 5 minutes for coins where auto_claim_enabled = true and the
// agent is part of an active strategy. When claimable fees exceed the
// per-launcher threshold (default 0.5 SOL), claims them via the platform
// fee-collect API. In simulate mode the claim is logged but not POSTed.

import { sql } from '../../api/_lib/db.js';
import { log } from './log.js';
import { screenPush } from './screen-push.js';
import { cachedStrategies } from './strategy-store.js';

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_THRESHOLD_SOL = 0.5;

const API_BASE = process.env.API_BASE_URL || 'https://three.ws';
const AGENT_JWT = process.env.AGENT_JWT;

// ── helpers ──────────────────────────────────────────────────────────────────

function lamportsToSol(l) {
	return Number(BigInt(l)) / 1e9;
}

/** Active agent IDs from armed strategies in the cached strategy set. */
function activeAgentIds() {
	const strategies = cachedStrategies();
	const ids = new Set();
	for (const s of strategies) {
		if (s.agent_id) ids.add(s.agent_id);
	}
	return [...ids];
}

/**
 * Fetch fee-info for a single mint from the platform API.
 * Returns null on any error so the caller can skip gracefully.
 */
async function fetchFeeInfo(mint, network) {
	const url = `${API_BASE}/api/pump?action=fee-info&mint=${encodeURIComponent(mint)}&network=${encodeURIComponent(network)}`;
	try {
		const res = await fetch(url, {
			headers: { authorization: `Bearer ${AGENT_JWT}` },
		});
		if (!res.ok) {
			log.warn('fee-info fetch failed', { mint, network, status: res.status });
			return null;
		}
		return await res.json();
	} catch (err) {
		log.warn('fee-info fetch error', { mint, network, err: err?.message });
		return null;
	}
}

/**
 * POST collect-creator-fee-agent to claim fees.
 * Returns { ok, sig, lamports } on success, null on failure.
 */
async function collectCreatorFee(agentId, mint, network) {
	const url = `${API_BASE}/api/pump?action=collect-creator-fee-agent`;
	try {
		const res = await fetch(url, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${AGENT_JWT}`,
			},
			body: JSON.stringify({ agentId, mint, network }),
		});
		if (!res.ok) {
			const body = await res.text().catch(() => '');
			log.warn('collect-creator-fee failed', { agentId, mint, network, status: res.status, body: body.slice(0, 200) });
			return null;
		}
		return await res.json();
	} catch (err) {
		log.warn('collect-creator-fee error', { agentId, mint, network, err: err?.message });
		return null;
	}
}

// ── main tick ────────────────────────────────────────────────────────────────

async function tick(cfg) {
	const agentIds = activeAgentIds();
	if (!agentIds.length) return;

	// Fetch all auto-claim-eligible coins for active agents.
	let coins;
	try {
		coins = await sql`
			SELECT
				c.id,
				c.agent_id,
				c.user_id,
				c.network,
				c.mint,
				c.symbol,
				c.name,
				c.claimable_lamports,
				c.total_claimed_lamports,
				l.auto_claim_threshold_sol,
				l.auto_claim_reinvest_pct
			FROM agent_launched_coins c
			LEFT JOIN agent_launcher_configs l ON l.id = c.launcher_id
			WHERE c.auto_claim_enabled = true
			  AND c.agent_id = ANY(${agentIds})
			  AND c.network = ${cfg.network}
		`;
	} catch (err) {
		log.error('auto-claimer query failed', { err: err?.message });
		return;
	}

	if (!coins.length) return;

	for (const coin of coins) {
		await processCoin(cfg, coin);
	}
}

async function processCoin(cfg, coin) {
	const symbol = coin.symbol || coin.mint.slice(0, 6);
	const thresholdSol = Number(coin.auto_claim_threshold_sol ?? DEFAULT_THRESHOLD_SOL);

	screenPush(`Checking creator fees: ${coin.symbol}`, 'activity');
	log.info('fee-check', { agent: coin.agent_id, mint: coin.mint, symbol });

	// 1. Fetch live fee-info from the platform endpoint.
	const feeInfo = await fetchFeeInfo(coin.mint, coin.network);
	if (!feeInfo) return;

	const claimableLamports = BigInt(feeInfo.claimable_lamports ?? 0);
	const claimableSol = lamportsToSol(claimableLamports);

	// Update last-checked claimable balance regardless of whether we claim.
	try {
		await sql`
			UPDATE agent_launched_coins
			SET claimable_lamports = ${claimableLamports.toString()},
			    last_fee_check_at  = now(),
			    is_graduated       = ${feeInfo.is_graduated ?? false}
			WHERE id = ${coin.id}
		`;
	} catch (err) {
		log.warn('fee-check db update failed', { mint: coin.mint, err: err?.message });
	}

	log.info('fee-check result', {
		agent: coin.agent_id,
		mint: coin.mint,
		symbol,
		claimable_sol: claimableSol,
		threshold_sol: thresholdSol,
	});

	// 2. Check threshold.
	if (claimableSol < thresholdSol) {
		log.info('below threshold — skip', { agent: coin.agent_id, mint: coin.mint, symbol, claimable_sol: claimableSol, threshold_sol: thresholdSol });
		return;
	}

	// 3. Claim (or simulate).
	screenPush(`Claiming ${claimableSol.toFixed(3)} SOL creator fees for $${symbol}`, 'trade');

	if (cfg.mode !== 'live') {
		log.info('simulate — would claim creator fees', {
			agent: coin.agent_id, mint: coin.mint, symbol, claimable_sol: claimableSol,
		});
		return;
	}

	const result = await collectCreatorFee(coin.agent_id, coin.mint, coin.network);
	if (!result?.ok) {
		log.warn('claim failed', { agent: coin.agent_id, mint: coin.mint, symbol });
		return;
	}

	// 4. Persist claim result.
	const claimedLamports = BigInt(result.lamports ?? 0);
	const newTotal = BigInt(coin.total_claimed_lamports ?? 0) + claimedLamports;
	const totalSol = lamportsToSol(newTotal).toFixed(3);

	try {
		await sql`
			UPDATE agent_launched_coins
			SET claimable_lamports       = 0,
			    last_claim_sig           = ${result.sig ?? null},
			    last_claim_at            = now(),
			    total_claimed_lamports   = ${newTotal.toString()}
			WHERE id = ${coin.id}
		`;
	} catch (err) {
		log.warn('claim db update failed', { mint: coin.mint, sig: result.sig, err: err?.message });
	}

	log.trade('creator-fee-claimed', {
		agent: coin.agent_id,
		mint: coin.mint,
		symbol,
		claimed_lamports: claimedLamports.toString(),
		claimed_sol: lamportsToSol(claimedLamports),
		total_claimed_sol: Number(totalSol),
		sig: result.sig,
	});

	screenPush(`Claimed ${lamportsToSol(claimedLamports)} SOL from $${symbol} — total: ${totalSol} SOL`, 'trade');
}

// ── public API ───────────────────────────────────────────────────────────────

/**
 * Start the auto-claimer watch loop.
 *
 * @param {{ cfg: object, signal?: AbortSignal }} options
 *   cfg   — the loadConfig() result (needs cfg.network, cfg.mode)
 *   signal — optional AbortSignal; abort stops the loop
 * @returns {Function} stop — call to cancel the interval
 */
export function startAutoClaimerWatch({ cfg, signal } = {}) {
	let running = false;

	const runTick = () => {
		if (running) return;
		running = true;
		tick(cfg)
			.catch((err) => log.error('auto-claimer tick crashed', { err: err?.message }))
			.finally(() => { running = false; });
	};

	const interval = setInterval(runTick, POLL_INTERVAL_MS);
	if (interval.unref) interval.unref();

	log.info('auto-claimer armed', { network: cfg.network, mode: cfg.mode, pollMs: POLL_INTERVAL_MS });

	// Fire immediately on start so we don't wait 5 minutes for the first check.
	runTick();

	function stop() {
		clearInterval(interval);
		log.info('auto-claimer stopped');
	}

	if (signal) {
		signal.addEventListener('abort', stop, { once: true });
	}

	return stop;
}
