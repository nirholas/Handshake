/**
 * /api/pump/launch-detail — the single server-side aggregator behind the rich
 * /launches/<mint> coin page.
 *
 *   GET /api/pump/launch-detail?mint=<mint>&network=mainnet|devnet
 *
 * One round-trip fuses every DB-side truth we hold about a coin so the page
 * paints a complete picture before any client-side enrichment:
 *
 *   · registry   — is this a three.ws agent launch? (pump_agent_mints) +
 *                  the agent identity and avatar behind it
 *   · economics  — confirmed agent payments, unique payers, buyback burns
 *                  (pump_agent_payments / pump_buyback_runs)
 *   · intel      — the Coin Intelligence Engine's first-seconds verdict
 *                  (pump_coin_intel) — quality / bundle / organic / risk flags
 *   · outcome    — graduated / rugged / ATH multiple (pump_coin_outcomes)
 *   · trader     — the launching agent's verifiable track record
 *                  (trader-stats truth layer, same numbers as the leaderboard)
 *
 * Live market price, the price chart, the trade tape, holder cohorts and the
 * community feed are streamed in by the client from their own dedicated
 * endpoints — this aggregator stays a fast, cacheable database read.
 *
 * Public + IP rate-limited. Every number traces to an on-chain transaction or a
 * row we persisted from one; nothing here is synthesized. A coin that isn't a
 * three.ws launch still resolves (found:false) with whatever intel we observed,
 * so the page works for any pump.fun mint, not only ours.
 */

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { sql } from '../_lib/db.js';
import { publicUrl as r2PublicUrl } from '../_lib/r2.js';
import { normalizeGatewayURL } from '../../src/ipfs.js';
import { getTraderStats } from '../_lib/trader-stats.js';
import { withBreaker } from '../_lib/resilience.js';
import { pumpFetchJson } from '../_lib/pump-feed-fetch.js';

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const lamportsToSol = (v) => (v == null ? null : Number(BigInt(v)) / 1e9);
const num = (v) => (v == null ? null : Number(v));

// The agent avatar is non-critical enrichment. If the R2 public-URL resolver
// throws (e.g. a misconfigured S3_PUBLIC_DOMAIN), degrade the avatar to null
// rather than 500 the entire coin page over a decorative thumbnail.
function safeR2Url(key) {
	if (!key) return null;
	try {
		return r2PublicUrl(key);
	} catch {
		return null;
	}
}

// Creator fee-sharing earnings — what the coin's creator has actually earned
// from pump.fun's creator-reward program. Two public pump.fun endpoints (the
// same ones the pump.fun frontend calls): coin metadata → creator wallet, then
// the creator's fee-sharing totals filtered to this mint.
//
// Each call is timeout-bounded, and the whole thing runs behind a circuit
// breaker at the call site (see buildDetail): an UNHEALTHY upstream (network
// error, timeout, non-2xx) throws so consecutive failures open the breaker and
// later requests skip pump.fun instantly instead of every launch-page load
// waiting out two 5s timeouts during an outage. A VALID-but-empty response (no
// creator, no earnings) returns null and counts as a success — it isn't an
// outage, so it must not trip the breaker.
const PUMP_FRONTEND_V3 = 'https://frontend-api-v3.pump.fun';
const PUMP_SWAP_API = 'https://swap-api.pump.fun';

async function fetchCreatorFees(mint, network) {
	if (network !== 'mainnet') return null;
	// pump.fun answers a burst with 429 far more often than it goes down, and a
	// bare fetch treated the two identically. pumpFetchJson honours Retry-After
	// and retries once, which is the difference between a launch page rendering
	// and a launch page erroring during someone else's mint.
	const metaRes = await pumpFetchJson(`${PUMP_FRONTEND_V3}/coins-v2/${mint}`, { timeoutMs: 5000 });
	if (!metaRes.ok) throw new Error(`pump.fun coin meta ${metaRes.status}`);
	const meta = metaRes.body;
	const creator = meta?.creator || meta?.creator_address;
	if (!creator || typeof creator !== 'string') return null; // valid: no creator on file

	const totRes = await pumpFetchJson(
		`${PUMP_SWAP_API}/v1/fee-sharing/account/${creator}/totals?mint=${mint}`,
		{ timeoutMs: 5000 },
	);
	if (!totRes.ok) throw new Error(`pump.fun fee-sharing ${totRes.status}`);
	const t = totRes.body;
	const earnedSol = Number(t?.shareholderTotalEarned?.sol);
	if (!Number.isFinite(earnedSol)) return null; // valid: creator has no fee-sharing earnings
	return {
		creator,
		earned_sol: earnedSol,
		earned_usd: Number(t?.shareholderTotalEarned?.usd) || null,
		claimed_sol: Number(t?.shareholderClaimed?.sol) || 0,
		unclaimed_sol: Number(t?.shareholderUnclaimed?.sol) || 0,
		mint_count: t?.mintCount != null ? Number(t.mintCount) : null,
	};
}

// Short-lived per-instance cache — the page is read far more than coins are
// observed, and every underlying query is cheap-but-not-free.
const CACHE = new Map();
const TTL_MS = 15_000;

function shapeIntel(r) {
	if (!r) return null;
	return {
		symbol: r.symbol,
		name: r.name,
		creator: r.creator,
		image_uri: r.image_uri,
		description: r.description,
		socials: { twitter: r.twitter, telegram: r.telegram, website: r.website },
		created_at: r.created_at,
		first_seen_at: r.first_seen_at,
		observation_seconds: r.observation_seconds,
		quality_score: r.quality_score,
		bundle_score: num(r.bundle_score),
		organic_score: num(r.organic_score),
		snipe_ratio: num(r.snipe_ratio),
		concentration_top10: num(r.concentration_top10),
		fresh_wallet_ratio: num(r.fresh_wallet_ratio),
		bubblemap_connectivity: num(r.bubblemap_connectivity),
		risk_flags: r.risk_flags || [],
		category: r.category,
		tags: r.tags || [],
		narrative: r.narrative,
		classify_confidence: num(r.classify_confidence),
		classify_source: r.classify_source,
		dev_buy_sol: lamportsToSol(r.dev_buy_lamports),
		dev_sold: r.dev_sold,
		buy_count: r.buy_count,
		sell_count: r.sell_count,
		buy_volume_sol: lamportsToSol(r.buy_volume_lamports),
		sell_volume_sol: lamportsToSol(r.sell_volume_lamports),
		unique_buyers: r.unique_buyers,
		unique_sellers: r.unique_sellers,
		largest_buy_sol: lamportsToSol(r.largest_buy_lamports),
	};
}

function shapeOutcome(o) {
	if (!o) return null;
	return {
		outcome: o.outcome,
		graduated: o.graduated,
		rugged: o.rugged,
		ath_multiple: num(o.ath_multiple),
		ath_market_cap_usd: num(o.ath_market_cap_usd),
		last_market_cap_usd: num(o.last_market_cap_usd),
		labeled_at: o.labeled_at,
	};
}

async function buildDetail(mint, network) {
	// Registry row (+ agent identity + avatar) — the authoritative "is this a
	// three.ws launch, and whose agent is it" answer.
	const [reg] = await sql`
		select pam.id, pam.mint, pam.network, pam.name, pam.symbol, pam.buyback_bps,
		       pam.agent_authority, pam.metadata_uri, pam.quote_mint,
		       pam.sharing_config, pam.created_at,
		       ai.id as agent_id, ai.name as agent_name, ai.description as agent_description,
		       ai.is_public as agent_public,
		       ai.meta->>'solana_address' as agent_solana_address,
		       ai.meta->>'solana_vanity_prefix' as agent_solana_vanity_prefix,
		       ai.meta->>'solana_vanity_suffix' as agent_solana_vanity_suffix,
		       a.thumbnail_key as avatar_thumbnail_key, a.storage_key as avatar_storage_key,
		       a.visibility as avatar_visibility
		from pump_agent_mints pam
		left join agent_identities ai on ai.id = pam.agent_id and ai.deleted_at is null
		left join avatars a on a.id = ai.avatar_id and a.deleted_at is null
		where pam.mint=${mint} and pam.network=${network}
		limit 1
	`;

	// Intel + outcome (observed by the Coin Intelligence Engine). Independent of
	// the registry — works for any mint the engine watched.
	const [intelRow] = await sql`
		select * from pump_coin_intel where mint=${mint} limit 1
	`;
	const [outcomeRow] = await sql`
		select graduated, rugged, outcome, ath_multiple, ath_market_cap_usd,
		       last_market_cap_usd, labeled_at
		from pump_coin_outcomes where mint=${mint} limit 1
	`;

	// Economics + the agent's track record only exist for registry coins.
	let economics = null;
	let trader = null;
	if (reg) {
		const [stats] = await sql`
			select
				count(*) filter (where status='confirmed')::int                      as confirmed_payments,
				count(distinct payer_wallet) filter (where status='confirmed')::int  as unique_payers,
				coalesce(sum(amount_atomics) filter (where status='confirmed'),0)::text as total_atomics,
				max(confirmed_at) filter (where status='confirmed')                  as last_payment_at
			from pump_agent_payments where mint_id=${reg.id}
		`;
		const [burnRow] = await sql`
			select
				count(*) filter (where status='confirmed')::int                       as runs,
				coalesce(sum(burn_amount) filter (where status='confirmed'),0)::text  as total_burned,
				max(created_at)                                                       as last_burn_at
			from pump_buyback_runs where mint_id=${reg.id}
		`;
		const [burnsFeed, creatorFees] = await Promise.all([
			sql`
				select id, currency_mint, tx_signature, burn_amount, created_at
				from pump_buyback_runs
				where mint_id=${reg.id} and status='confirmed'
				order by created_at desc limit 8
			`,
			// Behind a circuit breaker: a healthy pump.fun returns the fees (or a
			// valid null); a sick one trips the breaker after 3 failures so later
			// launch-page loads skip it instantly and degrade to null instead of
			// each waiting out two 5s timeouts during an outage.
			withBreaker('pumpfun:creator-fees', () => fetchCreatorFees(mint, network), {
				fallback: null,
				threshold: 3,
				halfOpenAfterMs: 30_000,
			}),
		]);
		economics = {
			confirmed_payments: stats?.confirmed_payments ?? 0,
			unique_payers: stats?.unique_payers ?? 0,
			total_atomics: stats?.total_atomics ?? '0',
			last_payment_at: stats?.last_payment_at ?? null,
			burns: {
				runs: burnRow?.runs ?? 0,
				total_burned: burnRow?.total_burned ?? '0',
				last_burn_at: burnRow?.last_burn_at ?? null,
			},
			burns_feed: burnsFeed,
			creator_fees: creatorFees,
		};

		// The launching agent's verifiable PnL — same truth layer as the
		// leaderboard, so the page and /leaderboard can never disagree. Public
		// agents only; private track records stay private.
		if (reg.agent_id && reg.agent_public) {
			try {
				const s = await getTraderStats({ agentId: reg.agent_id, network, window: 'all' });
				if (s?.metrics && s.metrics.closed_count > 0) {
					const m = s.metrics;
					trader = {
						agent_id: reg.agent_id,
						score: m.score,
						verified: m.verified,
						closed_count: m.closed_count,
						open_count: m.open_count,
						win_rate: m.win_rate,
						realized_pnl_sol: m.realized_pnl_sol,
						realized_pnl_usd: m.realized_pnl_usd,
						roi_pct: m.roi_pct,
						unique_coins: m.unique_coins,
						best_pnl_pct: m.best_pnl_pct,
						last_active_at: m.last_active_at,
					};
				}
			} catch {
				/* track record is best-effort enrichment; never block the page on it */
			}
		}
	}

	const avatarPublic =
		reg?.avatar_visibility === 'public' || reg?.avatar_visibility === 'unlisted';

	return {
		mint,
		network,
		found: !!reg,
		registry: reg
			? {
					name: reg.name,
					symbol: reg.symbol,
					buyback_bps: reg.buyback_bps,
					agent_authority: reg.agent_authority,
					metadata_uri: normalizeGatewayURL(reg.metadata_uri) || reg.metadata_uri,
					quote_mint: reg.quote_mint,
					sharing_config: reg.sharing_config,
					created_at: reg.created_at,
				}
			: null,
		agent: reg?.agent_id
			? {
					id: reg.agent_id,
					name: reg.agent_name,
					description: reg.agent_description,
					url: `/agents/${reg.agent_id}`,
					is_public: reg.agent_public,
					avatar_thumbnail_url: avatarPublic ? safeR2Url(reg.avatar_thumbnail_key) : null,
					// The launching agent's interactive 3D model — drives the inline
					// <agent-3d> stage on the coin page. Public/unlisted only; private
					// avatars fall back to the shared mannequin client-side.
					avatar_model_url: avatarPublic ? safeR2Url(reg.avatar_storage_key) : null,
					// Public custodial wallet (+ vanity) of the launching agent, so the
					// shared wallet chip renders identically here as on the feed/profile.
					solana_address: reg.agent_solana_address || null,
					solana_vanity_prefix: reg.agent_solana_vanity_prefix || null,
					solana_vanity_suffix: reg.agent_solana_vanity_suffix || null,
				}
			: null,
		economics,
		intel: shapeIntel(intelRow),
		outcome: shapeOutcome(outcomeRow),
		trader,
	};
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
	const mint = (url.searchParams.get('mint') || '').trim();
	const network = url.searchParams.get('network') === 'devnet' ? 'devnet' : 'mainnet';
	if (!MINT_RE.test(mint))
		return error(res, 400, 'invalid_mint', 'mint must be a base58 address');

	const cacheKey = `${network}:${mint}`;
	const now = Date.now();
	const hit = CACHE.get(cacheKey);
	if (hit && now - hit.at < TTL_MS) {
		res.setHeader('cache-control', 'public, max-age=15, s-maxage=30');
		return json(res, 200, hit.body);
	}

	const body = await buildDetail(mint, network);
	CACHE.set(cacheKey, { at: now, body });
	if (CACHE.size > 300) CACHE.delete(CACHE.keys().next().value);

	res.setHeader('cache-control', 'public, max-age=15, s-maxage=30');
	return json(res, 200, body);
});
