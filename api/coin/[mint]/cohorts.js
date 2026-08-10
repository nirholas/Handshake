// GET /api/coin/:mint/cohorts
//
// Holder cohorts for one agent token — named audience slices the /go bounty
// board, coin communities, and holder worlds can target. Two shapes:
//
//   …/cohorts                       → public: cohort definitions + live counts.
//   …/cohorts?cohort=whales&…       → creator-only: paginated member export,
//                                      with optional deterministic sampling.
//
// The holder set is already public on-chain, but a turnkey, sampled wallet
// export (built for airdrop/targeting) is gated to the coin's creator so it
// can't be casually scraped for someone else's token. Definitions and counts
// stay open so any surface can render the segmentation UI.

import { sql } from '../../_lib/db.js';
import { cors, json, error, method, wrap, rateLimited } from '../../_lib/http.js';
import { isValidSolanaAddress } from '../../_lib/validate.js';
import { getSessionUser } from '../../_lib/auth.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import {
	loadCoinByMint,
	listCohorts,
	isCohortId,
	cohortCounts,
	queryCohort,
	isLiveCohort,
	liveHolderSet,
	liveCohortCounts,
	liveCohortMembers,
} from '../../_lib/coin/index.js';

// Holder data changes slowly and the live path costs a Helius call, so let the
// CDN absorb repeat loads (the agent detail page hits this on every view).
const OVERVIEW_CACHE = 'public, max-age=30, s-maxage=120, stale-while-revalidate=300';

function mintFromReq(req) {
	const m = req.query?.mint;
	if (m) return m;
	// Fallback for runtimes that don't populate req.query for nested routes.
	const path = (req.url || '').split('?')[0].replace(/\/+$/, '');
	const parts = path.split('/');
	const i = parts.lastIndexOf('coin');
	return i >= 0 && parts[i + 1] ? decodeURIComponent(parts[i + 1]) : null;
}

/** True if the session user owns this coin (creator wallet linked, or admin). */
async function ownsCoin(user, coin) {
	if (!user) return false;
	if (user.is_admin) return true;
	const creator = coin.creator_wallet;
	if (!creator) return false;
	if (user.wallet_address === creator) return true;
	const rows = await sql`
		select 1 from user_wallets
		where user_id = ${user.id} and address = ${creator}
		limit 1
	`;
	return rows.length > 0;
}

function numParam(url, key) {
	const raw = url.searchParams.get(key);
	if (raw == null) return undefined;
	const n = parseFloat(raw);
	return Number.isFinite(n) ? n : undefined;
}

/** A launched agent token (no coin_launches row) identified by its mint. */
async function loadAgentTokenByMint(mint) {
	const [row] = await sql`
		select id, user_id, meta->'token' as token
		from agent_identities
		where meta->'token'->>'mint' = ${mint} and deleted_at is null
		limit 1
	`;
	return row || null;
}

/** True if the session user owns the agent that launched this token (or admin). */
function ownsAgentToken(user, agentToken) {
	if (!user) return false;
	if (user.is_admin) return true;
	return Boolean(agentToken.user_id) && user.id === agentToken.user_id;
}

// Agent tokens have no snapshot, so cohorts are computed live from the holder
// set Helius indexes for the mint. Same two shapes as the snapshot path:
// public counts + concentration, and a creator-only sampled member export.
// Tenure cohorts (diamond-hands / new-buyers / exited) report null / 422 —
// they need holder history this token has not accrued yet.
async function serveLiveCohorts(req, res, { mint, agentToken }) {
	const url = new URL(req.url, 'http://localhost');
	const cohortId = url.searchParams.get('cohort');
	const params = {
		topPct: numParam(url, 'topPct'),
		minHoldDays: numParam(url, 'minHoldDays'),
		windowDays: numParam(url, 'windowDays'),
		idleDays: numParam(url, 'idleDays'),
	};

	const token = agentToken.token || {};
	const network = token.cluster === 'devnet' ? 'devnet' : 'mainnet';
	const coinInfo = { mint, symbol: token.symbol || null, name: token.name || null };

	// Everything the export path can reject on its own is decided BEFORE the
	// holder set is fetched. That fetch costs a Helius call and can fail with a
	// 503 of its own, which used to swallow the real answer: an anonymous caller
	// asking for a bogus cohort got "holder data is temporarily unavailable"
	// instead of 404 or 401, and every such request still spent an upstream call.
	if (cohortId) {
		if (!isCohortId(cohortId)) {
			return error(res, 404, 'not_found', `unknown cohort: ${cohortId}`);
		}
		const user = await getSessionUser(req, res).catch(() => null);
		if (!user) return error(res, 401, 'unauthenticated', 'sign in to export cohort members');
		if (!ownsAgentToken(user, agentToken)) {
			return error(res, 403, 'forbidden', 'only the token creator can export holder cohorts');
		}
		if (!isLiveCohort(cohortId)) {
			return error(
				res,
				422,
				'snapshot_required',
				`the "${cohortId}" cohort needs holder history, which this token has not accrued yet`,
			);
		}
	}

	let set;
	try {
		set = await liveHolderSet({ mint, network });
	} catch (e) {
		// Helius unconfigured / RPC blip — typed, not a 500. Never echo e.message:
		// web3.js/Helius errors embed the keyed RPC URL (…helius-rpc.com/?api-key=…).
		console.error('[coin/cohorts] live holder set failed', e?.message);
		return error(res, 503, 'holders_unavailable', 'holder data is temporarily unavailable');
	}

	// ── Overview: definitions + counts + concentration (public) ──────────────
	if (!cohortId) {
		const { holderCount, counts, concentration } = liveCohortCounts(set, params);
		// A stale set came from the failover snapshot (Helius was unreachable) — use a
		// shorter cache so the panel re-attempts live data sooner, and label it.
		res.setHeader('Cache-Control', set.stale ? 'public, max-age=15, s-maxage=30' : OVERVIEW_CACHE);
		return json(res, 200, {
			coin: coinInfo,
			source: set.stale ? 'live-stale' : 'live',
			lastSnapshotAt: null,
			holderCount,
			concentration,
			cohorts: listCohorts().map((c) => ({ ...c, count: counts[c.id] ?? null })),
		});
	}

	// ── Member export: the creator gate above already passed ─────────────
	const limit = numParam(url, 'limit') ?? 200;
	const sampleRaw = numParam(url, 'sample');
	const sample = sampleRaw != null && sampleRaw > 0 && sampleRaw < 1 ? sampleRaw : undefined;
	const salt = url.searchParams.get('salt') || mint;

	const { members, sampled, total, truncated } = liveCohortMembers(set, {
		cohortId,
		params,
		limit,
		sample,
		salt,
	});

	return json(res, 200, {
		coin: coinInfo,
		source: set.stale ? 'live-stale' : 'live',
		cohort: cohortId,
		sampled,
		sample: sample ?? null,
		count: members.length,
		total,
		truncated,
		members,
		lastSnapshotAt: null,
	});
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	// One limiter for every shape. It used to guard only the live (Helius) path,
	// so the snapshot overview and the snapshot member export, both of which run
	// unbounded DB work, were reachable at any rate.
	const rl = await limits.cohortsIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const mint = mintFromReq(req);
	if (!mint || !isValidSolanaAddress(mint)) {
		return error(res, 400, 'bad_request', 'a valid token mint is required');
	}

	const coin = await loadCoinByMint(mint);
	if (!coin) {
		// Agent tokens are never registered in coin_launches, so they have no
		// coin_holders snapshot — serve live Helius-derived cohorts instead.
		// A mint that is neither a launch nor a known agent token still 404s.
		const agentToken = await loadAgentTokenByMint(mint);
		if (agentToken) return serveLiveCohorts(req, res, { mint, agentToken });
		return error(res, 404, 'not_found', 'no launch found for this mint');
	}

	const url = new URL(req.url, 'http://localhost');
	const cohortId = url.searchParams.get('cohort');

	const params = {
		topPct: numParam(url, 'topPct'),
		minHoldDays: numParam(url, 'minHoldDays'),
		windowDays: numParam(url, 'windowDays'),
		idleDays: numParam(url, 'idleDays'),
	};

	// ── Overview: definitions + counts (public) ──────────────────────────────
	if (!cohortId) {
		const counts = await cohortCounts({ coinId: coin.id, params });
		res.setHeader('Cache-Control', OVERVIEW_CACHE);
		return json(res, 200, {
			coin: { mint: coin.mint, symbol: coin.symbol, name: coin.name },
			lastSnapshotAt: coin.last_snapshot_at || null,
			cohorts: listCohorts().map((c) => ({ ...c, count: counts[c.id] ?? 0 })),
		});
	}

	// ── Member export: creator-only ──────────────────────────────────────────
	if (!isCohortId(cohortId)) {
		return error(res, 404, 'not_found', `unknown cohort: ${cohortId}`);
	}

	const user = await getSessionUser(req, res).catch(() => null);
	if (!user) return error(res, 401, 'unauthenticated', 'sign in to export cohort members');
	if (!(await ownsCoin(user, coin))) {
		return error(res, 403, 'forbidden', 'only the coin creator can export holder cohorts');
	}

	const limit = numParam(url, 'limit') ?? 200;
	const cursor = url.searchParams.get('cursor') || undefined;
	const sampleRaw = numParam(url, 'sample');
	const sample = sampleRaw != null && sampleRaw > 0 && sampleRaw < 1 ? sampleRaw : undefined;
	const salt = url.searchParams.get('salt') || undefined;

	const { members, nextCursor, sampled } = await queryCohort({
		coinId: coin.id,
		cohortId,
		params,
		limit,
		cursor,
		sample,
		salt,
	});

	return json(res, 200, {
		coin: { mint: coin.mint, symbol: coin.symbol, name: coin.name },
		cohort: cohortId,
		sampled,
		sample: sample ?? null,
		count: members.length,
		members,
		nextCursor,
		lastSnapshotAt: coin.last_snapshot_at || null,
	});
});
