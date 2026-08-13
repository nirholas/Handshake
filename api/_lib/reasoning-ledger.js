/**
 * The Reasoning Ledger — capture, scoring, and tamper-evidence.
 *
 * Two layers, by design (mirrors trader-stats.js):
 *
 *   PURE (no DB, no network) — deterministic, unit-tested with adversarial cases:
 *     · canonicalizeEntry / computeEntryHash / genesisHash — the per-agent HASH
 *       CHAIN. Each entry commits to the previous, so a backdated or silently
 *       edited "thought" breaks the chain and is provably detectable.
 *     · buildChain / verifyChain — assemble and re-verify a chain end to end.
 *     · computeReputation / calibrationBuckets — a transparent, EXPLAINABLE
 *       reputation derived ONLY from reconciled outcomes. No opaque magic number;
 *       every point traces to entries, and the formula is returned alongside it.
 *
 *   IMPURE (DB) — the single write path every decision chokepoint calls:
 *     · recordDecision — append one tamper-evident decision to an agent's chain.
 *     · recordOutcome  — reconcile a decision against ground truth (idempotent).
 *     · getChainEntries / getDecisionsWithOutcomes / getReputation — reads.
 *
 * Honest by construction: the chain commits the reasoning + prediction at DECISION
 * time; outcomes are reconciled later against real on-chain/market data and stored
 * separately so the committed decision is never rewritten to flatter the agent.
 */

import { sql } from './db.js';
import { sha256 } from './crypto.js';

// ── Pure: canonicalization + hash chain ──────────────────────────────────────

const GENESIS_DOMAIN = 'threews-reasoning-ledger:v1';
const HASH_SEP = '\u0000'; // domain separator between prev_hash and the canonical body

/** Per-agent genesis hash. Binding it to the agent id prevents splicing one
 *  agent's prefix onto another's chain. The seq-1 entry uses this as prev_hash. */
export function genesisHash(agentId) {
	return `${GENESIS_DOMAIN}:${String(agentId)}`;
}

/**
 * Deterministic JSON: object keys sorted recursively, numbers via JS canonical
 * repr (shortest round-trip). This is what makes a hash reproducible across a
 * write → Postgres jsonb → read round-trip (jsonb does not preserve key order).
 */
export function stableStringify(value) {
	if (value === null || value === undefined) return 'null';
	if (typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
	const keys = Object.keys(value).sort();
	return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

/**
 * The exact bytes the entry_hash commits to. Only DECISION-TIME fields are
 * included — never the outcome — so reconciling a decision can never alter its
 * hash. Floats (confidence) are fixed-precision and timestamps are normalized
 * through a Date round-trip so the value read back from PG hashes identically.
 */
export function canonicalizeEntry(entry) {
	return stableStringify({
		seq: Number(entry.seq),
		agent_id: String(entry.agent_id),
		kind: String(entry.kind),
		subject_ref: entry.subject_ref ?? null,
		action_ref: entry.action_ref ?? null,
		inputs: entry.inputs ?? {},
		rationale: entry.rationale ?? '',
		prediction: entry.prediction ?? {},
		confidence: Number(Number(entry.confidence ?? 0).toFixed(6)),
		network: entry.network ?? null,
		decided_at: new Date(entry.decided_at).toISOString(),
	});
}

/** entry_hash = sha256(prev_hash ‖ canonical(entry)). */
export async function computeEntryHash(prevHash, entry) {
	return sha256(String(prevHash) + HASH_SEP + canonicalizeEntry(entry));
}

/**
 * Assemble a fresh chain from raw decisions (no seq/prev/hash yet). Returns the
 * same entries with seq (1-based), prev_hash, and entry_hash filled in. Pure —
 * the DB write path uses computeEntryHash directly with the persisted head, but
 * tests and verification reuse this to build/replay a chain in memory.
 */
export async function buildChain(agentId, rawEntries, startSeq = 1, startPrev = null) {
	let prev = startPrev ?? genesisHash(agentId);
	let seq = startSeq;
	const out = [];
	for (const raw of rawEntries) {
		const entry = { ...raw, agent_id: agentId, seq };
		entry.prev_hash = prev;
		entry.entry_hash = await computeEntryHash(prev, entry);
		out.push(entry);
		prev = entry.entry_hash;
		seq += 1;
	}
	return out;
}

/**
 * Re-verify a persisted chain. Returns the integrity verdict WITHOUT trusting any
 * stored hash — every entry_hash is recomputed from its committed fields and
 * checked against both the stored entry_hash and the next entry's prev_hash. The
 * first inconsistency (edited field, broken link, sequence gap, wrong genesis) is
 * reported with its seq, so a tamper attempt is pinpointed, not just flagged.
 *
 * @param {string} agentId
 * @param {Array<object>} entries  decision rows ordered by seq ascending.
 * @returns {Promise<{ok:boolean, count:number, head_hash:string|null,
 *   computed_head:string|null, broken_at:number|null, reason:string|null}>}
 */
export async function verifyChain(agentId, entries) {
	const ordered = [...entries].sort((a, b) => Number(a.seq) - Number(b.seq));
	let prev = genesisHash(agentId);
	let computedHead = null;
	let storedHead = null;
	for (let i = 0; i < ordered.length; i++) {
		const e = ordered[i];
		const expectedSeq = i + 1;
		if (Number(e.seq) !== expectedSeq) {
			return broken(ordered.length, computedHead, expectedSeq, `sequence gap: expected seq ${expectedSeq}, found ${e.seq}`);
		}
		if (String(e.prev_hash) !== prev) {
			return broken(ordered.length, computedHead, Number(e.seq), 'prev_hash does not link to the previous entry');
		}
		const recomputed = await computeEntryHash(prev, e);
		if (recomputed !== String(e.entry_hash)) {
			return broken(ordered.length, computedHead, Number(e.seq), 'entry_hash does not match committed contents (entry was altered)');
		}
		prev = recomputed;
		computedHead = recomputed;
		storedHead = String(e.entry_hash);
	}
	return { ok: true, count: ordered.length, head_hash: storedHead, computed_head: computedHead, broken_at: null, reason: null };
}

function broken(count, computedHead, seq, reason) {
	return { ok: false, count, head_hash: null, computed_head: computedHead, broken_at: seq, reason };
}

// ── Pure: reputation + calibration ───────────────────────────────────────────

const REPUTATION_VERSION = 'rep-v1';
// Transparent weights — the score is a documented blend, not a black box.
const REP_WEIGHTS = { hitRate: 0.5, calibration: 0.3, pnl: 0.2 };
const CONFIDENCE_FULL_AT = 20;  // reconciled decisions for full statistical confidence
const NEUTRAL = 0.5;            // unproven agents regress toward neutral
const PNL_TANH_SOL = 5;         // ~5 SOL net realized ≈ a strongly positive sub-score
// Five equal confidence buckets for the calibration curve.
const CALIBRATION_EDGES = [0, 0.2, 0.4, 0.6, 0.8, 1.0001];

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/**
 * Bucket reconciled records by self-rated confidence and compare predicted
 * confidence against the actual hit rate in each bucket. A well-calibrated agent's
 * 80%-confidence calls hit ~80% of the time. Returns one bucket per band plus the
 * Expected Calibration Error (ECE) — the sample-weighted mean gap.
 */
export function calibrationBuckets(records) {
	const reconciled = records.filter((r) => r.was_correct === true || r.was_correct === false);
	const buckets = [];
	for (let i = 0; i < CALIBRATION_EDGES.length - 1; i++) {
		const lo = CALIBRATION_EDGES[i];
		const hi = CALIBRATION_EDGES[i + 1];
		const inBucket = reconciled.filter((r) => {
			const c = clamp(Number(r.confidence ?? 0), 0, 1);
			return c >= lo && c < hi;
		});
		const n = inBucket.length;
		const correct = inBucket.filter((r) => r.was_correct === true).length;
		const avgConf = n ? inBucket.reduce((a, r) => a + clamp(Number(r.confidence ?? 0), 0, 1), 0) / n : null;
		const accuracy = n ? correct / n : null;
		buckets.push({
			label: `${Math.round(lo * 100)}–${Math.round(Math.min(hi, 1) * 100)}%`,
			lo,
			hi: Math.min(hi, 1),
			count: n,
			predicted: avgConf != null ? Number(avgConf.toFixed(4)) : null,
			actual: accuracy != null ? Number(accuracy.toFixed(4)) : null,
		});
	}
	const total = reconciled.length;
	let ece = 0;
	if (total > 0) {
		for (const b of buckets) {
			if (b.count > 0 && b.predicted != null && b.actual != null) {
				ece += (b.count / total) * Math.abs(b.predicted - b.actual);
			}
		}
	}
	return { buckets, ece: total > 0 ? Number(ece.toFixed(4)) : null, sample_size: total };
}

/**
 * Compute an EXPLAINABLE reputation from reconciled decisions. Pure: no DB. Every
 * component is returned with its raw value, weight, and contribution, plus a plain
 * description and the regression applied for small samples — so the UI can show
 * exactly how the headline number was reached.
 *
 * @param {Array<{kind:string,confidence:number,was_correct:boolean|null,pnl_sol:number|null,decided_at?:string}>} records
 * @returns {object}
 */
export function computeReputation(records) {
	const all = Array.isArray(records) ? records : [];
	const reconciled = all.filter((r) => r.was_correct === true || r.was_correct === false);
	const pending = all.length - reconciled.length;
	const sample = reconciled.length;

	const correct = reconciled.filter((r) => r.was_correct === true).length;
	const hitRate = sample ? correct / sample : 0;

	const cal = calibrationBuckets(reconciled);
	const calibrationScore = cal.ece == null ? NEUTRAL : clamp(1 - cal.ece, 0, 1);

	// Net realized P&L over reconciled trade-like decisions (others contribute 0).
	const netPnlSol = reconciled.reduce((a, r) => a + (Number.isFinite(r.pnl_sol) ? Number(r.pnl_sol) : 0), 0);
	const pnlComponent = 0.5 + 0.5 * Math.tanh(netPnlSol / PNL_TANH_SOL);

	const rawScore =
		REP_WEIGHTS.hitRate * hitRate +
		REP_WEIGHTS.calibration * calibrationScore +
		REP_WEIGHTS.pnl * pnlComponent;

	// Regress toward neutral until the agent has enough reconciled decisions to trust.
	const confidence = clamp(sample / CONFIDENCE_FULL_AT, 0, 1);
	const effective = rawScore * confidence + NEUTRAL * (1 - confidence);
	const score = Math.round(100 * effective);

	const components = [
		{
			key: 'hit_rate',
			label: 'Hit rate',
			description: 'Share of reconciled calls that went the predicted way.',
			value: Number(hitRate.toFixed(4)),
			weight: REP_WEIGHTS.hitRate,
			contribution: Number((REP_WEIGHTS.hitRate * hitRate).toFixed(4)),
		},
		{
			key: 'calibration',
			label: 'Calibration',
			description: 'How well stated confidence matches reality (1 − expected calibration error).',
			value: Number(calibrationScore.toFixed(4)),
			weight: REP_WEIGHTS.calibration,
			contribution: Number((REP_WEIGHTS.calibration * calibrationScore).toFixed(4)),
		},
		{
			key: 'pnl',
			label: 'Realized P&L',
			description: 'Net realized SOL across reconciled trades, squashed to 0–1.',
			value: Number(pnlComponent.toFixed(4)),
			weight: REP_WEIGHTS.pnl,
			contribution: Number((REP_WEIGHTS.pnl * pnlComponent).toFixed(4)),
		},
	];

	return {
		version: REPUTATION_VERSION,
		score,
		sample_size: sample,
		pending_count: pending,
		decisions_total: all.length,
		hit_rate: Number(hitRate.toFixed(4)),
		wins: correct,
		losses: sample - correct,
		calibration_error: cal.ece,
		calibration_score: Number(calibrationScore.toFixed(4)),
		net_pnl_sol: Number(netPnlSol.toFixed(6)),
		confidence: Number(confidence.toFixed(3)),
		raw_score: Number(rawScore.toFixed(4)),
		neutral: NEUTRAL,
		components,
		calibration: cal.buckets,
		formula:
			'score = 100 × (raw × c + 0.5 × (1−c)), where ' +
			'raw = 0.5·hit_rate + 0.3·calibration + 0.2·pnl, and ' +
			`c = min(sample_size / ${CONFIDENCE_FULL_AT}, 1). ` +
			'Calibration = 1 − ECE. P&L = 0.5 + 0.5·tanh(net_sol / 5).',
		weights: REP_WEIGHTS,
	};
}

// ── Impure: the write path every chokepoint calls ────────────────────────────

const MAX_APPEND_RETRIES = 5;

/**
 * Append one tamper-evident decision to an agent's chain. Idempotent on
 * (agent_id, kind, subject_ref, action_ref): a chokepoint that fires twice for the
 * same real-world action records once. Concurrency-safe via optimistic
 * seq-claiming against the unique(agent_id, seq) constraint.
 *
 * @param {object} d
 * @param {string} d.agentId
 * @param {string} d.kind
 * @param {string} [d.subjectRef]
 * @param {string} [d.actionRef]
 * @param {object} [d.inputs]
 * @param {string} [d.rationale]
 * @param {object} [d.prediction]
 * @param {number} [d.confidence]   0..1
 * @param {string} [d.network]
 * @param {Date|string} [d.decidedAt]  defaults to now (captured here, not in SQL)
 * @returns {Promise<{id:string, seq:number, entry_hash:string, deduped:boolean}>}
 */
export async function recordDecision(d) {
	const agentId = d.agentId;
	if (!agentId) throw new Error('recordDecision: agentId required');
	if (!d.kind) throw new Error('recordDecision: kind required');

	const subjectRef = d.subjectRef ?? null;
	const actionRef = d.actionRef ?? null;
	const inputs = d.inputs && typeof d.inputs === 'object' ? d.inputs : {};
	const rationale = typeof d.rationale === 'string' ? d.rationale.slice(0, 4000) : '';
	const prediction = d.prediction && typeof d.prediction === 'object' ? d.prediction : {};
	const confidence = clamp(Number(d.confidence ?? 0.5), 0, 1);
	const network = d.network ?? null;
	const decidedAt = new Date(d.decidedAt ?? Date.now()).toISOString();

	// Idempotent: already captured? Return it.
	const [existing] = await sql`
		select id, seq, entry_hash from agent_decisions
		where agent_id = ${agentId} and kind = ${d.kind}
		  and subject_ref is not distinct from ${subjectRef}
		  and action_ref is not distinct from ${actionRef}
		limit 1
	`;
	if (existing) {
		return { id: existing.id, seq: Number(existing.seq), entry_hash: existing.entry_hash, deduped: true };
	}

	for (let attempt = 0; attempt < MAX_APPEND_RETRIES; attempt++) {
		const [head] = await sql`
			select seq, entry_hash from agent_decisions
			where agent_id = ${agentId} order by seq desc limit 1
		`;
		const seq = head ? Number(head.seq) + 1 : 1;
		const prevHash = head ? head.entry_hash : genesisHash(agentId);
		const entry = {
			seq, agent_id: agentId, kind: d.kind, subject_ref: subjectRef, action_ref: actionRef,
			inputs, rationale, prediction, confidence, network, decided_at: decidedAt,
		};
		const entryHash = await computeEntryHash(prevHash, entry);

		const rows = await sql`
			insert into agent_decisions
				(agent_id, seq, kind, subject_ref, action_ref, inputs, rationale, prediction,
				 confidence, network, decided_at, prev_hash, entry_hash)
			values
				(${agentId}, ${seq}, ${d.kind}, ${subjectRef}, ${actionRef},
				 ${JSON.stringify(inputs)}::jsonb, ${rationale}, ${JSON.stringify(prediction)}::jsonb,
				 ${confidence}, ${network}, ${decidedAt}, ${prevHash}, ${entryHash})
			on conflict do nothing
			returning id, seq, entry_hash
		`;
		if (rows.length) {
			return { id: rows[0].id, seq: Number(rows[0].seq), entry_hash: rows[0].entry_hash, deduped: false };
		}
		// Lost a race for this seq (or the idempotency key just landed). Re-check the
		// idempotency key — if a concurrent writer captured the same action, dedupe.
		const [now] = await sql`
			select id, seq, entry_hash from agent_decisions
			where agent_id = ${agentId} and kind = ${d.kind}
			  and subject_ref is not distinct from ${subjectRef}
			  and action_ref is not distinct from ${actionRef}
			limit 1
		`;
		if (now) return { id: now.id, seq: Number(now.seq), entry_hash: now.entry_hash, deduped: true };
		// Otherwise it was a pure seq collision — loop and claim the next seq.
	}
	throw new Error('recordDecision: could not claim a chain slot after retries');
}

/**
 * Reconcile a decision against ground truth. Idempotent — a second call for an
 * already-reconciled decision is a no-op (the first outcome stands), so a cron
 * that re-runs over late/again data never double-counts.
 *
 * @param {object} o
 * @param {string} o.decisionId
 * @param {string} o.agentId
 * @param {object} [o.observed]
 * @param {boolean|null} [o.wasCorrect]
 * @param {number|null} [o.pnlSol]
 * @param {number|null} [o.impact]
 * @param {string} [o.status]  'reconciled' | 'unresolved'
 * @returns {Promise<{reconciled:boolean}>}
 */
export async function recordOutcome(o) {
	const rows = await sql`
		insert into decision_outcomes (decision_id, agent_id, observed, was_correct, pnl_sol, impact, status)
		values (
			${o.decisionId}, ${o.agentId}, ${JSON.stringify(o.observed ?? {})}::jsonb,
			${o.wasCorrect ?? null}, ${o.pnlSol ?? null}, ${o.impact ?? null}, ${o.status ?? 'reconciled'}
		)
		on conflict (decision_id) do nothing
		returning decision_id
	`;
	return { reconciled: rows.length > 0 };
}

/** All chain entries for an agent, ordered by seq ascending (for verification). */
export async function getChainEntries(agentId) {
	return sql`
		select id, agent_id, seq, kind, subject_ref, action_ref, inputs, rationale,
		       prediction, confidence, network, decided_at, prev_hash, entry_hash
		from agent_decisions
		where agent_id = ${agentId}
		order by seq asc
	`;
}

/**
 * Largest page this read will ever return. Exported so the HTTP layer validates
 * against the SAME bound it will be clamped to here — a caller that asked for
 * more than one page's worth would otherwise get a silently truncated page and a
 * `next_before_seq: null` telling them the ledger ended.
 */
export const MAX_TIMELINE_LIMIT = 200;

/**
 * Decision timeline joined to outcomes, newest first. Filterable by kind and a
 * free-text query over the rationale/subject. Paginated by `beforeSeq`.
 */
export async function getDecisionsWithOutcomes(agentId, { limit = 50, beforeSeq = null, kind = null, q = null } = {}) {
	const lim = clamp(Number(limit) || 50, 1, MAX_TIMELINE_LIMIT);
	const beforeClause = beforeSeq != null ? sql`and d.seq < ${Number(beforeSeq)}` : sql``;
	const kindClause = kind ? sql`and d.kind = ${kind}` : sql``;
	const qClause = q
		? sql`and (d.rationale ilike ${'%' + String(q) + '%'} or d.subject_ref ilike ${'%' + String(q) + '%'})`
		: sql``;
	return sql`
		select d.id, d.seq, d.kind, d.subject_ref, d.action_ref, d.inputs, d.rationale,
		       d.prediction, d.confidence, d.network, d.decided_at, d.entry_hash,
		       o.observed, o.was_correct, o.pnl_sol, o.impact, o.status as outcome_status, o.reconciled_at
		from agent_decisions d
		left join decision_outcomes o on o.decision_id = d.id
		where d.agent_id = ${agentId} ${kindClause} ${qClause} ${beforeClause}
		order by d.seq desc
		limit ${lim}
	`;
}

/** Reconciled+pending records flattened for computeReputation. */
export async function getReputationRecords(agentId) {
	return sql`
		select d.kind, d.confidence, d.decided_at, o.was_correct, o.pnl_sol
		from agent_decisions d
		left join decision_outcomes o on o.decision_id = d.id
		where d.agent_id = ${agentId}
	`;
}

/** Convenience: load records and compute the explainable reputation. */
export async function getReputation(agentId) {
	const records = await getReputationRecords(agentId);
	return computeReputation(records);
}

export { REPUTATION_VERSION };
