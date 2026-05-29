/**
 * GET /api/agents/pumpfun
 * -----------------------
 * Read-only proxy to the upstream pumpfun-claims-bot MCP server. Backs the
 * `pumpfun-recent-claims` and `pumpfun-token-intel` skills, plus any external
 * MCP client that wants enriched pump.fun intel without standing up its own
 * indexer.
 *
 * Query:
 *   ?op=claims        &limit=10
 *   ?op=graduations   &limit=10
 *   ?op=token         &mint=<base58>
 *   ?op=creator       &wallet=<base58>
 *
 * Auth: session OR bearer (scope `mcp` or `profile`).
 * Cache: per-op, short TTL handled in api/_lib/pumpfun-mcp.js.
 */

import { getSessionUser, authenticateBearer, extractBearer, hasScope } from '../_lib/auth.js';
import { cors, json, method, error, wrap } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { pumpfunMcp, pumpfunBotEnabled } from '../_lib/pumpfun-mcp.js';

export default wrap(async (req, res) => {
	// Dispatch pumpfun-feed and pumpfun-metadata via _handler param (set by vercel.json rewrite)
	const _handler = req.query?._handler;
	if (_handler === 'feed') return handleFeed(req, res);
	if (_handler === 'metadata') return handleMetadata(req, res);

	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	if (!session && !bearer) return error(res, 401, 'unauthorized', 'sign in required');
	if (bearer && !hasScope(bearer.scope, 'mcp') && !hasScope(bearer.scope, 'profile')) {
		return error(res, 403, 'insufficient_scope', 'requires mcp or profile scope');
	}

	const userId = session?.id ?? bearer.userId;
	const rl = await limits.mcpUser(String(userId));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const url = new URL(req.url, 'http://x');
	const op = url.searchParams.get('op') || 'claims';
	const limit = clamp(Number(url.searchParams.get('limit')) || 10, 1, 50);

	// Soft-degrade to empty data when the upstream feed isn't configured —
	// callers get a usable 200 rather than a noisy 503 on every poll.
	if (!pumpfunBotEnabled()) {
		const empty = op === 'token' || op === 'creator' ? {} : { items: [] };
		return json(res, 200, empty);
	}

	let result;
	switch (op) {
		case 'claims':
			result = await pumpfunMcp.recentClaims({ limit });
			break;
		case 'graduations':
			result = await pumpfunMcp.graduations({ limit });
			break;
		case 'token': {
			const mint = url.searchParams.get('mint');
			if (!mint) return error(res, 400, 'validation_error', 'mint required');
			result = await pumpfunMcp.tokenIntel({ mint });
			break;
		}
		case 'creator': {
			const wallet = url.searchParams.get('wallet');
			if (!wallet) return error(res, 400, 'validation_error', 'wallet required');
			result = await pumpfunMcp.creatorIntel({ wallet });
			break;
		}
		default:
			return error(res, 400, 'validation_error', 'unknown op');
	}

	if (!result.ok) {
		return error(res, 502, 'upstream_error', result.error || 'pumpfun bot unavailable');
	}

	const payload = Array.isArray(result.data) ? { items: result.data } : result.data;
	return json(res, 200, payload);
});

function clamp(n, lo, hi) {
	return Math.max(lo, Math.min(hi, n));
}

// ── pumpfun-feed (SSE) ────────────────────────────────────────────────────────

import { connectPumpFunFeed, recentBuffered } from '../_lib/pumpfun-ws-feed.js';
const TIER_RANK = { notable: 1, influencer: 2, mega: 3 };

async function handleFeed(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;
	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many feed connections');
	const url = new URL(req.url, 'http://x');
	const kind = url.searchParams.get('kind') || 'all';
	const mintParam = url.searchParams.get('mint');
	const minTierParam = url.searchParams.get('minTier');
	const minTier = TIER_RANK[minTierParam] || 0;
	const mcMin = Number(url.searchParams.get('mcMin')) || 0;
	const mcMax = Number(url.searchParams.get('mcMax')) || 0;
	const minBuy = Number(url.searchParams.get('minBuy')) || 0;
	const whale = Number(url.searchParams.get('whale')) || 0;
	function passesFilters(ev) {
		if (minTier && TIER_RANK[(ev?.tier || '').toLowerCase()] < minTier) return false;
		const mc = ev?.usd_market_cap ?? ev?.market_cap_usd ?? ev?.market_cap ?? null;
		if (mcMin && mc != null && mc < mcMin) return false;
		if (mcMax && mc != null && mc > mcMax) return false;
		const initBuy = ev?.initial_buy_sol ?? null;
		if (minBuy && initBuy != null && initBuy < minBuy) return false;
		const tradeSol = ev?.initial_buy_sol ?? ev?.amount_sol ?? ev?.sol_amount ?? null;
		if (whale && tradeSol != null && tradeSol < whale) return false;
		return true;
	}
	res.statusCode = 200;
	res.setHeader('content-type', 'text/event-stream; charset=utf-8');
	res.setHeader('cache-control', 'no-store');
	res.setHeader('connection', 'keep-alive');
	res.setHeader('x-accel-buffering', 'no');
	res.flushHeaders?.();
	const started = Date.now();
	let active = true;
	req.on('close', () => { active = false; });
	const wsAbort = new AbortController();
	req.on('close', () => wsAbort.abort());
	const queue = [];
	const wsKind = kind === 'claims' ? 'graduation' : kind;
	// `trades` is per-mint on PumpPortal — require a mint and stream that token's
	// buy/sell flow. Other kinds (mint/graduation/all) ignore the mint param.
	const tradeMints = wsKind === 'trades' && mintParam ? [mintParam] : [];
	const stopWs = connectPumpFunFeed({ kind: wsKind, mints: tradeMints, signal: wsAbort.signal, onEvent: ({ kind: evKind, data }) => { if (active) queue.push({ evKind, data }); } });
	_writeSse(res, 'open', { kind, minTier: minTierParam || null, source: 'websocket' });
	// Replay the most recent buffered events so a freshly-opened feed is never
	// blank. Newest first so the UI's `prepend` results in chronological order.
	try {
		const replay = recentBuffered({ kind: wsKind, limit: 10 });
		// Emit oldest-first so each `prepend` puts the newest at the top.
		for (const ev of replay.slice().reverse()) {
			if (!passesFilters(ev.data)) continue;
			_writeSse(res, ev.kind, { ...ev.data, replay: true });
		}
	} catch (err) {
		console.warn('[pumpfun-feed] replay failed:', err?.message);
	}
	const seen = new Set();
	let lastSig = null;
	const tickClaims = pumpfunBotEnabled() ? async () => {
		if (kind !== 'claims' && kind !== 'all') return;
		const r = await pumpfunMcp.claimsSince({ sinceSig: lastSig, limit: 25 });
		if (!r.ok) return;
		const items = Array.isArray(r.data) ? r.data : r.data?.items || [];
		for (const ev of items) {
			const id = ev.tx_signature || ev.signature || ev.id;
			if (!id || seen.has(id)) continue;
			seen.add(id);
			if (!passesFilters(ev)) continue;
			lastSig = id;
			_writeSse(res, 'claim', ev);
		}
	} : null;
	while (active && Date.now() - started < 90_000) {
		while (queue.length > 0 && active) { const { evKind, data } = queue.shift(); if (passesFilters(data)) _writeSse(res, evKind, data); }
		if (tickClaims) { try { await tickClaims(); } catch {} }
		_writeSse(res, 'ping', { t: Date.now() });
		await new Promise((r) => setTimeout(r, 4000));
	}
	stopWs();
	_writeSse(res, 'close', { reason: 'duration_limit' });
	res.end();
}
function _writeSse(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }

// ── pumpfun-metadata ──────────────────────────────────────────────────────────

import { sql as _sql } from '../_lib/db.js';
import { env as _env } from '../_lib/env.js';

async function handleMetadata(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;
	const url = new URL(req.url, `http://${req.headers.host}`);
	const id = url.searchParams.get('id');
	if (!id) return error(res, 400, 'validation_error', 'id required');
	const [a] = await _sql`select id, name, description, avatar_id, meta, wallet_address from agent_identities where id = ${id} and deleted_at is null limit 1`;
	if (!a) return error(res, 404, 'not_found', 'agent not found');
	const origin = _env.APP_ORIGIN;
	const image = a.meta?.image_url || `${origin}/api/agents/${a.id}/og`;
	const animation = a.avatar_id ? `${origin}/api/avatars/${a.avatar_id}/glb` : null;
	const symbol = String(a.name || 'AGENT').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10) || 'AGENT';
	return json(res, 200, {
		name: a.name, symbol,
		description: a.description || `${a.name} is a 3D AI agent on three.ws with onchain identity and signed action history.`,
		image, animation_url: animation, external_url: `${origin}/agent/${a.id}`,
		attributes: [{ trait_type: 'platform', value: 'three.ws' }, { trait_type: 'agent_id', value: a.id }, ...(a.wallet_address ? [{ trait_type: 'owner', value: a.wallet_address }] : [])],
		properties: { category: 'video', files: [...(animation ? [{ uri: animation, type: 'model/gltf-binary' }] : []), { uri: image, type: 'image/png' }] },
	}, { 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' });
}
