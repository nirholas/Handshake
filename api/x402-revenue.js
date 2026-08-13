// GET /api/x402-revenue — the public, real-time view of money flowing INTO the
// platform's own x402 paid endpoints.
//
// This is the mirror image of the Money Pulse (/api/pulse): the Pulse surfaces
// agent wallet SPEND (agent_custody_events); this surfaces endpoint REVENUE — the
// USDC that buyers pay to call our paid endpoints, recorded in x402_audit_log.
// See docs/x402-revenue.md.
//
// EVERY row is a real settled payment with an explorer-verifiable tx. There are no
// synthetic events — if the endpoints are quiet, the feed is honestly empty.
//
// Privacy: x402_audit_log also stores ip_address and user_agent. Those are
// operational and NEVER leave the server — this endpoint selects only the
// already-public, on-chain-verifiable fields (route, network, amount, tx, time)
// plus a truncated payer label. The stats view exposes only aggregates.
//
// Views:
//   GET /api/x402-revenue                          — live feed of recent settlements (keyset)
//   GET /api/x402-revenue?since=<iso>              — delta poll: only settlements newer than cursor
//   GET /api/x402-revenue?endpoint=<slug>&network= — filter the feed
//   GET /api/x402-revenue?view=stats&period=24h    — aggregate revenue intelligence
//                                                    (totals, per-endpoint, per-network,
//                                                     time-series, momentum, settlement health)
//   GET /api/x402-revenue?view=export&period=24h   — CSV of settlements in the window

import { sql, isDbUnavailableError } from './_lib/db.js';
import { cors, json, method, error, serverError, rateLimited } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { cacheGet, cacheSet } from './_lib/cache.js';
import { atomicsToUsdc } from './_lib/agent-paid-services.js';
import { buildRevenueReport, resolvePeriod } from './_lib/x402/revenue-analytics.js';
import {
	networkIdentity,
	resolveNetworkFilter,
	revenueTxUrl,
	foldNetworkRows,
} from './_lib/x402/revenue-networks.js';

const STATS_TTL_S = 30;
const FEED_TTL_S = 8;
const FEED_DEFAULT_LIMIT = 30;
const FEED_MAX_LIMIT = 100;
const EXPORT_MAX_ROWS = 5000;

// Time-series bucket unit per period. Kept coarse enough to stay light, fine
// enough to draw a smooth chart (24h→24 pts, 7d→168, 30d→30, all→daily).
const SERIES_UNIT = { '24h': 'hour', '7d': 'hour', '30d': 'day', all: 'day' };

// Shorten a wallet/payer address for display — full address stays on-chain.
function shortAddr(a) {
	if (!a || typeof a !== 'string') return null;
	return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

// A route → slug ('/api/x402/token-intel' → 'token-intel'); null if not one of ours.
function routeForEndpoint(slug) {
	if (!slug) return null;
	const clean = String(slug)
		.trim()
		.replace(/^\/?(api\/x402\/)?/, '')
		.replace(/[^a-z0-9-]/gi, '');
	return clean ? `/api/x402/${clean}` : null;
}

// A `?network=` value → the raw ledger ids it selects, as a comma-joined string
// bound once and expanded in SQL. The ledger holds CAIP-2 ids ('solana:5eykt4Us…',
// 'eip155:8453') while callers filter by family ('solana', 'base'), so comparing
// the two directly matches nothing; see _lib/x402/revenue-networks.js.
function networkFilterIds(n) {
	const f = resolveNetworkFilter(n);
	return f ? f.ids.join(',') : null;
}

// Shape a settled-payment row into a privacy-safe public event.
function shapeSettlement(r) {
	const atomics = /^[0-9]+$/.test(String(r.amount_atomics || '')) ? Number(r.amount_atomics) : 0;
	const net = r.network || null;
	const identity = networkIdentity(net);
	return {
		id: r.id,
		route: r.route || 'unknown',
		network: net,
		network_family: identity.family,
		network_label: identity.label,
		amount_usd: atomicsToUsdc(atomics),
		asset: r.asset || 'USDC',
		payer: shortAddr(r.payer),
		tx: r.tx_hash || null,
		tx_url: revenueTxUrl(r.tx_hash, net),
		ts: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
	};
}

// Settlement success-rate over the window: settled vs failed payment events.
async function settlementHealth(since) {
	const [row] = await sql`
		SELECT
			count(*) FILTER (WHERE event_type = 'payment_settled')::int AS settled,
			count(*) FILTER (WHERE event_type = 'payment_failed')::int  AS failed
		FROM x402_audit_log
		WHERE event_type IN ('payment_settled', 'payment_failed')
			AND (${since}::timestamptz IS NULL OR created_at >= ${since}::timestamptz)
	`;
	const settled = row?.settled || 0;
	const failed = row?.failed || 0;
	const total = settled + failed;
	return { settled, failed, success_rate: total > 0 ? Number((settled / total).toFixed(4)) : 1 };
}

// Time-bucketed revenue for the chart. Gaps (buckets with no revenue) are filled
// client-side against the returned unit so the area chart stays continuous.
async function revenueSeries(period) {
	const { key, since } = resolvePeriod(period);
	const unit = SERIES_UNIT[key] || 'hour';
	const rows = await sql`
		SELECT date_trunc(${unit}, created_at) AS bucket,
			count(*)::int AS count,
			coalesce(sum(CASE WHEN amount_atomics ~ '^[0-9]+$' THEN amount_atomics::numeric ELSE 0 END), 0) AS gross_atomics
		FROM x402_audit_log
		WHERE event_type = 'payment_settled'
			AND (${since}::timestamptz IS NULL OR created_at >= ${since}::timestamptz)
		GROUP BY bucket
		ORDER BY bucket ASC
	`;
	return {
		unit,
		points: rows.map((r) => ({
			ts: r.bucket instanceof Date ? r.bucket.toISOString() : r.bucket,
			count: r.count,
			gross_usd: atomicsToUsdc(Number(r.gross_atomics || 0)),
		})),
	};
}

// Revenue split by settlement network, folded to one row per chain family so the
// UI names "Solana" rather than the genesis hash the ledger stores.
async function revenueByNetwork(since) {
	const rows = await sql`
		SELECT network,
			count(*)::int AS count,
			coalesce(sum(CASE WHEN amount_atomics ~ '^[0-9]+$' THEN amount_atomics::numeric ELSE 0 END), 0) AS gross_atomics
		FROM x402_audit_log
		WHERE event_type = 'payment_settled'
			AND (${since}::timestamptz IS NULL OR created_at >= ${since}::timestamptz)
		GROUP BY network
		ORDER BY gross_atomics DESC
	`;
	return foldNetworkRows(
		rows.map((r) => ({
			network: r.network,
			count: r.count,
			gross_usd: atomicsToUsdc(Number(r.gross_atomics || 0)),
		})),
	);
}

// Momentum: this window's gross vs the immediately-preceding equal window, plus a
// simple per-hour run-rate. Null for all-time (no comparable prior window).
async function revenueMomentum(period, grossUsd) {
	const { hours, since } = resolvePeriod(period);
	if (hours == null || since == null) {
		return { change_pct: null, prev_usd: null, per_hour_usd: null };
	}
	const prevSince = new Date(Date.parse(since) - hours * 3600_000).toISOString();
	const [row] = await sql`
		SELECT coalesce(sum(CASE WHEN amount_atomics ~ '^[0-9]+$' THEN amount_atomics::numeric ELSE 0 END), 0) AS prev_atomics
		FROM x402_audit_log
		WHERE event_type = 'payment_settled'
			AND created_at >= ${prevSince}::timestamptz
			AND created_at < ${since}::timestamptz
	`;
	const prevUsd = atomicsToUsdc(Number(row?.prev_atomics || 0));
	const change = prevUsd > 0 ? (grossUsd - prevUsd) / prevUsd : grossUsd > 0 ? 1 : 0;
	return {
		change_pct: Number(change.toFixed(4)),
		prev_usd: prevUsd,
		per_hour_usd: Number((grossUsd / hours).toFixed(6)),
	};
}

async function handleStats(period) {
	const { since } = resolvePeriod(period);
	const report = await buildRevenueReport({ period });
	const grossUsd = Number(report?.totals?.gross_usd || 0);
	const [health, series, byNetwork, momentum] = await Promise.all([
		settlementHealth(since),
		revenueSeries(period),
		revenueByNetwork(since),
		revenueMomentum(period, grossUsd),
	]);
	return { ...report, settlement_health: health, series, by_network: byNetwork, momentum };
}

async function handleFeed({ since, cursor, limit, endpoint, network }) {
	const route = routeForEndpoint(endpoint);
	const netIds = networkFilterIds(network);
	const rows = await sql`
		SELECT id, route, network, amount_atomics, asset, tx_hash, payer, created_at
		FROM x402_audit_log
		WHERE event_type = 'payment_settled'
			AND (${since}::timestamptz IS NULL OR created_at > ${since}::timestamptz)
			AND (${cursor}::timestamptz IS NULL OR created_at < ${cursor}::timestamptz)
			AND (${route}::text IS NULL OR route = ${route})
			AND (${netIds}::text IS NULL OR network = ANY(string_to_array(${netIds}::text, ',')))
		ORDER BY created_at DESC
		LIMIT ${limit}
	`;
	const events = rows.map(shapeSettlement);
	const last = rows[rows.length - 1];
	const nextCursor = last
		? last.created_at instanceof Date
			? last.created_at.toISOString()
			: last.created_at
		: null;
	return {
		events,
		count: events.length,
		next_cursor: events.length === limit ? nextCursor : null,
		filter: {
			endpoint: route ? endpoint : null,
			network: resolveNetworkFilter(network)?.family || null,
		},
	};
}

// CSV export of settlements in the window (bounded). Streams a downloadable file.
async function handleExport(res, { period, endpoint, network }) {
	const { since } = resolvePeriod(period);
	const route = routeForEndpoint(endpoint);
	const netIds = networkFilterIds(network);
	const rows = await sql`
		SELECT route, network, amount_atomics, asset, tx_hash, payer, created_at
		FROM x402_audit_log
		WHERE event_type = 'payment_settled'
			AND (${since}::timestamptz IS NULL OR created_at >= ${since}::timestamptz)
			AND (${route}::text IS NULL OR route = ${route})
			AND (${netIds}::text IS NULL OR network = ANY(string_to_array(${netIds}::text, ',')))
		ORDER BY created_at DESC
		LIMIT ${EXPORT_MAX_ROWS}
	`;
	const header = 'timestamp,endpoint,network,chain,amount_usd,asset,payer,tx_hash,tx_url\n';
	const csv = rows.reduce((acc, r) => {
		const ev = shapeSettlement(r);
		const cells = [
			ev.ts,
			ev.route,
			ev.network || '',
			ev.network_label,
			ev.amount_usd,
			ev.asset,
			r.payer || '',
			ev.tx || '',
			ev.tx_url || '',
		].map((c) => {
			const s = String(c ?? '');
			return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
		});
		return acc + cells.join(',') + '\n';
	}, header);
	res.statusCode = 200;
	res.setHeader('content-type', 'text/csv; charset=utf-8');
	res.setHeader(
		'content-disposition',
		`attachment; filename="x402-revenue-${resolvePeriod(period).key}.csv"`,
	);
	res.setHeader('cache-control', 'no-store');
	res.end(csv);
}

export default async function handler(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://x');
	const view = url.searchParams.get('view') || 'feed';
	const period = url.searchParams.get('period') || '24h';
	const since = url.searchParams.get('since');
	const cursor = url.searchParams.get('cursor');
	const endpoint = url.searchParams.get('endpoint');
	const network = url.searchParams.get('network');
	const limit = Math.min(
		FEED_MAX_LIMIT,
		Math.max(1, Number(url.searchParams.get('limit')) || FEED_DEFAULT_LIMIT),
	);

	try {
		if (view === 'stats') {
			const cacheKey = `x402rev:stats:${resolvePeriod(period).key}`;
			let body = await cacheGet(cacheKey);
			if (body === null) {
				body = await handleStats(period);
				await cacheSet(cacheKey, body, STATS_TTL_S);
			}
			res.setHeader('cache-control', 'public, max-age=20');
			return json(res, 200, { data: body });
		}

		if (view === 'export') {
			return await handleExport(res, { period, endpoint, network });
		}

		// Delta polls (since=) are never cached — they must reflect the latest row.
		if (since) {
			return json(res, 200, { data: await handleFeed({ since, limit, endpoint, network }) });
		}

		// Filtered feeds and older pages: a short cache smooths the live-poll cadence.
		const filterKey = `${routeForEndpoint(endpoint) || 'all'}:${resolveNetworkFilter(network)?.family || 'all'}`;
		const cacheKey = `x402rev:feed:${cursor || 'head'}:${limit}:${filterKey}`;
		let body = await cacheGet(cacheKey);
		if (body === null) {
			body = await handleFeed({ cursor, limit, endpoint, network });
			await cacheSet(cacheKey, body, FEED_TTL_S);
		}
		res.setHeader('cache-control', 'public, max-age=8');
		return json(res, 200, { data: body });
	} catch (err) {
		if (isDbUnavailableError(err)) {
			return error(res, 503, 'db_unavailable', 'revenue ledger is temporarily unavailable');
		}
		return serverError(res, 500, 'x402_revenue_error', err);
	}
}
