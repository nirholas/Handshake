/**
 * Trading Brain — assisted candidate scan (P4)
 * ============================================
 *
 *   POST /api/trading/scan  { agent_id, config }
 *     → live launches that match the rule's entry conditions RIGHT NOW, each with
 *       a real on-chain quote (expected tokens out, price impact) and a real
 *       rug/honeypot firewall verdict. NEVER executes — this is the assisted
 *       mode's "what would my agent buy?" preview. The owner confirms a candidate
 *       with the existing discretionary trade endpoint, which re-runs every guard.
 *
 * Read-only over real data: the same launch feed (recentPumpLaunches), the same
 * entry gate (matchesEntry), the same quote function (quoteTrade), and the same
 * firewall (assessTradeSafety) the autonomous runner uses — so what the owner
 * sees here is exactly what the engine would act on. No synthetic candidates, no
 * fabricated fills, no fake P&L.
 *
 * Owner-scoped + rate-limited. CSRF-exempt because it moves no funds and never
 * touches the custodial key (like the trade endpoint's preview path).
 *
 * Coin rule: coin-agnostic plumbing — it scans whatever real launches the live
 * pump.fun feed returns against the owner's runtime filters. It hardcodes,
 * markets, and recommends no specific mint. $THREE remains the only coin three.ws
 * promotes.
 */

import { cors, json, method, error, readJson, wrap, rateLimited } from '../_lib/http.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { sql } from '../_lib/db.js';
import { isUuid } from '../_lib/validate.js';
import { PublicKey } from '@solana/web3.js';
import { normalizeStrategyConfig, matchesEntry } from '../_lib/strategy-schema.js';
import { recentPumpLaunches, enrichCreatorStats } from '../_lib/pump-launch-feed.js';
import { quoteTrade } from '../agents/solana-trade.js';
import { assessTradeSafety } from '../_lib/trade-firewall.js';
import { solanaConnection } from '../_lib/agent-pumpfun.js';

const LAMPORTS_PER_SOL = 1_000_000_000;
// Quoting + firewall each cost RPC round-trips; cap how many candidates we price
// so an owner's scan stays fast and never hammers the node.
const MAX_PRICED = 6;
const MAX_LAUNCHES = 60;

async function resolveUser(req) {
	const session = await getSessionUser(req);
	if (session) return { id: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { id: bearer.userId };
	return null;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const user = await resolveUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.authedReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	let body;
	try {
		body = await readJson(req);
	} catch (e) {
		return error(res, e?.status === 415 ? 415 : 400, 'bad_request', e?.message || 'invalid request body');
	}

	const agentId = body?.agent_id;
	if (!isUuid(agentId)) return error(res, 400, 'validation_error', 'a valid agent_id is required');

	// Ownership — scanning is an owner tool; it reflects the owner's private rule.
	const [agent] = await sql`
		SELECT id, user_id, meta FROM agent_identities
		WHERE id = ${agentId} AND user_id = ${user.id} AND deleted_at IS NULL
	`;
	if (!agent) return error(res, 404, 'not_found', 'agent not found');

	const config = normalizeStrategyConfig(body?.config);
	const network = config.network === 'devnet' ? 'devnet' : 'mainnet';
	// The live pre-graduation feed exists for mainnet only (the autonomous runner
	// has the same constraint). Be honest about it rather than returning [] silently.
	if (network !== 'mainnet') {
		return json(res, 200, { data: { network, scanned: 0, matched: 0, candidates: [], note: 'Live launch scanning is available on mainnet only.' } });
	}

	const payerAddr = agent.meta?.solana_address || null;
	const payer = payerAddr ? new PublicKey(payerAddr) : null;
	const conn = solanaConnection(network);
	const nowMs = Date.now();
	const amountSol = config.sizing.amount_sol;
	const slippageBps = config.sizing.max_slippage_bps;

	// 1. Real launch feed.
	let launches = [];
	try {
		launches = await recentPumpLaunches({ network, limit: MAX_LAUNCHES });
	} catch {
		return error(res, 502, 'feed_unavailable', 'the live launch feed is unreachable right now — try again in a moment');
	}

	// 2. Cheap entry gate (pure, no network). Enrich creator stats only when the
	//    rule actually gates on them, then re-check — keeps the scan fast.
	const gatesCreator = config.entry.max_creator_launches != null || config.entry.min_creator_graduated != null;
	const matched = [];
	for (const launch of launches) {
		let verdict = matchesEntry(config, launch, nowMs);
		if (!verdict.pass && !gatesCreator) continue;
		if (gatesCreator && (launch.creator_launches == null || launch.creator_graduated == null)) {
			await enrichCreatorStats(launch, 0).catch(() => {});
			verdict = matchesEntry(config, launch, nowMs);
		}
		if (verdict.pass) matched.push({ launch, reasons: verdict.reasons });
		if (matched.length >= MAX_PRICED) break;
	}

	// 3. Real quote + firewall for each match (the costly, on-chain part).
	const candidates = [];
	for (const { launch, reasons } of matched) {
		let quote = null;
		let firewall = null;
		try {
			const mintPk = new PublicKey(launch.mint);
			const q = await quoteTrade({ conn, side: 'buy', mintPk, mintStr: launch.mint, network, solAmount: amountSol, slippageBps });
			quote = {
				out_ui: q.outUi,
				price_impact_pct: q.priceImpactPct,
				venue: q.venue,
				min_out_atomics: q.minOutAtomics,
				decimals: q.decimals,
			};
			const a = await assessTradeSafety({
				network, mint: mintPk, side: 'buy', payer,
				quoteAmount: BigInt(q.inAtomics), priceImpactPct: q.priceImpactPct,
			}).catch(() => null);
			if (a) firewall = { verdict: a.verdict, score: a.score, simulated: a.simulated, reasons: a.reasons || [] };
		} catch (e) {
			// A coin that can't be quoted (no curve, RPC hiccup) is simply not a
			// confirmable candidate — surface it as unquotable rather than dropping it.
			quote = null;
			firewall = { verdict: 'warn', score: null, simulated: false, reasons: ['Could not quote this coin right now.'] };
		}
		candidates.push({
			mint: launch.mint,
			name: launch.name || null,
			symbol: launch.symbol || null,
			image: launch.image || launch.image_uri || null,
			created_at: launch.created_at || null,
			age_minutes: launch.created_at ? Math.max(0, Math.round((nowMs - Number(launch.created_at)) / 60000)) : null,
			market_cap_usd: launch.market_cap_usd ?? null,
			liquidity_sol: launch.liquidity_sol ?? null,
			creator: launch.creator || null,
			creator_launches: launch.creator_launches ?? null,
			creator_graduated: launch.creator_graduated ?? null,
			has_socials: !!(launch.twitter || launch.telegram || launch.website),
			twitter: launch.twitter || null,
			telegram: launch.telegram || null,
			website: launch.website || null,
			reasons,
			quote,
			firewall,
			amount_sol: amountSol,
			slippage_bps: slippageBps,
		});
	}

	return json(res, 200, {
		data: {
			network,
			scanned: launches.length,
			matched: candidates.length,
			candidates,
			amount_sol: amountSol,
			slippage_bps: slippageBps,
		},
	});
});
