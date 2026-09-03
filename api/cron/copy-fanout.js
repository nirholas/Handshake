// GET /api/cron/copy-fanout — turn leader trades into copier intents.
//
// Two fanout sources:
//   1. agent_sniper_positions — the sniper engine's real executed positions.
//   2. oracle_watch_actions   — the Oracle conviction agent's live buys.
//
// For each (position/action, subscriber) the cron generates a sized,
// safety-checked copy INTENT via the pure copy-engine. Non-custodial: it only
// records the intent — the copier acts from their own wallet.
//
//   BUY  fanout: a leader opens/buys → size each subscriber's order, clamp to
//                their per-trade cap + remaining daily budget, gate on coin safety,
//                and insert a pending intent (or a 'skipped' row with reason).
//   SELL fanout (sniper only): a leader closes → mirror exit ONLY to copiers who
//                acted on the matching buy. Oracle sells are not modelled (there
//                is no explicit exit event — outcomes are graded after the fact).
//
// Two guards run BEFORE any sizing (api/_lib/copy-eligibility.js), because both
// protect money rather than shaping an intent:
//   • DRAWDOWN BREAKER — the leader's realized peak-to-trough loss is measured
//     once per leader per tick; every subscription whose max_drawdown_pct it
//     breaches is flipped to 'paused' with the reason recorded, and fans out
//     nothing further. A copier is never mirrored into a leader's slide.
//   • SELF-COPY — a subscription whose copier owns the leader agent is skipped.
//     Subscribing to your own agent is refused at the endpoint; this catches any
//     row that predates that rule, so a wash-trade loop cannot keep firing.
//
// Idempotent via partial unique indexes:
//   (subscription_id, leader_position_id,      direction) when leader_position_id      is not null
//   (subscription_id, leader_oracle_action_id, direction) when leader_oracle_action_id is not null

import { json, method, wrapCron } from '../_lib/http.js';
import { sql } from '../_lib/db.js';
import { planCopyOrder } from '../_lib/copy-engine.js';
import { BREAKER_REASON, evaluateDrawdownBreaker, leaderDrawdownPcts } from '../_lib/copy-eligibility.js';
import { loadDripConfigs, newTierCache, priceRelease, releaseDueDrips } from '../_lib/copy-drip-runtime.js';
import { requireCron } from '../_lib/cron-auth.js';
import { pumpFetchJson, PUMP_FRONTEND_BASE } from '../_lib/pump-feed-fetch.js';
import { fetchTokenMarketData } from '../_lib/market/token-market.js';

const NETWORKS = ['mainnet', 'devnet'];
const lamToSol = (l) => (l == null ? 0 : Number(BigInt(l)) / 1e9);

// ── Telegram notification helpers ─────────────────────────────────────────────

async function sendTg(chatId, text) {
	const token = process.env.TELEGRAM_BOT_TOKEN;
	if (!token || !chatId) return;
	try {
		await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
			signal: AbortSignal.timeout(5000),
		});
	} catch { /* best-effort */ }
}

function buyIntentMessage({ sym, name, plannedSol, leaderName, oracleScore, oracleTier, mint, network, traderUrl }) {
	const coin = sym ? `$${sym}${name ? ` (${name})` : ''}` : mint?.slice(0, 8) || 'unknown';
	const tier = oracleTier ? ` [${oracleTier.toUpperCase()}]` : '';
	const score = oracleScore != null ? ` · score ${Math.round(oracleScore)}` : '';
	const net = network === 'devnet' ? ' [devnet]' : '';
	const lines = [
		`⚡ Copy Trade Intent${net}`,
		`${coin}${tier}${score}`,
		`Leader: ${leaderName || 'unknown'}`,
		`Your order: ${plannedSol != null ? `${plannedSol.toFixed(4)} SOL` : 'sized by your rules'}`,
		``,
		`Act now → https://three.ws${traderUrl}/dashboard/copy`,
	];
	// Only append the coin link when there is a mint; a blank entry here rendered
	// as a trailing empty line in the Telegram message.
	if (mint) lines.push(`pump.fun → https://pump.fun/${mint}`);
	return lines.join('\n');
}

// Fetch agent display name (cached per run).
const _agentNameCache = new Map();
async function agentName(agentId) {
	if (_agentNameCache.has(agentId)) return _agentNameCache.get(agentId);
	try {
		const [row] = await sql`select name from agent_identities where id = ${agentId} limit 1`;
		const n = row?.name || null;
		_agentNameCache.set(agentId, n);
		return n;
	} catch { return null; }
}

// Best-effort coin context for the safety gate. pump.fun's public coin endpoint
// gives a live USD market cap; richer signals (dev holding, liquidity, honeypot)
// are left null and the engine treats them as "unknown". Oracle score is merged
// in separately so subscriptions with min_oracle_score can filter on it.
const _coinCache = new Map();
async function coinContext(mint, oracleScore) {
	if (_coinCache.has(mint)) {
		const cached = _coinCache.get(mint);
		return oracleScore != null ? { ...cached, oracle_score: oracleScore } : cached;
	}
	let ctx = null;
	try {
		const { ok, body: c } = await pumpFetchJson(`${PUMP_FRONTEND_BASE}/coins/${mint}`, { timeoutMs: 5000, retries: 1 });
		if (ok && c) {
			ctx = { market_cap_usd: Number(c.usd_market_cap) || null, graduated: !!c.complete };
		} else {
			// pump.fun down: the shared multi-source reader still knows the market
			// cap. Graduation is a pump.fun fact, so it stays unknown (null) rather
			// than guessed; the engine treats a missing field as missing.
			const md = await fetchTokenMarketData(mint);
			if (md) ctx = { market_cap_usd: Number(md.market_cap) || null, graduated: null };
		}
	} catch { /* leave null — engine handles missing context */ }
	_coinCache.set(mint, ctx);
	return oracleScore != null ? { ...(ctx || {}), oracle_score: oracleScore } : ctx;
}

// Fetch the latest Oracle conviction score for a mint from the DB. Returns null
// if unscored. Called in the sniper fanout path (Oracle fanout has the score inline).
const _oracleScoreCache = new Map();
async function oracleScore(mint, network) {
	const key = `${network}:${mint}`;
	if (_oracleScoreCache.has(key)) return _oracleScoreCache.get(key);
	try {
		const [row] = await sql`
			select score from oracle_conviction
			where mint = ${mint} and network = ${network}
			limit 1
		`;
		const score = row?.score != null ? Number(row.score) : null;
		_oracleScoreCache.set(key, score);
		return score;
	} catch { return null; }
}

// ── Pre-sizing guards ─────────────────────────────────────────────────────────

function breakerMessage({ leaderName, drawdownPct, limitPct }) {
	return [
		'\u26d4 Copy trading paused',
		`Leader: ${leaderName || 'unknown'}`,
		`Drawdown ${drawdownPct}% reached your ${limitPct}% limit.`,
		'',
		'Nothing was copied. Review and resume when you are ready:',
		'https://three.ws/dashboard/copy',
	].join('\n');
}

/**
 * Active subscriptions for a batch of leaders, grouped by leader, with the two
 * money-protecting guards already applied.
 *
 * Self-copy rows are dropped (a copier who owns the leader would pay a
 * performance fee to themselves and inflate that leader's public copier count),
 * and any subscription whose copier-set drawdown limit the leader has breached is
 * flipped to 'paused' here, with the reason and timestamp recorded, before it can
 * size a single order.
 *
 * Exported so the guards can be exercised directly: they are the money-adjacent
 * half of this cron, and the fanout itself only runs when a leader traded inside
 * the last 8 minutes.
 */
export async function activeSubscriptionsByLeader(leaderIds, network, stats) {
	const byLeader = new Map();
	if (!leaderIds.length) return byLeader;

	// The leader's owner comes back on the row so the self-copy test costs no
	// extra round trip.
	const subRows = await sql`
		select s.*, a.user_id as leader_user_id, a.name as leader_name
		from copy_subscriptions s
		join agent_identities a on a.id = s.leader_agent_id
		where s.leader_agent_id = any(${leaderIds}) and s.network = ${network} and s.status = 'active'
	`;
	if (!subRows.length) return byLeader;

	// One drawdown query for every leader in the batch, not one per subscription.
	const drawdowns = await leaderDrawdownPcts(leaderIds, network);

	for (const sub of subRows) {
		if (sub.leader_user_id && sub.leader_user_id === sub.copier_user_id) {
			stats.skipped_self_copy = (stats.skipped_self_copy || 0) + 1;
			continue;
		}

		const breaker = evaluateDrawdownBreaker(sub, drawdowns.get(sub.leader_agent_id) ?? null);
		if (breaker.breached) {
			const [paused] = await sql`
				update copy_subscriptions
				set status = 'paused', paused_reason = ${BREAKER_REASON}, paused_at = now(), updated_at = now()
				where id = ${sub.id} and status = 'active'
				returning id
			`;
			// Only the tick that actually flipped the row counts it and notifies, so a
			// retry or an overlapping run cannot double-report or double-message.
			if (paused) {
				stats.paused_drawdown = (stats.paused_drawdown || 0) + 1;
				if (sub.telegram_chat_id) {
					sendTg(sub.telegram_chat_id, breakerMessage({
						leaderName: sub.leader_name,
						drawdownPct: breaker.drawdown_pct,
						limitPct: breaker.limit_pct,
					}));
				}
			}
			continue;
		}

		if (!byLeader.has(sub.leader_agent_id)) byLeader.set(sub.leader_agent_id, []);
		byLeader.get(sub.leader_agent_id).push(sub);
	}
	return byLeader;
}

async function fanoutBuys(network, stats) {
	const positions = await sql`
		select p.id, p.agent_id, p.mint, p.symbol, p.name, p.entry_quote_lamports, p.buy_sig, p.opened_at
		from agent_sniper_positions p
		where p.network = ${network} and p.buy_sig is not null and p.buy_sig <> 'SIMULATED'
		  and p.opened_at > now() - interval '8 minutes'
		  and exists (
		    select 1 from copy_subscriptions s
		    where s.leader_agent_id = p.agent_id and s.network = ${network} and s.status = 'active'
		  )
		order by p.opened_at desc
		limit 200
	`;
	if (!positions.length) return;

	// Per-subscription day-spend + open-intent counts, batched once.
	const spendRows = await sql`
		select subscription_id, coalesce(sum(planned_sol), 0) as spent
		from copy_executions
		where direction = 'buy' and status in ('pending', 'acted') and created_at::date = current_date
		group by subscription_id
	`;
	const openRows = await sql`
		select subscription_id, count(*) as open
		from copy_executions
		where direction = 'buy' and status = 'pending'
		group by subscription_id
	`;
	const spent = new Map(spendRows.map((r) => [r.subscription_id, Number(r.spent) || 0]));
	const open = new Map(openRows.map((r) => [r.subscription_id, Number(r.open) || 0]));

	// Active subscriptions for every leader in this batch, fetched once and grouped
	// by leader_agent_id — replaces a per-position query. Self-copy rows are dropped
	// and drawdown-breached ones are auto-paused before anything is sized.
	const leaderIds = [...new Set(positions.map((p) => p.agent_id))];
	const subsByLeader = await activeSubscriptionsByLeader(leaderIds, network, stats);
	// Alpha-drip ladders for this batch. Leaders without one cost nothing below.
	const drips = await loadDripConfigs(leaderIds);
	const tierCache = newTierCache();

	for (const pos of positions) {
		const subs = subsByLeader.get(pos.agent_id) || [];
		if (!subs.length) continue;
		const score = await oracleScore(pos.mint, network);
		const coin = await coinContext(pos.mint, score);
		const entrySol = lamToSol(pos.entry_quote_lamports);

		for (const sub of subs) {
			const decision = planCopyOrder({
				subscription: sub,
				position: { direction: 'buy', entry_sol: entrySol, mint: pos.mint },
				coin,
				spentTodaySol: spent.get(sub.id) || 0,
				openCopies: open.get(sub.id) || 0,
			});
			// Alpha-drip: price this copier's seat, apply the tier's capacity cap, and
			// work out when the intent is revealed to them. The row itself is written
			// in full either way — only the reveal moves.
			const release = decision.action === 'copy'
				? await priceRelease({ subscription: sub, config: drips.get(pos.agent_id) || null, plannedSol: decision.order_sol, tierCache })
				: null;
			const capacitySkip = release?.capacitySkip || null;
			const status = decision.action === 'copy' && !capacitySkip ? 'pending' : 'skipped';
			const planned = status === 'pending' ? release.plannedSol : null;
			const skipReason = capacitySkip ? capacitySkip.reason : (status === 'skipped' ? decision.reason : null);

			const [inserted] = await sql`
				insert into copy_executions (
					subscription_id, copier_user_id, leader_agent_id, leader_position_id, network,
					mint, symbol, name, direction, planned_sol, leader_entry_sol, status, skip_reason,
					safety, leader_buy_sig, visible_at, drip_tier, drip_delay_sec, notified_at,
					expires_at
				) values (
					${sub.id}, ${sub.copier_user_id}, ${pos.agent_id}, ${pos.id}, ${network},
					${pos.mint}, ${pos.symbol}, ${pos.name}, 'buy', ${planned}, ${entrySol}, ${status},
					${skipReason},
					${coin ? JSON.stringify(coin) : null}::jsonb, ${pos.buy_sig},
					${release?.visibleAt ?? null}, ${release?.tier ?? null}, ${release?.delaySec ?? null},
					${release && !release.notifyNow ? null : new Date()},
					${release?.expiresAt ?? new Date(Date.now() + 30 * 60 * 1000)}
				)
				on conflict (subscription_id, leader_position_id, direction) do nothing
				returning id
			`;
			if (inserted) {
				stats[status] = (stats[status] || 0) + 1;
				if (status === 'pending') {
					spent.set(sub.id, (spent.get(sub.id) || 0) + (planned || 0));
					open.set(sub.id, (open.get(sub.id) || 0) + 1);
					// Telegram notify copier of the new buy intent (best-effort, async).
					// A dripped seat stays quiet here — releaseDueDrips sends it when
					// the intent is actually revealed, so the alert cannot leak the
					// coin ahead of the copier's own release time.
					if (sub.telegram_chat_id && release?.notifyNow !== false) {
						const leader = await agentName(pos.agent_id);
						sendTg(sub.telegram_chat_id, buyIntentMessage({
							sym: pos.symbol, name: pos.name, plannedSol: planned,
							leaderName: leader, oracleScore: score,
							oracleTier: null, mint: pos.mint, network,
							traderUrl: `/trader/${pos.agent_id}`,
						}));
					}
				}
			}
		}
	}
}

async function fanoutSells(network, stats) {
	// Closes whose matching buy a copier actually acted on.
	const closes = await sql`
		select distinct p.id, p.agent_id, p.mint, p.symbol, p.name, p.sell_sig, p.closed_at
		from agent_sniper_positions p
		where p.network = ${network} and p.status = 'closed' and p.closed_at > now() - interval '8 minutes'
		  and exists (
		    select 1 from copy_executions e
		    where e.leader_position_id = p.id and e.direction = 'buy' and e.status = 'acted'
		  )
		order by p.closed_at desc
		limit 200
	`;
	if (!closes.length) return;

	// Acted buys for every close in this batch, fetched once and grouped by the
	// leader position they mirror — replaces a per-close query.
	const closeIds = [...new Set(closes.map((p) => p.id))];
	const buyRows = await sql`
		select e.leader_position_id, e.subscription_id, e.copier_user_id, s.copy_sells, s.status as sub_status
		from copy_executions e
		join copy_subscriptions s on s.id = e.subscription_id
		where e.leader_position_id = any(${closeIds}) and e.direction = 'buy' and e.status = 'acted'
	`;
	const buysByPosition = new Map();
	for (const b of buyRows) {
		if (!buysByPosition.has(b.leader_position_id)) buysByPosition.set(b.leader_position_id, []);
		buysByPosition.get(b.leader_position_id).push(b);
	}

	for (const pos of closes) {
		const buys = buysByPosition.get(pos.id) || [];
		for (const b of buys) {
			// Exit signals deliberately survive a pause. A subscription paused by the
			// drawdown breaker has its BUYS frozen, but the copier is already in the
			// position this close exits — withholding the sell intent would strand
			// them in the exact leader the breaker just fired on. Only a stopped
			// subscription (the copier's own hard exit) stops mirroring exits.
			if (!b.copy_sells || b.sub_status === 'stopped') continue;
			const [inserted] = await sql`
				insert into copy_executions (
					subscription_id, copier_user_id, leader_agent_id, leader_position_id, network,
					mint, symbol, name, direction, planned_sol, status, leader_buy_sig
				) values (
					${b.subscription_id}, ${b.copier_user_id}, ${pos.agent_id}, ${pos.id}, ${network},
					${pos.mint}, ${pos.symbol}, ${pos.name}, 'sell', 0, 'pending', ${pos.sell_sig}
				)
				on conflict (subscription_id, leader_position_id, direction) do nothing
				returning id
			`;
			if (inserted) stats.sell_pending = (stats.sell_pending || 0) + 1;
		}
	}
}

// ── Oracle conviction fanout ───────────────────────────────────────────────────
// Mirrors live oracle buy actions to copy subscribers, using the same sizing
// and safety logic as the sniper fanout. Only `mode = 'live'` actions fan out.

async function fanoutOracleBuys(network, stats) {
	// Only live fills from the last 8 minutes that have at least one active
	// copy subscriber following the acting agent.
	const actions = await sql`
		select a.id, a.agent_id, a.mint, a.symbol, a.conviction, a.tier, a.size_sol, a.acted_at
		from oracle_watch_actions a
		where a.network = ${network}
		  and a.mode = 'live'
		  and a.status = 'filled'
		  and a.acted_at > now() - interval '8 minutes'
		  and exists (
		    select 1 from copy_subscriptions s
		    where s.leader_agent_id = a.agent_id and s.network = ${network} and s.status = 'active'
		  )
		order by a.acted_at desc
		limit 200
	`;
	if (!actions.length) return;

	// Per-subscription day-spend + open-intent counts, batched once.
	const spendRows = await sql`
		select subscription_id, coalesce(sum(planned_sol), 0) as spent
		from copy_executions
		where direction = 'buy' and status in ('pending', 'acted') and created_at::date = current_date
		group by subscription_id
	`;
	const openRows = await sql`
		select subscription_id, count(*) as open
		from copy_executions
		where direction = 'buy' and status = 'pending'
		group by subscription_id
	`;
	const spent = new Map(spendRows.map((r) => [r.subscription_id, Number(r.spent) || 0]));
	const open = new Map(openRows.map((r) => [r.subscription_id, Number(r.open) || 0]));

	// Active subscriptions for every acting agent in this batch, fetched once and
	// grouped by leader_agent_id — replaces a per-action query. Same two guards as
	// the sniper path: self-copy dropped, drawdown-breached auto-paused.
	const leaderIds = [...new Set(actions.map((a) => a.agent_id))];
	const subsByLeader = await activeSubscriptionsByLeader(leaderIds, network, stats);
	// Alpha-drip ladders for this batch. Leaders without one cost nothing below.
	const drips = await loadDripConfigs(leaderIds);
	const tierCache = newTierCache();

	for (const action of actions) {
		const subs = subsByLeader.get(action.agent_id) || [];
		if (!subs.length) continue;
		// Oracle action has conviction inline — no DB lookup needed.
		const coin = await coinContext(action.mint, action.conviction != null ? Number(action.conviction) : null);
		const entrySol = Number(action.size_sol) || 0;

		for (const sub of subs) {
			const decision = planCopyOrder({
				subscription: sub,
				position: { direction: 'buy', entry_sol: entrySol, mint: action.mint },
				coin,
				spentTodaySol: spent.get(sub.id) || 0,
				openCopies: open.get(sub.id) || 0,
			});
			// Alpha-drip: same seat pricing and capacity cap as the sniper path.
			const release = decision.action === 'copy'
				? await priceRelease({ subscription: sub, config: drips.get(action.agent_id) || null, plannedSol: decision.order_sol, tierCache })
				: null;
			const capacitySkip = release?.capacitySkip || null;
			const status = decision.action === 'copy' && !capacitySkip ? 'pending' : 'skipped';
			const planned = status === 'pending' ? release.plannedSol : null;
			const skipReason = capacitySkip ? capacitySkip.reason : (status === 'skipped' ? decision.reason : null);

			// Note: leader_position_id is null for oracle-sourced intents.
			// Idempotency is guaranteed by the copy_executions_oracle_idem partial unique index.
			const [inserted] = await sql`
				insert into copy_executions (
					subscription_id, copier_user_id, leader_agent_id, leader_position_id, leader_oracle_action_id,
					network, mint, symbol, direction, planned_sol, leader_entry_sol, status, skip_reason,
					safety, visible_at, drip_tier, drip_delay_sec, notified_at, expires_at
				) values (
					${sub.id}, ${sub.copier_user_id}, ${action.agent_id}, null, ${action.id},
					${network}, ${action.mint}, ${action.symbol || null}, 'buy', ${planned}, ${entrySol},
					${status}, ${skipReason},
					${coin ? JSON.stringify(coin) : null}::jsonb,
					${release?.visibleAt ?? null}, ${release?.tier ?? null}, ${release?.delaySec ?? null},
					${release && !release.notifyNow ? null : new Date()},
					${release?.expiresAt ?? new Date(Date.now() + 30 * 60 * 1000)}
				)
				on conflict (subscription_id, leader_oracle_action_id, direction)
				where leader_oracle_action_id is not null
				do nothing
				returning id
			`;
			if (inserted) {
				const key = `oracle_${status}`;
				stats[key] = (stats[key] || 0) + 1;
				if (status === 'pending') {
					spent.set(sub.id, (spent.get(sub.id) || 0) + (planned || 0));
					open.set(sub.id, (open.get(sub.id) || 0) + 1);
					// Telegram notify copier of the new oracle-sourced buy intent (best-effort).
					// Held back for a dripped seat — releaseDueDrips sends it on reveal.
					if (sub.telegram_chat_id && release?.notifyNow !== false) {
						const leader = await agentName(action.agent_id);
						sendTg(sub.telegram_chat_id, buyIntentMessage({
							sym: action.symbol, name: null, plannedSol: planned,
							leaderName: leader,
							oracleScore: action.conviction != null ? Number(action.conviction) : null,
							oracleTier: action.tier || null,
							mint: action.mint, network,
							traderUrl: `/trader/${action.agent_id}`,
						}));
					}
				}
			}
		}
	}
}

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET', 'POST'])) return;
	if (!requireCron(req, res)) return;

	const stats = {};
	// Every per-run memo is dropped at the top of a tick. Cloud Run keeps a
	// container warm across ticks, so a Map that is only ever written grows
	// without bound and, worse, pins a stale answer: an unscored mint cached as
	// null would keep failing a subscription's min_oracle_score filter long after
	// the Oracle scored it.
	_coinCache.clear();
	_oracleScoreCache.clear();
	_agentNameCache.clear();

	// Alerts held back by an alpha-drip go out the moment their reveal passes.
	// Running it at the top of the tick means the release cadence is the fanout
	// cadence, with no second cron to keep in sync.
	try {
		await releaseDueDrips({ sendTg, stats });
	} catch (err) {
		stats.error_drip_release = err.message;
	}

	for (const network of NETWORKS) {
		try {
			await fanoutBuys(network, stats);
			await fanoutSells(network, stats);
			await fanoutOracleBuys(network, stats);
		} catch (err) {
			stats[`error_${network}`] = err.message;
		}
	}
	return json(res, 200, { ok: true, ...stats });
});
