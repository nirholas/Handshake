// Clip Director API, turn a real closed trade into shareable artifacts.
// ---------------------------------------------------------------------------
//   GET  /api/clip-director?agent_id=<uuid>[&surface=x|telegram|feed|all]
//                          [&position_id=<uuid>][&network=mainnet]
//        The agent's most notable recent closed round-trip (or a specific
//        position) rendered as a shareable artifact per surface. Public, cached.
//
//   POST /api/clip-director   { agent_name, avatar_style?, trade, surface?,
//                               copied_by_count? }
//        Direct a clip from an already-shaped trade object (for the copy-engine
//        fan-out / arena feed to call on every notable close). Public.
//
// Every number traces to a real closed trade; losses get an honest card too.
// $THREE is the only coin promoted; the traded coin is user runtime data.

import { cors, json, error, method, wrap, readJson, rateLimited } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { getSessionUser } from './_lib/auth.js';
import { sql } from './_lib/db.js';
import { isUuid } from './_lib/validate.js';
import { directClip, tradeFromPosition, SURFACES } from './_lib/clip-director.js';

const NETWORKS = new Set(['mainnet', 'devnet']);

export const maxDuration = 30;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', origins: '*', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	let userId = null;
	try { userId = (await getSessionUser(req))?.id ?? null; } catch { userId = null; }

	if (req.method === 'POST') return handlePost(req, res, userId);
	return handleGet(req, res, userId);
});

async function handleGet(req, res, userId) {
	const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
	const agentId = (url.searchParams.get('agent_id') || '').trim();
	const positionId = (url.searchParams.get('position_id') || '').trim();
	const network = NETWORKS.has(url.searchParams.get('network')) ? url.searchParams.get('network') : 'mainnet';
	const surfaceParam = (url.searchParams.get('surface') || 'all').trim();

	if (!isUuid(agentId)) return error(res, 400, 'invalid_agent', 'agent_id must be an agent UUID.');
	if (positionId && !isUuid(positionId)) return error(res, 400, 'invalid_position', 'position_id must be a UUID.');

	const [agent] = await sql`
		select id, name, avatar_url, profile_image_url
		from agent_identities
		where id = ${agentId} and deleted_at is null
		limit 1
	`.catch(() => []);
	if (!agent) return error(res, 404, 'agent_not_found', 'No such agent.');

	// The notable close: a specific position if asked, else the most compelling
	// recent one, biggest absolute realized move first, so the card headlines a
	// real story (a big win OR a big honest loss), never a dust trade.
	const [pos] = positionId
		? await sql`
			select * from agent_sniper_positions
			where id = ${positionId} and agent_id = ${agentId} and network = ${network} and status = 'closed'
			limit 1
		`.catch(() => [])
		: await sql`
			select * from agent_sniper_positions
			where agent_id = ${agentId} and network = ${network} and status = 'closed'
			  and closed_at is not null
			order by abs(coalesce(realized_pnl_pct, 0)) desc, closed_at desc
			limit 1
		`.catch(() => []);

	if (!pos) {
		return json(res, 200, {
			agent: { id: agent.id, name: agent.name, avatar: agent.avatar_url || agent.profile_image_url || null },
			trade: null,
			clips: [],
			empty: 'This agent has no closed trades yet. Clips are minted from real closed round-trips.',
		});
	}

	const copiedByCount = await followerCount(agentId, network);
	const trade = tradeFromPosition(pos);
	const surfaces = surfaceParam === 'all' ? ['x', 'telegram', 'feed'] : (SURFACES.has(surfaceParam) ? [surfaceParam] : ['feed']);

	const clips = await Promise.all(surfaces.map((surface) =>
		directClip({
			agentName: agent.name, avatarStyle: null, trade, copiedByCount, surface, userId,
		})));

	res.setHeader?.('cache-control', 'public, max-age=60, s-maxage=120');
	return json(res, 200, {
		agent: { id: agent.id, name: agent.name, avatar: agent.avatar_url || agent.profile_image_url || null },
		position_id: pos.id,
		trade,
		proof: pos.sell_sig ? `https://solscan.io/tx/${pos.sell_sig}` : null,
		copied_by_count: copiedByCount,
		clips,
	});
}

// Every string on this path is caller-supplied and ends up inside an LLM prompt
// (directClip drives llmComplete), so each one is length-clamped at the
// boundary. Unclamped, a single anonymous POST could push a megabyte of text
// through the whole provider chain. The GET path needs none of this: its agent
// name and trade both come from our own tables.
const BODY_MAX_BYTES = 8_000;

function clampText(v, max) {
	if (typeof v !== 'string') return null;
	const s = v.trim();
	return s ? s.slice(0, max) : null;
}

async function handlePost(req, res, userId) {
	let body;
	try {
		body = await readJson(req, BODY_MAX_BYTES);
	} catch (err) {
		if (err?.status === 413) {
			return error(res, 413, 'body_too_large', `Body must be under ${BODY_MAX_BYTES} bytes.`);
		}
		return error(res, 400, 'invalid_json', 'Body must be JSON.');
	}

	const trade = body?.trade;
	if (!trade || typeof trade !== 'object' || Array.isArray(trade)) {
		return error(res, 400, 'invalid_trade', 'trade object is required (symbol, multiple or realized_pnl_sol, etc.).');
	}
	// Accept a raw position row too, normalize either shape.
	const shaped = trade.entry_quote_lamports != null || trade.realized_pnl_lamports != null
		? tradeFromPosition(trade)
		: normalizeTrade(trade);

	const surface = SURFACES.has(body?.surface) ? body.surface : 'feed';
	const copiedByCount = Math.max(0, Math.min(1e9, Math.trunc(Number(body?.copied_by_count)) || 0));
	const clip = await directClip({
		agentName: clampText(body?.agent_name, 80) || 'the agent',
		avatarStyle: clampText(body?.avatar_style, 40),
		trade: shaped,
		copiedByCount,
		surface,
		userId,
	});
	res.setHeader?.('cache-control', 'no-store');
	return json(res, 200, { clip });
}

function normalizeTrade(t) {
	const num = (v) => {
		if (v == null || v === '') return null;
		const n = Number(v);
		return Number.isFinite(n) ? n : null;
	};
	const pnl = num(t.realized_pnl_sol ?? t.realized_pnl_quote);
	const pct = num(t.pnl_pct);
	return {
		mint: clampText(t.mint, 64),
		symbol: clampText(t.symbol, 32),
		name: clampText(t.name, 80),
		multiple: num(t.multiple),
		pnl_pct: pct,
		entry_sol: num(t.entry_sol),
		exit_sol: num(t.exit_sol),
		realized_pnl_sol: pnl,
		hold_min: num(t.hold_min),
		exit_reason: clampText(t.exit_reason, 40),
		quote_symbol: 'SOL',
		is_win: pnl != null ? pnl >= 0 : (pct != null ? pct >= 0 : null),
		sell_sig: clampText(t.sell_sig, 100),
	};
}

async function followerCount(agentId, network) {
	const [row] = await sql`
		select count(*)::int as n from agent_mirror_follows
		where leader_agent_id = ${agentId} and network = ${network} and enabled = true
	`.catch(() => [{ n: 0 }]);
	return Number(row?.n || 0);
}
