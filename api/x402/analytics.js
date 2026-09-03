// POST /api/x402/analytics
//
// Social-Economy Analytics Feed — $0.005 USDC per call on Solana or Base.
//
// One agent pays another for a live, aggregated view of the three.ws social
// economy. The first report exposed is the Pole Club's activity: how many
// stages (clubs) are currently active, how many distinct patrons (members) are
// participating, the tip throughput, the cover charges collected at the door,
// and which stages are growing fastest. Every number is read live from the
// real ledgers — club_tips (the settled tip ledger), club_dancer_wallets (the
// stage roster) and x402_audit_log (settled cover-charge payments). No mock
// path: if a backing table is missing in an environment the metric folds to a
// real zero rather than a fabricated value.
//
// Reports:
//   • clubs            — Pole Club social economy (active stages, patrons, tips,
//                        cover charges, fastest-growing stages).
//       Body: { report: "clubs", period: "1h"|"24h"|"7d"|"30d"|"all" }
//   • agent_leaderboard — top agents by USDC spend over a trailing window, read
//                        live from the real agent-to-agent hire ledger
//                        (agent_hires + agent_identities). Surfaces high-value
//                        paying agents for partnership / outreach.
//       Body: { report: "agent_leaderboard", limit?: 1-100, window_days?: 1-90 }
//
// The endpoint is consumed by the autonomous x402 loop (see
// autonomous-registry.js → 'analytics-club-social' for the clubs report and
// 'agent-spend-leaderboard' for the agent_leaderboard report).

import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { readBody as readRawBody } from '../_lib/http.js';
import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { installAccessControl } from '../_lib/x402/access-control.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { priceFor } from '../_lib/x402-prices.js';
import { sql } from '../_lib/db.js';
import { solUsdPrice } from '../_lib/avatar-wallet.js';
import { buildSniperAnalytics } from '../_lib/x402/sniper-analytics-store.js';
import { computeUserActivity, normalizePeriod } from '../_lib/x402/user-activity-analytics.js';
import { getPaymentStats } from '../_lib/x402/audit-log.js';
import { revenueSplit } from '../_lib/x402/revenue-split.js';

const ROUTE = '/api/x402/analytics';

const DESCRIPTION =
	'three.ws Economy Analytics — pay $0.005 USDC per call for a live, aggregated ' +
	'view of platform activity. "clubs": Pole Club economy — active stages, patrons, ' +
	'tip volume, cover charges, fastest-growing leaderboard. "agent_leaderboard": top ' +
	'agents by USDC spend over a trailing window. "marketplace": catalog stats — ' +
	'active listing count, price distribution normalised to USD + SOL at the live ' +
	'rate, new listings in the window, and the most-viewed / most-forked listing. ' +
	'All numbers are read live from the real ledgers and catalog tables.';

// Supported reports + period windows. Both are strict whitelists — a value
// outside the set is rejected BEFORE settlement (the buyer is never charged for
// a report we can't produce).
const REPORTS = new Set(['clubs', 'agent_leaderboard', 'marketplace', 'sniper_trades', 'user_activity', 'x402_volume']);

// period → window in seconds (null = all-time, no time filter).
// '6h' is a window the marketplace and sniper_trades reports resolve directly.
const PERIODS = {
	'1h': 3600,
	'6h': 21600,
	'24h': 86400,
	'7d': 604800,
	'30d': 2592000,
	all: null,
};

const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	properties: {
		report: {
			type: 'string',
			enum: ['clubs', 'agent_leaderboard', 'marketplace', 'sniper_trades', 'user_activity', 'x402_volume'],
			default: 'clubs',
			description: 'Which analytics report to return.',
		},
		period: {
			type: 'string',
			enum: ['1h', '6h', '24h', '7d', '30d', 'all'],
			default: '24h',
			description: 'Aggregation window (clubs, marketplace and sniper_trades reports).',
		},
		limit: {
			type: 'integer',
			minimum: 1,
			maximum: 100,
			default: 10,
			description: 'Max ranked agents to return (agent_leaderboard report).',
		},
		window_days: {
			type: 'integer',
			minimum: 1,
			maximum: 90,
			default: 7,
			description: 'Trailing window in days (agent_leaderboard report).',
		},
		network: {
			type: 'string',
			enum: ['mainnet', 'devnet', 'all'],
			default: 'mainnet',
			description: 'Network filter (sniper_trades report).',
		},
	},
};

const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['ok', 'report', 'period', 'generated_at', 'metrics'],
	properties: {
		ok: { type: 'boolean', const: true },
		report: { type: 'string', enum: ['clubs'] },
		period: { type: 'string' },
		generated_at: { type: 'string', format: 'date-time' },
		metrics: {
			type: 'object',
			required: ['active_clubs', 'total_clubs', 'members', 'tips', 'cover_charges'],
			properties: {
				active_clubs: { type: 'integer', minimum: 0, description: 'Stages that received a tip in the window.' },
				total_clubs: { type: 'integer', minimum: 0, description: 'Registered stages in the roster.' },
				members: { type: 'integer', minimum: 0, description: 'Distinct patron wallets active in the window.' },
				tips: {
					type: 'object',
					properties: {
						count: { type: 'integer', minimum: 0 },
						volume_atomics: { type: 'string' },
						volume_usdc: { type: 'number' },
					},
				},
				cover_charges: {
					type: 'object',
					properties: {
						count: { type: 'integer', minimum: 0 },
						atomics: { type: 'string' },
						usdc: { type: 'number' },
					},
				},
			},
		},
		top_clubs: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					dancer: { type: 'string' },
					display_name: { type: ['string', 'null'] },
					volume_atomics: { type: 'string' },
					volume_usdc: { type: 'number' },
					tips: { type: 'integer' },
				},
			},
		},
	},
};

const OUTPUT_EXAMPLE = {
	ok: true,
	report: 'clubs',
	period: '24h',
	generated_at: '2026-06-27T18:42:09.000Z',
	metrics: {
		active_clubs: 3,
		total_clubs: 4,
		members: 27,
		tips: { count: 41, volume_atomics: '410000', volume_usdc: 0.41 },
		cover_charges: { count: 12, atomics: '120000', usdc: 0.12 },
	},
	top_clubs: [
		{ dancer: '1', display_name: 'Nyx', volume_atomics: '190000', volume_usdc: 0.19, tips: 19 },
	],
};

const BAZAAR = {
	discoverable: true,
	description: DESCRIPTION,
	useCases: ['social analytics', 'club economy health', 'agent-to-agent payment'],
	input: { type: 'json', example: { report: 'clubs', period: '24h' }, schema: INPUT_SCHEMA },
	output: { type: 'json', example: OUTPUT_EXAMPLE },
	info: {
		input: { type: 'json', example: { report: 'clubs', period: '24h' } },
		output: { type: 'json', example: OUTPUT_EXAMPLE },
	},
	schema: buildBazaarSchema({
		method: 'POST',
		bodySchema: INPUT_SCHEMA,
		outputSchema: OUTPUT_SCHEMA,
	}),
};

export const BAZAAR_SCHEMA = BAZAAR;

const ROUTE_COVER = '/api/x402/club-cover';

const atomicsToUsd = (atomics) => Math.round((Number(atomics || 0) / 1e6) * 1e6) / 1e6;

// Read the request body without assuming a framework parsed it. Mirrors the
// crypto-intel idiom so this file works under the same raw-stream dispatch.
async function readBody(req) {
	if (req.body && typeof req.body === 'object') return req.body;
	try {
		const chunks = [await readRawBody(req, 1_000_000)];
		const raw = Buffer.concat(chunks).toString('utf8').trim();
		return raw ? JSON.parse(raw) : {};
	} catch {
		return {};
	}
}

// Each aggregate is read independently and fails soft to a zeroed shape, so one
// missing table (e.g. x402_audit_log not yet migrated in a fresh env) never
// blanks the whole report — the live tables still report real numbers.
//
// The window is a parameterized fragment over created_at; the seconds value is
// bound, never interpolated, so a hostile `period` can never inject SQL. null
// seconds → all-time. The top-clubs query joins club_dancer_wallets (which also
// has a created_at), so it needs the alias-qualified t.created_at variant.
async function clubsReport(seconds) {
	const tipsWindow =
		seconds == null ? sql`true` : sql`created_at >= now() - (${seconds}::int * interval '1 second')`;
	const auditWindow = tipsWindow; // x402_audit_log: single table, created_at unambiguous
	const topWindow =
		seconds == null ? sql`true` : sql`t.created_at >= now() - (${seconds}::int * interval '1 second')`;

	const [tips, roster, covers, topClubs] = await Promise.all([
		sql`
			select
				count(*)::int                              as tip_count,
				coalesce(sum(amount_atomics), 0)::text     as tip_volume_atomics,
				count(distinct lower(payer))::int          as members,
				count(distinct dancer)::int                as active_clubs
			from club_tips
			where ${tipsWindow}
		`.catch(() => [{}]),
		sql`select count(*)::int as total_clubs from club_dancer_wallets`.catch(() => [{}]),
		sql`
			select
				count(*)::int                              as cover_count,
				coalesce(sum(amount_atomics), 0)::text     as cover_atomics
			from x402_audit_log
			where route = ${ROUTE_COVER}
			  and event_type = 'payment_settled'
			  and settlement_status = 'success'
			  and ${auditWindow}
		`.catch(() => [{}]),
		sql`
			select
				t.dancer                                   as dancer,
				w.display_name                             as display_name,
				coalesce(sum(t.amount_atomics), 0)::text   as volume_atomics,
				count(*)::int                              as tips
			from club_tips t
			left join club_dancer_wallets w on w.dancer = t.dancer
			where ${topWindow}
			group by t.dancer, w.display_name
			order by sum(t.amount_atomics) desc nulls last, t.dancer asc
			limit 5
		`.catch(() => []),
	]);

	const tipRow = tips?.[0] || {};
	const coverRow = covers?.[0] || {};

	return {
		metrics: {
			active_clubs: tipRow.active_clubs ?? 0,
			total_clubs: roster?.[0]?.total_clubs ?? 0,
			members: tipRow.members ?? 0,
			tips: {
				count: tipRow.tip_count ?? 0,
				volume_atomics: tipRow.tip_volume_atomics ?? '0',
				volume_usdc: atomicsToUsd(tipRow.tip_volume_atomics),
			},
			cover_charges: {
				count: coverRow.cover_count ?? 0,
				atomics: coverRow.cover_atomics ?? '0',
				usdc: atomicsToUsd(coverRow.cover_atomics),
			},
		},
		top_clubs: (topClubs || []).map((r) => ({
			dancer: r.dancer,
			display_name: r.display_name ?? null,
			volume_atomics: r.volume_atomics ?? '0',
			volume_usdc: atomicsToUsd(r.volume_atomics),
			tips: r.tips ?? 0,
		})),
	};
}

function clampInt(v, { min, max, fallback }) {
	const n = Math.floor(Number(v));
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, n));
}

// Top agents by completed x402 spend (as the hiring/paying side) over a trailing
// window, read live from the real agent-to-agent hire ledger. `usd` is the human
// dollar value recorded at settle time; when absent we fall back to
// amount_atomics (USDC 6-decimal) so spend is never under-counted. window_days is
// bound, never interpolated. Returns the actionable shape partnership outreach
// consumes: the ranked agents with their hire counts + payout addresses.
async function agentLeaderboardReport(limit, windowDays) {
	const rows = await sql`
		select
			h.hirer_agent_id                                      as agent_id,
			coalesce(ai.name, 'Agent')                            as name,
			ai.meta->>'solana_address'                            as solana_address,
			sum(coalesce(h.usd, h.amount_atomics::numeric / 1e6)) as spend_usdc,
			count(*)::int                                         as hires,
			max(h.created_at)                                     as last_hire_at
		from agent_hires h
		left join agent_identities ai on ai.id = h.hirer_agent_id
		where h.status = 'completed'
		  and h.created_at >= now() - (${windowDays}::int * interval '1 day')
		group by h.hirer_agent_id, ai.name, ai.meta->>'solana_address'
		order by spend_usdc desc nulls last, last_hire_at desc
		limit ${limit}
	`.catch(() => []);

	const leaderboard = (rows || []).map((r, i) => ({
		rank: i + 1,
		agent_id: r.agent_id,
		name: r.name || 'Agent',
		solana_address: r.solana_address || null,
		spend_usdc: Number(Number(r.spend_usdc || 0).toFixed(6)),
		hires: Number(r.hires || 0),
		last_hire_at: r.last_hire_at instanceof Date
			? r.last_hire_at.toISOString()
			: (r.last_hire_at || null),
	}));

	const total_spend_usdc = Number(
		leaderboard.reduce((s, a) => s + a.spend_usdc, 0).toFixed(6),
	);

	return {
		agent_count: leaderboard.length,
		total_spend_usdc,
		leaderboard,
	};
}

// Auto-named / stub agent names excluded from the public marketplace listing
// count — kept in sync with api/marketplace/[action].js so the numbers match
// exactly what a visitor browsing /marketplace sees.
const AGENT_AUTONAMED_RE =
	'^(Agent|My Agent|My First Agent|Demo Agent|Untitled.*|TEST|Test|test|mo[a-z0-9]{4,}|draft-[a-z0-9]+|new_project_[0-9]+|Avatar[ ]*#[0-9a-f]{4,}([ ]*agent)?|https?://.+)$';

// Mints we can normalise to USD at query time. Lookups compare against a
// lower-cased mint, so the sets are normalised at construction rather than by
// hand: a hand-lowered literal drifted (one entry kept its mixed-case tail),
// which silently made every Solana-priced listing unpriceable and dropped it
// out of the marketplace report's USD average. Display form is preserved
// per-row via currencyLabel().
const lowerSet = (mints) => new Set(mints.map((m) => m.toLowerCase()));
const USDC_MINTS = lowerSet([
	'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // Solana mainnet USDC
	'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',   // Base USDC
]);
const SOL_MINTS = lowerSet(['native', 'So11111111111111111111111111111111111111112']);

function currencyLabel(mint) {
	const m = String(mint || '').toLowerCase();
	if (USDC_MINTS.has(m)) return 'USDC';
	if (SOL_MINTS.has(m)) return 'SOL';
	return mint && mint.length > 10 ? `${mint.slice(0, 4)}…${mint.slice(-4)}` : String(mint || 'unknown');
}

// Exported for the currency-normalisation contract test: the marketplace
// report's USD maths is only correct while every mint in these sets matches a
// lower-cased lookup.
export const __test__ = { USDC_MINTS, SOL_MINTS, currencyLabel };

function roundNum(n, dp) {
	if (n == null || !Number.isFinite(Number(n))) return null;
	const f = 10 ** dp;
	return Math.round(Number(n) * f) / f;
}

// Marketplace catalog stats for the public agent marketplace.
// seconds: null → all-time for new_in_period; integer → published_at window.
async function marketplaceReport(seconds) {
	const publishWindow =
		seconds == null ? sql`true` : sql`ai.published_at >= now() - (${seconds}::int * interval '1 second')`;

	const [[summary], priceRows, [mostViewed], [mostForked]] = await Promise.all([
		sql`
			SELECT
				COUNT(*)::int AS listing_count,
				COUNT(*) FILTER (WHERE ${publishWindow})::int AS new_in_period,
				COALESCE(SUM(ai.views_count), 0)::bigint AS total_views,
				COALESCE(SUM(ai.forks_count), 0)::bigint AS total_forks
			FROM agent_identities ai
			WHERE ai.is_published = true
			  AND ai.deleted_at IS NULL
			  AND ai.name !~* ${AGENT_AUTONAMED_RE}
		`.catch(() => [{}]),
		sql`
			SELECT
				ap.currency_mint,
				ap.mint_decimals,
				ap.chain,
				COUNT(*)::int           AS cnt,
				SUM(ap.amount)::numeric AS sum_amount,
				MIN(ap.amount)::numeric AS min_amount,
				MAX(ap.amount)::numeric AS max_amount
			FROM asset_prices ap
			JOIN agent_identities ai ON ai.id = ap.item_id
			WHERE ap.item_type = 'agent'
			  AND ap.is_active = true
			  AND ai.is_published = true
			  AND ai.deleted_at IS NULL
			  AND ai.name !~* ${AGENT_AUTONAMED_RE}
			GROUP BY ap.currency_mint, ap.mint_decimals, ap.chain
			ORDER BY cnt DESC
		`.catch(() => []),
		sql`
			SELECT id, name, category, COALESCE(views_count, 0)::int AS views_count
			FROM agent_identities
			WHERE is_published = true AND deleted_at IS NULL AND name !~* ${AGENT_AUTONAMED_RE}
			ORDER BY views_count DESC NULLS LAST LIMIT 1
		`.catch(() => [null]),
		sql`
			SELECT id, name, category, COALESCE(forks_count, 0)::int AS forks_count
			FROM agent_identities
			WHERE is_published = true AND deleted_at IS NULL AND name !~* ${AGENT_AUTONAMED_RE}
			ORDER BY forks_count DESC NULLS LAST LIMIT 1
		`.catch(() => [null]),
	]);

	// SOL/USD for price normalisation — fail-soft; SOL listings omitted from the
	// USD average if the price oracle is transiently unavailable.
	let solUsd = null;
	try { solUsd = await solUsdPrice(); } catch { /* decoration only */ }

	let pricedCount = 0;
	let totalUsd = 0;
	let minUsd = null;
	let maxUsd = null;

	const byCurrency = (priceRows || []).map((r) => {
		const decimals = Number(r.mint_decimals ?? 6);
		const scale = 10 ** decimals;
		const cnt = Number(r.cnt);
		const m = String(r.currency_mint || '').toLowerCase();
		const isUsdc = USDC_MINTS.has(m);
		const isSol = SOL_MINTS.has(m);
		const rate = isUsdc ? 1 : (isSol && solUsd ? solUsd : null);
		const avgHuman = Number(r.sum_amount) / cnt / scale;

		if (rate != null) {
			pricedCount += cnt;
			totalUsd += (Number(r.sum_amount) / scale) * rate;
			const lo = (Number(r.min_amount) / scale) * rate;
			const hi = (Number(r.max_amount) / scale) * rate;
			minUsd = minUsd == null ? lo : Math.min(minUsd, lo);
			maxUsd = maxUsd == null ? hi : Math.max(maxUsd, hi);
		}

		return {
			currency: currencyLabel(r.currency_mint),
			currency_mint: r.currency_mint,
			chain: r.chain,
			count: cnt,
			avg_price: roundNum(avgHuman, 6),
			priceable: rate != null,
		};
	});

	const totalPriced = byCurrency.reduce((n, c) => n + c.count, 0);
	const avgUsd = pricedCount > 0 ? totalUsd / pricedCount : null;
	const avgSol = avgUsd != null && solUsd ? avgUsd / solUsd : null;
	const listingCount = Number(summary?.listing_count ?? 0);

	return {
		catalog: {
			listing_count: listingCount,
			priced_listings: totalPriced,
			free_listings: Math.max(0, listingCount - totalPriced),
			new_in_period: Number(summary?.new_in_period ?? 0),
		},
		pricing: {
			avg_price_usd: roundNum(avgUsd, 4),
			avg_price_sol: roundNum(avgSol, 6),
			min_price_usd: roundNum(minUsd, 4),
			max_price_usd: roundNum(maxUsd, 4),
			priceable_count: pricedCount,
			sol_usd_price: roundNum(solUsd, 2),
			by_currency: byCurrency,
		},
		engagement: {
			total_views: Number(summary?.total_views ?? 0),
			total_forks: Number(summary?.total_forks ?? 0),
			most_viewed_id: mostViewed?.id ?? null,
			most_viewed_name: mostViewed?.name ?? null,
			most_viewed_count: mostViewed ? Number(mostViewed.views_count) : 0,
			most_forked_id: mostForked?.id ?? null,
			most_forked_name: mostForked?.name ?? null,
			most_forked_count: mostForked ? Number(mostForked.forks_count) : 0,
		},
	};
}


// Aggregate closed positions from the autonomous sniper's real trade ledger.
// All SOL amounts are stored as lamports (numeric(40,0)); we aggregate in SQL to
// keep bigint precision before dividing. interval is a Postgres interval literal
// (e.g. '24 hours'); null means all-time (no time filter). network is 'mainnet',
// 'devnet', or 'all'. Parameters are bound — never interpolated.
const PERIOD_INTERVALS = {
	'1h': '1 hour',
	'6h': '6 hours',
	'24h': '24 hours',
	'7d': '7 days',
	'30d': '30 days',
	all: null,
};
const NETWORKS_SNIPER = new Set(['mainnet', 'devnet', 'all']);

async function sniperTradesReport({ interval, network, period }) {
	const networkClause =
		network && network !== 'all' ? sql`AND network = ${network}` : sql``;
	const periodClause =
		interval ? sql`AND closed_at >= now() - ${interval}::interval` : sql``;

	const [row] = await sql`
		SELECT
			COUNT(*)                                                       AS closed,
			COUNT(*) FILTER (WHERE realized_pnl_lamports > 0)              AS wins,
			COUNT(*) FILTER (WHERE realized_pnl_lamports < 0)              AS losses,
			COUNT(*) FILTER (WHERE realized_pnl_lamports = 0)              AS breakeven,
			COALESCE(SUM(entry_quote_lamports), 0)                         AS volume_lamports,
			COALESCE(SUM(realized_pnl_lamports), 0)                        AS total_pnl_lamports,
			COALESCE(AVG(realized_pnl_lamports), 0)                        AS avg_pnl_lamports,
			COALESCE(MIN(realized_pnl_lamports), 0)                        AS worst_loss_lamports,
			COALESCE(MAX(realized_pnl_lamports), 0)                        AS best_win_lamports,
			COALESCE(AVG(realized_pnl_pct), 0)                             AS avg_pnl_pct
		FROM agent_sniper_positions
		WHERE status = 'closed'
		  AND realized_pnl_lamports IS NOT NULL
		  ${periodClause}
		  ${networkClause}
	`.catch(() => [{}]);

	let solUsd = null;
	try { solUsd = await solUsdPrice(); } catch { solUsd = null; }

	const result = buildSniperAnalytics(row || {}, {
		solUsd,
		period,
		network: network || 'mainnet',
		report: 'sniper_trades',
		generatedAt: new Date().toISOString(),
	});

	return { ok: true, ...result };
}

// How many of the least-active endpoints to surface as the "underused" signal.
const UNDERUSED_LIMIT = 5;

// x402 transaction volume across every endpoint over the window, read live from
// the durable settled-payment ledger (x402_audit_log via getPaymentStats — the
// same ledger the admin analytics dashboard reads). Returns total settled calls,
// total USDC paid, unique payers, the per-endpoint breakdown, and the
// least-active endpoints (the actionable "underused" signal for surfacing
// endpoints to promote, investigate, or retire). `seconds` null → all-time.
async function volumeReport(seconds) {
	const since = seconds == null ? null : new Date(Date.now() - seconds * 1000).toISOString();
	const stats = await getPaymentStats({ since });

	const byEndpoint = (stats.by_route || [])
		.filter((r) => r.route)
		.map((r) => ({ route: r.route, count: r.count, volume: r.volume }));

	// Ascending by settled-call count, ties broken by lower volume.
	const underused = [...byEndpoint]
		.sort((a, b) => a.count - b.count || Number(a.volume) - Number(b.volume))
		.slice(0, UNDERUSED_LIMIT);

	// The totals above are GROSS: they include the x402 ring, the closed
	// dogfooding loop in which platform-controlled wallets pay platform
	// endpoints on a cron. That traffic is the overwhelming majority of settled
	// volume, so a buyer reading total_usdc_paid as "three.ws revenue" would be
	// reading our own money back to us. `revenue_split` states which share is
	// external, and folds a soft failure to null rather than guessing, because a
	// missing split is honest where a fabricated one is not.
	const revenueSplitBlock = await buildRevenueSplit(since);

	return {
		total_calls: stats.total_payments || 0,
		total_usdc_paid: stats.total_volume_usdc || '0.000000',
		unique_payers: stats.unique_payers || 0,
		total_failed: stats.total_failed || 0,
		avg_payment_usdc: stats.avg_payment_usdc || '0.000000',
		endpoint_count: byEndpoint.length,
		by_endpoint: byEndpoint,
		by_network: stats.by_network || [],
		underused_endpoints: underused,
		revenue_split: revenueSplitBlock,
	};
}

// Compact the full split (api/_lib/x402/revenue-split.js) down to what a paid
// buyer needs: the three buckets and whether the classification is trustworthy.
// Route-level external attribution stays internal to the readout script; it
// names the endpoints our few real buyers touched, which is our commercial
// detail rather than the buyer's.
async function buildRevenueSplit(since) {
	try {
		const split = await revenueSplit({ since });
		const bucket = (b) => ({
			calls: b.calls,
			volume_usdc: b.volume_usdc,
			unique_payers: b.unique_payers,
			share_of_calls: b.share_of_calls,
		});
		return {
			confident: split.confident,
			confidence_note: split.confidence_note,
			external: bucket(split.external),
			internal_ring: bucket(split.internal),
			synthetic: bucket(split.synthetic),
		};
	} catch {
		// A split we cannot compute is reported as absent. The gross totals above
		// remain accurate on their own terms; what is unavailable is the
		// interpretation, and inventing one is the failure mode this guards.
		return null;
	}
}

export default paidEndpoint({
	route: ROUTE,
	method: 'POST',
	priceAtomics: priceFor('analytics', '5000'), // $0.005 USDC
	networks: ['solana', 'base'],
	description: DESCRIPTION,
	bazaar: BAZAAR,
	service: withService({
		serviceName: 'three.ws Social Analytics',
		tags: ['analytics', 'club', 'social', 'metrics', 'solana'],
	}),
	accessControl: installAccessControl({ requiredScope: 'x402:bypass' }),

	async handler({ req }) {
		const body = await readBody(req);
		const report = String(body.report || 'clubs').toLowerCase().trim();
		const period = String(body.period || '24h').toLowerCase().trim();

		// Validate BEFORE returning — a throw here lands before settlement, so an
		// unsupported report/period is rejected without charging the buyer.
		if (!REPORTS.has(report)) {
			throw Object.assign(new Error(`unknown report "${report}" — supported: ${[...REPORTS].join(', ')}`), {
				status: 400,
				code: 'unknown_report',
			});
		}
		if (!(period in PERIODS)) {
			throw Object.assign(new Error(`unknown period "${period}" — supported: ${Object.keys(PERIODS).join(', ')}`), {
				status: 400,
				code: 'unknown_period',
			});
		}

		// ── Agent leaderboard — top spenders from the hire ledger. ──────────────
		if (report === 'agent_leaderboard') {
			const limit = clampInt(body.limit, { min: 1, max: 100, fallback: 10 });
			const windowDays = clampInt(body.window_days, { min: 1, max: 90, fallback: 7 });
			const data = await agentLeaderboardReport(limit, windowDays);
			return {
				ok: true,
				report,
				period,
				generated_at: new Date().toISOString(),
				...data,
			};
		}

		// ── Marketplace report — live catalog stats for the public agent market. ──
		if (report === 'marketplace') {
			const seconds = PERIODS[period];
			const data = await marketplaceReport(seconds);
			return {
				ok: true,
				report,
				period,
				generated_at: new Date().toISOString(),
				...data,
			};
		}

		// ── Sniper trades report — autonomous sniper performance from real ledger. ──
		if (report === 'sniper_trades') {
			const network = NETWORKS_SNIPER.has(body.network) ? body.network : 'mainnet';
			return sniperTradesReport({
				interval: PERIOD_INTERVALS[period],
				network,
				period,
			});
		}


		// ── User activity — DAU/WAU/stickiness, top features, session lengths. ──
		if (report === 'user_activity') {
			// normalizePeriod maps to usage_events query windows (24h, 7d, 30d);
			// unsupported values like 1h/6h/all fall back to 7d.
			const activityPeriod = normalizePeriod(period);
			let data;
			try {
				data = await computeUserActivity(sql, activityPeriod);
			} catch (err) {
				throw Object.assign(new Error('analytics store is temporarily unavailable'), {
					status: 503,
					code: 'data_unavailable',
					cause: err,
				});
			}
			return data;
		}

		// ── x402 volume — transaction volume across every endpoint. ─────────────
		if (report === 'x402_volume') {
			const seconds = PERIODS[period];
			const data = await volumeReport(seconds);
			return {
				ok: true,
				report,
				period,
				generated_at: new Date().toISOString(),
				...data,
			};
		}

		// ── Clubs report (default) — Pole Club social economy. ──────────────────
		const seconds = PERIODS[period];
		const { metrics, top_clubs } = await clubsReport(seconds);

		return {
			ok: true,
			report,
			period,
			generated_at: new Date().toISOString(),
			metrics,
			top_clubs,
		};
	},
});
