// agent-orders — one evaluation sweep over all active orders.
//
// For each order: re-quote its mint off live on-chain state, evaluate the
// trigger/schedule, and on fire execute through executeAgentTrade — the SAME
// quote → firewall → spend-guard → custody-claim → sign → confirm pipeline the
// owner-driven trade endpoint uses. The orders worker adds NO new way to move
// funds: it only decides WHEN to call that one audited path. Every fill is
// firewall-gated, capped by the agent's spend policy + daily budget, and written
// to agent_custody_events (with an order_fills receipt linking back).

import { executeAgentTrade, parseTradeInput } from '../../api/agents/agent-trade.js';
import { getTradeLimits } from '../../api/_lib/agent-trade-guards.js';
import {
	shouldFirePrice, evaluateCondition, conditionSignals,
} from '../../api/_lib/orders.js';
import { getSignals, metricValue, getHolding } from './market.js';
import {
	getActiveOrders, expireOrders, recoverStaleFiring,
	claimFire, releaseFire, markEvaluated, seedReference,
	recordFillAndAdvance, loadAgent,
} from './store.js';
import { log } from './log.js';

// ── per-agent serialization ───────────────────────────────────────────────────
// One agent wallet, one budget: serialize an agent's fills inside a sweep so two
// orders can't both pass the daily-budget check on the same stale total. Across
// processes the custody idempotency_key is the real backstop.
const _locks = new Map();
async function withAgentLock(agentId, fn) {
	const prev = _locks.get(agentId) || Promise.resolve();
	let release;
	const next = new Promise((r) => (release = r));
	_locks.set(agentId, prev.then(() => next));
	await prev;
	try { return await fn(); }
	finally { release(); if (_locks.get(agentId) === next) _locks.delete(agentId); }
}

function errCode(err) {
	return err?.code || err?.name || 'error';
}

// Blocks that won't clear by retrying — stop the order (status 'error') instead
// of re-quoting it every sweep forever.
const TERMINAL_CODES = new Set(['firewall_blocked', 'graduated', 'zero_out', 'invalid_mint', 'quote_not_sol']);

/**
 * Decide whether (and how) an order fires this sweep. Returns a fire descriptor
 * or null to hold. Persists the per-sweep observation (last metric + trailing
 * high/low-water mark) as a side effect — that part runs every sweep, fired or not.
 */
async function evaluate(order, now) {
	// ── scheduled (DCA / TWAP) ────────────────────────────────────────────────
	if (order.type === 'dca' || order.type === 'twap') {
		if (!order.next_fire_at || new Date(order.next_fire_at).getTime() > now) return null;
		const slices = Number(order.schedule?.slices ?? 1);
		const sliceIndex = Number(order.schedule?.filled_slices ?? 0);
		if (sliceIndex >= slices) return null;
		const terminal = sliceIndex + 1 >= slices;
		const intervalMs = Number(order.schedule?.interval_seconds ?? 0) * 1000;
		const nextFireAt = terminal ? null : new Date(now + intervalMs).toISOString();
		// Best-effort price for the receipt (never blocks a scheduled fill).
		let triggerPrice = null;
		try {
			const { market, signals } = await getSignals({ network: order.network, mint: order.mint, metric: order.trigger_metric });
			triggerPrice = metricValue(market, signals, order.trigger_metric);
		} catch { /* receipt-only */ }
		return { reason: `${order.type}_slice`, triggerPrice, sliceIndex, terminal, nextFireAt };
	}

	// ── price-driven + conditional ────────────────────────────────────────────
	const need = order.type === 'conditional' ? conditionSignals(order.condition) : [];
	const { market, signals } = await getSignals({
		network: order.network, mint: order.mint, need,
		referencePrice: order.reference_price, metric: order.trigger_metric,
	});
	if (!market) { await markEvaluated(order.id, {}); return null; } // honest: no live price → hold

	const metricVal = metricValue(market, signals, order.trigger_metric);
	if (order.reference_price == null && metricVal != null) await seedReference(order.id, metricVal);

	// Track the trailing high/low-water mark every sweep, fired or not.
	let peak = order.peak_price;
	if (order.type === 'trailing' && metricVal != null) {
		const base = order.peak_price ?? metricVal;
		peak = order.side === 'sell' ? Math.max(base, metricVal) : Math.min(base, metricVal);
	}
	await markEvaluated(order.id, { lastPrice: metricVal, peak });

	if (order.type === 'conditional') {
		const { fired } = evaluateCondition(order.condition, signals);
		if (!fired) return null;
		return { reason: 'condition', triggerPrice: metricVal, sliceIndex: 0, terminal: true, nextFireAt: null };
	}

	if (!shouldFirePrice(order, metricVal, peak)) return null;
	const reason = order.type === 'trailing'
		? (order.side === 'sell' ? 'trailing_stop' : 'trailing_entry')
		: order.type;
	return { reason, triggerPrice: metricVal, sliceIndex: 0, terminal: true, nextFireAt: null };
}

/** Build the executeAgentTrade `body` for a fire, or null if it can't be sized. */
async function buildBody(order, agent) {
	const base = { mint: order.mint, slippageBps: order.slippage_bps, network: order.network, side: order.side };
	if (order.side === 'buy') {
		if (!(Number(order.size_sol) > 0)) return null;
		return { ...base, amount: Number(order.size_sol) };
	}
	// sell
	if (order.sell_pct != null) {
		if (order.sell_pct >= 100) return { ...base, amount: 'max' };
		const holding = await getHolding({ network: order.network, mint: order.mint, owner: agent.meta.solana_address });
		if (!holding || holding.whole <= 0) return null;
		const amt = holding.whole * (order.sell_pct / 100);
		return amt > 0 ? { ...base, amount: amt } : null;
	}
	if (Number(order.size_tokens) > 0) {
		// size_tokens is stored in RAW base units (see the orders migration and
		// docs/agent-wallet-api.md) while the trade path takes WHOLE tokens, so it
		// has to be scaled by the mint's own decimals. Passing the raw figure
		// through would ask for 10^decimals times the intended size and bounce off
		// insufficient_token_balance, a clearable code, on every sweep forever.
		const holding = await getHolding({ network: order.network, mint: order.mint, owner: agent.meta.solana_address });
		if (!holding) return null; // no decimals to scale by: hold, never guess
		const whole = Number(order.size_tokens) / 10 ** holding.decimals;
		return whole > 0 ? { ...base, amount: whole } : null;
	}
	return null;
}

/** Map an executeAgentTrade result onto an order_fills record + advance the order. */
async function settle(order, fire, result, mode) {
	const priorPartial = order.fill_count > 0;
	if (!result.ok) {
		const code = result.code || 'error';
		if (TERMINAL_CODES.has(code)) {
			// Record the failed attempt AND halt the order to 'error' atomically — a
			// rug verdict / graduated-buy / zero-out won't clear by retrying.
			await recordFillAndAdvance({
				order, terminal: false, terminalError: true,
				fill: { sliceIndex: fire.sliceIndex, triggerReason: fire.reason, triggerPrice: fire.triggerPrice, status: 'failed', detail: `${code}: ${result.message || ''}`.slice(0, 280) },
			});
			log.warn('order halted', { order: order.id, type: order.type, code });
			return;
		}
		// Transient/clearable block (budget, kill switch, frozen, rpc) — hold + retry.
		await releaseFire(order.id, priorPartial ? 'partial' : 'active', `${code}: ${result.message || ''}`.slice(0, 280));
		log.info('order fire blocked (will retry)', { order: order.id, code });
		return;
	}

	const d = result.data || {};
	const simulated = d.simulated === true || mode !== 'live';
	const status = simulated ? 'simulated' : (d.signature ? 'confirmed' : 'unconfirmed');
	const solAmount = order.side === 'buy' ? (d.sol_spent ?? null) : (d.sol_received ?? null);
	const tokenAmount = order.side === 'buy' ? (d.tokens_received ?? d.expected_out_raw ?? null) : (d.tokens_sold ?? null);

	await recordFillAndAdvance({
		order, terminal: fire.terminal, nextFireAt: fire.nextFireAt,
		fill: {
			sliceIndex: fire.sliceIndex, triggerReason: fire.reason, triggerPrice: fire.triggerPrice,
			solAmount: simulated ? 0 : solAmount, tokenAmount: simulated ? 0 : tokenAmount,
			priceImpactPct: d.price_impact_pct ?? null, venue: d.venue || null,
			signature: d.signature && d.signature !== 'SIMULATED' ? d.signature : null,
			custodyEventId: d.custody_event_id ?? null,
			status, detail: simulated ? 'paper fill (simulate mode)' : null,
			meta: { mode, slice: fire.sliceIndex },
		},
	});
	log.trade('fill', {
		order: order.id, type: order.type, side: order.side, mode, status,
		reason: fire.reason, slice: fire.sliceIndex, terminal: fire.terminal,
		sig: d.signature || null, impact: d.price_impact_pct ?? null,
	});
}

/** Fire one order (claim → size → execute → settle). Per-agent serialized. */
async function fireOne(order, agent, fire, cfg) {
	if (!(await claimFire(order.id))) return; // another sweep owns it
	try {
		const body = await buildBody(order, agent);
		if (!body) { await releaseFire(order.id, order.fill_count > 0 ? 'partial' : 'active', 'no_balance_or_size'); return; }

		const tradeLimits = getTradeLimits(agent.meta);
		let input;
		try { input = parseTradeInput(body, tradeLimits); }
		catch (e) { await releaseFire(order.id, 'error', `invalid_order: ${e?.message || e?.code || ''}`.slice(0, 280)); return; }

		input.idempotencyKey = `order:${order.id}:slice:${fire.sliceIndex ?? 0}`;
		if (cfg.mode !== 'live') input.simulate = true;

		const result = await executeAgentTrade({
			id: order.agent_id, userId: agent.userId, meta: agent.meta, input,
			source: `order:${order.type}`, sourceMeta: { order_id: order.id, slice: fire.sliceIndex },
		});
		await settle(order, fire, result, cfg.mode);
	} catch (err) {
		await releaseFire(order.id, order.fill_count > 0 ? 'partial' : 'active', errCode(err)).catch(() => {});
		log.error('order fire crashed', { order: order.id, err: err?.message });
	}
}

/**
 * Run one full sweep. Self-healing first (expire deadlines, recover stale firing
 * claims), then evaluate every active order, firing those whose trigger/schedule
 * is met. Orders are grouped by agent and agents processed with bounded
 * concurrency; an agent's own orders run serially under a per-agent lock.
 */
export async function runOrderSweep(cfg) {
	const now = Date.now();
	try {
		const expired = await expireOrders(cfg.network);
		const recovered = await recoverStaleFiring(cfg.network, cfg.staleFiringMs);
		if (expired || recovered) log.info('housekeeping', { expired, recovered });
	} catch (err) {
		log.warn('housekeeping failed', { err: err?.message });
	}

	let orders;
	try { orders = await getActiveOrders(cfg.network); }
	catch (err) { log.error('active-order query failed', { err: err?.message }); return; }
	if (!orders.length) return;

	// Group by agent so each agent's wallet is touched serially.
	const byAgent = new Map();
	for (const o of orders) {
		if (!byAgent.has(o.agent_id)) byAgent.set(o.agent_id, []);
		byAgent.get(o.agent_id).push(o);
	}

	const agentIds = [...byAgent.keys()];
	const agentCache = new Map();
	let cursor = 0;
	const worker = async () => {
		while (cursor < agentIds.length) {
			const agentId = agentIds[cursor++];
			await withAgentLock(agentId, async () => {
				let agent = agentCache.get(agentId);
				if (!agent) { agent = await loadAgent(agentId); agentCache.set(agentId, agent); }
				if (!agent || !agent.meta?.encrypted_solana_secret) {
					// No provisioned wallet — can't trade; leave orders untouched (the
					// owner sees them sit until the wallet exists). Don't spam errors.
					return;
				}
				for (const order of byAgent.get(agentId)) {
					try {
						const fire = await evaluate(order, now);
						if (fire) await fireOne(order, agent, fire, cfg);
					} catch (err) {
						log.error('order eval failed', { order: order.id, err: err?.message });
					}
				}
			});
		}
	};
	const pool = Math.max(1, Math.min(cfg.concurrency, agentIds.length));
	await Promise.all(Array.from({ length: pool }, worker));
}
