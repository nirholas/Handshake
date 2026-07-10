// GET /api/galaxy/flows — the Galaxy Money-Cam feed.
//
// A real, platform-wide stream of money MOVING between agent wallets, shaped for
// the 3D star-map: every row is one on-chain, explorer-verifiable transfer that
// touches at least one PUBLIC three.ws agent, with the counterparty resolved to a
// second agent whenever its wallet belongs to one. The galaxy renders an
// agent↔agent transfer as a pulse of light travelling star→star, and a one-sided
// flow (a community tip, a DEX trade) as a flare on the single agent's star.
//
// EVERY flow is real. There are NO synthetic edges — when the platform is quiet
// the feed is honestly empty and the galaxy stays calm. This is the visual layer
// over the same public ledger as /api/pulse (Money Pulse), so the two never
// disagree; this endpoint adds the counterparty→agent resolution the map needs to
// draw an edge between two stars.
//
// Sources (all real, all public):
//   · agent_custody_events — tips received (event_type='tip', sender = meta.from),
//     and outbound spends (event_type='spend', category in trade/snipe/x402,
//     recipient = destination). Withdraws / vanity-swaps / limit-changes /
//     key-recovery are OWNER-PRIVATE and never appear.
//   · pump_agent_mints — coins an agent launched.
//
// Privacy is load-bearing: a private (is_public=false) or pulse-opted-out agent
// never appears — as the actor OR as a resolved counterparty.
//
//   GET /api/galaxy/flows                  — most-recent window (keyset paginated)
//   GET /api/galaxy/flows?since=<cursor>   — delta poll: only flows newer than cursor
//   GET /api/galaxy/flows?cursor=<cursor>  — load older history (scrubber backfill)
//   GET /api/galaxy/flows?type=tips|trades|payments|launches|all
//   GET /api/galaxy/flows?network=mainnet|devnet&limit=<n>

import { sql, isDbUnavailableError } from '../_lib/db.js';
import { cors, json, method, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { cacheGet, cacheSet } from '../_lib/cache.js';
import {
	PUBLIC_SPEND_CATEGORIES,
	TYPE_KINDS,
	encodeCursor,
	decodeCursor,
	shapeFlow,
	isAgentEdge,
} from '../_lib/galaxy-flows.js';

const FEED_TTL_S = 8; // first-page cache — it's a live feed, keep it short
const LASTGOOD_TTL_S = 600; // last-good snapshot, served if a build is slow/fails
// The last-good snapshot is the degraded fallback, not live data, so it does NOT
// need rewriting on every 8s cache miss. Writing it on every build doubled the
// large-payload SET volume on this endpoint — the codebase's own named cause of
// the Upstash cache-SET timeouts (see _lib/env.js UPSTASH_CACHE_REST_* note).
// Refresh it at most once per window per view; a fallback at most this stale is
// still a perfectly good calm-degrade snapshot, and SET pressure on the hot path
// is roughly halved. In-process gate (per warm instance) — best-effort by design.
const LASTGOOD_REFRESH_MS = 60_000;
const _lastGoodWrittenAt = new Map();
const DEFAULT_LIMIT = 80;
const MAX_LIMIT = 200;

// The feed query fans across agent_custody_events + a JSONB-keyed counterparty
// self-join; under load it can run long. Rather than hold the request until
// Vercel's hard 30s ceiling (a 504 page the galaxy can't render), we cap the
// build at a soft deadline and degrade to the last-good snapshot or an honestly
// empty window — both valid 200s the map renders calmly.
const BUILD_DEADLINE_MS = 22_000;

class FeedDeadline extends Error {}

// A valid, empty feed window — the same shape handleFeed returns — so a degraded
// response is indistinguishable to the client from a genuinely quiet platform.
function emptyFeed(network, type) {
	return {
		flows: [],
		has_more: false,
		next_cursor: null,
		head_cursor: null,
		network,
		type,
		summary: {
			count: 0,
			edges: 0,
			flares: 0,
			usd_total: 0,
			by_kind: { tip: 0, trade: 0, snipe: 0, payment: 0, launch: 0 },
			window_start: null,
			window_end: null,
		},
		server_time: new Date().toISOString(),
	};
}

// A flow is only worth animating if it touches a star the viewer can actually
// see, but that gating happens client-side against the loaded snapshot — here we
// return the full public window so the scrubber has real history to replay.
async function handleFeed({ network, type, limit, cursor, since }) {
	const kinds = TYPE_KINDS[type] || TYPE_KINDS.all;

	// Public-map privacy gate — a private or pulse-opted-out agent never appears,
	// as the actor OR as a resolved counterparty. Written out per-alias (not
	// parameterized) to match the proven /api/pulse composition exactly.
	const actorGate = sql`ai.deleted_at IS NULL AND ai.is_public = true
		AND COALESCE((ai.meta->>'pulse_opt_out')::boolean, false) = false`;
	const cpGate = sql`cp.deleted_at IS NULL AND cp.is_public = true
		AND COALESCE((cp.meta->>'pulse_opt_out')::boolean, false) = false`;

	// The counterparty wallet depends on direction: a tip's counterparty is the
	// sender (meta.from); a spend's counterparty is the recipient (destination).
	const counterpartyAddr = sql`
		(CASE WHEN ce.event_type = 'tip'
			THEN NULLIF(ce.meta->>'from', '')
			ELSE ce.destination END)
	`;

	const feedCte = sql`
		SELECT
			ce.created_at                                AS ts,
			(CASE
				WHEN ce.event_type = 'tip'   THEN 'tip'
				WHEN ce.category   = 'x402'  THEN 'payment'
				WHEN ce.category   = 'snipe' THEN 'snipe'
				ELSE 'trade'
			END)                                          AS kind,
			(CASE WHEN ce.event_type = 'tip' THEN 'in' ELSE 'out' END) AS direction,
			'c' || ce.id::text                            AS row_id,
			ce.network                                    AS network,
			ai.id                                         AS actor_id,
			ai.name                                       AS actor_name,
			ai.meta->>'solana_address'                    AS actor_addr,
			ai.meta->>'solana_vanity_prefix'              AS actor_vp,
			ai.meta->>'solana_vanity_suffix'              AS actor_vs,
			ce.asset                                      AS asset,
			ce.amount_lamports                            AS amount_lamports,
			ce.amount_raw                                 AS amount_raw,
			ce.usd                                        AS usd,
			ce.signature                                  AS signature,
			${counterpartyAddr}                           AS counterparty_addr,
			cp.id                                         AS counterparty_id,
			cp.name                                       AS counterparty_name,
			NULL::text                                    AS mint,
			NULL::text                                    AS symbol,
			NULL::text                                    AS coin_name
		FROM agent_custody_events ce
		JOIN agent_identities ai ON ai.id = ce.agent_id AND ${actorGate}
		LEFT JOIN agent_identities cp
			ON cp.meta->>'solana_address' = ${counterpartyAddr}
			AND ${cpGate}
		WHERE ce.network = ${network}
		  AND ce.status IN ('ok', 'confirmed')
		  AND (
			ce.event_type = 'tip'
			OR (ce.event_type = 'spend' AND ce.category = ANY(${PUBLIC_SPEND_CATEGORIES}))
		  )

		UNION ALL

		SELECT
			pam.created_at                                AS ts,
			'launch'                                      AS kind,
			'launch'                                      AS direction,
			'l' || pam.id::text                           AS row_id,
			pam.network                                   AS network,
			ai.id                                         AS actor_id,
			ai.name                                       AS actor_name,
			ai.meta->>'solana_address'                    AS actor_addr,
			ai.meta->>'solana_vanity_prefix'              AS actor_vp,
			ai.meta->>'solana_vanity_suffix'              AS actor_vs,
			NULL::text                                    AS asset,
			NULL::bigint                                  AS amount_lamports,
			NULL::numeric                                 AS amount_raw,
			NULL::numeric                                 AS usd,
			NULL::text                                    AS signature,
			NULL::text                                    AS counterparty_addr,
			NULL::uuid                                    AS counterparty_id,
			NULL::text                                    AS counterparty_name,
			pam.mint                                      AS mint,
			pam.symbol                                    AS symbol,
			pam.name                                      AS coin_name
		FROM pump_agent_mints pam
		JOIN agent_identities ai ON ai.id = pam.agent_id AND ${actorGate}
		WHERE pam.network = ${network}
	`;

	const cur = decodeCursor(cursor);
	const sinceCur = decodeCursor(since);
	const olderBound = cur
		? sql`AND (feed.ts < ${cur.ts} OR (feed.ts = ${cur.ts} AND feed.row_id < ${cur.rowId}))`
		: sql``;
	const newerBound = sinceCur
		? sql`AND (feed.ts > ${sinceCur.ts} OR (feed.ts = ${sinceCur.ts} AND feed.row_id > ${sinceCur.rowId}))`
		: sql``;

	const rows = await sql`
		WITH feed AS (${feedCte})
		SELECT * FROM feed
		WHERE feed.kind = ANY(${kinds})
		  ${olderBound}
		  ${newerBound}
		ORDER BY feed.ts DESC, feed.row_id DESC
		LIMIT ${limit + 1}
	`;

	const hasMore = rows.length > limit;
	const flows = rows.slice(0, limit).map(shapeFlow);
	const last = flows[flows.length - 1];
	const head = flows[0];
	const nextCursor = hasMore && last ? encodeCursor(last.ts, last.id) : null;
	const headCursor = head ? encodeCursor(head.ts, head.id) : (sinceCur ? since : null);

	// Honest window summary computed over exactly what we returned.
	let edges = 0;
	let usdTotal = 0;
	const byKind = { tip: 0, trade: 0, snipe: 0, payment: 0, launch: 0 };
	for (const f of flows) {
		if (isAgentEdge(f)) edges++;
		if (f.usd) usdTotal += f.usd;
		if (byKind[f.kind] != null) byKind[f.kind]++;
	}

	return {
		flows,
		has_more: hasMore,
		next_cursor: nextCursor,
		head_cursor: headCursor,
		network,
		type,
		summary: {
			count: flows.length,
			edges, // agent↔agent transfers (two stars)
			flares: flows.length - edges, // one-sided flows (one star)
			usd_total: usdTotal,
			by_kind: byKind,
			window_start: last ? last.ts : null, // oldest in page
			window_end: head ? head.ts : null, // newest in page
		},
		server_time: new Date().toISOString(),
	};
}

export default async function handler(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.galaxyIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://x');
	const network = url.searchParams.get('network') === 'devnet' ? 'devnet' : 'mainnet';
	const typeRaw = url.searchParams.get('type') || 'all';
	const type = TYPE_KINDS[typeRaw] ? typeRaw : 'all';
	const limit = Math.min(MAX_LIMIT, Math.max(1, Number(url.searchParams.get('limit')) || DEFAULT_LIMIT));
	const cursor = url.searchParams.get('cursor');
	const since = url.searchParams.get('since');

	// Build the feed but never let a slow query run past the soft deadline. On a
	// timeout or DB failure, fall back to the last-good snapshot for this
	// view, and only then to an empty (but valid) window — so the galaxy degrades
	// to last-known or calm-empty instead of surfacing a 504/502 the map can't use.
	const lastGoodKey = `galaxy:flows:lastgood:${network}:${type}:${limit}`;
	async function buildWithDeadline() {
		let timer;
		const deadline = new Promise((_, reject) => {
			timer = setTimeout(() => reject(new FeedDeadline('feed build exceeded soft deadline')), BUILD_DEADLINE_MS);
		});
		try {
			const body = await Promise.race([handleFeed({ network, type, limit, cursor, since }), deadline]);
			// Retain a long-lived copy for the degraded path on a future slow build —
			// but at most once per LASTGOOD_REFRESH_MS per view, so the live-feed cache
			// miss isn't paired with a second large SET on every request.
			const now = Date.now();
			if (now - (_lastGoodWrittenAt.get(lastGoodKey) || 0) >= LASTGOOD_REFRESH_MS) {
				_lastGoodWrittenAt.set(lastGoodKey, now);
				cacheSet(lastGoodKey, body, LASTGOOD_TTL_S).catch(() => {});
			}
			return body;
		} finally {
			clearTimeout(timer);
		}
	}

	try {
		// A first page (no cursor/since) is cached briefly to shield the DB from a
		// herd of pollers. A delta poll (`since`) is never cached — it must be live.
		const isFirstPage = !cursor && !since;
		if (isFirstPage) {
			const cacheKey = `galaxy:flows:${network}:${type}:${limit}`;
			let body = await cacheGet(cacheKey);
			if (body === null) {
				body = await buildWithDeadline();
				// Fire-and-forget: the body is already in hand and the cache is an
				// optimization, not part of the result. Awaiting put a degraded Upstash
				// (SET timing out at REDIS_CMD_TIMEOUT_MS) directly on the request's
				// critical path — up to 3s of dead latency for a write that falls back to
				// memory anyway. cacheSet swallows its own errors; .catch is belt-and-braces.
				cacheSet(cacheKey, body, FEED_TTL_S).catch(() => {});
			}
			res.setHeader('cache-control', 'public, max-age=6');
			return json(res, 200, { data: body });
		}

		const body = await buildWithDeadline();
		return json(res, 200, { data: body });
	} catch (e) {
		const timedOut = e instanceof FeedDeadline;
		const dbDown = !timedOut && isDbUnavailableError(e);
		if (dbDown) console.warn('[api/galaxy/flows] degraded (db unavailable):', e?.message);
		else console.error('[api/galaxy/flows] failed', timedOut ? 'soft-deadline' : e?.message, timedOut ? '' : e?.stack);
		// Degrade gracefully: a delta poll (`since`) returns nothing new rather than
		// erroring the live map; any view falls back to its last-good snapshot when
		// one exists, else an empty window. All are valid 200s.
		const lastGood = await cacheGet(lastGoodKey).catch(() => null);
		if (lastGood) {
			res.setHeader('cache-control', 'public, max-age=6');
			res.setHeader('x-galaxy-flows-degraded', timedOut ? 'deadline' : 'error');
			return json(res, 200, { data: lastGood });
		}
		res.setHeader('x-galaxy-flows-degraded', timedOut ? 'deadline-empty' : 'error-empty');
		return json(res, 200, { data: emptyFeed(network, type) });
	}
}
