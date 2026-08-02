// GET /api/cron/oracle-digest — daily Oracle conviction digest via Telegram.
//
// Runs once daily (08:00 UTC). Three lanes:
//
//   1. Channel digest: a platform-wide summary posted to the public signals
//      channel (TELEGRAM_ORACLE_CHAT_ID): coins scored, top conviction of the
//      day, agent action stats. Fires whenever the channel is configured,
//      even with zero personal subscribers, so the feed always has a daily
//      anchor post.
//   2. Owner digests: each armed Oracle subscriber (telegram_chat_id on
//      their watch) gets their agent's armed status, action count, W/L,
//      realized PnL, and top coins above their threshold.
//   3. Follower digests: users following agents they don't own.
//
// Fire-and-forget per recipient: one failure never blocks others. Respects
// CRON_SECRET auth.

import { error, json, method, wrapCron } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { constantTimeEquals } from '../_lib/crypto.js';
import { sql } from '../_lib/db.js';
import { gmgnTokenUrl, referralUrl, TERMINAL_LABELS } from '../../src/shared/trading-terminals.js';

const TIER_EMOJI = { prime: '🟣', strong: '🔵', lean: '🟡', watch: '⚪', avoid: '🔴' };
const ALERT_TIMEOUT_MS = 5000;

function requireCron(req, res) {
	const secret = process.env.CRON_SECRET || env.CRON_SECRET;
	if (!secret) { error(res, 503, 'not_configured', 'CRON_SECRET unset'); return false; }
	const auth = req.headers['authorization'] || '';
	const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
	if (!constantTimeEquals(presented, secret)) {
		error(res, 401, 'unauthorized', 'invalid cron secret');
		return false;
	}
	return true;
}

function esc(s) {
	return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function subscribedWatches(network) {
	return sql`
		select w.agent_id, w.armed, w.mode, w.min_score, w.telegram_chat_id,
		       a.name as agent_name
		from oracle_agent_watch w
		join agent_identities a on a.id = w.agent_id and a.deleted_at is null
		where w.telegram_chat_id is not null and w.network = ${network}
	`.catch(() => []);
}

/** All follower subscriptions grouped by chat_id. */
async function followerSubscriptions(network) {
	const rows = await sql`
		select f.chat_id, f.min_score, f.agent_id, a.name as agent_name
		from oracle_followers f
		join agent_identities a on a.id = f.agent_id and a.deleted_at is null
		where f.network = ${network}
		order by f.chat_id, f.agent_id
	`.catch(() => []);

	// Group by chat_id
	const map = new Map();
	for (const r of rows) {
		if (!map.has(r.chat_id)) map.set(r.chat_id, { chat_id: r.chat_id, min_score: r.min_score, agents: [] });
		map.get(r.chat_id).agents.push({ agent_id: r.agent_id, agent_name: r.agent_name });
	}
	return [...map.values()];
}

async function followedAgentStats(agentIds, network) {
	if (!agentIds.length) return [];
	const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
	return sql`
		select a.agent_id, ai.name as agent_name,
		       count(a.id) as total,
		       count(a.id) filter (where a.outcome = 'win')  as wins,
		       count(a.id) filter (where a.outcome = 'loss') as losses,
		       sum(a.realized_pnl_sol)                       as pnl
		from oracle_watch_actions a
		join agent_identities ai on ai.id = a.agent_id
		where a.agent_id = any(${agentIds}::uuid[])
		  and a.network = ${network}
		  and a.acted_at > ${since}::timestamptz
		group by a.agent_id, ai.name
	`.catch(() => []);
}

function buildFollowerMessage(follower, agentStats, coins) {
	const agentList = follower.agents.map((a) => esc(a.agent_name || 'Agent')).join(', ');
	const lines = [
		`🔮 <b>Oracle daily digest — agents you follow</b>`,
		`Following: ${esc(agentList)}`,
		``,
	];

	if (agentStats.length) {
		lines.push(`<b>Last 24h activity</b>`);
		for (const s of agentStats) {
			const pnlStr = s.pnl != null && Number(s.pnl) !== 0
				? `  ·  PnL <b>${Number(s.pnl) >= 0 ? '+' : ''}${Number(s.pnl).toFixed(4)} SOL</b>`
				: '';
			lines.push(`• <b>${esc(s.agent_name || 'Agent')}</b>: ${s.total} action${s.total !== 1 ? 's' : ''}, ${s.wins}W / ${s.losses}L${pnlStr}`);
		}
		lines.push(``);
	} else {
		lines.push(`<i>No actions in the last 24h from your followed agents.</i>`, ``);
	}

	if (coins.length) {
		lines.push(`<b>Top conviction above your threshold (${follower.min_score})</b>`);
		for (const c of coins) {
			const e = TIER_EMOJI[c.tier] || '⚪';
			lines.push(`${e} <b>$${esc(c.symbol || c.mint.slice(0, 6))}</b> · <code>${c.score}</code> · <a href="https://three.ws/oracle/coin/${encodeURIComponent(c.mint)}">view</a>`);
		}
		lines.push(``);
	} else {
		lines.push(`<i>No coins above your threshold (${follower.min_score}) right now.</i>`, ``);
	}

	lines.push(`<a href="https://three.ws/oracle">Open Oracle →</a>`);
	return lines.join('\n');
}

async function todayStats(agentId, network) {
	const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
	const rows = await sql`
		select outcome, realized_pnl_sol, size_sol
		from oracle_watch_actions
		where agent_id = ${agentId} and network = ${network}
		  and acted_at > ${since}::timestamptz
	`.catch(() => []);
	let wins = 0, losses = 0, open = 0, pnl = 0;
	for (const r of rows) {
		if (r.outcome === 'win') wins++;
		else if (r.outcome === 'loss') losses++;
		else open++;
		if (r.realized_pnl_sol != null) pnl += Number(r.realized_pnl_sol);
	}
	return { total: rows.length, wins, losses, open, pnl: +pnl.toFixed(4) };
}

async function topCoins(minScore, network, limit = 3) {
	return sql`
		select mint, symbol, score, tier
		from oracle_conviction
		where network = ${network} and score >= ${minScore}
		order by score desc
		limit ${limit}
	`.catch(() => []);
}

async function sendDigest(chatId, text) {
	const token = process.env.TELEGRAM_BOT_TOKEN;
	if (!token) return false;
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), ALERT_TIMEOUT_MS);
	try {
		const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				chat_id: chatId,
				text: text.slice(0, 4000),
				parse_mode: 'HTML',
				disable_web_page_preview: true,
			}),
			signal: ctrl.signal,
		});
		const result = await r.json().catch(() => null);
		return result?.ok === true;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

/** Platform-wide 24h stats for the channel digest. Exported for tests. */
export async function platformDayStats(network) {
	const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
	const [scored] = await sql`
		select count(*)::int as n
		from oracle_conviction
		where network = ${network} and scored_at > ${since}::timestamptz
	`.catch(() => [{ n: 0 }]);
	const [actions] = await sql`
		select count(*)::int as total,
		       count(*) filter (where outcome = 'win')::int  as wins,
		       count(*) filter (where outcome = 'loss')::int as losses,
		       coalesce(sum(realized_pnl_sol), 0)            as pnl
		from oracle_watch_actions
		where network = ${network} and acted_at > ${since}::timestamptz
	`.catch(() => [{ total: 0, wins: 0, losses: 0, pnl: 0 }]);
	const top = await sql`
		select mint, symbol, score, tier, category
		from oracle_conviction
		where network = ${network} and scored_at > ${since}::timestamptz
		order by score desc
		limit 5
	`.catch(() => []);
	return { scored: scored?.n ?? 0, actions: actions ?? { total: 0, wins: 0, losses: 0, pnl: 0 }, top };
}

/** Render the channel digest message. Exported for tests. */
export function buildChannelDigest({ scored, actions, top }) {
	const lines = [
		`🔮 <b>Oracle daily digest</b>`,
		`Scored <b>${scored.toLocaleString('en-US')}</b> pump.fun launches in the last 24h.`,
		``,
	];

	if (top.length) {
		lines.push(`<b>Top conviction today</b>`);
		for (const c of top) {
			const e = TIER_EMOJI[c.tier] || '⚪';
			const cat = c.category && c.category !== 'unknown' ? ` · ${esc(c.category)}` : '';
			lines.push(`${e} <b>$${esc(c.symbol || c.mint.slice(0, 6))}</b> · <code>${c.score}</code>${cat} · <a href="https://three.ws/oracle/coin/${encodeURIComponent(c.mint)}">view</a> · <a href="${gmgnTokenUrl(c.mint)}">GMGN</a>`);
		}
		lines.push(``);
	} else {
		lines.push(`<i>No launches cleared the scoring floor today.</i>`, ``);
	}

	if (actions.total > 0) {
		const pnl = Number(actions.pnl) || 0;
		const pnlStr = pnl !== 0 ? `  ·  PnL <b>${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL</b>` : '';
		lines.push(`<b>Agents</b>  ${actions.total} action${actions.total !== 1 ? 's' : ''}  ·  ${actions.wins}W / ${actions.losses}L${pnlStr}`, ``);
	}

	const offers = ['gmgn', 'axiom', 'padre', 'fomo']
		.map((k) => `<a href="${referralUrl(k)}">${TERMINAL_LABELS[k]}</a>`)
		.join(' · ');
	lines.push(`Trade with a fee discount: ${offers}`);
	lines.push(`<a href="https://three.ws/oracle">Open the live feed →</a>`);
	return lines.join('\n');
}

function buildMessage(watch, stats, coins) {
	const armedLabel = watch.armed
		? (watch.mode === 'live' ? '🟢 Armed · live' : '🟡 Armed · simulate')
		: '⚪ Disarmed';
	const agentName = esc(watch.agent_name || 'Your agent');

	const lines = [
		`🔮 <b>Oracle daily digest — ${agentName}</b>`,
		armedLabel,
		``,
	];

	if (stats.total > 0) {
		const pnlSign = stats.pnl >= 0 ? '+' : '';
		lines.push(
			`<b>Last 24h</b>  ${stats.total} action${stats.total !== 1 ? 's' : ''}`,
			`Wins <b>${stats.wins}</b>  ·  Losses <b>${stats.losses}</b>  ·  Open <b>${stats.open}</b>`,
		);
		if (stats.pnl !== 0) lines.push(`PnL  <b>${pnlSign}${stats.pnl} SOL</b>`);
		lines.push(``);
	} else {
		lines.push(`<i>No actions in the last 24h.</i>`, ``);
	}

	if (coins.length) {
		lines.push(`<b>Top signals above threshold (${watch.min_score})</b>`);
		for (const c of coins) {
			const e = TIER_EMOJI[c.tier] || '⚪';
			lines.push(`${e} <b>$${esc(c.symbol || c.mint.slice(0, 6))}</b> · <code>${c.score}</code> · <a href="https://three.ws/oracle/coin/${encodeURIComponent(c.mint)}">view</a>`);
		}
		lines.push(``);
	} else {
		lines.push(`<i>No coins above threshold (${watch.min_score}) right now.</i>`, ``);
	}

	lines.push(`<a href="https://three.ws/oracle">Open Oracle →</a>`);
	return lines.join('\n');
}

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET', 'POST'])) return;
	if (!requireCron(req, res)) return;

	const network = process.env.ORACLE_NETWORK || 'mainnet';
	const token = process.env.TELEGRAM_BOT_TOKEN;
	if (!token) return json(res, 200, { ok: true, sent: 0, reason: 'TELEGRAM_BOT_TOKEN not set' });

	let sent = 0;
	let failed = 0;

	// Channel digest: the public signals channel gets a platform-wide daily
	// anchor post whenever it is configured, independent of personal subscribers.
	let channelSent = false;
	const channelChatId = process.env.TELEGRAM_ORACLE_CHAT_ID;
	if (channelChatId) {
		const day = await platformDayStats(network);
		channelSent = await sendDigest(channelChatId, buildChannelDigest(day));
		if (channelSent) sent++; else failed++;
	}

	const watches = await subscribedWatches(network);

	// Digest for armed agent owners
	for (const watch of watches) {
		const [stats, coins] = await Promise.all([
			todayStats(watch.agent_id, network),
			topCoins(Number(watch.min_score) || 54, network),
		]);
		const text = buildMessage(watch, stats, coins);
		const ok = await sendDigest(watch.telegram_chat_id, text);
		if (ok) sent++; else failed++;
	}

	// Digest for followers (users who followed agents but don't own one)
	// Skip chat_ids already receiving the owner digest above to avoid duplicate messages.
	const ownerChats = new Set(watches.map((w) => w.telegram_chat_id));
	const followers = (await followerSubscriptions(network)).filter((f) => !ownerChats.has(f.chat_id));

	for (const follower of followers) {
		const agentIds = follower.agents.map((a) => a.agent_id);
		const [agentStats, coins] = await Promise.all([
			followedAgentStats(agentIds, network),
			topCoins(Number(follower.min_score) || 54, network),
		]);
		const text = buildFollowerMessage(follower, agentStats, coins);
		const ok = await sendDigest(follower.chat_id, text);
		if (ok) sent++; else failed++;
	}

	return json(res, 200, { ok: true, network, channel: channelChatId ? channelSent : null, subscribers: watches.length + followers.length, sent, failed });
});
