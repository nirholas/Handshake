// POST /api/x402/bazaar-feed
//
// Bazaar Feed — $0.001 USDC per call on Solana or Base. One endpoint, two
// live views over the x402 service marketplace selected by the `filter` field:
//
//   • filter "new" / "active" — New-Listing Feed (USE-059)
//     Returns the newest service listings from the canonical bazaar_service_index
//     registry the daily catalog-refresh pipeline maintains: id, name, price,
//     networks, tags and first_seen, plus a category rollup and a listing-velocity
//     signal (spike / active / quiet). Poll it to keep a local catalog warm and to
//     catch fresh agent marketing activity the moment new services appear.
//     Body: { filter: "new" | "active", limit?: 1..50 }
//
//   • filter "price_trends" — Price Trend Monitor (USE-060)
//     Reads the x402_service_price_history time series (populated by the
//     x402-pricing-tracker pipeline) and, over the requested window, classifies
//     each tracked service as trending up / down / stable and derives the net
//     price pressure as a bullish / bearish / neutral signal.
//     Body: { filter: "price_trends", period: "24h" | "7d" | "1h" | "30m" }
//
// Data is live in both modes — derived from the platform's own bazaar registry
// and price-history tables. No mock path: a cold install with no data yet returns
// a genuine empty feed / neutral signal, never fabricated rows.

import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { readBody } from '../_lib/http.js';
import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { installAccessControl } from '../_lib/x402/access-control.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { priceFor } from '../_lib/x402-prices.js';
import { sql } from '../_lib/db.js';
import bazaarFeedListing from '../_lib/service-catalog/services/bazaar-feed.js';

const ROUTE = '/api/x402/bazaar-feed';

// Move bands. A service whose cheapest price moved more than ±STABLE_PCT over
// the window is "trending"; inside the band it is "stable". Env-overridable so
// ops can tune sensitivity without a redeploy.
const STABLE_PCT = Math.max(0.5, Number(process.env.X402_BAZAAR_TREND_STABLE_PCT || 5));
// Net-pressure thresholds for the directional sentiment signal.
const PRESSURE_PCT = Math.max(0.05, Number(process.env.X402_BAZAAR_TREND_PRESSURE || 0.15));
// Cap on how many movers to return per side (the long tail isn't actionable).
const TOP_N = 25;

// Single source of truth: api/_lib/service-catalog/services/bazaar-feed.js is
// the storefront listing copy — importing it here keeps the live 402 challenge
// from drifting from what /.well-known/x402.json and the OKX projection
// advertise (same pattern as forge.js → forge-listing.js).
const DESCRIPTION = bazaarFeedListing.description;

const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	properties: {
		filter: {
			type: 'string',
			description:
				'"new"/"active" returns newest-listing feed (default "new");' +
				' "price_trends" returns price-movement monitor.',
			enum: ['new', 'active', 'price_trends'],
			default: 'new',
		},
		limit: {
			type: 'integer',
			minimum: 1,
			maximum: 50,
			default: 10,
			description: 'Max listings to return (filter "new"/"active" only).',
		},
		period: {
			type: 'string',
			description: 'Lookback window: <n><unit>, unit m/h/d/w (e.g. 24h, 7d). filter "price_trends" only.',
			default: '24h',
		},
	},
};

const TREND_ITEM_SCHEMA = {
	type: 'object',
	required: ['service_key', 'pct_change', 'price_atomic'],
	properties: {
		service_key:       { type: 'string' },
		name:              { type: ['string', 'null'] },
		resource:          { type: ['string', 'null'] },
		tool_name:         { type: ['string', 'null'] },
		network:           { type: ['string', 'null'] },
		pct_change:        { type: 'number' },
		price_atomic:      { type: 'number' },
		price_usdc:        { type: 'number' },
		first_price_atomic:{ type: 'number' },
		observations:      { type: 'integer' },
	},
};

const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['filter'],
	properties: {
		// Shared
		filter:        { type: 'string' },
		// price_trends mode
		period:        { type: 'string' },
		trending_up:   { type: 'array', items: TREND_ITEM_SCHEMA },
		trending_down: { type: 'array', items: TREND_ITEM_SCHEMA },
		stable_count:  { type: 'integer' },
		total_tracked: { type: 'integer' },
		net_pressure:  { type: 'number' },
		avg_change_pct:{ type: ['number', 'null'] },
		signal:        { type: 'string' },
		headline:      { type: 'string' },
		confidence:    { type: 'number', minimum: 0, maximum: 1 },
		ts:            { type: 'string', format: 'date-time' },
		// new / active mode
		limit:         { type: 'integer' },
		count:         { type: 'integer' },
		listings:      { type: 'array', items: { type: 'object' } },
		newest:        { type: ['object', 'null'] },
		categories:    { type: 'array', items: { type: 'object' } },
		activity:      { type: 'object' },
		generated_at:  { type: 'string', format: 'date-time' },
	},
};

const BAZAAR = {
	description: DESCRIPTION,
	useCases: ['bazaar listings', 'bazaar price trends', 'service cost monitoring', 'market sentiment', 'agent-to-agent intel'],
	input: {
		type: 'json',
		example: { filter: 'new', limit: 10 },
		schema: INPUT_SCHEMA,
	},
	output: {
		type: 'json',
		example: {
			filter: 'new', limit: 10, count: 3,
			listings: [{ id: 'http:https://svc.example/x402', name: 'Example Feed', price: '0.001 USDC', first_seen: '2026-06-28T00:00:00Z' }],
			activity: { new_24h: 3, new_7d: 9, daily_avg_7d: 1.29, signal: 'active', headline: '3 new bazaar listings in 24 h', confidence: 0.65 },
			generated_at: '2026-06-28T10:00:00Z',
		},
	},
	schema: buildBazaarSchema({
		method: 'POST',
		bodySchema: INPUT_SCHEMA,
		outputSchema: OUTPUT_SCHEMA,
	}),
};

// Parse a period string (e.g. "24h", "7d", "30m", "2w") into a validated
// Postgres interval string. Defaults to 24 hours. Clamps to [1 minute, 30 days]
// so a hostile/typo value can never request an unbounded scan.
const UNIT_TO_PG = { m: 'minutes', h: 'hours', d: 'days', w: 'weeks' };
const UNIT_TO_MIN = { m: 1, h: 60, d: 1440, w: 10080 };
export function parsePeriod(raw) {
	const def = { interval: '24 hours', label: '24h' };
	if (typeof raw !== 'string') return def;
	const m = raw.trim().toLowerCase().match(/^(\d{1,5})\s*([mhdw])$/);
	if (!m) return def;
	let n = Number(m[1]);
	const unit = m[2];
	if (!Number.isFinite(n) || n <= 0) return def;
	const minutes = n * UNIT_TO_MIN[unit];
	const MIN = 1, MAX = 30 * 1440; // 1 minute .. 30 days
	if (minutes < MIN) { n = 1; return { interval: '1 minutes', label: '1m' }; }
	if (minutes > MAX) return { interval: '30 days', label: '30d' };
	return { interval: `${n} ${UNIT_TO_PG[unit]}`, label: `${n}${unit}` };
}

// Derive the directional sentiment from the up/down/stable tally + average move.
function classify(up, down, stable, avgChange) {
	const total = up + down + stable;
	const movers = up + down;
	const netPressure = total > 0 ? Number(((up - down) / total).toFixed(4)) : 0;
	let signal = 'neutral';
	if (netPressure > PRESSURE_PCT) signal = 'bullish';
	else if (netPressure < -PRESSURE_PCT) signal = 'bearish';

	// Confidence scales with sample size and the strength of the imbalance.
	let confidence = total === 0
		? 0.4
		: Math.min(0.95, 0.5 + Math.min(total / 20, 0.2) + Math.min(Math.abs(netPressure), 0.3));
	confidence = Number(confidence.toFixed(2));

	const dir = signal === 'bullish'
		? 'rising'
		: signal === 'bearish'
			? 'cooling'
			: 'steady';
	const headline = total === 0
		? 'Bazaar price trends: no service movement recorded yet'
		: `Bazaar prices ${dir} — ${up} up, ${down} down, ${stable} stable`;

	return { signal, netPressure, confidence, headline, total, movers };
}

// Read the price-trend feed from the live service price-history time series.
export async function readBazaarPriceTrends(periodRaw) {
	const { interval, label } = parsePeriod(periodRaw);

	let rows = [];
	try {
		rows = await sql`
			SELECT service_key,
			       (array_agg(price_atomic ORDER BY ts ASC))[1]  AS first_price,
			       (array_agg(price_atomic ORDER BY ts DESC))[1] AS last_price,
			       (array_agg(name        ORDER BY ts DESC))[1]  AS name,
			       (array_agg(resource    ORDER BY ts DESC))[1]  AS resource,
			       (array_agg(tool_name   ORDER BY ts DESC))[1]  AS tool_name,
			       (array_agg(network     ORDER BY ts DESC))[1]  AS network,
			       count(*)::int AS observations
			FROM x402_service_price_history
			WHERE ts >= now() - ${interval}::interval
			  AND available = true
			  AND price_atomic IS NOT NULL
			  AND price_atomic > 0
			GROUP BY service_key
			HAVING count(*) >= 2
		`;
	} catch (err) {
		// Tracker has never run (table absent) — genuine empty feed, not an error.
		if (/does not exist/i.test(err?.message || '')) rows = [];
		else throw err;
	}

	const up = [];
	const down = [];
	let stableCount = 0;
	let changeSum = 0;
	let changeN = 0;

	for (const r of rows) {
		const first = Number(r.first_price);
		const last = Number(r.last_price);
		if (!Number.isFinite(first) || first <= 0 || !Number.isFinite(last)) continue;
		const pct = Number((((last - first) / first) * 100).toFixed(2));
		changeSum += pct;
		changeN += 1;

		if (Math.abs(pct) < STABLE_PCT) {
			stableCount += 1;
			continue;
		}
		const item = {
			service_key: r.service_key,
			name: r.name || null,
			resource: r.resource || null,
			tool_name: r.tool_name || null,
			network: r.network || null,
			pct_change: pct,
			price_atomic: last,
			price_usdc: Number((last / 1e6).toFixed(6)),
			first_price_atomic: first,
			observations: Number(r.observations || 0),
		};
		(pct > 0 ? up : down).push(item);
	}

	up.sort((a, b) => b.pct_change - a.pct_change);
	down.sort((a, b) => a.pct_change - b.pct_change);

	const avgChange = changeN > 0 ? Number((changeSum / changeN).toFixed(2)) : null;
	const { signal, netPressure, confidence, headline, total } =
		classify(up.length, down.length, stableCount, avgChange);

	return {
		filter: 'price_trends',
		period: label,
		trending_up: up.slice(0, TOP_N),
		trending_down: down.slice(0, TOP_N),
		stable_count: stableCount,
		total_tracked: total,
		net_pressure: netPressure,
		avg_change_pct: avgChange,
		signal,
		headline: `${headline} over ${label}`,
		confidence,
		ts: new Date().toISOString(),
	};
}

// ── New-Listing Feed helpers (USE-059) ────────────────────────────────────────

let _indexSchemaReady = false;
async function ensureIndexSchema() {
	if (_indexSchemaReady) return;
	await sql`
		CREATE TABLE IF NOT EXISTS bazaar_service_index (
			service_key  text PRIMARY KEY,
			resource     text NOT NULL,
			tool_name    text,
			type         text,
			name         text,
			description  text,
			price_atomic bigint,
			price        text,
			networks     text[] NOT NULL DEFAULT '{}',
			tags         jsonb  NOT NULL DEFAULT '[]'::jsonb,
			details      jsonb,
			status       text   NOT NULL DEFAULT 'active',
			first_seen   timestamptz NOT NULL DEFAULT now(),
			last_seen    timestamptz NOT NULL DEFAULT now(),
			removed_at   timestamptz,
			last_run_id  uuid
		)
	`;
	await sql`CREATE INDEX IF NOT EXISTS bazaar_service_index_status_first ON bazaar_service_index (status, first_seen DESC)`;
	_indexSchemaReady = true;
}

function asTags(raw) {
	if (Array.isArray(raw)) return raw.filter((t) => typeof t === 'string');
	if (typeof raw === 'string') {
		try {
			const p = JSON.parse(raw);
			return Array.isArray(p) ? p.filter((t) => typeof t === 'string') : [];
		} catch { return []; }
	}
	return [];
}

function rowToListing(r) {
	return {
		id: r.service_key,
		resource: r.resource,
		tool_name: r.tool_name || null,
		type: r.type || null,
		name: r.name || null,
		price_atomic: r.price_atomic != null ? String(r.price_atomic) : null,
		price: r.price || null,
		networks: Array.isArray(r.networks) ? r.networks : [],
		tags: asTags(r.tags),
		first_seen: new Date(r.first_seen).toISOString(),
		last_seen: new Date(r.last_seen).toISOString(),
	};
}

function rollupCategories(listings) {
	const counts = new Map();
	for (const l of listings) {
		for (const tag of l.tags) counts.set(tag, (counts.get(tag) || 0) + 1);
	}
	return [...counts.entries()]
		.map(([tag, count]) => ({ tag, count }))
		.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
		.slice(0, 10);
}

function classifyListingActivity(new24h, new7d) {
	const dailyAvg7d = new7d / 7;
	let signal, headline, confidence;
	if (new24h === 0) {
		signal = 'quiet';
		headline = 'No new bazaar listings in the last 24 h';
		confidence = 0.6;
	} else if (new24h >= 3 && dailyAvg7d > 0 && new24h >= dailyAvg7d * 2) {
		signal = 'spike';
		headline = `${new24h} new bazaar listings in 24 h — above the ${dailyAvg7d.toFixed(1)}/day trend`;
		confidence = Math.min(0.95, 0.6 + Math.min(new24h / 20, 0.35));
	} else {
		signal = 'active';
		headline = `${new24h} new bazaar listing${new24h === 1 ? '' : 's'} in 24 h`;
		confidence = 0.65;
	}
	return {
		new_24h: new24h,
		new_7d: new7d,
		daily_avg_7d: Number(dailyAvg7d.toFixed(2)),
		signal,
		headline,
		confidence,
	};
}

export async function readBazaarNewListings({ filter, limit }) {
	await ensureIndexSchema();

	const rows = filter === 'active'
		? await sql`
			SELECT service_key, resource, tool_name, type, name,
			       price_atomic, price, networks, tags, first_seen, last_seen
			  FROM bazaar_service_index
			 WHERE status = 'active'
			 ORDER BY last_seen DESC
			 LIMIT ${limit}
		`
		: await sql`
			SELECT service_key, resource, tool_name, type, name,
			       price_atomic, price, networks, tags, first_seen, last_seen
			  FROM bazaar_service_index
			 WHERE status = 'active'
			 ORDER BY first_seen DESC
			 LIMIT ${limit}
		`;

	const [velocity] = await sql`
		SELECT
			COUNT(*) FILTER (WHERE first_seen >= now() - interval '24 hours') AS new_24h,
			COUNT(*) FILTER (WHERE first_seen >= now() - interval '7 days')   AS new_7d
		  FROM bazaar_service_index
		 WHERE status = 'active'
	`;

	const listings = rows.map(rowToListing);
	const newestByDate = listings.length
		? listings.reduce((a, b) => (a.first_seen >= b.first_seen ? a : b))
		: null;
	const newest = newestByDate ? {
		id: newestByDate.id,
		name: newestByDate.name,
		price_atomic: newestByDate.price_atomic,
		price: newestByDate.price,
		type: newestByDate.type,
		networks: newestByDate.networks,
		first_seen: newestByDate.first_seen,
	} : null;

	return {
		filter,
		limit,
		count: listings.length,
		listings,
		newest,
		categories: rollupCategories(listings),
		activity: classifyListingActivity(
			Number(velocity?.new_24h || 0),
			Number(velocity?.new_7d || 0),
		),
		generated_at: new Date().toISOString(),
	};
}

// ── paidEndpoint ──────────────────────────────────────────────────────────────

export default paidEndpoint({
	route: ROUTE,
	method: 'POST',
	priceAtomics: priceFor('bazaar-feed', '1000'), // $0.001 USDC — lightweight read
	networks: ['solana', 'base'],
	description: DESCRIPTION,
	bazaar: BAZAAR,
	service: withService({
		serviceName: 'three.ws Bazaar Feed',
		tags: ['bazaar', 'listings', 'discovery', 'market', 'x402'],
	}),
	siwx: {
		statement: 'Sign in to refresh the three.ws bazaar feed without re-paying.',
		ttlSeconds: 24 * 3600,
		expirationSeconds: 300,
	},
	requiredScope: 'x402:bypass',
	accessControl: installAccessControl({ requiredScope: 'x402:bypass' }),

	async handler({ req }) {
		let filter = 'new';
		let period = '24h';
		let limit = 10;
		try {
			const chunks = [await readBody(req, 1_000_000)];
			const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
			if (typeof body.filter === 'string' && body.filter.trim()) {
				filter = body.filter.trim().toLowerCase();
			}
			if (typeof body.period === 'string' && body.period.trim()) {
				period = body.period.trim();
			}
			const limitRaw = parseInt(body.limit, 10);
			if (Number.isFinite(limitRaw)) limit = Math.min(Math.max(limitRaw, 1), 50);
		} catch { /* defaults */ }

		if (filter === 'price_trends') return readBazaarPriceTrends(period);
		if (filter === 'new' || filter === 'active') return readBazaarNewListings({ filter, limit });

		throw Object.assign(
			new Error(`unsupported filter "${filter}"; use "new", "active", or "price_trends"`),
			{ status: 400, code: 'unsupported_filter' },
		);
	},
});
