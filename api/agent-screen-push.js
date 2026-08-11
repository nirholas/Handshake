// POST /api/agent-screen-push — agent pushes a screen frame to the live feed.
//
// Agents (snipers, browser workers, autonomous scripts) POST here to publish
// what they're currently doing. Viewers subscribe via /api/agent-screen-stream.
//
// Body (JSON):
//   agentId   string   — UUID of the agent
//   frame     object   — { data?, activity, type }
//     data       string?  — base64 data URL (data:image/png;base64,…) or omit for text-only
//     activity   string   — plain-language description of what the agent is doing
//     type       string   — "screenshot" | "activity" | "trade" | "analysis"
//
// Auth: bearer JWT (same as other agent-authenticated endpoints). The agentId
// in the body must match the token's sub or an agent the user owns. Workers
// running as the agent itself use the agent's own JWT.
//
// Storage: Upstash Redis, key agent:screen:{agentId}:frame (TTL 90s — if the
// agent stops pushing, the stream goes dark automatically). A secondary list
// agent:screen:{agentId}:log holds the last 50 activity entries (no image data)
// for the activity log panel.

import { timingSafeEqual } from 'node:crypto';
import { cors, error, json, method, rateLimited, readJson } from './_lib/http.js';
import { getSessionUser, authenticateBearer, extractBearer } from './_lib/auth.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { getRedis } from './_lib/redis.js';
import { sql } from './_lib/db.js';
import { sanitizeFrameMeta } from '../src/shared/forge-frames.js';

// First-party on-demand caster pool (workers/agent-screen-pool) authenticates
// with a single shared secret and may push frames for ANY agent — it casts
// whichever agents viewers are currently watching, not agents it "owns". The
// secret is never optional-by-default: an unset/blank env disables the path.
const WORKER_SECRET = process.env.SCREEN_WORKER_SECRET || '';
function isPoolWorker(bearer) {
	if (!bearer || !WORKER_SECRET || WORKER_SECRET.length < 16) return false;
	const a = Buffer.from(bearer);
	const b = Buffer.from(WORKER_SECRET);
	return a.length === b.length && timingSafeEqual(a, b);
}

const FRAME_TTL = 90; // seconds — stream goes dark if agent stops pushing
const LOG_CAP = 50; // activity log entries kept per agent
const DATA_MAX = 800_000; // ~600 KB base64 PNG max (approx 450 KB PNG)
const ACTIVITY_MAX = 320; // chars

// Accept only raster image data URLs. SVG is rejected on purpose: it can carry
// active content (scripts, external fetches) that would execute the moment a
// viewer ever inline-rendered a frame instead of using <img src>. Anything that
// isn't a base64 raster image is dropped to text-only.
const RASTER_DATA_URL = /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
export function isRasterDataUrl(s) {
	return typeof s === 'string' && RASTER_DATA_URL.test(s);
}

// Whitelist + coerce a trade PnL ride-along payload. Keeps only known fields,
// drops non-finite numbers, and bounds the strings so an agent can't smuggle
// arbitrary data through the frame's `pnl` slot. Returns null when unusable.
const PNL_PHASES = ['scored', 'buy', 'hold', 'exit'];
export function sanitizePnl(pnl) {
	if (!pnl || typeof pnl !== 'object' || !PNL_PHASES.includes(pnl.phase)) return null;
	const out = { phase: pnl.phase };
	if (typeof pnl.mint === 'string') out.mint = pnl.mint.slice(0, 64);
	if (typeof pnl.symbol === 'string') out.symbol = pnl.symbol.slice(0, 32);
	for (const k of ['solDelta', 'pct', 'realizedUsd', 'unrealizedUsd']) {
		const n = Number(pnl[k]);
		if (Number.isFinite(n)) out[k] = n;
	}
	return out;
}

// Whitelist + coerce a market-maker `mm` ride-along (Floor Defense). Same shape
// the agent-mm worker writes directly to Redis, accepted here so any first-party
// pusher (or a JWT-authed owner) can drive the arena floor line through the HTTP
// transport too. Bounds the strings + drops non-finite numbers so a malformed
// push can't poison the stream. Returns null when unusable.
const MM_TYPES = ['mm_seed', 'mm_defend', 'mm_recycle', 'mm_rebalance', 'mm_graduate', 'mm_quote'];
export function sanitizeMm(mm) {
	if (!mm || typeof mm !== 'object' || !MM_TYPES.includes(mm.type)) return null;
	const out = { type: mm.type };
	for (const k of ['floorSol', 'priceSol', 'sizeSol']) {
		const n = Number(mm[k]);
		out[k] = Number.isFinite(n) && n >= 0 ? n : 0;
	}
	out.sideBuy = mm.sideBuy === true ? true : mm.sideBuy === false ? false : null;
	out.simulate = !!mm.simulate;
	if (typeof mm.mint === 'string') out.mint = mm.mint.slice(0, 64);
	if (typeof mm.signature === 'string') out.signature = mm.signature.slice(0, 96);
	return out;
}

// A pixels-only push (a periodic screenshot with no activity text) belongs in
// the frame slot, never in the 50-entry activity log: services/agent-screen-caster
// pushes one every FRAME_INTERVAL_MS, so logging them evicts the agent's real
// narration within seconds and leaves watchers reading blank lines. Log an entry
// only when it carries something to read: activity text, or a structured
// ride-along (PnL / forge meta / market-maker) the viewer renders on its own.
export function shouldLogEntry({ activity, pnl, meta, mm }) {
	return Boolean(activity || pnl || meta || mm);
}

export default async function handleAgentScreenPush(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;

	// Auth: first-party pool worker (shared secret, casts any agent) OR the
	// agent owner (bearer JWT / session, casts only their own agents).
	let userId = null;
	let isWorker = false;
	const bearer = extractBearer(req);
	if (isPoolWorker(bearer)) {
		isWorker = true;
	} else {
		if (bearer) {
			const auth = await authenticateBearer(bearer).catch(() => null);
			if (auth?.userId) userId = auth.userId;
		}
		if (!userId) {
			const auth = await getSessionUser(req, res);
			if (auth?.id) userId = auth.id;
		}
		if (!userId) return error(res, 401, 'unauthorized', 'authentication required');
	}

	// Rate limit: 6 frames/second per IP (generous for screenshot streams)
	const rl = await limits.apiIp(clientIp(req), { limit: 360, window: '60s' });
	if (!rl.success) return rateLimited(res, rl, 'frame rate limit exceeded');

	// Cap the body so a client can't force us to buffer tens of MB before we slice
	// the frame down to DATA_MAX. 1 MB comfortably holds a ~600 KB base64 frame.
	let body;
	try {
		body = await readJson(req, 1_100_000);
	} catch {
		return error(res, 400, 'invalid_body', 'request body must be valid JSON under 1 MB');
	}

	const { agentId, frame } = body || {};
	if (!agentId || typeof agentId !== 'string') {
		return error(res, 400, 'missing_agent_id', 'agentId is required');
	}
	if (!frame || typeof frame !== 'object') {
		return error(res, 400, 'missing_frame', 'frame object is required');
	}

	const activity = String(frame.activity || '').slice(0, ACTIVITY_MAX);
	const type = ['screenshot', 'activity', 'trade', 'analysis'].includes(frame.type)
		? frame.type : 'activity';
	const sliced = typeof frame.data === 'string' ? frame.data.slice(0, DATA_MAX) : null;
	const data = sliced && isRasterDataUrl(sliced) ? sliced : null;
	// Optional structured PnL ride-along on 'trade' frames (Live Trading Desk).
	// Drives the viewer's PnL ticker + avatar emote; sanitized so a malformed
	// push can't poison the stream. Persisted on the frame AND the log entry so
	// the ticker survives a reconnect's backfill.
	const pnl = sanitizePnl(frame.pnl);
	// Optional forge sidecar on the final 'analysis' frame of a Live Avatar Forge
	// run: carries the durable GLB url + viewer link so every connected viewer can
	// load and animate the freshly-forged avatar. Sanitized + http(s)-gated so a
	// push can't smuggle a junk or javascript: url to the viewer's loader.
	const meta = sanitizeFrameMeta(frame.meta);
	// Optional market-maker ride-along (Floor Defense): the structured floor/price
	// + fill context the arena reads to draw the floor line and route emotes.
	const mm = sanitizeMm(frame.mm);

	// Ownership: the pool worker may cast any existing agent; owners are limited
	// to their own agents.
	const [agentRow] = isWorker
		? await sql`SELECT id FROM agent_identities WHERE id = ${agentId} AND deleted_at IS NULL LIMIT 1`
		: await sql`SELECT id FROM agent_identities WHERE id = ${agentId} AND user_id = ${userId} LIMIT 1`;
	if (!agentRow) return error(res, isWorker ? 404 : 403, isWorker ? 'not_found' : 'forbidden', isWorker ? 'agent not found' : 'agent not owned by this user');

	const r = getRedis();
	if (!r) return error(res, 503, 'redis_unavailable', 'frame store offline');

	const now = Date.now();
	const frameKey = `agent:screen:${agentId}:frame`;
	const logKey = `agent:screen:${agentId}:log`;

	// Full frame record (includes image data when present)
	const frameRecord = JSON.stringify({ ts: now, data, activity, type, agentId, ...(pnl ? { pnl } : {}), ...(meta ? { meta } : {}), ...(mm ? { mm } : {}) });

	// Log entry (no image — the activity log only needs text + metadata)
	const logEntry = JSON.stringify({ ts: now, activity, type, ...(pnl ? { pnl } : {}), ...(meta ? { meta } : {}), ...(mm ? { mm } : {}) });

	const logs = shouldLogEntry({ activity, pnl, meta, mm });

	await Promise.all([
		r.set(frameKey, frameRecord, { ex: FRAME_TTL }),
		...(logs ? [
			r.lpush(logKey, logEntry).then(() => r.ltrim(logKey, 0, LOG_CAP - 1)),
			r.expire(logKey, FRAME_TTL * 5),
		] : []),
		// Track active agents in a sorted set (score = timestamp) so the walk
		// scene can discover which agents have live streams to show desks for.
		r.zadd('agent:screen:active', { score: now, member: agentId }),
		// Evict agents that haven't pushed in 120s so the set can't grow unbounded
		// under continuous traffic (the read side filters by score, but never removes).
		r.zremrangebyscore('agent:screen:active', 0, now - 120_000),
		r.expire('agent:screen:active', FRAME_TTL * 3),
	]);

	return json(res, 200, { ok: true, ts: now });
}
