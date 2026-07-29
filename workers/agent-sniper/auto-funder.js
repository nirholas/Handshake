// agent-sniper — buy-side auto-funding loop.
//
// A live sniper's wallet drains as it buys. Without a top-up it silently goes
// broke and every subsequent snipe fails its balance check — a green heartbeat
// hiding a dead bot. This loop keeps each armed agent's OWN Solana wallet above
// a floor: when an agent's balance drops below SNIPER_AUTO_FUND_MIN_SOL it tops
// it back up to SNIPER_AUTO_FUND_TARGET_SOL from the launcher master wallet,
// reusing the same guarded transfer (caps + master-balance buffer + protected
// submit) the autonomous launcher uses.
//
// Guardrails (no env weakens them past the master's own balance buffer):
//   - per-transfer cap   (SNIPER_AUTO_FUND_PER_TX_SOL)
//   - daily total cap     (SNIPER_AUTO_FUND_DAILY_SOL), summed from the on-chain
//                          funding ledger so a worker restart can't bypass it
//   - master balance buffer (enforced inside fundAgentForLaunch)
// In simulate mode it logs what it WOULD move and records a 'SIMULATED' ledger
// row — zero SOL leaves the master.

import { sql } from '../../api/_lib/db.js';
import { fundAgentForLaunch, masterBalanceSol } from '../../api/_lib/launcher-funding.js';
import { getSolBalance } from '../../api/_lib/avatar-wallet.js';
import { solanaConnection } from '../../api/_lib/agent-pumpfun.js';
import { log } from './log.js';
import { screenPush } from './screen-push.js';
import { cachedStrategies, getRealizedNetLamports, effectiveDailyLossLimitLamports } from './strategy-store.js';
import { checkDailyLoss } from '../../api/_lib/agent-trade-guards.js';
import { autoFundMinSol, autoFundTargetSol } from '../../api/_lib/agent-funding-policy.js';

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

function num(name, def) {
	const raw = process.env[name];
	if (raw == null || raw === '') return def;
	const n = Number(raw);
	return Number.isFinite(n) ? n : def;
}

// Floor + target + caps (SOL). Conservative defaults: keep ~0.05 SOL of dry
// powder per agent, refill when it falls under 0.02, never move more than 0.1 in
// one top-up or 1.0 total per UTC day across all agents.
// Shared with the economy's idle-capital reclaim (api/_lib/agent-funding-policy.js).
// Defining these here again is what let a reclaim floor drift under this target and
// set the two crons ping-ponging the same SOL; the numbers now have one home.
const MIN_SOL = autoFundMinSol();
const TARGET_SOL = autoFundTargetSol();
const PER_TX_CAP_SOL = Math.max(0, num('SNIPER_AUTO_FUND_PER_TX_SOL', 0.1));
const DAILY_CAP_SOL = Math.max(0, num('SNIPER_AUTO_FUND_DAILY_SOL', 1.0));
// Per-agent daily refill ceiling — the guard the incident lacked. The fleet cap
// alone let a SINGLE wallet that only bought rugs consume the whole day's budget:
// buy rug → drop below MIN → refill → repeat. This bounds how much any one agent
// can draw from the master per UTC day (default 0.25 SOL ≈ 5 top-ups), so a
// bleeding wallet can't starve healthy agents or drain the master after it. 0 = off.
const PER_AGENT_DAILY_CAP_SOL = Math.max(0, num('SNIPER_AUTO_FUND_PER_AGENT_DAILY_SOL', 0.25));

/**
 * Agent ids eligible for auto-funding on this network.
 *
 * Explicit consent only: a strategy must set `auto_fund_enabled = true` before
 * its agent's wallet may be topped up from the launcher master. Merely arming a
 * strategy (enabled=true) moves NO money — that implicit trigger was the
 * "arming a mainnet strategy silently pushes SOL from a master" footgun. A
 * missing/false flag (e.g. before the consent migration is applied) is treated
 * as "do not fund", so the safe default holds even mid-migration.
 *
 * Pure over its `strategies` arg so it can be unit-tested without the cache.
 *
 * @param {Array<{agent_id?: string, network?: string, auto_fund_enabled?: boolean}>} strategies
 * @param {string} network
 * @returns {string[]}
 */
export function optedInAgentIds(strategies, network) {
	const ids = new Set();
	for (const s of strategies || []) {
		if (s.agent_id && s.network === network && s.auto_fund_enabled === true) {
			ids.add(s.agent_id);
		}
	}
	return [...ids];
}

/** Unique agent ids that have opted into auto-funding for this network. */
function activeAgentIds(network) {
	return optedInAgentIds(cachedStrategies(), network);
}

/** SOL actually moved (live) since the start of the UTC day — the daily-cap base. */
async function dailyFundedSol(network) {
	const [row] = await sql`
		SELECT coalesce(sum(lamports), 0)::float8 / 1e9 AS sol
		FROM sniper_funding_events
		WHERE network = ${network}
		  AND mode = 'live'
		  AND created_at >= date_trunc('day', now())
	`;
	return Number(row?.sol || 0);
}

/** SOL moved (live) to EACH agent since the start of the UTC day — the per-agent cap base. */
async function perAgentFundedSol(network) {
	const rows = await sql`
		SELECT agent_id, coalesce(sum(lamports), 0)::float8 / 1e9 AS sol
		FROM sniper_funding_events
		WHERE network = ${network}
		  AND mode = 'live'
		  AND created_at >= date_trunc('day', now())
		GROUP BY agent_id
	`;
	const m = new Map();
	for (const r of rows) m.set(r.agent_id, Number(r.sol || 0));
	return m;
}

/**
 * Tightest effective daily-loss cap (lamports) across an agent's opted-in
 * strategies — an agent may run more than one. Used to decide whether to keep
 * refilling a wallet: once realized loss crosses this, the refills stop.
 */
function agentLossLimit(agentId, network) {
	let tightest = null;
	for (const s of cachedStrategies()) {
		if (s.agent_id !== agentId || s.network !== network) continue;
		const lim = effectiveDailyLossLimitLamports(s);
		if (lim == null) continue;
		if (tightest == null || lim < tightest) tightest = lim;
	}
	return tightest;
}

/** Resolve each armed agent's Solana address from its identity meta. */
async function agentAddresses(agentIds) {
	if (!agentIds.length) return new Map();
	const rows = await sql`
		SELECT id, meta->>'solana_address' AS address
		FROM agent_identities
		WHERE id = ANY(${agentIds}) AND deleted_at IS NULL
	`;
	const m = new Map();
	for (const r of rows) {
		if (r.address) m.set(r.id, r.address);
	}
	return m;
}

async function tick(cfg) {
	const agentIds = activeAgentIds(cfg.network);
	if (!agentIds.length) return;

	const addresses = await agentAddresses(agentIds);
	if (!addresses.size) return;

	// One daily-spend read per tick; decremented locally as we fund so several
	// agents in the same tick can't collectively blow past the cap.
	let dailyRemaining = DAILY_CAP_SOL > 0 ? Math.max(0, DAILY_CAP_SOL - (await dailyFundedSol(cfg.network))) : Infinity;
	// Per-agent funded-today, so one wallet can't consume the whole fleet budget.
	const perAgentFunded = PER_AGENT_DAILY_CAP_SOL > 0 ? await perAgentFundedSol(cfg.network) : new Map();
	const conn = solanaConnection(cfg.network);

	for (const [agentId, address] of addresses) {
		if (DAILY_CAP_SOL > 0 && dailyRemaining <= 0) {
			log.warn('auto-fund daily cap reached — skipping remaining agents', { network: cfg.network, dailyCapSol: DAILY_CAP_SOL });
			break;
		}

		let balanceSol;
		try {
			({ sol: balanceSol } = await getSolBalance(conn, address));
		} catch (err) {
			log.warn('auto-fund balance read failed', { agentId, err: err?.message });
			continue;
		}

		if (balanceSol >= MIN_SOL) continue; // healthy — nothing to do

		// LOSS GATE — stop refilling a wallet that has bled past its daily loss cap.
		// This is the fix for the rug-buy + auto-refill loop: a wallet that only
		// loses stops getting topped up, so the master can't keep pouring SOL after
		// it. Only priced when a loss cap is configured; a DB hiccup never blocks a
		// legitimate refill (the per-agent + daily SOL caps below stay the backstop).
		const lossLimit = agentLossLimit(agentId, cfg.network);
		if (lossLimit != null) {
			try {
				const netRealized = await getRealizedNetLamports(agentId, cfg.network);
				if (checkDailyLoss(netRealized, lossLimit)) {
					log.warn('auto-fund paused — agent hit daily loss cap', { agentId, wallet: address, net_realized_sol: Number(netRealized) / 1e9 });
					screenPush(`Paused refills for ${address.slice(0, 4)}… — daily loss cap reached`, 'guard');
					continue;
				}
			} catch (err) {
				log.warn('auto-fund loss check failed — allowing on SOL-cap backstop', { agentId, err: err?.message });
			}
		}

		// PER-AGENT DAILY CAP — bound how much any one wallet can draw per day.
		let agentRemaining = Infinity;
		if (PER_AGENT_DAILY_CAP_SOL > 0) {
			agentRemaining = Math.max(0, PER_AGENT_DAILY_CAP_SOL - (perAgentFunded.get(agentId) || 0));
			if (agentRemaining <= 0) {
				log.warn('auto-fund per-agent daily cap reached — skipping', { agentId, wallet: address, perAgentCapSol: PER_AGENT_DAILY_CAP_SOL });
				continue;
			}
		}

		// Top up to the target, bounded by the per-transfer, per-agent, and fleet caps.
		let topUp = TARGET_SOL - balanceSol;
		if (PER_TX_CAP_SOL > 0) topUp = Math.min(topUp, PER_TX_CAP_SOL);
		if (PER_AGENT_DAILY_CAP_SOL > 0) topUp = Math.min(topUp, agentRemaining);
		if (DAILY_CAP_SOL > 0) topUp = Math.min(topUp, dailyRemaining);
		topUp = Math.round(topUp * 1e9) / 1e9; // lamport precision
		if (topUp <= 0) continue;

		log.info('auto-fund low wallet', { agentId, wallet: address, balance_sol: balanceSol, min_sol: MIN_SOL, top_up_sol: topUp });
		screenPush(`Topping up sniper wallet ${address.slice(0, 4)}… +${topUp.toFixed(3)} SOL`, 'activity');

		if (cfg.mode !== 'live') {
			await recordFunding({ agentId, wallet: address, network: cfg.network, sol: topUp, balanceBeforeSol: balanceSol, signature: 'SIMULATED', mode: 'simulate' });
			log.info('simulate — would top up wallet', { agentId, wallet: address, top_up_sol: topUp });
			if (DAILY_CAP_SOL > 0) dailyRemaining -= topUp;
			if (PER_AGENT_DAILY_CAP_SOL > 0) perAgentFunded.set(agentId, (perAgentFunded.get(agentId) || 0) + topUp);
			continue;
		}

		let result;
		try {
			result = await fundAgentForLaunch({
				agentAddress: address,
				sol: topUp,
				perLaunchCapSol: PER_TX_CAP_SOL,
				dailyCapSol: DAILY_CAP_SOL > 0 ? dailyRemaining : null,
				network: cfg.network,
				memo: 'three.ws sniper top-up',
			});
		} catch (err) {
			log.error('auto-fund transfer threw', { agentId, wallet: address, err: err?.message });
			continue;
		}

		if (!result?.ok) {
			log.warn('auto-fund refused', { agentId, wallet: address, reason: result?.reason });
			continue;
		}

		await recordFunding({
			agentId, wallet: address, network: cfg.network, sol: topUp,
			balanceBeforeSol: balanceSol, signature: result.signature, mode: 'live',
		});
		if (DAILY_CAP_SOL > 0) dailyRemaining -= topUp;
		if (PER_AGENT_DAILY_CAP_SOL > 0) perAgentFunded.set(agentId, (perAgentFunded.get(agentId) || 0) + topUp);

		log.trade('wallet-funded', { agentId, wallet: address, top_up_sol: topUp, balance_before_sol: balanceSol, sig: result.signature });
		screenPush(`Funded ${address.slice(0, 4)}… +${topUp.toFixed(3)} SOL`, 'trade');
	}
}

async function recordFunding({ agentId, wallet, network, sol, balanceBeforeSol, signature, mode }) {
	try {
		const lamports = String(Math.round(sol * 1e9));
		const beforeLamports = balanceBeforeSol == null ? null : String(Math.round(balanceBeforeSol * 1e9));
		await sql`
			INSERT INTO sniper_funding_events (agent_id, wallet, network, lamports, balance_before_lamports, signature, mode)
			VALUES (${agentId}, ${wallet}, ${network}, ${lamports}, ${beforeLamports}, ${signature}, ${mode})
		`;
	} catch (err) {
		// A ledger write failure must not double-fund: in live mode treat it as a
		// hard error the caller should see, but never throw out of the tick.
		log.error('auto-fund ledger write failed', { agentId, wallet, sig: signature, err: err?.message });
	}
}

/**
 * Start the auto-funding watch loop.
 *
 * @param {{ cfg: object, signal?: AbortSignal }} options
 * @returns {Function} stop
 */
export function startAutoFunderWatch({ cfg, signal } = {}) {
	let running = false;

	const runTick = () => {
		if (running) return;
		running = true;
		tick(cfg)
			.catch((err) => log.error('auto-funder tick crashed', { err: err?.message }))
			.finally(() => { running = false; });
	};

	const interval = setInterval(runTick, POLL_INTERVAL_MS);
	if (interval.unref) interval.unref();

	log.info('auto-funder armed', {
		network: cfg.network, mode: cfg.mode, pollMs: POLL_INTERVAL_MS,
		minSol: MIN_SOL, targetSol: TARGET_SOL, perTxCapSol: PER_TX_CAP_SOL, dailyCapSol: DAILY_CAP_SOL,
		perAgentDailyCapSol: PER_AGENT_DAILY_CAP_SOL,
		lossCapSol: num('SNIPER_MAX_DAILY_LOSS_SOL', null),
		// Consent is explicit and per-strategy — this is how many agents can be funded at all.
		optedInAgents: activeAgentIds(cfg.network).length,
	});

	// Warn loudly if live funding is armed but the master wallet is unconfigured —
	// otherwise every top-up silently refuses and wallets drain anyway.
	if (cfg.mode === 'live') {
		masterBalanceSol(cfg.network)
			.then((bal) => {
				if (bal == null) log.warn('auto-funder: master launch wallet not configured — top-ups will be refused');
				else log.info('auto-funder master balance', { master_sol: bal });
			})
			.catch((err) => log.warn('auto-funder master balance check failed', { err: err?.message }));
	}

	runTick(); // fire immediately so a freshly-armed agent isn't unfunded for 5 min

	function stop() {
		clearInterval(interval);
		log.info('auto-funder stopped');
	}

	if (signal) signal.addEventListener('abort', stop, { once: true });
	return stop;
}
