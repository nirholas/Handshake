/**
 * Alpha-drip at fanout time — the DB-facing half of the tiered signal release.
 *
 * `api/_lib/alpha-drip.js` decides WHAT seat a copier gets (pure, exhaustively
 * tested). This module is what the copy-fanout cron actually calls: it loads the
 * leaders' ladders, prices each copier against their live $THREE balance, and
 * later releases the alerts it held back.
 *
 * Cost discipline: a leader with the drip off costs nothing here — no config
 * row, no balance read, no branch taken. Balance reads are memoized per wallet
 * for the length of one tick, because a copier following three leaders should
 * not be priced three times.
 *
 * The invariant this module exists to keep: an intent row is ALWAYS written in
 * full at fanout time. `visible_at` moves when the copier is shown it, never
 * whether it happened.
 */

import { sql } from './db.js';
import { holderUsd, tierForUsd } from './three-tier.js';
import {
	normalizeDripConfig, planRelease, applyCapacityCap, formatDelay, emptyDripConfig,
} from './alpha-drip.js';

/** How long a copier gets to act once an intent is revealed to them. */
const ACT_WINDOW_MS = 30 * 60 * 1000;

/**
 * Load the enabled ladders for a batch of leaders in one query.
 * @returns {Promise<Map<string, object>>} leader_agent_id → normalized config (enabled only)
 */
export async function loadDripConfigs(leaderIds) {
	const configs = new Map();
	if (!leaderIds?.length) return configs;
	const rows = await sql`
		select leader_agent_id, enabled, schedule, public_delay_sec, disclosure, capacity_note
		from copy_alpha_drip
		where leader_agent_id = any(${leaderIds}) and enabled
	`;
	for (const row of rows) {
		const norm = normalizeDripConfig(row);
		// A row that no longer satisfies the release rules (a tier renamed under it,
		// say) releases to everyone at once rather than silently delaying anybody.
		if (norm.ok && norm.value.enabled) configs.set(row.leader_agent_id, norm.value);
	}
	return configs;
}

/** Per-tick memo of wallet → $THREE tier id, so one copier is priced once. */
export function newTierCache() {
	return new Map();
}

async function tierFor(wallet, cache) {
	if (!wallet) return tierForUsd(0).id;
	if (cache.has(wallet)) return cache.get(wallet);
	const { usd } = await holderUsd(wallet);
	const id = tierForUsd(usd).id;
	cache.set(wallet, id);
	return id;
}

/**
 * Price one copier's seat for one leader's signal.
 *
 * Returns the columns the fanout insert needs plus the capacity verdict. A
 * leader with no ladder returns the no-drip shape, which is exactly what every
 * row looked like before alpha-drip existed.
 *
 * @param {object} p
 * @param {object} p.subscription copy_subscriptions row (needs copier_wallet, min_order_sol)
 * @param {object|null} p.config normalized ladder, or null when the leader has none
 * @param {number|null} p.plannedSol the order the copy engine already sized and gated
 * @param {Map} p.tierCache from `newTierCache()`
 */
export async function priceRelease({ subscription, config, plannedSol, tierCache }) {
	if (!config?.enabled) {
		return {
			delaySec: 0, tier: null, matchedTier: null,
			visibleAt: null, expiresAt: null, notifyNow: true,
			plannedSol, capacitySkip: null,
		};
	}

	const tierId = await tierFor(subscription.copier_wallet, tierCache);
	const release = planRelease(config, tierId);

	const capped = applyCapacityCap(plannedSol, release.max_copy_size_sol, Number(subscription.min_order_sol) || 0);
	if (!capped.ok) {
		// The cap made the order too small to be worth signing: record the skip with
		// its own reason instead of a dust intent the copier would dismiss anyway.
		return {
			delaySec: release.delay_sec, tier: release.tier, matchedTier: release.matched_tier,
			visibleAt: null, expiresAt: null, notifyNow: false,
			plannedSol: null, capacitySkip: capped,
		};
	}

	const now = Date.now();
	const delayMs = release.delay_sec * 1000;
	return {
		delaySec: release.delay_sec,
		tier: release.tier,
		matchedTier: release.matched_tier,
		// A zero-delay seat is written exactly like a no-drip row, so nothing
		// downstream has to special-case "delayed by nothing".
		visibleAt: release.delay_sec > 0 ? new Date(now + delayMs) : null,
		expiresAt: release.delay_sec > 0 ? new Date(now + delayMs + ACT_WINDOW_MS) : null,
		notifyNow: release.delay_sec === 0,
		plannedSol: capped.order_sol,
		capacitySkip: null,
	};
}

function releaseMessage({ sym, name, plannedSol, leaderName, mint, network, delaySec, tier }) {
	const coin = sym ? `$${sym}${name ? ` (${name})` : ''}` : mint?.slice(0, 8) || 'unknown';
	const net = network === 'devnet' ? ' [devnet]' : '';
	const seat = tier ? ` · ${tier} seat` : '';
	const lines = [
		`⏱ Signal released${net}`,
		`${coin}`,
		`Leader: ${leaderName || 'unknown'}${seat}`,
		`Held ${formatDelay(delaySec)} on this leader's release ladder.`,
		`Your order: ${plannedSol != null ? `${Number(plannedSol).toFixed(4)} SOL` : 'sized by your rules'}`,
		``,
		`Act now → https://three.ws/dashboard/copy`,
	];
	if (mint) lines.push(`pump.fun → https://pump.fun/${mint}`);
	return lines.join('\n');
}

/**
 * Send the alerts held back by a drip, for every pending intent whose reveal has
 * now passed. Runs at the top of each fanout tick, so the release cadence is the
 * fanout cadence and no second cron is needed.
 *
 * `notified_at` is stamped for every row it touches, chat id or not, so a
 * subscription with notifications off is scanned once and never again.
 *
 * @param {object} p
 * @param {(chatId: string, text: string) => any} p.sendTg
 * @param {object} p.stats mutated with a `drip_released` counter
 */
export async function releaseDueDrips({ sendTg, stats = {} }) {
	const due = await sql`
		select e.id, e.mint, e.symbol, e.name, e.planned_sol, e.network, e.drip_delay_sec, e.drip_tier,
		       s.telegram_chat_id, a.name as leader_name
		from copy_executions e
		join copy_subscriptions s on s.id = e.subscription_id
		left join agent_identities a on a.id = e.leader_agent_id
		where e.status = 'pending'
		  and e.notified_at is null
		  and e.visible_at is not null
		  and e.visible_at <= now()
		order by e.visible_at asc
		limit 500
	`;
	if (!due.length) return;

	for (const row of due) {
		if (row.telegram_chat_id) {
			sendTg(row.telegram_chat_id, releaseMessage({
				sym: row.symbol, name: row.name, plannedSol: row.planned_sol,
				leaderName: row.leader_name, mint: row.mint, network: row.network,
				delaySec: row.drip_delay_sec || 0, tier: row.drip_tier,
			}));
		}
	}
	await sql`update copy_executions set notified_at = now() where id = any(${due.map((r) => r.id)})`;
	stats.drip_released = (stats.drip_released || 0) + due.length;
}

export { emptyDripConfig };
