// POST /api/agents/balances — batched, real on-chain wallet valuation for the
// wallet identity layer.
//
// The wallet chip appears in dense lists (trending rows, galaxy cards, the
// marketplace grid). Firing GET /:id/solana + /holdings per row would be an
// N×3 request storm. This endpoint takes an array of agent ids and returns one
// real, cached portfolio descriptor per wallet in a single round-trip, so a list
// hydrates its visible chips with exactly one request.
//
// Every number is real: balances come from the shared on-chain valuation library
// (Helius DAS → public-RPC fallback, Jupiter/pump.fun pricing), cached 60s. The
// 24h P&L + sparkline are derived from real periodic value snapshots persisted in
// wallet_value_snapshots — never a synthesized curve. A wallet with no snapshot
// history yet returns an empty sparkline (the UI renders its empty state), and if
// the snapshot table is absent the balances still return with P&L simply null.
//
// Public read: balances are public on-chain data, so no auth is required. When a
// session is present each entry is marked is_owner so the caller can render the
// "Yours" vs creator-attribution marker without trusting a client-supplied flag.

import { sql, sqlValues } from '../_lib/db.js';
import { wrap, cors, json, method, error, readJson, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { getSessionUser } from '../_lib/auth.js';
import { isUuid } from '../_lib/validate.js';
import { getBalances, walletUsdTotal } from '../_lib/balances.js';
import { env } from '../_lib/env.js';

const MAX_IDS = 60;
const FETCH_CONCURRENCY = 8;
// Don't write more than one snapshot per wallet per this interval — browsing a
// list shouldn't spam the series. 5 min keeps the sparkline dense enough for a
// readable curve without bloating the table.
const SNAPSHOT_MIN_GAP_MS = 5 * 60_000;
// Sparkline window. Snapshots older than this are ignored for both the curve and
// the change reference, and a retention sweep can prune past it.
const PNL_WINDOW_HOURS = 24;
const SPARKLINE_MAX_POINTS = 24;

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Map a unique list through an async fn with a fixed concurrency ceiling so a
// 60-id batch never opens 60 simultaneous RPC sockets.
async function mapPool(items, limit, fn) {
	const out = new Array(items.length);
	let i = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (i < items.length) {
			const idx = i++;
			out[idx] = await fn(items[idx], idx);
		}
	});
	await Promise.all(workers);
	return out;
}

// Reduce a full portfolio (native SOL + every priced token) into the compact
// descriptor the chip + popover render: total USD, the SOL / USDC / $THREE
// breakdown, a token count, and the top holdings by USD value.
function summarizePortfolio(portfolio, threeMint) {
	const tokens = Array.isArray(portfolio?.tokens) ? portfolio.tokens : [];
	const native = portfolio?.native || null;
	const usd = walletUsdTotal(portfolio);

	const findToken = (mint) => tokens.find((t) => t.mint === mint) || null;
	const usdc = findToken(USDC_MINT);
	const three = threeMint ? findToken(threeMint) : null;

	const topHoldings = tokens
		.slice()
		.sort((a, b) => (b.usd || 0) - (a.usd || 0))
		.slice(0, 4)
		.map((t) => ({
			mint: t.mint,
			symbol: t.symbol,
			amount: t.amount,
			usd: t.usd || 0,
			price: t.price || 0,
			logo: t.logo || null,
		}));

	return {
		usd,
		sol: {
			amount: native?.amount ?? 0,
			usd: native?.usd ?? 0,
			price: native?.price ?? 0,
		},
		usdc: usdc ? { amount: usdc.amount, usd: usdc.usd || 0 } : { amount: 0, usd: 0 },
		three: three ? { amount: three.amount, usd: three.usd || 0, price: three.price || 0 } : null,
		tokenCount: tokens.length,
		topHoldings,
	};
}

// Build the { sparkline, changePct, changeUsd, windowHours } block from a real
// ascending value series (snapshots within the window, plus the just-captured
// point). Honest by construction: with <2 points there is no curve, so we return
// an empty sparkline and null change rather than inventing a baseline.
function derivePnl(series) {
	if (!Array.isArray(series) || series.length < 2) {
		return { sparkline: series?.map((s) => s.usd) || [], changePct: null, changeUsd: null, windowHours: null };
	}
	const first = series[0];
	const last = series[series.length - 1];
	const changeUsd = last.usd - first.usd;
	const changePct = first.usd > 0 ? (changeUsd / first.usd) * 100 : null;
	const windowHours = (new Date(last.capturedAt).getTime() - new Date(first.capturedAt).getTime()) / 3_600_000;

	// Downsample to a fixed point budget so a long series stays a tidy payload.
	let points = series.map((s) => s.usd);
	if (points.length > SPARKLINE_MAX_POINTS) {
		const step = points.length / SPARKLINE_MAX_POINTS;
		points = Array.from({ length: SPARKLINE_MAX_POINTS }, (_, k) => points[Math.floor(k * step)]);
		points[points.length - 1] = last.usd;
	}
	return {
		sparkline: points,
		changePct: changePct == null ? null : Number(changePct.toFixed(2)),
		changeUsd: Number(changeUsd.toFixed(2)),
		windowHours: Number(windowHours.toFixed(1)),
	};
}

// Load each agent's snapshot series within the window, append the freshly-valued
// point (and persist it, deduped), all wrapped so a missing table degrades to
// "no P&L" rather than failing the whole balance read.
async function attachPnl(entries) {
	const withAddr = entries.filter((e) => e.address && Number.isFinite(e.summary?.usd));
	if (withAddr.length === 0) return;
	const agentIds = withAddr.map((e) => e.agentId);

	let seriesByAgent = new Map();
	try {
		const rows = await sql`
			SELECT agent_id, usd_value, captured_at
			FROM wallet_value_snapshots
			WHERE agent_id = ANY(${agentIds}::uuid[])
			  AND captured_at > now() - (${PNL_WINDOW_HOURS} || ' hours')::interval
			ORDER BY agent_id, captured_at ASC
		`;
		for (const r of rows) {
			const list = seriesByAgent.get(r.agent_id) || [];
			list.push({ usd: Number(r.usd_value), capturedAt: r.captured_at });
			seriesByAgent.set(r.agent_id, list);
		}
	} catch {
		// Snapshot table not present (un-migrated env) — balances still return,
		// P&L is simply absent. Don't attempt inserts either.
		for (const e of withAddr) e.pnl = { sparkline: [], changePct: null, changeUsd: null, windowHours: null };
		return;
	}

	const now = Date.now();
	const toInsert = [];
	for (const e of withAddr) {
		const series = seriesByAgent.get(e.agentId) || [];
		const latest = series[series.length - 1];
		const stale = !latest || now - new Date(latest.capturedAt).getTime() >= SNAPSHOT_MIN_GAP_MS;
		if (stale) {
			const point = { usd: Number(e.summary.usd.toFixed(6)), capturedAt: new Date(now).toISOString() };
			series.push(point);
			toInsert.push(e);
		}
		e.pnl = derivePnl(series);
	}

	if (toInsert.length > 0) {
		// One multi-row insert for every wallet that needed a fresh point.
		try {
			const rows = toInsert.map((e) => [
				e.agentId,
				e.address,
				Number(e.summary.usd.toFixed(6)),
				Number((e.summary.sol?.amount ?? 0).toFixed(9)),
			]);
			await sql`
				INSERT INTO wallet_value_snapshots (agent_id, address, usd_value, sol_amount)
				VALUES ${sqlValues(rows)}
			`;
		} catch {
			// Persist is best-effort; the in-memory point still feeds this response.
		}
	}
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	// getSessionUser returns the user row, so the id lives on `.id` (not `.userId`).
	const auth = await getSessionUser(req).catch(() => null);
	const rl = await limits.walletRead(auth?.id || clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const body = await readJson(req).catch(() => null);
	const rawIds = Array.isArray(body?.ids) ? body.ids : null;
	if (!rawIds) return error(res, 400, 'validation_error', 'body.ids must be an array of agent ids');

	const ids = [...new Set(rawIds.filter((x) => typeof x === 'string' && isUuid(x)))].slice(0, MAX_IDS);
	if (ids.length === 0) return json(res, 200, { data: {} });

	const rows = await sql`
		SELECT id, user_id, meta
		FROM agent_identities
		WHERE id = ANY(${ids}) AND deleted_at IS NULL
	`;

	const threeMint = env.THREE_TOKEN_MINT;
	const entries = rows.map((row) => ({
		agentId: row.id,
		address: row.meta?.solana_address || null,
		isOwner: !!(auth && row.user_id === auth.id),
		ownerId: row.user_id,
		forkedFrom: row.meta?.forked_from || null,
		summary: null,
		pnl: null,
	}));

	// Value unique addresses once (two agents can't share a custodial wallet, but
	// dedupe defensively) under a concurrency ceiling.
	const valued = entries.filter((e) => e.address);
	await mapPool(valued, FETCH_CONCURRENCY, async (e) => {
		try {
			const portfolio = await getBalances({ chain: 'solana', address: e.address });
			e.summary = summarizePortfolio(portfolio, threeMint);
		} catch {
			// One wallet's RPC failure must not blank the batch — mark it unpriced.
			e.summary = null;
		}
	});

	await attachPnl(entries);

	const data = {};
	for (const e of entries) {
		data[e.agentId] = {
			agentId: e.agentId,
			address: e.address,
			isOwner: e.isOwner,
			forkedFrom: e.forkedFrom,
			...(e.summary
				? {
						usd: e.summary.usd,
						sol: e.summary.sol,
						usdc: e.summary.usdc,
						three: e.summary.three,
						tokenCount: e.summary.tokenCount,
						topHoldings: e.summary.topHoldings,
						pnl: e.pnl,
					}
				: { usd: null, priced: false }),
		};
	}

	return json(res, 200, { data });
});
