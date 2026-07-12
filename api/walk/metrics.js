// POST /api/walk/metrics — the shared ingest for the walk leaderboard (task 39)
// and the per-creator embed analytics dashboard (task 40).
//
// The walking-avatar client (src/walk.js) and the embed runtime accumulate two
// running totals — horizontal distance travelled (sum of per-frame position
// deltas, in metres) and session wall-clock — and flush a compact batch here
// every ~60s plus once on pagehide via navigator.sendBeacon. The Chrome
// extension flushes the same shape with the host it piloted.
//
// One batch UPSERTs into a per-(walker, day, env, embed origin, avatar) rollup
// row in walk_metrics, so a walker who roams for an hour produces a handful of
// rows, not thousands. The leaderboard and analytics endpoints aggregate over
// that rollup.
//
// Attribution: a signed-in session/bearer wins; otherwise the batch is keyed to
// the client-supplied anonymous id (anonId). Anonymous walkers are first-class —
// the leaderboard ranks them too — but a batch with neither identity is rejected.
//
// embedOrigin is NEVER trusted from the body: it is derived server-side from the
// Origin / Referer header (the embedding page's host), so a creator's analytics
// reflect where the avatar actually ran, not what a caller claims.
//
// eventName (+ optional value) records a creator-defined conversion event fired
// from the embed SDK — window.ThreeWalkAvatar.track('subscribe', { value: 9 }) —
// into walk_events for the analytics funnel. Achievement unlocks (1 km, 10 sites,
// all 6 environments) are persisted once each into walk_achievements.

import { z } from 'zod';
import { cors, method, readJson, json, wrap, rateLimited } from '../_lib/http.js';
import { parse } from '../_lib/validate.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { sql } from '../_lib/db.js';
import { getSessionUser, extractBearer, authenticateBearer } from '../_lib/auth.js';
import { recordDailyActivity } from '../_lib/streaks.js';

export const maxDuration = 10;

// Known achievement codes — the client may only persist these. Kept in lockstep
// with the toasts fired in src/walk.js.
const ACHIEVEMENT_CODES = new Set([
	'distance_1km',
	'distance_5km',
	'sites_10',
	'all_environments',
]);

const bodySchema = z
	.object({
		// Cumulative-since-last-flush increments. Clamped to sane per-batch ceilings
		// so a malformed/hostile client can't inject an implausible jump (a brisk
		// walk is ~1.4 m/s, so even a 10-minute batch is < 1 km; 50 km is a hard
		// upper bound that still tolerates fast-travel/teleport edge cases).
		distanceMeters: z.number().finite().min(0).max(50_000).optional().default(0),
		durationSec: z.number().finite().min(0).max(86_400).optional().default(0),
		sessions: z.number().int().min(0).max(50).optional().default(0),
		envId: z.string().trim().max(64).optional().nullable(),
		siteHostname: z.string().trim().max(255).optional().nullable(),
		avatarId: z.string().uuid().optional().nullable(),
		// embedOrigin is accepted in the schema for forward-compat but ignored:
		// the value written to the DB is always derived from request headers.
		embedOrigin: z.string().max(255).optional().nullable(),
		eventName: z.string().trim().min(1).max(64).optional().nullable(),
		value: z.number().finite().optional().nullable(),
		anonId: z.string().trim().min(8).max(64).optional().nullable(),
		achievements: z.array(z.string().trim().max(64)).max(8).optional().default([]),
	})
	.strict();

// Reduce a request's Origin/Referer to a bare hostname, lowercased, https/http
// only. Returns null for same-origin (the three.ws app itself) and for anything
// unparseable — a creator's "unique sites" should count third-party embeds, not
// our own page. APP_ORIGIN is matched so a /walk session on three.ws isn't
// double-counted as an external embed origin.
function deriveEmbedOrigin(req) {
	const raw = req.headers.origin || req.headers.referer || '';
	if (!raw) return null;
	let host;
	try {
		host = new URL(raw).hostname.toLowerCase();
	} catch {
		return null;
	}
	if (!host) return null;
	if (host === 'three.ws' || host === 'www.three.ws' || host === 'localhost') return null;
	return host;
}

async function resolveUserId(req) {
	try {
		const bearer = extractBearer(req);
		const user = bearer ? await authenticateBearer(bearer) : await getSessionUser(req);
		return user?.userId || user?.id || user?.sub || null;
	} catch {
		return null;
	}
}

export default wrap(async (req, res) => {
	// Embeds POST from third-party hosts, so the ingest must be open-CORS.
	if (cors(req, res, { origins: '*', methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;

	const ip = clientIp(req);
	const rl = await limits.irlInteractIp(ip); // 60/min — matches the ~1/min flush cadence + retries
	if (!rl.success) return rateLimited(res, rl, 'too many metric flushes');

	const raw = await readJson(req);
	const body = parse(bodySchema, raw);

	const userId = await resolveUserId(req);
	const anonId = body.anonId || null;

	// A batch must be attributable to someone. Anonymous walkers supply anonId.
	if (!userId && !anonId) {
		return json(res, 202, { ok: false, reason: 'no walker identity', recorded: false });
	}

	const embedOrigin = deriveEmbedOrigin(req);
	const day = new Date().toISOString().slice(0, 10); // UTC date
	const envId = body.envId || null;
	const avatarId = body.avatarId || null;
	const siteHostname = body.siteHostname || null;

	const hasMetrics = body.distanceMeters > 0 || body.durationSec > 0 || body.sessions > 0;

	// Rollup UPSERT: add this batch's increments onto the matching daily row. The
	// unique index is on the COALESCE'd dimension tuple, so the ON CONFLICT target
	// must match it expression-for-expression.
	if (hasMetrics) {
		await sql`
			insert into walk_metrics
				(user_id, anon_id, avatar_id, day, env_id, embed_origin, site_hostname,
				 distance_meters, duration_sec, sessions)
			values
				(${userId}, ${anonId}, ${avatarId}, ${day}, ${envId}, ${embedOrigin}, ${siteHostname},
				 ${body.distanceMeters}, ${body.durationSec}, ${body.sessions})
			on conflict (
				coalesce(user_id::text, ''),
				coalesce(anon_id, ''),
				day,
				coalesce(env_id, ''),
				coalesce(embed_origin, ''),
				coalesce(avatar_id::text, '')
			)
			do update set
				distance_meters = walk_metrics.distance_meters + excluded.distance_meters,
				duration_sec    = walk_metrics.duration_sec + excluded.duration_sec,
				sessions        = walk_metrics.sessions + excluded.sessions,
				site_hostname   = coalesce(excluded.site_hostname, walk_metrics.site_hostname),
				updated_at      = now()
		`;
	}

	// Creator-defined conversion event from the embed SDK.
	if (body.eventName) {
		await sql`
			insert into walk_events (user_id, anon_id, avatar_id, event_name, value, embed_origin)
			values (${userId}, ${anonId}, ${avatarId}, ${body.eventName}, ${body.value ?? null}, ${embedOrigin})
		`;
	}

	// Persist any newly-crossed achievement thresholds, once each.
	const codes = (body.achievements || []).filter((c) => ACHIEVEMENT_CODES.has(c));
	if (codes.length) {
		for (const code of codes) {
			await sql`
				insert into walk_achievements (user_id, anon_id, code)
				values (${userId}, ${anonId}, ${code})
				on conflict (coalesce(user_id::text, ''), coalesce(anon_id, ''), code)
				do nothing
			`;
		}
	}

	// A signed-in walker's session is a qualifying streak action. Anonymous
	// walkers have no user_id to attach a cross-surface streak to.
	if (userId && hasMetrics) recordDailyActivity(userId).catch(() => {});

	return json(res, 200, { ok: true, recorded: hasMetrics || !!body.eventName || codes.length > 0 });
});
