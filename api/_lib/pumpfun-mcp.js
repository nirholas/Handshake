// Pumpfun MCP client — HTTP jsonrpc transport.
//
// Makes JSON-RPC calls to an optional upstream MCP bot (PUMPFUN_BOT_URL) for
// claims / token-intel / creator-intel enrichment. The bot is an OPTIONAL
// enrichment layer: when it is unset (the prod default) or unreachable,
// graduations are served from the live, WS-fed `pumpfun_graduations` Postgres
// table — the same source /api/pump/recent-graduations reads — so the
// graduations tool never silently degrades to empty. A legacy `pf:graduations`
// Redis list is kept only as a last-resort fallback.
//
// Env:
//   PUMPFUN_BOT_URL    HTTP endpoint for the upstream MCP bot (optional enrichment)
//   PUMPFUN_BOT_TOKEN  Optional Bearer token for MCP bot auth
//   DATABASE_URL       live graduation source (pumpfun_graduations, via ws-feed)
//   UPSTASH_REDIS_REST_URL    legacy Redis graduation feed fallback
//   UPSTASH_REDIS_REST_TOKEN  legacy Redis graduation feed fallback
//   GRADUATIONS_LIST_KEY      default: pf:graduations

import { env } from './env.js';
import { getRedis } from './redis.js';
import { fetchUpstream } from './upstream-fetch.js';

const LIST_KEY = process.env.GRADUATIONS_LIST_KEY || 'pf:graduations';

function redis() { return getRedis(); }

export function pumpfunBotEnabled() {
	return !!(process.env.PUMPFUN_BOT_URL);
}

// Live graduation source, newest-first. Reads the WS-fed `pumpfun_graduations`
// Postgres table (kept fresh by the live SSE feed + the pumpfun-graduations-sync
// cron). Falls back to the legacy `pf:graduations` Redis list only when the DB
// path yields nothing, so the graduations tool returns real data whether or not
// the optional upstream bot is configured.
async function liveGraduations(limit = 20) {
	try {
		const { recentGraduations } = await import('./pumpfun-ws-feed.js');
		const items = await recentGraduations({ limit });
		if (Array.isArray(items) && items.length) return items;
	} catch (err) {
		console.error('[pumpfun-mcp] live graduations read failed:', err?.message || err);
	}
	return readGraduations(limit);
}

async function readGraduations(limit = 20) {
	const r = redis();
	if (!r) return [];
	try {
		const items = await r.lrange(LIST_KEY, 0, Math.max(0, limit - 1));
		return items
			.map((x) => (typeof x === 'string' ? safeJson(x) : x))
			.filter(Boolean)
			.map(toFeedShape);
	} catch (err) {
		console.error('[pumpfun-mcp] redis read failed:', err?.message || err);
		return [];
	}
}

function toFeedShape(g) {
	return {
		tx_signature: g.signature,
		signature: g.signature,
		mint: g.mint,
		name: g.tokenName || null,
		symbol: g.tokenSymbol || null,
		pool_address: g.poolAddress || null,
		final_mcap: g.finalMcap ?? null,
		timestamp: g.timestamp,
	};
}

function safeJson(s) {
	try { return JSON.parse(s); } catch { return null; }
}

async function jsonrpc(toolName, args) {
	const url = process.env.PUMPFUN_BOT_URL;
	if (!url) return { ok: false, error: 'bot not configured' };
	const token = process.env.PUMPFUN_BOT_TOKEN;
	const headers = { 'content-type': 'application/json' };
	if (token) headers.authorization = `Bearer ${token}`;
	let res;
	try {
		res = await fetchUpstream(url, {
			method: 'POST',
			headers,
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: toolName, arguments: args } }),
		}, { name: 'pumpfun-bot', timeoutMs: 15_000, attempts: 1, okWhen: () => true });
	} catch (err) {
		return { ok: false, error: err?.message || 'bot unreachable' };
	}
	if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
	const j = await res.json();
	if (j.error) return { ok: false, error: j.error.message || JSON.stringify(j.error) };
	return { ok: true, data: j.result?.structuredContent ?? j.result?.content ?? [] };
}

export const pumpfunMcp = {
	enabled: pumpfunBotEnabled,
	async recentClaims({ limit = 20 } = {}) {
		return jsonrpc('getRecentClaims', { limit });
	},
	async tokenIntel({ mint } = {}) {
		if (!mint) return { ok: false, error: 'mint is required' };
		return jsonrpc('getTokenIntel', { mint });
	},
	async graduations({ limit = 20 } = {}) {
		if (pumpfunBotEnabled()) {
			const r = await jsonrpc('getGraduations', { limit });
			// Propagate explicit RPC application errors (e.g. auth / config problems).
			if (!r.ok && r.error && r.error !== 'bot not configured') return r;
			const arr = Array.isArray(r.data) ? r.data : r.data?.items;
			if (r.ok && Array.isArray(arr) && arr.length) return { ok: true, data: arr };
			// Bot unreachable or returned empty — fall through to the live
			// WS-fed table so the tool never surfaces a blank result.
		}
		const items = await liveGraduations(limit);
		return { ok: true, data: items };
	},
	async creatorIntel({ wallet } = {}) {
		if (!wallet) return { ok: false, error: 'wallet is required' };
		return jsonrpc('getCreatorIntel', { wallet });
	},
	async claimsSince({ since } = {}) {
		return jsonrpc('getClaimsSince', { since });
	},
};
