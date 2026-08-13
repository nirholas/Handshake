// GET /api/ledger/:agentId — the Reasoning Ledger timeline + explainable
// reputation for one agent. Public read (a track record is meant to be audited).
//
// Query: ?limit=50&before=<seq>&kind=snipe&q=<text>&network=mainnet
//
// Returns the headline reputation (with its full formula + per-component
// breakdown + calibration curve), the latest on-chain anchor summary, and a
// paginated, filterable decision timeline where each entry carries its reasoning,
// prediction, and — once reconciled — the real outcome (right/wrong, by how much).

import { json, method, wrap, error } from '../_lib/http.js';
import { sql } from '../_lib/db.js';
import {
	getDecisionsWithOutcomes,
	getReputationRecords,
	computeReputation,
	MAX_TIMELINE_LIMIT,
} from '../_lib/reasoning-ledger.js';
import { latestAnchor } from '../_lib/ledger-anchor.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Longest `kind` / `q` filter accepted. Both reach the database as bound
// parameters, so this is not an injection guard: it keeps an unauthenticated
// caller from driving an unbounded `ilike '%…%'` scan across an agent's history.
const MAX_FILTER_LEN = 200;

/**
 * Read a whole-number query param. Absent or empty means "not supplied"; garbage
 * is a 400 rather than a silent fallback. `before` used to be coerced with
 * Number(), so `?before=abc` sent NaN into a bigint comparison and answered a
 * sanitized 500 to what is plainly a client mistake.
 */
function intParam(url, name, min, max) {
	const raw = url.searchParams.get(name);
	if (raw == null || raw === '') return { value: null, error: null };
	if (!/^\d+$/.test(raw)) return { value: null, error: `${name} must be a whole number` };
	const n = Number(raw);
	if (!Number.isSafeInteger(n) || n < min || n > max) {
		return { value: null, error: `${name} must be between ${min} and ${max}` };
	}
	return { value: n, error: null };
}

function paramAgentId(req) {
	if (req.query?.agentId) return String(req.query.agentId);
	const m = String(req.url || '').match(/\/api\/ledger\/([^/?]+)/);
	return m ? decodeURIComponent(m[1]) : null;
}

function solscanUrl(sig, network) {
	if (!sig) return null;
	return network === 'devnet' ? `https://solscan.io/tx/${sig}?cluster=devnet` : `https://solscan.io/tx/${sig}`;
}

function shapeDecision(d) {
	const reconciled = d.outcome_status != null && d.was_correct != null;
	return {
		id: d.id,
		seq: Number(d.seq),
		kind: d.kind,
		subject_ref: d.subject_ref,
		action_ref: d.action_ref,
		inputs: d.inputs || {},
		rationale: d.rationale,
		prediction: d.prediction || {},
		confidence: d.confidence != null ? Number(d.confidence) : null,
		network: d.network,
		decided_at: d.decided_at,
		entry_hash: d.entry_hash,
		outcome: reconciled
			? {
					status: 'reconciled',
					was_correct: d.was_correct,
					pnl_sol: d.pnl_sol != null ? Number(d.pnl_sol) : null,
					impact: d.impact != null ? Number(d.impact) : null,
					observed: d.observed || {},
					reconciled_at: d.reconciled_at,
					proof_url: solscanUrl(d.observed?.sell_sig, d.network),
				}
			: { status: 'pending' },
	};
}

export default wrap(async (req, res) => {
	if (!method(req, res, ['GET'])) return;
	const agentId = paramAgentId(req);
	if (!agentId || !UUID_RE.test(agentId)) {
		return error(res, 400, 'bad_request', 'a valid agent id is required');
	}

	const url = new URL(req.url, 'http://localhost');
	const limitParam = intParam(url, 'limit', 1, MAX_TIMELINE_LIMIT);
	if (limitParam.error) return error(res, 400, 'bad_request', limitParam.error);
	const beforeParam = intParam(url, 'before', 1, Number.MAX_SAFE_INTEGER);
	if (beforeParam.error) return error(res, 400, 'bad_request', beforeParam.error);
	const limit = limitParam.value ?? 50;
	const before = beforeParam.value;
	const kind = url.searchParams.get('kind');
	const q = url.searchParams.get('q');
	if ((kind && kind.length > MAX_FILTER_LEN) || (q && q.length > MAX_FILTER_LEN)) {
		return error(res, 400, 'bad_request', `kind and q must be ${MAX_FILTER_LEN} characters or fewer`);
	}

	const [identity, repRecords, decisions, anchor] = await Promise.all([
		sql`select id, name, profile_image_url, avatar_url, is_public, deleted_at from agent_identities where id = ${agentId} limit 1`
			.then((r) => r[0] || null)
			.catch(() => null),
		getReputationRecords(agentId),
		getDecisionsWithOutcomes(agentId, {
			limit,
			beforeSeq: before,
			kind: kind || null,
			q: q || null,
		}),
		latestAnchor(agentId).catch(() => null),
	]);

	// The track record is public by design; the agent's identity is not. An
	// unlisted or deleted agent renders as the bare id, exactly like an id with no
	// identity row. This endpoint used to select is_public and never read it, so it
	// published the name and avatar of every agent its owner had made private.
	const named = !!identity && identity.is_public !== false && !identity.deleted_at;

	const reputation = computeReputation(repRecords);
	const shaped = decisions.map(shapeDecision);
	const nextBeforeSeq = shaped.length ? shaped[shaped.length - 1].seq : null;

	return json(res, 200, {
		agent: named
			? { id: identity.id, name: identity.name, image: identity.profile_image_url || identity.avatar_url || null }
			: { id: agentId, name: null, image: null },
		reputation,
		anchor: anchor
			? {
					status: anchor.status,
					signature: anchor.signature,
					head_hash: anchor.head_hash,
					through_seq: Number(anchor.through_seq),
					entry_count: Number(anchor.entry_count),
					anchored_at: anchor.anchored_at,
					network: anchor.network,
					explorer_url: solscanUrl(anchor.signature, anchor.network),
					detail: anchor.detail || null,
				}
			: null,
		decisions: shaped,
		paging: { next_before_seq: shaped.length >= limit ? nextBeforeSeq : null },
		filters: { kind: kind || null, q: q || null },
	}, { 'cache-control': 'public, s-maxage=15, stale-while-revalidate=60' });
});
