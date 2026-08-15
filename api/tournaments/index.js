/**
 * Social Trading Arena — tournament collection endpoint.
 *
 *   GET  /api/tournaments?network=mainnet&phase=live   → list (public)
 *   POST /api/tournaments                              → create (auth required)
 *
 * Tournaments are time-boxed PvP trading competitions scored on real, verified PnL
 * over a window (see api/_lib/tournament-scoring.js). Listing is public and IP
 * rate-limited; creation requires a signed-in user (session cookie or bearer token)
 * and records them as the creator.
 */

import { cors, json, method, wrap, error, rateLimited, readJson } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { env } from '../_lib/env.js';
import { createTournament, listTournaments, derivedStatus } from '../_lib/tournament-store.js';
import { attestationUrl } from '../_lib/tournament-attest.js';

const NETWORKS = new Set(['mainnet', 'devnet']);
const PHASES = new Set(['upcoming', 'live', 'finished']);
const SCORINGS = new Set(['score', 'realized_pnl', 'roi_pct']);
const BRACKETS = new Set(['prize', 'practice']);
const MAX_NAME = 120;
const MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MIN_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

async function resolveUser(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

/** Public projection of a tournament row for the list view. */
export function publicTournament(row, now = Date.now()) {
	const decimals = env.THREE_TOKEN_DECIMALS;
	return {
		id: row.id,
		name: row.name,
		description: row.description || null,
		network: row.network,
		scoring: row.scoring,
		bracket: row.bracket,
		status: row.status,
		phase: row.phase || undefined,
		derived_status: derivedStatus(row, now),
		starts_at: row.starts_at,
		ends_at: row.ends_at,
		entry_rules: row.entry_rules || {},
		prize_pool_three_atomics: String(row.prize_pool_three || 0),
		prize_pool_three: atomicsToThree(row.prize_pool_three || 0, decimals),
		prize_splits: row.prize_splits || [],
		entrant_count: Number(row.entrant_count || 0),
		attestation_sig: row.attestation_sig || null,
		attestation_url: row.attestation_sig ? attestationUrl(row.attestation_sig, row.network) : null,
		created_at: row.created_at,
	};
}

/**
 * Drop dead rows from the public list. A finished tournament nobody entered has no
 * result to show. It is a husk, and rendering it makes the Arena look like a
 * graveyard of empty brackets. Live and upcoming ones stay visible at 0 entrants:
 * those are still joinable, and hiding them would hide the thing you can act on.
 */
export function visibleTournaments(rows) {
	return rows.filter((r) => r.phase !== 'finished' || Number(r.entrant_count || 0) > 0);
}

function atomicsToThree(atomics, decimals) {
	const a = BigInt(atomics);
	if (a === 0n) return 0;
	const div = 10n ** BigInt(decimals);
	return Number(`${a / div}.${(a % div).toString().padStart(decimals, '0')}`);
}

const DECIMAL_RE = /^\d+(?:\.\d+)?$/;
// Far above $THREE's 1B supply. It exists to keep the value in plain decimal form,
// because JS renders anything past 1e21 in exponential notation.
const MAX_PRIZE_THREE = 1e15;

/**
 * Decimal $THREE to atomics, or null when the caller sent something that is not a
 * non-negative decimal amount. The conversion runs on TEXT, never on a float
 * round-trip: String(1e21) and String(0.0000001) are exponential notation, which
 * BigInt refuses, so both of those (plausible) request bodies used to escape the
 * validator and crash the handler with a 500 instead of being answered with a 400.
 * A numeric string is read as written, so precision beyond a double survives.
 */
export function threeToAtomics(amount, decimals) {
	let text;
	if (typeof amount === 'number') {
		if (!Number.isFinite(amount) || amount < 0 || amount > MAX_PRIZE_THREE) return null;
		text = amount.toFixed(decimals); // plain decimal even for exponential input
	} else if (typeof amount === 'string') {
		text = amount.trim();
	} else {
		return null;
	}
	if (!DECIMAL_RE.test(text) || Number(text) > MAX_PRIZE_THREE) return null;
	const [whole, frac = ''] = text.split('.');
	const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
	return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fracPadded || '0');
}

function validSplits(splits) {
	if (!Array.isArray(splits)) return false;
	let sum = 0;
	const ranks = new Set();
	for (const s of splits) {
		const rank = Number(s?.rank);
		const bps = Number(s?.bps);
		if (!Number.isInteger(rank) || rank < 1 || rank > 100) return false;
		if (!Number.isFinite(bps) || bps <= 0 || bps > 10000) return false;
		if (ranks.has(rank)) return false;
		ranks.add(rank);
		sum += bps;
	}
	return sum <= 10000;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	if (req.method === 'GET') {
		const rl = await limits.mcpIp(clientIp(req));
		if (!rl.success) return rateLimited(res, rl);

		const params = new URL(req.url, `http://${req.headers.host || 'x'}`).searchParams;
		const network = NETWORKS.has(params.get('network')) ? params.get('network') : null;
		const phase = PHASES.has(params.get('phase')) ? params.get('phase') : null;
		const now = Date.now();
		const rows = await listTournaments({ network, phase, now });
		const visible = visibleTournaments(rows);
		return json(
			res,
			200,
			{ tournaments: visible.map((r) => publicTournament(r, now)), t: now },
			{ 'cache-control': 'public, max-age=10, s-maxage=20' },
		);
	}

	// POST — create
	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const auth = await resolveUser(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required to create a tournament');

	let body;
	try {
		body = await readJson(req);
	} catch (err) {
		return error(res, err.status || 400, 'bad_request', err.message || 'invalid JSON body');
	}

	const name = String(body.name || '').trim();
	if (!name || name.length > MAX_NAME) {
		return error(res, 400, 'invalid_name', `name is required and must be ≤ ${MAX_NAME} chars`);
	}
	const network = NETWORKS.has(body.network) ? body.network : 'mainnet';
	const scoring = SCORINGS.has(body.scoring) ? body.scoring : 'score';
	const bracket = BRACKETS.has(body.bracket) ? body.bracket : 'prize';

	const startMs = Date.parse(body.starts_at);
	const endMs = Date.parse(body.ends_at);
	if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
		return error(res, 400, 'invalid_window', 'starts_at and ends_at must be ISO-8601 timestamps');
	}
	if (endMs <= startMs) return error(res, 400, 'invalid_window', 'ends_at must be after starts_at');
	const span = endMs - startMs;
	if (span < MIN_WINDOW_MS || span > MAX_WINDOW_MS) {
		return error(res, 400, 'invalid_window', 'tournament window must be between 5 minutes and 30 days');
	}
	if (endMs <= Date.now()) return error(res, 400, 'invalid_window', 'ends_at must be in the future');

	// Entry rules (anti-cheat gates + access gating).
	const rules = body.entry_rules && typeof body.entry_rules === 'object' ? body.entry_rules : {};
	const entry_rules = {};
	for (const k of ['min_closed', 'min_unique_coins', 'max_churn_pct']) {
		if (rules[k] != null && Number.isFinite(Number(rules[k])) && Number(rules[k]) >= 0) {
			entry_rules[k] = Number(rules[k]);
		}
	}
	if (rules.gated === true) entry_rules.gated = true;
	if (Array.isArray(rules.allow_agents)) {
		entry_rules.allow_agents = rules.allow_agents.filter((x) => typeof x === 'string').slice(0, 200);
	}

	// Prize pool (decimal $THREE → atomics). Practice brackets never carry a prize.
	const decimals = env.THREE_TOKEN_DECIMALS;
	let prizeAtomics = 0n;
	let prize_splits = [];
	if (bracket === 'prize' && body.prize_pool_three != null) {
		const atomics = threeToAtomics(body.prize_pool_three, decimals);
		if (atomics == null) {
			return error(
				res,
				400,
				'invalid_prize',
				`prize_pool_three must be a non-negative decimal amount of $THREE, at most ${MAX_PRIZE_THREE}`,
			);
		}
		prizeAtomics = atomics;
		if (prizeAtomics > 0n) {
			prize_splits = Array.isArray(body.prize_splits) && body.prize_splits.length
				? body.prize_splits.map((s) => ({ rank: Number(s.rank), bps: Number(s.bps) }))
				: [
						{ rank: 1, bps: 6000 },
						{ rank: 2, bps: 3000 },
						{ rank: 3, bps: 1000 },
					];
			if (!validSplits(prize_splits)) {
				return error(res, 400, 'invalid_splits', 'prize_splits ranks must be unique and bps must sum to ≤ 10000');
			}
		}
	}

	const status = startMs <= Date.now() ? 'live' : 'upcoming';
	const row = await createTournament({
		name,
		description: body.description ? String(body.description).slice(0, 2000) : null,
		network,
		scoring,
		bracket,
		starts_at: new Date(startMs).toISOString(),
		ends_at: new Date(endMs).toISOString(),
		entry_rules,
		prize_pool_three: prizeAtomics.toString(),
		prize_splits,
		status,
		created_by: auth.userId,
	});

	return json(res, 201, { tournament: publicTournament({ ...row, entrant_count: 0 }) }, { 'cache-control': 'no-store' });
});
