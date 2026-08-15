/**
 * Social Trading Arena: single-tournament endpoint + sub-routes.
 *
 *   GET  /api/tournaments/:id            → state + live standings + prize + attestation
 *   GET  /api/tournaments/:id/stream     → SSE live rank changes
 *   POST /api/tournaments/:id/join       → enter an agent you own (snapshots baseline)
 *   POST /api/tournaments/:id/withdraw   → withdraw an agent you own
 *   POST /api/tournaments/:id/close      → freeze + attest final standings (creator)
 *   POST /api/tournaments/:id/settle     → pay $THREE prizes (creator)
 *
 * Standings are computed live from the shared trader-stats truth layer over trades
 * OPENED inside the window, so the board, the SSE stream, and the on-chain
 * attestation can never disagree.
 */

import { cors, json, method, wrap, error, rateLimited, readJson } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { sql } from '../_lib/db.js';
import { isUuid } from '../_lib/validate.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { computeTraderMetrics, fetchTraderPositions } from '../_lib/trader-stats.js';
import {
	getTournament,
	getEntry,
	joinTournament,
	withdrawEntry,
	derivedStatus,
} from '../_lib/tournament-store.js';
import { loadStandings, finalizeTournament, settleNow } from '../_lib/tournament-engine.js';
import { attestationUrl } from '../_lib/tournament-attest.js';
import { settlementBlockReason } from '../_lib/tournament-settlement.js';
import { publicTournament } from './index.js';

const SSE_MAX_DURATION_MS = 90_000;
const SSE_PING_MS = 15_000;
const SSE_POLL_MS = 3_000;

async function resolveUser(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

/**
 * The id and the action, from the route params rather than the path.
 *
 * Both runtimes hand them over as query values: the filesystem resolver merges
 * `[id]`/`[action]` params into req.query, and the vercel.json rewrite carries them
 * as `?id=..&action=..` while rewriting the PATH to the literal
 * /api/tournaments/[id]/[action]. Reading the path first would therefore see the
 * placeholder `[id]` behind the rewrite and answer 400 for every valid request.
 */
function parseRoute(req) {
	const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
	const parts = url.pathname.split('/').filter(Boolean); // ['api','tournaments',id,sub]
	const id = String(req.query?.id ?? parts[2] ?? '');
	const sub = req.query?.action ?? parts[3] ?? null;
	return { id, sub: sub ? String(sub) : null, url };
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', origins: '*' })) return;

	const { id, sub } = parseRoute(req);
	if (!isUuid(id)) return error(res, 400, 'invalid_id', 'tournament id must be a UUID');

	if (sub === 'stream') {
		if (!method(req, res, ['GET'])) return;
		return handleStream(req, res, id);
	}

	if (!sub) {
		if (!method(req, res, ['GET'])) return;
		return handleState(req, res, id);
	}

	// Mutating sub-routes.
	if (!method(req, res, ['POST'])) return;
	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	if (sub === 'join') return handleJoin(req, res, id);
	if (sub === 'withdraw') return handleWithdraw(req, res, id);
	if (sub === 'close') return handleClose(req, res, id);
	if (sub === 'settle') return handleSettle(req, res, id);
	return error(res, 404, 'not_found', `unknown action ${sub}`);
});

async function handleState(req, res, id) {
	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const tournament = await getTournament(id);
	if (!tournament) return error(res, 404, 'not_found', 'tournament not found');

	const now = Date.now();
	const view = await loadStandings(tournament, { now });
	const settlement = settlementSummary(view.standings, tournament.network, tournament);

	return json(
		res,
		200,
		{
			tournament: publicTournament({ ...tournament, entrant_count: view.standings.length }, now),
			derived_status: derivedStatus(tournament, now),
			standings: view.standings,
			scoring: view.scoring,
			bracket: view.bracket,
			gates: view.gates,
			window: view.window,
			sol_usd: view.sol_usd,
			prize_pool_three: view.prize_pool_three,
			prize_pool_three_atomics: view.prize_pool_three_atomics,
			prize_splits: view.prize_splits,
			attestation: tournament.attestation_sig
				? { signature: tournament.attestation_sig, url: attestationUrl(tournament.attestation_sig, tournament.network) }
				: null,
			settlement,
			computed_at: view.computed_at,
		},
		{ 'cache-control': 'public, max-age=5, s-maxage=10' },
	);
}

function settlementSummary(standings, network, tournament) {
	const winners = standings.filter((s) => BigInt(s.persisted_prize_three_atomics || 0) > 0n);
	return {
		block_reason: settlementBlockReason(network, tournament),
		winners: winners.map((s) => ({
			agent_id: s.agent_id,
			agent_name: s.agent_name,
			rank: s.rank,
			prize_three_atomics: s.persisted_prize_three_atomics,
			settlement_status: s.settlement_status,
			settlement_tx: s.settlement_tx,
			settlement_url: s.settlement_tx ? attestationUrl(s.settlement_tx, network) : null,
		})),
	};
}

/** Resolve an agent's Solana trading wallet (latest sniper wallet → identity wallet). */
async function resolveAgentWallet(agentId, network) {
	const [pos] = await sql`
		select wallet from agent_sniper_positions
		where agent_id = ${agentId} and network = ${network} and wallet is not null
		order by opened_at desc limit 1
	`;
	if (pos?.wallet) return pos.wallet;
	const [a] = await sql`select wallet_address from agent_identities where id = ${agentId} limit 1`;
	return a?.wallet_address || null;
}

async function handleJoin(req, res, id) {
	const auth = await resolveUser(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required to join a tournament');

	let body;
	try {
		body = await readJson(req);
	} catch (err) {
		return error(res, err.status || 400, 'bad_request', err.message || 'invalid JSON body');
	}
	const agentId = String(body.agent_id || '').trim();
	if (!isUuid(agentId)) return error(res, 400, 'invalid_agent', 'agent_id must be a valid agent UUID');

	const tournament = await getTournament(id);
	if (!tournament) return error(res, 404, 'not_found', 'tournament not found');
	const status = derivedStatus(tournament, Date.now());
	if (['ended', 'closed', 'settled', 'cancelled'].includes(status)) {
		return error(res, 409, 'closed', 'this tournament has ended, entries are closed');
	}

	// Ownership check.
	const [agent] = await sql`
		select id, user_id, name, is_public from agent_identities where id = ${agentId} and deleted_at is null limit 1
	`;
	if (!agent) return error(res, 404, 'agent_not_found', 'agent not found');
	if (agent.user_id !== auth.userId) return error(res, 403, 'forbidden', 'that agent is not yours');

	// Access gating.
	const rules = tournament.entry_rules || {};
	if (rules.gated && Array.isArray(rules.allow_agents) && !rules.allow_agents.includes(agentId)) {
		return error(res, 403, 'not_invited', 'this tournament is gated and that agent is not on the allow list');
	}

	const wallet = await resolveAgentWallet(agentId, tournament.network);

	// Baseline snapshot: all-time metrics at join, so window scoping is auditable.
	let snapshot = {};
	try {
		const positions = await fetchTraderPositions({ agentId, network: tournament.network, window: 'all' });
		const m = computeTraderMetrics(positions, { solUsd: null });
		snapshot = {
			at: new Date().toISOString(),
			all_time_closed: m.closed_count,
			all_time_realized_pnl_sol: m.realized_pnl_sol,
			all_time_score: m.score,
			verified: m.verified,
		};
	} catch {
		snapshot = { at: new Date().toISOString() };
	}

	const { entry, created } = await joinTournament({ tournamentId: id, agentId, wallet, snapshot });
	if (!entry) return error(res, 500, 'join_failed', 'could not record the entry, try again');
	if (entry.status === 'disqualified') {
		return error(res, 409, 'disqualified', 'that agent was disqualified from this tournament and cannot re-enter');
	}

	return json(
		res,
		created ? 201 : 200,
		{
			joined: true,
			created,
			entry: {
				tournament_id: id,
				agent_id: agentId,
				agent_name: agent.name,
				wallet,
				status: entry.status,
				joined_at: entry.joined_at,
				starting_snapshot: entry.starting_snapshot,
			},
		},
		{ 'cache-control': 'no-store' },
	);
}

async function handleWithdraw(req, res, id) {
	const auth = await resolveUser(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	let body;
	try {
		body = await readJson(req);
	} catch (err) {
		return error(res, err.status || 400, 'bad_request', err.message || 'invalid JSON body');
	}
	const agentId = String(body.agent_id || '').trim();
	if (!isUuid(agentId)) return error(res, 400, 'invalid_agent', 'agent_id must be a valid agent UUID');

	const [agent] = await sql`select user_id from agent_identities where id = ${agentId} limit 1`;
	if (!agent) return error(res, 404, 'agent_not_found', 'agent not found');
	if (agent.user_id !== auth.userId) return error(res, 403, 'forbidden', 'that agent is not yours');

	const entry = await getEntry(id, agentId);
	if (!entry) return error(res, 404, 'not_entered', 'that agent is not entered in this tournament');

	const row = await withdrawEntry(id, agentId);
	return json(res, 200, { withdrawn: !!row }, { 'cache-control': 'no-store' });
}

/** Only the creator may close/settle. */
async function requireCreator(req, res, tournament) {
	const auth = await resolveUser(req);
	if (!auth) {
		error(res, 401, 'unauthorized', 'sign in required');
		return null;
	}
	if (!tournament.created_by || tournament.created_by !== auth.userId) {
		error(res, 403, 'forbidden', 'only the tournament creator can do that');
		return null;
	}
	return auth;
}

async function handleClose(req, res, id) {
	const tournament = await getTournament(id);
	if (!tournament) return error(res, 404, 'not_found', 'tournament not found');
	if (!(await requireCreator(req, res, tournament))) return;

	try {
		const result = await finalizeTournament(tournament, { now: Date.now() });
		return json(
			res,
			200,
			{
				closed: true,
				status: result.status,
				attestation: result.attestation,
				standings: result.standings.map((s) => ({
					rank: s.rank,
					agent_id: s.agent_id,
					agent_name: s.agent_name,
					score_value: s.score_value,
					eligible: s.eligible,
				})),
			},
			{ 'cache-control': 'no-store' },
		);
	} catch (err) {
		return error(res, err.status || 500, err.code || 'close_failed', err.message || 'could not close tournament');
	}
}

async function handleSettle(req, res, id) {
	const tournament = await getTournament(id);
	if (!tournament) return error(res, 404, 'not_found', 'tournament not found');
	if (!(await requireCreator(req, res, tournament))) return;

	try {
		const result = await settleNow(id, { now: Date.now() });
		return json(
			res,
			200,
			{
				settled: result.settled,
				blocked: result.blocked,
				skipped: result.skipped,
				block_reason: result.block_reason,
				status: result.status,
				results: result.results.map((r) => ({
					...r,
					tx_url: r.tx ? attestationUrl(r.tx, tournament.network) : null,
				})),
			},
			{ 'cache-control': 'no-store' },
		);
	} catch (err) {
		return error(res, err.status || 500, err.code || 'settle_failed', err.message || 'could not settle tournament');
	}
}

/** SSE: re-emit the ranked standings on an interval; the client animates rank deltas. */
async function handleStream(req, res, id) {
	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const tournament = await getTournament(id);
	if (!tournament) return error(res, 404, 'not_found', 'tournament not found');

	res.writeHead(200, {
		'Content-Type': 'text/event-stream; charset=utf-8',
		'Cache-Control': 'no-cache, no-transform',
		Connection: 'keep-alive',
		'X-Accel-Buffering': 'no',
	});
	res.flushHeaders?.();

	let active = true;
	const send = (event, data) => {
		if (!active) return;
		res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	};

	const poll = async () => {
		if (!active) return;
		try {
			const fresh = await getTournament(id);
			if (!fresh) return;
			const now = Date.now();
			const view = await loadStandings(fresh, { now });
			send('standings', {
				status: derivedStatus(fresh, now),
				computed_at: view.computed_at,
				standings: view.standings.map((s) => ({
					rank: s.rank,
					agent_id: s.agent_id,
					agent_name: s.agent_name,
					image: s.image,
					score_value: s.score_value,
					realized_pnl_sol: s.metrics.realized_pnl_sol,
					roi_pct: s.metrics.roi_pct,
					win_rate: s.metrics.win_rate,
					closed: s.in_window_trades,
					verified: s.metrics.verified,
					eligible: s.eligible,
					wash_suspected: s.wash_suspected,
					projected_prize_three: s.projected_prize_three,
					settlement_status: s.settlement_status,
					sample_trades: s.sample_trades,
				})),
			});
		} catch {
			send('error', { message: 'poll_failed' });
		}
	};

	send('open', { tournament_id: id, network: tournament.network });
	await poll();
	const pollTimer = setInterval(poll, SSE_POLL_MS);
	const ping = setInterval(() => send('ping', { t: Date.now() }), SSE_PING_MS);

	const teardown = () => {
		if (!active) return;
		active = false;
		clearInterval(pollTimer);
		clearInterval(ping);
		clearTimeout(durationTimer);
		try {
			res.end();
		} catch {
			/* already closed */
		}
	};
	const durationTimer = setTimeout(() => {
		send('close', { reason: 'duration_limit' });
		teardown();
	}, SSE_MAX_DURATION_MS);

	req.on('close', teardown);
}
