// three.ws demo coin API — public read-only.
//
// Routes (via vercel.json rewrites, all under the /demo/* namespace until
// graduation to a production path):
//   GET  /api/demo/coin/state?mint=XXX
//   GET  /api/demo/coin/holder?mint=XXX&wallet=YYY
//   GET  /api/demo/coin/history?mint=XXX&limit=20
//   GET  /api/demo/coin/events?mint=XXX&limit=50&kind=<event_kind>
//   GET  /api/demo/coin/winners?mint=XXX&limit=20
//   GET  /api/demo/coin/holders?mint=XXX&limit=50
//
// Caller may omit `mint` when exactly one active coin exists — the API picks
// it automatically so /demo/coin works without any query parameter for the
// common single-launch case.
//
// All `*_lamports` values are returned as strings to preserve precision on
// the JSON wire (Number can't safely represent values > 2^53).

import { sql } from '../../_lib/db.js';
import { cors, error, json, method, wrap, rateLimited } from '../../_lib/http.js';
import { parseLimit } from '../../_lib/http-params.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { listActiveCoins, loadCoinByMint } from '../../_lib/coin/index.js';

function bigStr(v) {
	if (v === null || v === undefined) return null;
	return String(v);
}

async function resolveCoin(req) {
	const mint = req.query?.mint?.toString();
	if (mint) {
		const coin = await loadCoinByMint(mint);
		if (!coin) return { coin: null, err: 'coin_not_found' };
		return { coin, err: null };
	}
	const coins = await listActiveCoins();
	if (coins.length === 1) return { coin: coins[0], err: null };
	if (coins.length === 0) return { coin: null, err: 'no_active_coins' };
	return { coin: null, err: 'multiple_active_coins_specify_mint' };
}

async function handleState(req, res) {
	const { coin, err } = await resolveCoin(req);
	if (err) return error(res, 404, err, err.replace(/_/g, ' '));

	const [holdersAgg] = await sql`
		select
			count(*) filter (where balance > ${coin.min_holder_balance}::bigint) as eligible,
			count(*) filter (where balance > 0) as total_with_balance,
			coalesce(sum(balance::numeric) filter (where balance > 0), 0)::text as supply_held,
			coalesce(sum(total_reflection_paid_lamports::numeric), 0)::text as total_reflection_paid,
			coalesce(sum(total_lottery_won_lamports::numeric), 0)::text as total_lottery_paid
		from coin_holders
		where coin_id = ${coin.id}
	`;

	const [pendingPayouts] = await sql`
		select
			count(*)::int as pending_count,
			coalesce(sum(amount_lamports::numeric), 0)::text as pending_lamports
		from coin_payouts
		where coin_id = ${coin.id} and status in ('pending', 'submitted')
	`;

	const [latestDraw] = await sql`
		select draw_id, drand_round, pot_lamports::text as pot, winner_wallet, status, created_at, resolved_at, paid_at
		from coin_draws
		where coin_id = ${coin.id}
		order by created_at desc
		limit 1
	`;

	const nowMs = Date.now();
	const interval = coin.draw_interval_seconds * 1000;
	const nextDrawAt = new Date(Math.ceil(nowMs / interval) * interval).toISOString();

	return json(res, 200, {
		platform: 'three.ws',
		mint: coin.mint,
		name: coin.name,
		symbol: coin.symbol,
		network: coin.network,
		is_live: coin.is_live,
		pots: {
			lottery_lamports: bigStr(coin.lottery_pot_lamports),
			reflection_lamports: bigStr(coin.reflection_pot_lamports),
			ops_lamports: bigStr(coin.ops_pot_lamports),
			total_claimed_lamports: bigStr(coin.total_claimed_lamports),
		},
		allocation_bps: {
			lottery: coin.lottery_bps,
			reflection: coin.reflection_bps,
			ops: coin.ops_bps,
		},
		cadence: {
			draw_interval_seconds: coin.draw_interval_seconds,
			reflection_interval_seconds: coin.reflection_interval_seconds,
			next_draw_at: nextDrawAt,
			last_claim_at: coin.last_claim_at,
			last_draw_at: coin.last_draw_at,
			last_reflection_at: coin.last_reflection_at,
			last_snapshot_at: coin.last_snapshot_at,
		},
		holders: {
			eligible: Number(holdersAgg?.eligible || 0),
			total: Number(holdersAgg?.total_with_balance || 0),
			supply_held: holdersAgg?.supply_held || '0',
			min_balance: bigStr(coin.min_holder_balance),
		},
		paid_total: {
			reflection_lamports: holdersAgg?.total_reflection_paid || '0',
			lottery_lamports: holdersAgg?.total_lottery_paid || '0',
		},
		pending_payouts: {
			count: Number(pendingPayouts?.pending_count || 0),
			lamports: pendingPayouts?.pending_lamports || '0',
		},
		latest_draw: latestDraw
			? {
					draw_id: latestDraw.draw_id,
					drand_round: Number(latestDraw.drand_round),
					pot_lamports: latestDraw.pot,
					winner: latestDraw.winner_wallet,
					status: latestDraw.status,
					created_at: latestDraw.created_at,
					resolved_at: latestDraw.resolved_at,
					paid_at: latestDraw.paid_at,
				}
			: null,
	});
}

async function handleHolder(req, res) {
	const { coin, err } = await resolveCoin(req);
	if (err) return error(res, 404, err, err.replace(/_/g, ' '));
	const wallet = req.query?.wallet?.toString();
	if (!wallet) return error(res, 400, 'validation_error', 'wallet is required');

	const [row] = await sql`
		select wallet, balance::text as balance,
		       accrued_reflection_lamports::text as accrued,
		       total_reflection_paid_lamports::text as total_reflection,
		       total_lottery_won_lamports::text as total_lottery,
		       first_seen, last_seen, last_payout_at
		from coin_holders
		where coin_id = ${coin.id} and wallet = ${wallet}
		limit 1
	`;
	if (!row) {
		return json(res, 200, {
			mint: coin.mint,
			wallet,
			balance: '0',
			accrued_reflection_lamports: '0',
			total_reflection_paid_lamports: '0',
			total_lottery_won_lamports: '0',
			recent_payouts: [],
			recent_wins: [],
		});
	}

	const recentPayouts = await sql`
		select kind, amount_lamports::text as amount, batch_id, tx_signature, status, created_at, confirmed_at
		from coin_payouts
		where coin_id = ${coin.id} and wallet = ${wallet}
		order by created_at desc
		limit 25
	`;
	const wins = recentPayouts.filter((p) => p.kind === 'lottery');

	return json(res, 200, {
		mint: coin.mint,
		wallet: row.wallet,
		balance: row.balance,
		accrued_reflection_lamports: row.accrued,
		total_reflection_paid_lamports: row.total_reflection,
		total_lottery_won_lamports: row.total_lottery,
		first_seen: row.first_seen,
		last_seen: row.last_seen,
		last_payout_at: row.last_payout_at,
		recent_payouts: recentPayouts.map((p) => ({
			kind: p.kind,
			amount_lamports: p.amount,
			batch_id: p.batch_id,
			tx_signature: p.tx_signature,
			status: p.status,
			created_at: p.created_at,
			confirmed_at: p.confirmed_at,
		})),
		recent_wins: wins.map((w) => ({
			amount_lamports: w.amount,
			tx_signature: w.tx_signature,
			created_at: w.created_at,
		})),
	});
}

async function handleHistory(req, res) {
	const { coin, err } = await resolveCoin(req);
	if (err) return error(res, 404, err, err.replace(/_/g, ' '));
	const limit = parseLimit(req.query, { fallback: 20, max: 100 });

	const fees = await sql`
		select payload, tx_signature, created_at
		from coin_events
		where coin_id = ${coin.id} and kind = 'fee_claim'
		order by created_at desc
		limit ${limit}
	`;
	const draws = await sql`
		select draw_id, drand_round, pot_lamports::text as pot, winner_wallet, status,
		       drand_randomness, tx_signature, created_at, resolved_at, paid_at
		from coin_draws
		where coin_id = ${coin.id}
		order by created_at desc
		limit ${limit}
	`;
	const reflections = await sql`
		select payload, tx_signature, created_at
		from coin_events
		where coin_id = ${coin.id} and kind = 'reflection_batch'
		order by created_at desc
		limit ${limit}
	`;

	return json(res, 200, {
		mint: coin.mint,
		fee_claims: fees.map((r) => ({
			claimed_lamports: r.payload?.claimed,
			lottery_lamports: r.payload?.lottery,
			reflection_lamports: r.payload?.reflection,
			ops_lamports: r.payload?.ops,
			tx_signature: r.tx_signature,
			created_at: r.created_at,
		})),
		draws: draws.map((d) => ({
			draw_id: d.draw_id,
			drand_round: Number(d.drand_round),
			pot_lamports: d.pot,
			winner: d.winner_wallet,
			status: d.status,
			drand_randomness: d.drand_randomness,
			tx_signature: d.tx_signature,
			created_at: d.created_at,
			resolved_at: d.resolved_at,
			paid_at: d.paid_at,
		})),
		reflection_batches: reflections.map((r) => ({
			batch_id: r.payload?.batch_id,
			queued: r.payload?.queued,
			allocated_lamports: r.payload?.allocated,
			tx_signature: r.tx_signature,
			created_at: r.created_at,
		})),
	});
}

async function handleEvents(req, res) {
	const { coin, err } = await resolveCoin(req);
	if (err) return error(res, 404, err, err.replace(/_/g, ' '));
	const limit = parseLimit(req.query, { fallback: 50, max: 200 });
	const kind = req.query?.kind?.toString() || null;

	const rows = kind
		? await sql`
				select kind, payload, tx_signature, created_at
				from coin_events
				where coin_id = ${coin.id} and kind = ${kind}
				order by created_at desc
				limit ${limit}
			`
		: await sql`
				select kind, payload, tx_signature, created_at
				from coin_events
				where coin_id = ${coin.id}
				order by created_at desc
				limit ${limit}
			`;
	return json(res, 200, {
		mint: coin.mint,
		events: rows.map((r) => ({
			kind: r.kind,
			payload: r.payload,
			tx_signature: r.tx_signature,
			created_at: r.created_at,
		})),
	});
}

async function handleWinners(req, res) {
	const { coin, err } = await resolveCoin(req);
	if (err) return error(res, 404, err, err.replace(/_/g, ' '));
	const limit = parseLimit(req.query, { fallback: 20, max: 100 });
	const rows = await sql`
		select draw_id, drand_round, pot_lamports::text as pot, winner_wallet,
		       drand_randomness, tx_signature, status, created_at, paid_at
		from coin_draws
		where coin_id = ${coin.id} and winner_wallet is not null
		order by created_at desc
		limit ${limit}
	`;
	return json(res, 200, {
		mint: coin.mint,
		winners: rows.map((r) => ({
			draw_id: r.draw_id,
			drand_round: Number(r.drand_round),
			amount_lamports: r.pot,
			wallet: r.winner_wallet,
			drand_randomness: r.drand_randomness,
			tx_signature: r.tx_signature,
			status: r.status,
			created_at: r.created_at,
			paid_at: r.paid_at,
		})),
	});
}

async function handleHolders(req, res) {
	const { coin, err } = await resolveCoin(req);
	if (err) return error(res, 404, err, err.replace(/_/g, ' '));
	const limit = parseLimit(req.query, { fallback: 50, max: 500 });
	const rows = await sql`
		select wallet, balance::text as balance,
		       accrued_reflection_lamports::text as accrued,
		       total_reflection_paid_lamports::text as total_reflection,
		       total_lottery_won_lamports::text as total_lottery
		from coin_holders
		where coin_id = ${coin.id} and balance > 0
		order by balance::numeric desc
		limit ${limit}
	`;
	return json(res, 200, {
		mint: coin.mint,
		holders: rows.map((r, i) => ({
			rank: i + 1,
			wallet: r.wallet,
			balance: r.balance,
			accrued_reflection_lamports: r.accrued,
			total_reflection_paid_lamports: r.total_reflection,
			total_lottery_won_lamports: r.total_lottery,
		})),
	});
}

const HANDLERS = {
	state: handleState,
	holder: handleHolder,
	history: handleHistory,
	events: handleEvents,
	winners: handleWinners,
	holders: handleHolders,
};

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	// Rate-limit every public read endpoint by client IP. Re-uses the existing
	// `publicIp` bucket (60 req/min, Upstash-backed in prod, in-memory in dev)
	// so /api/demo/coin/* shares a single budget per IP across all actions —
	// preventing a hot dashboard tab from burning through the quota that a
	// share-bot calling /og also needs.
	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) {
		return rateLimited(res, rl);
	}

	const action = req.query?.action;
	const handler = typeof action === 'string' ? HANDLERS[action] : null;
	if (!handler) return error(res, 404, 'not_found', 'unknown action');
	return handler(req, res);
});
