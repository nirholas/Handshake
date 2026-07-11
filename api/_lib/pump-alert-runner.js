// @ts-check
// Server-side evaluator for pump dashboard alert rules (Task 04).
//
// Invoked every ~3 min by the pumpfun-monitor cron (api/cron/[name].js). For
// every enabled rule it matches the configured event class against a REAL
// persisted/live data source, respects the rule's cooldown, dedupes so the same
// on-chain event is never delivered twice, and fans the match out across the
// rule's delivery channels (in-app / webhook / Telegram).
//
// Data sources (all real, no mocks):
//   graduation  → pumpfun_graduations (persisted global feed) + pump_agent_mints
//   new_mint    → pump_agent_mints (a tracked agent's new coins)
//   price_*     → pump.fun coins API (authoritative USD market cap)
//   whale_buy   → pump.fun trades API (recent buys on the target mint)

import { sql } from './db.js';
import {
	cooldownElapsed,
	gradMatchesRule,
	newMintMatchesRule,
	isWhaleBuy,
	evaluatePriceRule,
	buildGraduationPayload,
	buildNewMintPayload,
	buildWhalePayload,
	buildPricePayload,
} from './pump-alert-eval.js';
import { deliverAlert } from './alert-delivery.js';
import { solPriceUsd as sharedSolPriceUsd } from './sol-price.js';

const GRAD_WINDOW = '15 minutes';
const NEW_MINT_WINDOW = '60 minutes';
const GRADS_PER_RUN = 100;
const DELIVER_CAP = 5; // max events delivered per rule per run (storm guard)
const MAX_PRICE_MINTS = 60; // distinct mints priced per run
const MAX_WHALE_MINTS = 60; // distinct mints polled for trades per run
const TRADES_LIMIT = 50;
const FETCH_TIMEOUT_MS = 2_500;

const PUMPFUN_COIN_API = 'https://frontend-api-v3.pump.fun/coins';
const PUMPFUN_TRADES_API = 'https://frontend-api-v3.pump.fun/trades/all';

/**
 * Evaluate all enabled pump alert rules and deliver matches.
 * @returns {Promise<Record<string, any>>} a structured report for the cron response.
 */
export async function runPumpAlertRules(now = Date.now()) {
	const report = {
		rules: 0,
		evaluated: 0,
		fired: 0,
		deliveries: { in_app: 0, webhook: 0, telegram: 0 },
		failures: { in_app: 0, webhook: 0, telegram: 0 },
		capped: { price_mints: false, whale_mints: false },
		errors: 0,
	};

	/** @type {any[]} */
	let rules;
	try {
		rules = await sql`
			SELECT id, user_id, kind, target_mint, target_agent, threshold,
			       deliver_in_app, webhook_url, webhook_secret, telegram_chat,
			       cooldown_seconds, enabled, label
			FROM pump_alert_rules
			WHERE enabled = true
		`;
	} catch (e) {
		// Table not migrated yet (dev/test) — skip cleanly.
		return { skipped: 'pump_alert_rules_unavailable', detail: e?.message || String(e) };
	}
	report.rules = rules.length;
	if (!rules.length) {
		await pruneDeliveries();
		return report;
	}

	// Fire state (cooldown / dedupe / crossing) for every rule, in one query.
	const fireRows = await sql`
		SELECT rule_id, last_fired_at, last_event_id, last_state
		FROM pump_alert_rule_fires
		WHERE rule_id = ANY(${rules.map((r) => r.id)}::uuid[])
	`;
	const fireState = new Map(fireRows.map((f) => [f.rule_id, f]));

	// Partition rules by kind.
	const byKind = { graduation: [], new_mint: [], price: [], whale_buy: [] };
	for (const r of rules) {
		if (r.kind === 'graduation') byKind.graduation.push(r);
		else if (r.kind === 'new_mint') byKind.new_mint.push(r);
		else if (r.kind === 'price_above' || r.kind === 'price_below') byKind.price.push(r);
		else if (r.kind === 'whale_buy') byKind.whale_buy.push(r);
	}

	const ctx = { now, solPrice: 0 };

	await Promise.all([
		runGraduationRules(byKind.graduation, fireState, report, ctx).catch((e) => bumpErr(report, e)),
		runNewMintRules(byKind.new_mint, fireState, report, ctx).catch((e) => bumpErr(report, e)),
		runPriceRules(byKind.price, fireState, report, ctx).catch((e) => bumpErr(report, e)),
		runWhaleRules(byKind.whale_buy, fireState, report, ctx).catch((e) => bumpErr(report, e)),
	]);

	await pruneDeliveries();
	return report;
}

function bumpErr(report, e) {
	report.errors++;
	console.error('[pump-alerts] evaluation error:', e?.message || e);
}

// ── graduation ───────────────────────────────────────────────────────────────

async function runGraduationRules(rules, fireState, report, ctx) {
	if (!rules.length) return;

	const grads = await sql`
		SELECT tx_signature, mint, name, symbol, amount_sol, market_cap_usd, seen_at
		FROM pumpfun_graduations
		WHERE seen_at > now() - ${GRAD_WINDOW}::interval
		ORDER BY seen_at ASC
		LIMIT ${GRADS_PER_RUN}
	`;
	if (!grads.length) return;

	// Build agent → owned-mints map for any agent-scoped graduation rules.
	const agentIds = [...new Set(rules.map((r) => r.target_agent).filter(Boolean))];
	const agentMints = await loadAgentMintSets(agentIds);

	for (const rule of rules) {
		report.evaluated++;
		const owned = rule.target_agent ? agentMints.get(rule.target_agent) || new Set() : undefined;
		const matched = grads.filter((g) => gradMatchesRule(rule, g, { agentMints: owned }));
		if (!matched.length) continue;
		const events = matched.map((g) => buildGraduationPayload(rule, g));
		await deliverEventRule(rule, fireState.get(rule.id), events, report, ctx.now);
	}
}

// ── new_mint (by tracked agent) ───────────────────────────────────────────────

async function runNewMintRules(rules, fireState, report, ctx) {
	if (!rules.length) return;
	const agentIds = [...new Set(rules.map((r) => r.target_agent).filter(Boolean))];
	if (!agentIds.length) return;

	const mints = await sql`
		SELECT id, agent_id, mint, name, symbol, created_at
		FROM pump_agent_mints
		WHERE agent_id = ANY(${agentIds}::uuid[])
		  AND created_at > now() - ${NEW_MINT_WINDOW}::interval
		ORDER BY created_at ASC
	`;
	if (!mints.length) return;

	for (const rule of rules) {
		report.evaluated++;
		const matched = mints.filter((m) => newMintMatchesRule(rule, m));
		if (!matched.length) continue;
		const events = matched.map((m) => buildNewMintPayload(rule, m));
		await deliverEventRule(rule, fireState.get(rule.id), events, report, ctx.now);
	}
}

// ── price (USD market cap crossing) ────────────────────────────────────────────

async function runPriceRules(rules, fireState, report, ctx) {
	if (!rules.length) return;

	let mints = [...new Set(rules.map((r) => r.target_mint).filter(Boolean))];
	if (mints.length > MAX_PRICE_MINTS) {
		report.capped.price_mints = mints.length;
		console.warn(`[pump-alerts] price rules: ${mints.length} mints exceeds cap ${MAX_PRICE_MINTS}; pricing first ${MAX_PRICE_MINTS}`);
		mints = mints.slice(0, MAX_PRICE_MINTS);
	}
	const priced = new Map();
	await Promise.all(
		mints.map(async (mint) => {
			priced.set(mint, await fetchCoin(mint));
		}),
	);

	for (const rule of rules) {
		report.evaluated++;
		const coin = priced.get(rule.target_mint);
		if (!coin || coin.market_cap_usd == null) continue;
		const fs = fireState.get(rule.id);
		const lastState = fs?.last_state || {};
		const { fire, nextState } = evaluatePriceRule(rule, coin.market_cap_usd, lastState);

		if (!fire) {
			// Persist crossing state every tick so the edge-trigger stays accurate.
			await upsertFire(rule.id, { last_state: nextState });
			continue;
		}
		if (!cooldownElapsed(fs?.last_fired_at, rule.cooldown_seconds, ctx.now)) {
			await upsertFire(rule.id, { last_state: nextState });
			continue;
		}
		const payload = buildPricePayload(rule, coin);
		await deliverOne(rule, payload, report);
		await upsertFire(rule.id, { last_fired_at: new Date(ctx.now), last_event_id: payload.event_id, last_state: nextState });
		report.fired++;
	}
}

// ── whale buys ─────────────────────────────────────────────────────────────────

async function runWhaleRules(rules, fireState, report, ctx) {
	if (!rules.length) return;

	let mints = [...new Set(rules.map((r) => r.target_mint).filter(Boolean))];
	if (mints.length > MAX_WHALE_MINTS) {
		report.capped.whale_mints = mints.length;
		console.warn(`[pump-alerts] whale rules: ${mints.length} mints exceeds cap ${MAX_WHALE_MINTS}; polling first ${MAX_WHALE_MINTS}`);
		mints = mints.slice(0, MAX_WHALE_MINTS);
	}
	ctx.solPrice = await getSolPrice();
	const tradesByMint = new Map();
	await Promise.all(
		mints.map(async (mint) => {
			tradesByMint.set(mint, await fetchRecentTrades(mint, ctx.solPrice));
		}),
	);

	for (const rule of rules) {
		report.evaluated++;
		const coin = { mint: rule.target_mint };
		const trades = tradesByMint.get(rule.target_mint) || [];
		// trades are returned newest-first; flip to ascending for ordered dedupe.
		const asc = trades.slice().reverse();
		const matched = asc.filter((t) => isWhaleBuy(rule, { ...t, mint: rule.target_mint }));
		if (!matched.length) continue;
		const events = matched.map((t) => buildWhalePayload(rule, coin, t));
		await deliverEventRule(rule, fireState.get(rule.id), events, report, ctx.now);
	}
}

// ── generic event delivery (graduation / new_mint / whale) ─────────────────────

/**
 * Deliver an ordered (ascending) list of event payloads for one rule, honoring
 * cooldown and deduping against last_event_id.
 */
async function deliverEventRule(rule, fs, events, report, now) {
	if (!cooldownElapsed(fs?.last_fired_at, rule.cooldown_seconds, now)) return;

	let fresh = events;
	if (fs?.last_event_id) {
		const idx = events.findIndex((e) => e.event_id && e.event_id === fs.last_event_id);
		if (idx >= 0) fresh = events.slice(idx + 1);
	}
	fresh = fresh.filter((e) => e.event_id);
	if (!fresh.length) return;

	const toDeliver = fresh.slice(-DELIVER_CAP);
	for (const payload of toDeliver) {
		await deliverOne(rule, payload, report);
		report.fired++;
	}
	const latest = toDeliver[toDeliver.length - 1];
	await upsertFire(rule.id, { last_fired_at: new Date(now), last_event_id: latest.event_id });
}

/** Run one payload across the rule's channels and log per-channel outcomes. */
async function deliverOne(rule, payload, report) {
	const result = await deliverAlert(rule, payload);
	for (const channel of /** @type {const} */ (['in_app', 'webhook', 'telegram'])) {
		const r = result[channel];
		if (!r.attempted) continue;
		if (r.ok) report.deliveries[channel]++;
		else report.failures[channel]++;
		await logDelivery(rule, channel, r, payload.event_id).catch(() => {});
	}
}

async function logDelivery(rule, channel, r, eventId) {
	await sql`
		insert into pump_alert_deliveries (rule_id, user_id, channel, ok, detail, event_id)
		values (${rule.id}, ${rule.user_id}, ${channel}, ${r.ok}, ${r.detail || null}, ${eventId || null})
	`;
}

/** Upsert a rule's fire/cooldown/crossing state. Only provided columns change. */
async function upsertFire(ruleId, { last_fired_at, last_event_id, last_state } = {}) {
	await sql`
		insert into pump_alert_rule_fires (rule_id, last_fired_at, last_event_id, last_state, updated_at)
		values (
			${ruleId},
			${last_fired_at ?? null},
			${last_event_id ?? null},
			${last_state ? JSON.stringify(last_state) : '{}'}::jsonb,
			now()
		)
		on conflict (rule_id) do update set
			last_fired_at = coalesce(${last_fired_at ?? null}, pump_alert_rule_fires.last_fired_at),
			last_event_id = coalesce(${last_event_id ?? null}, pump_alert_rule_fires.last_event_id),
			last_state    = coalesce(${last_state ? JSON.stringify(last_state) : null}::jsonb, pump_alert_rule_fires.last_state),
			updated_at    = now()
	`;
}

async function pruneDeliveries() {
	try {
		await sql`DELETE FROM pump_alert_deliveries WHERE created_at < now() - interval '7 days'`;
	} catch {
		/* best-effort */
	}
}

// ── agent → owned mints ────────────────────────────────────────────────────────

async function loadAgentMintSets(agentIds) {
	const map = new Map();
	if (!agentIds.length) return map;
	const rows = await sql`
		SELECT agent_id, mint FROM pump_agent_mints WHERE agent_id = ANY(${agentIds}::uuid[])
	`;
	for (const r of rows) {
		if (!map.has(r.agent_id)) map.set(r.agent_id, new Set());
		map.get(r.agent_id).add(r.mint);
	}
	return map;
}

// ── live pump.fun fetchers ─────────────────────────────────────────────────────

async function fetchJsonWithTimeout(url, ms = FETCH_TIMEOUT_MS) {
	const ctrl = new AbortController();
	const tid = setTimeout(() => ctrl.abort(), ms);
	try {
		const r = await fetch(url, {
			signal: ctrl.signal,
			headers: { accept: 'application/json', 'user-agent': 'three.ws-pump-alerts/1' },
		});
		if (!r.ok) return null;
		return await r.json();
	} catch {
		return null;
	} finally {
		clearTimeout(tid);
	}
}

/** Current coin snapshot → { mint, name, symbol, market_cap_usd } or null. */
async function fetchCoin(mint) {
	const d = await fetchJsonWithTimeout(`${PUMPFUN_COIN_API}/${encodeURIComponent(mint)}`);
	if (!d) return null;
	const mc = typeof d.usd_market_cap === 'number' ? d.usd_market_cap : null;
	return { mint, name: d.name || null, symbol: d.symbol || null, market_cap_usd: mc };
}

/**
 * Recent trades for a mint, newest-first, normalized to
 * { signature, is_buy, sol_amount (SOL), sol_value_usd, buyer, ts }.
 */
async function fetchRecentTrades(mint, solPrice = 0) {
	const d = await fetchJsonWithTimeout(`${PUMPFUN_TRADES_API}/${encodeURIComponent(mint)}?limit=${TRADES_LIMIT}&offset=0`);
	if (!Array.isArray(d)) return [];
	return d.map((t) => {
		const sol = typeof t.sol_amount === 'number' ? t.sol_amount / 1e9 : null;
		return {
			signature: t.signature || t.tx_signature || null,
			is_buy: t.is_buy === true,
			sol_amount: sol,
			sol_value_usd: sol != null && solPrice > 0 ? sol * solPrice : null,
			buyer: t.user || t.trader || null,
			ts: typeof t.timestamp === 'number' ? new Date(t.timestamp * 1000) : null,
		};
	});
}

// SOL/USD for USD-denominating price-rule evaluations. Delegates to the shared
// 7-source failover helper (itself cached ~60s) so a single-provider rate-limit
// never stalls alert pricing. Returns 0 only if every free source is down.
const getSolPrice = () => sharedSolPriceUsd();
