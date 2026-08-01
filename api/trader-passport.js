/**
 * Trader Passport: a trader's on-chain-anchored track record, in portable form.
 *
 *   GET /api/trader-passport?wallet=<base58>&network=mainnet&window=all
 *   GET /api/trader-passport?agent_id=<uuid>&network=mainnet&window=all
 *
 * The /trader profile page has always been able to prove a track record by
 * following each position to its Solscan transaction, and a daily cron commits the
 * rolled-up score on-chain as a signed attestation. This endpoint is what makes
 * that anchor usable *outside* three.ws: one public, CORS-open document holding the
 * credential, its history, the issuer to pin, the live numbers, and the drift
 * between them, so another terminal can render "verified trader" without trusting
 * us and without re-indexing the chain.
 *
 * Public, IP rate-limited, short CDN cache. Never requires auth, a credential a
 * third party cannot fetch is not portable.
 */

import { cors, json, method, wrap, error, rateLimited } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { env } from './_lib/env.js';
import { getTraderStats } from './_lib/trader-stats.js';
import {
	PASSPORT_NETWORKS, PASSPORT_WINDOWS, WALLET_RE, TRADESCORE_KIND,
	loadCredentials, resolveIssuer, agentForWallet, scoreDrift, ageInDays, explorerAddr,
} from './_lib/trader-passport.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HISTORY_LIMIT = 30;
const SITE = env.APP_ORIGIN || 'https://three.ws';

/**
 * Why a wallet has no credential yet, in the trader's language. The attestor walks
 * the top of the all-time leaderboard once a day, so "not attested" is usually
 * "not ranked yet", not "something is broken".
 */
function unattestedReason(hasAgent, closedCount) {
	if (!hasAgent) {
		return 'This wallet has no three.ws trading agent yet. Claim it at /claim-wallet to start building an attested record.';
	}
	if (!closedCount) {
		return 'No closed trades yet. The daily attestor commits a score once this trader has a realized track record to commit.';
	}
	return 'Not attested yet. The attestor signs the top of the all-time leaderboard once per UTC day; this trader has not been in that set yet.';
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const p = new URL(req.url, `http://${req.headers.host || 'x'}`).searchParams;
	const network = PASSPORT_NETWORKS.has(p.get('network')) ? p.get('network') : 'mainnet';
	const window  = PASSPORT_WINDOWS.has(p.get('window')) ? p.get('window') : 'all';
	const wantLive = p.get('live') !== '0';
	const agentParam = (p.get('agent_id') || p.get('agent') || '').trim();
	let wallet = (p.get('wallet') || '').trim();

	if (!wallet && !agentParam) {
		return error(res, 400, 'missing_subject', 'Pass wallet=<base58 address> or agent_id=<uuid>.');
	}
	if (agentParam && !UUID_RE.test(agentParam)) {
		return error(res, 400, 'invalid_agent_id', 'agent_id must be a three.ws agent UUID.');
	}
	if (wallet && !WALLET_RE.test(wallet)) {
		return error(res, 400, 'invalid_wallet', 'wallet must be a Solana base-58 address.');
	}

	// Resolving by agent first gives us the live metrics for free, and the wallet
	// the attestations are keyed by.
	let stats = null;
	if (agentParam) {
		stats = await getTraderStats({ agentId: agentParam, network, window });
		if (!stats) return error(res, 404, 'agent_not_found', 'No three.ws agent with that id.');
		if (!stats.agent.wallet) {
			return error(res, 404, 'no_trading_wallet', 'That agent has never traded from a wallet, so it has nothing to attest.');
		}
		wallet = stats.agent.wallet;
	}

	const credentials = await loadCredentials({ wallet, network, window, limit: HISTORY_LIMIT });
	const credential = credentials.find((c) => !c.revoked) || null;

	// An unclaimed wallet still gets a passport document (with a null credential and
	// a designed reason) rather than a 404: a consumer integrating this endpoint
	// needs one predictable shape, not two.
	let agent = credential?.agent_id
		? { id: credential.agent_id, name: null, image: null, is_public: true }
		: null;
	if (!agent) agent = await agentForWallet({ wallet, network });

	if (wantLive && !stats && agent?.id) {
		stats = await getTraderStats({ agentId: agent.id, network, window });
	}
	if (stats) {
		agent = {
			id: stats.agent.id,
			name: stats.agent.name,
			image: stats.agent.image,
			is_public: stats.agent.is_public,
			copiers: stats.agent.copiers,
		};
	}

	const issuer = await resolveIssuer({ network, credentials });
	const live = stats
		? {
			score: stats.metrics.score,
			closed: stats.metrics.closed_count,
			win_rate: stats.metrics.win_rate,
			realized_pnl_sol: stats.metrics.realized_pnl_sol,
			max_drawdown_pct: stats.metrics.max_drawdown_pct,
			unique_coins: stats.metrics.unique_coins,
			verified: stats.metrics.verified === true,
		}
		: null;

	const body = {
		subject: {
			wallet,
			wallet_url: explorerAddr(wallet, network),
			agent,
			profile_url: agent?.id ? `${SITE}/trader/${agent.id}` : null,
		},
		network,
		window,
		kind: TRADESCORE_KIND,
		issuer,
		status: credential ? 'attested' : 'unattested',
		credential,
		credential_age_days: credential ? ageInDays(credential.block_time) : null,
		unattested_reason: credential ? null : unattestedReason(!!agent, live?.closed ?? 0),
		history: credentials.map((c) => ({
			day: c.day,
			signature: c.signature,
			block_time: c.block_time,
			score: c.snapshot.score,
			closed: c.snapshot.closed,
			realized_pnl_sol: c.snapshot.realized_pnl_sol,
			revoked: c.revoked,
			explorer_url: c.explorer_url,
		})),
		live,
		drift: credential && live ? scoreDrift(stats.metrics, credential.snapshot) : null,
		verify: {
			url: credential
				? `${SITE}/api/trader-passport/verify?signature=${encodeURIComponent(credential.signature)}&network=${network}`
				: null,
			how: 'Fetch the attestation transaction from any Solana RPC, read the SPL-Memo payload, and check that the issuer key signed it and the subject wallet is one of its accounts. /api/trader-passport/verify performs exactly that check and reads no database.',
		},
		generated_at: new Date().toISOString(),
	};

	return json(res, 200, body, { 'Cache-Control': 'public, max-age=60, stale-while-revalidate=300' });
});
