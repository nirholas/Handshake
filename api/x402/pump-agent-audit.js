// INTERNAL-USE ONLY; not an agent product. De-listed from the x402 discovery
// catalog (api/wk.js) in the 2026-07 overhaul: the /play town NPC sells it; the agent-facing read is the free /api/crypto/whales + /api/crypto/security.
// The route stays live for those consumers; do not re-add it to the catalog.
// /api/x402/pump-agent-audit
//
// Two HTTP methods:
//   GET  — audit a single pump.fun agent-payments token or list recent launches
//   POST — whale wallet activity oracle (mode:"whale_activity")
//
// GET: For $0.02 USDC the server audits a pump.fun agent-payments token:
// total acceptPayment volume in, distribute/buyback success/failure history,
// recent failure errors, and risk flags. Also supports list mode (omit mint)
// for the live bonding-curve launch feed with per-launch initial liquidity.
//
// POST (mode:"whale_activity"): For $0.02 USDC, identifies the top whale
// wallets active on pump.fun right now (wallets that bought ≥5 SOL across
// any coin in the last sweep). Returns { wallets, total_sol_moved } plus a
// bullish/bearish/neutral signal so the sniper gate can avoid front-running
// and confirm genuine large-buyer interest before committing.

import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { installAccessControl } from '../_lib/x402/access-control.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { sql } from '../_lib/db.js';
import { priceFor } from '../_lib/x402-prices.js';
import { recentPumpLaunches } from '../_lib/pump-launch-feed.js';
import { readBody } from '../_lib/http.js';
import { pumpFetchJson } from '../_lib/pump-feed-fetch.js';

const ROUTE = '/api/x402/pump-agent-audit';

const DESCRIPTION =
	'three.ws Pump-Agent Audit — two modes. SINGLE (pass ?mint=<spl-mint>): a ' +
	'full operational audit of one pump.fun agent-payments token — total USDC ' +
	'paid in, unique payer count, distribute run history with success/failure ' +
	'breakdown, buyback runs with burn totals, recent error reasons, and risk ' +
	'flags ("never distributed", "high failure rate"). LIST (omit mint, pass ' +
	'?limit=&sort=newest|liquidity): the N most-recently launched pump.fun ' +
	'tokens (live bonding-curve feed) with each one\'s initial SOL liquidity, ' +
	'market cap and whether it is a three.ws agent-payments token, plus the ' +
	'cohort\'s average/peak initial liquidity. Use SINGLE to evaluate ' +
	'counterparty risk before trading; use LIST to screen fresh launches for ' +
	'snipe candidates.';

const INPUT_EXAMPLE = { mint: 'C3vQABCDEFGHJKLMNopqrstuvwxyZ12345abcdefghi' };

const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	// `mint` selects SINGLE mode; omitting it selects LIST mode. Neither field is
	// unconditionally required, so the schema documents both inputs without
	// forcing a mint on the list path.
	properties: {
		mint: {
			type: 'string',
			description: 'Solana SPL mint pubkey (base58). Present → single-mint audit.',
		},
		limit: {
			type: 'integer',
			minimum: 1,
			maximum: 25,
			description: 'LIST mode: number of recent launches to return (default 10).',
		},
		sort: {
			type: 'string',
			enum: ['newest', 'liquidity'],
			description: 'LIST mode: order — newest-first (default) or by initial liquidity.',
		},
	},
};

// LIST mode example (omit mint → recent launches)
const OUTPUT_EXAMPLE_LIST = {
	network: 'mainnet',
	sort: 'newest',
	count: 2,
	newest_mint: 'AbcDEFGHJKLMNopqrstuvwxyZ12345abcdefghi1234',
	newest_name: 'PepeGo',
	newest_symbol: 'PEPEGO',
	avg_initial_liquidity_sol: 28.4,
	max_initial_liquidity_sol: 45.1,
	launches: [
		{
			mint: 'AbcDEFGHJKLMNopqrstuvwxyZ12345abcdefghi1234',
			name: 'PepeGo',
			symbol: 'PEPEGO',
			created_at: 1748908800000,
			market_cap_usd: 6500,
			liquidity_sol: 45.1,
			creator: '5oo1g...',
			twitter: null,
			telegram: null,
			website: null,
			is_agent_token: false,
		},
	],
	queried_at: '2026-05-14T17:00:00Z',
};

// SINGLE mode example (pass ?mint=)
const OUTPUT_EXAMPLE = {
	mint: 'C3vQABCDEFGHJKLMNopqrstuvwxyZ12345abcdefghi',
	network: 'mainnet',
	name: 'Helios',
	symbol: 'HELIO',
	agent_id: '7b9a4f30-2d11-4e2d-9d12-1cdb1f6a3a55',
	pump_agent_pda: 'PdaABC...',
	deployed_at: '2026-04-30T14:08:22Z',
	payments: {
		total_in_atomics: '142000000',
		confirmed_count: 142,
		failed_count: 3,
		pending_count: 1,
		distinct_payers: 87,
		first_payment_at: '2026-04-30T14:30:00Z',
		latest_payment_at: '2026-05-14T16:45:00Z',
	},
	distributions: {
		confirmed: 12,
		failed: 1,
		pending: 0,
		latest_run_at: '2026-05-14T12:00:00Z',
		latest_status: 'confirmed',
		latest_error: null,
	},
	buybacks: {
		confirmed: 5,
		failed: 0,
		total_burn_atomics: '500000000',
		latest_run_at: '2026-05-13T22:00:00Z',
	},
	risk_flags: [],
	indexed_at: '2026-05-14T17:00:00Z',
};

const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	oneOf: [
		{
			title: 'List mode',
			type: 'object',
			required: ['count', 'launches', 'queried_at'],
			properties: {
				network: { type: 'string' },
				sort: { type: 'string' },
				count: { type: 'integer' },
				newest_mint: { type: ['string', 'null'] },
				newest_name: { type: ['string', 'null'] },
				newest_symbol: { type: ['string', 'null'] },
				avg_initial_liquidity_sol: { type: ['number', 'null'] },
				max_initial_liquidity_sol: { type: ['number', 'null'] },
				launches: { type: 'array', items: { type: 'object' } },
				queried_at: { type: 'string', format: 'date-time' },
			},
		},
		{
			title: 'Single mode',
			type: 'object',
			required: ['mint', 'payments', 'distributions', 'buybacks', 'risk_flags'],
			properties: {
				mint: { type: 'string' },
				network: { type: ['string', 'null'] },
				name: { type: ['string', 'null'] },
				symbol: { type: ['string', 'null'] },
				agent_id: { type: ['string', 'null'] },
				pump_agent_pda: { type: ['string', 'null'] },
				deployed_at: { type: ['string', 'null'] },
				payments: { type: 'object' },
				distributions: { type: 'object' },
				buybacks: { type: 'object' },
				risk_flags: { type: 'array', items: { type: 'string' } },
				indexed_at: { type: 'string', format: 'date-time' },
			},
		},
	],
};

const BAZAAR = {
	// De-listed per the 2026-07-08 storefront cleanup (prompt 18) — the paid
	// "oracle" framing over-claims what a payments-history audit actually is; a
	// free whale surface (/api/crypto/whales) replaces it as the agent product.
	// Route stays live for the /play town NPC.
	discoverable: false,
	info: {
		input: {
			type: 'http',
			method: 'GET',
			// Show list-mode query params as the primary example (common caller path)
			queryParams: { limit: 10, sort: 'newest' },
		},
		output: { type: 'json', example: OUTPUT_EXAMPLE_LIST },
	},
	schema: buildBazaarSchema({
		method: 'GET',
		queryParamsSchema: INPUT_SCHEMA,
		outputSchema: OUTPUT_SCHEMA,
	}),
};

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function deriveRiskFlags({ payments, distributions, buybacks }) {
	const flags = [];
	if (payments.confirmed_count >= 5 && distributions.confirmed === 0) {
		flags.push('never_distributed');
	}
	const distribTotal = distributions.confirmed + distributions.failed;
	if (distribTotal >= 3 && distributions.failed / distribTotal > 0.3) {
		flags.push('high_distribute_failure_rate');
	}
	const payTotal = payments.confirmed_count + payments.failed_count;
	if (payTotal >= 10 && payments.failed_count / payTotal > 0.2) {
		flags.push('high_payment_failure_rate');
	}
	if (payments.confirmed_count >= 20 && buybacks.confirmed === 0) {
		flags.push('no_buybacks_run');
	}
	return flags;
}

async function loadAudit(mint) {
	const [mintRow] = await sql`
		select id, mint, network, name, symbol, agent_id, pump_agent_pda, created_at
		  from pump_agent_mints
		 where mint = ${mint}
		 order by created_at desc
		 limit 1
	`;
	if (!mintRow) {
		const err = new Error('mint not found in pump_agent_mints index');
		err.status = 404;
		err.code = 'mint_not_found';
		throw err;
	}

	const mintId = mintRow.id;
	const [payRow] = await sql`
		select
			coalesce(sum(case when status = 'confirmed' then amount_atomics else 0 end), 0)::text
				as total_in,
			count(*) filter (where status = 'confirmed')::int as confirmed_count,
			count(*) filter (where status = 'failed')::int    as failed_count,
			count(*) filter (where status = 'pending')::int   as pending_count,
			count(distinct case when status = 'confirmed' then payer_wallet end)::int
				as distinct_payers,
			min(case when status = 'confirmed' then created_at end) as first_payment_at,
			max(case when status = 'confirmed' then created_at end) as latest_payment_at
		  from pump_agent_payments
		 where mint_id = ${mintId}
	`;

	const [distAggRow] = await sql`
		select
			count(*) filter (where status = 'confirmed')::int as confirmed,
			count(*) filter (where status = 'failed')::int    as failed,
			count(*) filter (where status = 'pending')::int   as pending
		  from pump_distribute_runs
		 where mint_id = ${mintId}
	`;
	const [distLatestRow] = await sql`
		select status, error, created_at
		  from pump_distribute_runs
		 where mint_id = ${mintId}
		 order by created_at desc
		 limit 1
	`;

	const [buyRow] = await sql`
		select
			count(*) filter (where status = 'confirmed')::int as confirmed,
			count(*) filter (where status = 'failed')::int    as failed,
			coalesce(sum(case when status = 'confirmed' then burn_amount else 0 end), 0)::text
				as total_burn,
			max(case when status = 'confirmed' then created_at end) as latest_run_at
		  from pump_buyback_runs
		 where mint_id = ${mintId}
	`;

	const payments = {
		total_in_atomics: payRow.total_in,
		confirmed_count: payRow.confirmed_count,
		failed_count: payRow.failed_count,
		pending_count: payRow.pending_count,
		distinct_payers: payRow.distinct_payers,
		first_payment_at: payRow.first_payment_at
			? new Date(payRow.first_payment_at).toISOString()
			: null,
		latest_payment_at: payRow.latest_payment_at
			? new Date(payRow.latest_payment_at).toISOString()
			: null,
	};
	const distributions = {
		confirmed: distAggRow.confirmed,
		failed: distAggRow.failed,
		pending: distAggRow.pending,
		latest_run_at: distLatestRow?.created_at
			? new Date(distLatestRow.created_at).toISOString()
			: null,
		latest_status: distLatestRow?.status || null,
		latest_error: distLatestRow?.error || null,
	};
	const buybacks = {
		confirmed: buyRow.confirmed,
		failed: buyRow.failed,
		total_burn_atomics: buyRow.total_burn,
		latest_run_at: buyRow.latest_run_at ? new Date(buyRow.latest_run_at).toISOString() : null,
	};

	return {
		mint: mintRow.mint,
		network: mintRow.network,
		name: mintRow.name,
		symbol: mintRow.symbol,
		agent_id: mintRow.agent_id,
		pump_agent_pda: mintRow.pump_agent_pda,
		deployed_at: new Date(mintRow.created_at).toISOString(),
		payments,
		distributions,
		buybacks,
		risk_flags: deriveRiskFlags({ payments, distributions, buybacks }),
		indexed_at: new Date().toISOString(),
	};
}

// Cross-reference the live pump.fun launches against pump_agent_mints so each
// list entry gains an `is_agent_token` flag without N per-launch DB queries.
async function markAgentTokens(launches) {
	if (!launches.length) return launches;
	const mints = launches.map((l) => l.mint).filter(Boolean);
	if (!mints.length) return launches;
	try {
		const rows = await sql`
			select mint from pump_agent_mints where mint = any(${mints})
		`;
		const agentSet = new Set(rows.map((r) => r.mint));
		return launches.map((l) => ({ ...l, is_agent_token: agentSet.has(l.mint) }));
	} catch {
		// Non-fatal — caller still gets the live launches, just without the flag.
		return launches.map((l) => ({ ...l, is_agent_token: false }));
	}
}

// Build the LIST-mode response from the raw (newest-first) feed. Exported for
// tests: the newest_* fields must keep describing the NEWEST launch even under
// sort=liquidity, so `newest` is read off the feed BEFORE the re-rank. Reading
// index 0 of the already-sorted array reported the highest-liquidity launch as
// the newest one, which only looked right whenever the two happened to coincide.
export function summarizeLaunches(feed, sort) {
	const newest = feed.reduce(
		(best, l) => (best == null || (l?.created_at ?? -Infinity) > (best.created_at ?? -Infinity) ? l : best),
		null,
	);

	const launches = feed.slice();
	// sort='liquidity' re-ranks by initial bonding-curve SOL reserves, highest first.
	if (sort === 'liquidity') {
		launches.sort((a, b) => (b.liquidity_sol ?? 0) - (a.liquidity_sol ?? 0));
	}

	const liq = launches.map((l) => l.liquidity_sol).filter((v) => v != null && v > 0);
	const avgLiq = liq.length ? liq.reduce((a, b) => a + b, 0) / liq.length : null;
	const maxLiq = liq.length ? Math.max(...liq) : null;

	return {
		network: 'mainnet',
		sort: sort || 'newest',
		count: launches.length,
		newest_mint: newest?.mint || null,
		newest_name: newest?.name || null,
		newest_symbol: newest?.symbol || null,
		avg_initial_liquidity_sol: avgLiq != null ? Math.round(avgLiq * 1e4) / 1e4 : null,
		max_initial_liquidity_sol: maxLiq != null ? Math.round(maxLiq * 1e4) / 1e4 : null,
		launches,
	};
}

async function loadRecentLaunches({ limit, sort }) {
	const n = Math.min(25, Math.max(1, Number(limit) || 10));
	const raw = await recentPumpLaunches({ network: 'mainnet', limit: n });
	const feed = await markAgentTokens(raw);

	return {
		...summarizeLaunches(feed, sort),
		queried_at: new Date().toISOString(),
	};
}

// ── GET endpoint (single audit + list mode) ───────────────────────────────────
const getEndpoint = paidEndpoint({
	route: ROUTE,
	method: 'GET',
	priceAtomics: priceFor('pump-agent-audit', '20000'),
	networks: ['base', 'solana'],
	description: DESCRIPTION,
	bazaar: BAZAAR,
	service: withService({
		serviceName: 'three.ws Pump Audit',
		tags: ['pump.fun', 'audit', 'agent', 'risk', 'solana'],
	}),
	requiredScope: 'x402:bypass',
	accessControl: installAccessControl({ requiredScope: 'x402:bypass' }),
	async handler({ req }) {
		const mint = String(req.query?.mint || '').trim();

		// LIST MODE — no mint supplied
		if (!mint) {
			const limit = req.query?.limit;
			const sort = String(req.query?.sort || 'newest').trim();
			if (sort !== 'newest' && sort !== 'liquidity') {
				const err = new Error('sort must be "newest" or "liquidity"');
				err.status = 400;
				err.code = 'invalid_sort';
				throw err;
			}
			return loadRecentLaunches({ limit, sort });
		}

		// SINGLE MODE — validate mint then audit
		if (!BASE58_RE.test(mint)) {
			const err = new Error('mint must be a base58 Solana pubkey');
			err.status = 400;
			err.code = 'invalid_mint';
			throw err;
		}
		return loadAudit(mint);
	},
});

// ── Whale Activity Oracle (POST mode:"whale_activity") ────────────────────────
// Identifies the top pump.fun whale wallets active right now by scanning recent
// trades across the top-ranked bonding-curve coins. A whale is any wallet that
// bought ≥ WHALE_SOL_THRESHOLD SOL in the current sweep window. Returns the
// top wallets by volume plus an aggregate bullish/bearish/neutral verdict so
// the sniper gate can avoid front-running and confirm genuine large-buyer
// conviction before entering a position.

const PUMP_FRONTEND_BASE_AUDIT =
	process.env.PUMP_FRONTEND_BASE || 'https://frontend-api-v3.pump.fun';
const PUMP_SWAP_BASE_AUDIT =
	process.env.PUMP_SWAP_BASE || 'https://swap-api.pump.fun';

// Minimum SOL in a single transaction to qualify as a whale buy.
const WHALE_SOL_THRESHOLD = Number(process.env.PUMP_WHALE_SOL_THRESHOLD || 5);

// How many top-market-cap coins to pull trades from per sweep.
const WHALE_TRADE_COINS = 5;

// Max wallets returned per call.
const WHALE_LIMIT_DEFAULT = 5;
const WHALE_LIMIT_MAX = 25;

async function fetchTopCoins(limit) {
	const url = `${PUMP_FRONTEND_BASE_AUDIT}/coins?offset=0&limit=${limit}&sort=market_cap&order=DESC&includeNsfw=false`;
	const { ok, body } = await pumpFetchJson(url, { timeoutMs: 7000, retries: 1 });
	if (!ok) return [];
	const coins = Array.isArray(body) ? body : Array.isArray(body?.coins) ? body.coins : [];
	return coins.filter((c) => c && typeof c.mint === 'string' && c.mint.length >= 32);
}

async function fetchCoinTrades(mint) {
	const { ok, body } = await pumpFetchJson(
		`${PUMP_SWAP_BASE_AUDIT}/v2/coins/${mint}/trades?limit=50`,
		{ timeoutMs: 6000, retries: 1 },
	);
	if (!ok) return [];
	return Array.isArray(body) ? body : Array.isArray(body?.trades) ? body.trades : [];
}

function parseNum(v) {
	const n = typeof v === 'string' ? parseFloat(v) : Number(v);
	return Number.isFinite(n) ? n : null;
}

async function detectWhaleActivity(limit) {
	const topCoins = await fetchTopCoins(20).catch(() => []);
	if (!topCoins.length) {
		throw Object.assign(
			new Error('pump.fun coin feed is temporarily unavailable'),
			{ status: 503, code: 'data_unavailable' },
		);
	}

	// Fetch trades for the top WHALE_TRADE_COINS concurrently.
	const tradeResults = await Promise.allSettled(
		topCoins.slice(0, WHALE_TRADE_COINS).map((c) => fetchCoinTrades(c.mint)),
	);

	// Aggregate buys by wallet across all coins.
	const walletMap = new Map();
	topCoins.slice(0, WHALE_TRADE_COINS).forEach((coin, i) => {
		const trades = tradeResults[i].status === 'fulfilled' ? tradeResults[i].value : [];
		for (const t of trades) {
			const isBuy = String(t.type ?? t.txType ?? '').toLowerCase() === 'buy';
			if (!isBuy) continue;
			const sol = parseNum(t.amountSol) ?? 0;
			if (sol < WHALE_SOL_THRESHOLD) continue;
			const wallet = t.userAddress ?? t.user ?? null;
			if (!wallet) continue;
			const existing = walletMap.get(wallet) || { wallet, total_sol: 0, buy_count: 0, coins: [] };
			existing.total_sol += sol;
			existing.buy_count += 1;
			if (!existing.coins.includes(coin.mint)) existing.coins.push(coin.mint);
			walletMap.set(wallet, existing);
		}
	});

	// Sort by total SOL descending, take top limit.
	const allWhales = Array.from(walletMap.values())
		.sort((a, b) => b.total_sol - a.total_sol);
	const whales = allWhales.slice(0, limit).map((w) => ({
		wallet: w.wallet,
		total_sol: Math.round(w.total_sol * 1000) / 1000,
		buy_count: w.buy_count,
		coins: w.coins.slice(0, 5),
	}));

	const whale_count = allWhales.length;
	const total_sol_moved = Math.round(
		allWhales.reduce((s, w) => s + w.total_sol, 0) * 1000,
	) / 1000;

	let signal, headline, confidence;
	if (whale_count >= 5 && total_sol_moved >= 50) {
		signal = 'bullish';
		headline = `${whale_count} whale wallets moved ${total_sol_moved} SOL on pump.fun — strong buyer conviction`;
		confidence = Math.min(0.92, 0.72 + (whale_count * 0.02) + (total_sol_moved / 500));
	} else if (whale_count >= 2 || total_sol_moved >= 10) {
		signal = 'neutral';
		headline = `${whale_count} whale wallet${whale_count !== 1 ? 's' : ''} moved ${total_sol_moved} SOL on pump.fun — moderate activity`;
		confidence = 0.62;
	} else {
		signal = 'bearish';
		headline = `Low whale activity on pump.fun — only ${total_sol_moved} SOL moved by large buyers`;
		confidence = 0.55;
	}
	confidence = Math.round(Math.min(0.95, confidence) * 100) / 100;

	return {
		mode: 'whale_activity',
		wallets: whales,
		whale_count,
		total_sol_moved,
		signal,
		headline,
		confidence,
		ts: new Date().toISOString(),
	};
}

// Read + parse the JSON body off the raw request stream (same idiom as the
// other POST x402 endpoints — req.body is not pre-parsed in this runtime).
async function readJsonBody(req) {
	const raw = await readBody(req, 1_000_000);
	return JSON.parse(Buffer.from(raw).toString('utf8') || '{}');
}

const WHALE_DESCRIPTION =
	'three.ws Pump Whale Activity Oracle — POST {"mode":"whale_activity","limit":N} ' +
	'to identify the top N whale wallets currently active on pump.fun (default 5, max 25). ' +
	'A whale is any wallet that bought ≥5 SOL in one transaction across the top bonding-curve coins. ' +
	'Returns { wallets, whale_count, total_sol_moved } plus a bullish/bearish/neutral signal and ' +
	'confidence score. Use to avoid front-running (whale already in = price moving) and to confirm ' +
	'genuine large-buyer interest before committing a sniper position.';

const WHALE_INPUT_EXAMPLE = { mode: 'whale_activity', limit: 5 };

const WHALE_INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['mode'],
	properties: {
		mode: { type: 'string', enum: ['whale_activity'], description: 'Must be "whale_activity".' },
		limit: {
			type: 'integer',
			minimum: 1,
			maximum: WHALE_LIMIT_MAX,
			description: `Top whale wallets to return (default ${WHALE_LIMIT_DEFAULT}, max ${WHALE_LIMIT_MAX}).`,
		},
	},
};

const WHALE_OUTPUT_EXAMPLE = {
	mode: 'whale_activity',
	wallets: [
		{
			wallet: 'AbcDEF12345GHJKLMNopqrstuvwxyZabcdefghijk1',
			total_sol: 34.5,
			buy_count: 3,
			coins: ['PepeGoMint111111111111111111111111111111111'],
		},
	],
	whale_count: 5,
	total_sol_moved: 187.3,
	signal: 'bullish',
	headline: '5 whale wallets moved 187.3 SOL on pump.fun — strong buyer conviction',
	confidence: 0.82,
	ts: '2026-06-28T00:00:00Z',
};

const WHALE_OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['mode', 'wallets', 'whale_count', 'total_sol_moved', 'signal', 'headline', 'confidence', 'ts'],
	properties: {
		mode: { type: 'string', enum: ['whale_activity'] },
		wallets: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					wallet: { type: 'string' },
					total_sol: { type: 'number' },
					buy_count: { type: 'integer' },
					coins: { type: 'array', items: { type: 'string' } },
				},
			},
		},
		whale_count: { type: 'integer', minimum: 0 },
		total_sol_moved: { type: 'number', minimum: 0 },
		signal: { type: 'string', enum: ['bullish', 'bearish', 'neutral'] },
		headline: { type: 'string' },
		confidence: { type: 'number', minimum: 0, maximum: 1 },
		ts: { type: 'string', format: 'date-time' },
	},
};

const WHALE_BAZAAR = {
	// De-listed per the 2026-07-08 storefront cleanup (prompt 18) — see BAZAAR
	// above; the free /api/crypto/whales surface replaces this as the agent
	// product, this route stays live for its in-product consumer only.
	discoverable: false,
	info: {
		input: {
			type: 'http',
			method: 'POST',
			bodyType: 'json',
			body: WHALE_INPUT_EXAMPLE,
		},
		output: { type: 'json', example: WHALE_OUTPUT_EXAMPLE },
	},
	schema: buildBazaarSchema({
		method: 'POST',
		bodySchema: WHALE_INPUT_SCHEMA,
		outputSchema: WHALE_OUTPUT_SCHEMA,
	}),
};

const whaleEndpoint = paidEndpoint({
	route: ROUTE,
	method: 'POST',
	priceAtomics: priceFor('pump-agent-audit', '20000'),
	networks: ['base', 'solana'],
	description: WHALE_DESCRIPTION,
	bazaar: WHALE_BAZAAR,
	service: withService({
		serviceName: 'three.ws Pump Whale Activity Oracle',
		tags: ['pump.fun', 'whale', 'oracle', 'sniper', 'solana'],
	}),
	requiredScope: 'x402:bypass',
	accessControl: installAccessControl({ requiredScope: 'x402:bypass' }),
	async handler({ req }) {
		let body;
		try {
			body = await readJsonBody(req);
		} catch {
			const err = new Error('request body must be valid JSON');
			err.status = 400;
			err.code = 'invalid_json';
			throw err;
		}
		if (body.mode !== 'whale_activity') {
			const err = new Error('mode must be "whale_activity"');
			err.status = 400;
			err.code = 'invalid_mode';
			throw err;
		}
		const limit = body.limit == null ? WHALE_LIMIT_DEFAULT : Number(body.limit);
		if (!Number.isFinite(limit) || limit < 1) {
			const err = new Error('limit must be a positive integer');
			err.status = 400;
			err.code = 'invalid_limit';
			throw err;
		}
		return detectWhaleActivity(Math.min(WHALE_LIMIT_MAX, Math.floor(limit)));
	},
});

// Route by method: GET → single audit / list mode, POST → whale activity oracle.
// OPTIONS preflight is dispatched to GET (its CORS headers cover read-only callers)
// or to the POST handler when the preflight explicitly targets POST.
export default function pumpAgentAuditRouter(req, res) {
	const httpMethod = String(req.method || 'GET').toUpperCase();
	if (httpMethod === 'POST') {
		// Buffer the body once (via the shared readBody, which prefers the
		// pre-parsed req.rawBody/req.body the Cloud Run server already captured)
		// so readJsonBody inside the paidEndpoint handler can drain it as if the
		// stream was never touched. Re-reading the raw stream directly here (the
		// old implementation) hangs forever once Express has drained it.
		return readBody(req, 1_000_000)
			.then((raw) => {
				req[Symbol.asyncIterator] = async function* () { yield raw; };
			})
			.catch(() => {})
			.then(() => whaleEndpoint(req, res));
	}
	if (httpMethod === 'OPTIONS') {
		const requested = String(req.headers['access-control-request-method'] || '').toUpperCase();
		return requested === 'POST' ? whaleEndpoint(req, res) : getEndpoint(req, res);
	}
	return getEndpoint(req, res);
}
