// Reflection & Dreams — the memory-consolidation engine (Living Agents · Task 04).
//
// An agent "reflects": it reads its own recent raw memories + signed action log
// and runs a real LLM pass that synthesizes higher-order insights ("dreams").
// Each dream cites the raw memory ids it drew from — provenance is mandatory; a
// dream with no real source memory is dropped, never stored.
//
// This module is pure orchestration over the DB + the shared LLM proxy
// (api/_lib/llm.js). It is called from three places, all real triggers:
//   • POST /api/agent/reflect   — on-demand, when the owner opens the review surface
//   • /api/cron/reflect-sweep   — scheduled pass over agents with recent activity
//   • the dreams review endpoint — to enforce caps / read state
//
// Cost & rate discipline (no silent caps): every pass writes an
// agent_reflection_runs row — including skips — recording why it ran or didn't,
// how many candidates the model produced, and the token counts. The daily cap
// and debounce are enforced against that log.

import { sql } from './db.js';
import { llmComplete, LlmUnavailableError } from './llm.js';

// Preferred synthesis model. Per CLAUDE.md, default to the latest Claude for
// synthesis quality — passed as the Anthropic model so that when the paid key
// is live the chain uses it; the free providers (Groq/OpenRouter/NVIDIA) remain
// the actual workhorses and the call still succeeds when the paid key is dead.
export const REFLECTION_MODEL = 'claude-opus-5';

// How many successful reflection passes an agent may run per rolling 24h. A pass
// can produce 0..MAX_INSIGHTS dreams; this caps the LLM spend, not the dreams.
export const REFLECTION_DAILY_CAP = Number(process.env.REFLECTION_DAILY_CAP) || 8;

// Don't reflect more often than this (debounce). Opening the review surface
// repeatedly must not trigger a fresh pass each time. Manual/forced runs bypass.
export const REFLECTION_DEBOUNCE_MS = Number(process.env.REFLECTION_DEBOUNCE_MS) || 30 * 60 * 1000;

// Below this much new raw material there's nothing worth consolidating — skip.
export const MIN_NEW_SIGNALS = 3;

// Hard ceiling on dreams per pass so one run can't flood the review queue.
export const MAX_INSIGHTS = 5;

// How far back to look on the very first reflection (no prior run to bound from).
const FIRST_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;

// Caps on how much context we feed the model, to bound token cost.
const MAX_MEMORIES_IN_CONTEXT = 60;
const MAX_ACTIONS_IN_CONTEXT = 40;
const MAX_REJECTED_IN_CONTEXT = 12;

/**
 * Decide whether an agent is eligible to reflect right now and, if so, gather
 * the raw signal since its last pass.
 *
 * Returns one of:
 *   { eligible: false, reason }                              — skip (logged)
 *   { eligible: true, since, memories, actions, rejected }   — go
 */
export async function gatherReflectionContext(agentId, { force = false } = {}) {
	const [lastRun] = await sql`
		SELECT created_at, status
		FROM agent_reflection_runs
		WHERE agent_id = ${agentId}
		ORDER BY created_at DESC
		LIMIT 1
	`;

	if (!force && lastRun) {
		const sinceLast = Date.now() - new Date(lastRun.created_at).getTime();
		if (sinceLast < REFLECTION_DEBOUNCE_MS) {
			const mins = Math.ceil((REFLECTION_DEBOUNCE_MS - sinceLast) / 60000);
			return { eligible: false, reason: `debounced — reflected ${Math.round(sinceLast / 60000)}m ago, next in ~${mins}m` };
		}
	}

	const [{ runs } = { runs: 0 }] = await sql`
		SELECT COUNT(*)::int AS runs
		FROM agent_reflection_runs
		WHERE agent_id = ${agentId}
		  AND status = 'ok'
		  AND created_at > now() - interval '24 hours'
	`;
	if (!force && runs >= REFLECTION_DAILY_CAP) {
		return { eligible: false, reason: `daily cap reached (${runs}/${REFLECTION_DAILY_CAP} reflections in 24h)` };
	}

	// Bound the window to "since the last successful reflection" so we only
	// consolidate genuinely new material. Falls back to a fixed lookback on the
	// first-ever pass.
	const [lastOk] = await sql`
		SELECT created_at
		FROM agent_reflection_runs
		WHERE agent_id = ${agentId} AND status = 'ok'
		ORDER BY created_at DESC
		LIMIT 1
	`;
	const since = lastOk ? new Date(lastOk.created_at) : new Date(Date.now() - FIRST_LOOKBACK_MS);
	const sinceIso = since.toISOString();

	const memories = await sql`
		SELECT id, type, content, tags, salience, created_at
		FROM agent_memories
		WHERE agent_id = ${agentId}
		  AND (expires_at IS NULL OR expires_at > now())
		  AND created_at > ${sinceIso}
		ORDER BY salience DESC, created_at DESC
		LIMIT ${MAX_MEMORIES_IN_CONTEXT}
	`;

	const actions = await sql`
		SELECT id, type, payload, source_skill, created_at
		FROM agent_actions
		WHERE agent_id = ${agentId}
		  AND created_at > ${sinceIso}
		ORDER BY created_at DESC
		LIMIT ${MAX_ACTIONS_IN_CONTEXT}
	`;

	const signals = memories.length + actions.length;
	if (signals < MIN_NEW_SIGNALS) {
		return { eligible: false, reason: `not enough new material (${signals} new signals since last reflection; need ${MIN_NEW_SIGNALS})` };
	}

	// Feed prior rejections back in so the agent learns not to re-propose a
	// synthesis the owner already rejected. This is the learning loop.
	const rejected = await sql`
		SELECT statement
		FROM agent_reflections
		WHERE agent_id = ${agentId} AND status = 'rejected'
		ORDER BY reviewed_at DESC NULLS LAST, created_at DESC
		LIMIT ${MAX_REJECTED_IN_CONTEXT}
	`;

	return { eligible: true, since, memories, actions, rejected };
}

const SYSTEM_PROMPT = [
	'You are the reflective faculty of a personal AI agent — the part of its mind that,',
	'while the user is away, reviews recent experience and consolidates it into',
	'higher-order understanding. This is the Stanford "Generative Agents" reflection',
	'mechanism: from many raw observations, synthesize a few durable insights.',
	'',
	'You are given the agent\'s recent raw MEMORIES (each with a stable id) and recent',
	'ACTIONS. Produce up to ' + MAX_INSIGHTS + ' candidate insights. Rules:',
	'',
	'1. PROVENANCE IS MANDATORY. Every insight must cite "source_memory_ids" — the',
	'   exact ids of the memories it was derived from. Use only ids that appear in the',
	'   provided memories. An insight you cannot ground in specific memories is invalid;',
	'   do not emit it.',
	'2. SYNTHESIZE, don\'t restate. A good insight notices a pattern across multiple',
	'   memories ("three conversations were about settlement speed → the user prioritizes',
	'   finality over fees"), or proposes a useful routine, or forms a belief about the',
	'   user. Prefer insights grounded in 2+ memories.',
	'3. Be honest about confidence (0..1). If you are unsure but the pattern matters,',
	'   set kind="question" and put a specific clarifying question in "question".',
	'4. Do not repeat anything in PREVIOUSLY REJECTED — the user already rejected those',
	'   syntheses; proposing them again is a mistake.',
	'5. Choose a memory "proposed_type": user (facts about the user), feedback (how the',
	'   agent should behave), project (ongoing work/goals), reference (external pointers).',
	'   Set "proposed_salience" higher (0.6–0.95) than a raw memory — a consolidated',
	'   insight is more important than any single observation.',
	'6. Optionally propose ONE automation in "proposed_action" when an insight implies a',
	'   recurring helpful behavior (e.g. {"kind":"briefing","summary":"morning $THREE',
	'   alert digest","trigger":"daily 9am"}). Otherwise null.',
	'',
	'Return ONLY a JSON object, no prose, no markdown fences:',
	'{"insights":[{"kind":"insight|belief|question|prune","statement":"...","rationale":"why, from the memories","confidence":0.0,"source_memory_ids":["uuid",...],"proposed_type":"user|feedback|project|reference","proposed_salience":0.0,"proposed_action":{...}|null,"question":"...|null"}]}',
	'If there is nothing worth consolidating, return {"insights":[]}.',
].join('\n');

function buildUserPrompt({ agent, memories, actions, rejected }) {
	const lines = [];
	lines.push(`AGENT: ${agent?.name || 'Agent'}${agent?.description ? ` — ${agent.description}` : ''}`);
	lines.push('');
	lines.push('RECENT MEMORIES:');
	for (const m of memories) {
		const tags = Array.isArray(m.tags) && m.tags.length ? ` [${m.tags.join(', ')}]` : '';
		const when = new Date(m.created_at).toISOString().slice(0, 10);
		lines.push(`- id=${m.id} (${m.type}, salience ${Number(m.salience).toFixed(2)}, ${when})${tags}: ${truncate(m.content, 500)}`);
	}
	if (actions.length) {
		lines.push('');
		lines.push('RECENT ACTIONS (what the agent actually did):');
		for (const a of actions) {
			const when = new Date(a.created_at).toISOString().slice(0, 16).replace('T', ' ');
			const detail = a.payload ? truncate(JSON.stringify(a.payload), 200) : '';
			lines.push(`- ${when} ${a.type}${a.source_skill ? ` via ${a.source_skill}` : ''}: ${detail}`);
		}
	}
	if (rejected?.length) {
		lines.push('');
		lines.push('PREVIOUSLY REJECTED (do not propose these again):');
		for (const r of rejected) lines.push(`- ${truncate(r.statement, 200)}`);
	}
	lines.push('');
	lines.push(`Synthesize up to ${MAX_INSIGHTS} grounded insights as the specified JSON.`);
	return lines.join('\n');
}

function truncate(s, n) {
	const str = String(s ?? '');
	return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

/**
 * Extract the first JSON object from a model response, tolerant of code fences
 * or stray prose around it. Returns the parsed object or null — never throws.
 */
export function parseInsightPayload(text) {
	if (!text) return null;
	let body = String(text).trim();
	// Strip ```json … ``` fences if present.
	const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fence) body = fence[1].trim();
	// Fall back to the first balanced { … } span.
	if (body[0] !== '{') {
		const start = body.indexOf('{');
		const end = body.lastIndexOf('}');
		if (start === -1 || end === -1 || end <= start) return null;
		body = body.slice(start, end + 1);
	}
	try {
		return JSON.parse(body);
	} catch {
		return null;
	}
}

const VALID_TYPES = ['user', 'feedback', 'project', 'reference'];
const VALID_KINDS = ['insight', 'belief', 'question', 'prune'];

function clamp(n, lo, hi, dflt) {
	const v = Number(n);
	if (!Number.isFinite(v)) return dflt;
	return Math.max(lo, Math.min(hi, v));
}

/**
 * Validate one raw model insight against the strict schema + provenance rule.
 * `validIds` is a Set of memory ids that were actually fed to the model.
 * Returns a normalized insight object, or null if it must be dropped.
 */
export function validateInsight(raw, validIds) {
	if (!raw || typeof raw !== 'object') return null;

	const statement = typeof raw.statement === 'string' ? raw.statement.trim() : '';
	if (!statement || statement.length > 1000) return null;

	// Provenance: keep only cited ids that were really in the context. Require ≥1.
	const cited = Array.isArray(raw.source_memory_ids) ? raw.source_memory_ids : [];
	const sourceIds = [...new Set(cited.filter((id) => typeof id === 'string' && validIds.has(id)))];
	if (sourceIds.length === 0) return null;

	let kind = VALID_KINDS.includes(raw.kind) ? raw.kind : 'insight';
	const confidence = clamp(raw.confidence, 0, 1, 0.5);
	const question = typeof raw.question === 'string' && raw.question.trim() ? raw.question.trim().slice(0, 600) : null;
	// A genuine clarification with a question is a 'question' dream regardless of
	// the model's label — that's what unlocks the answer flow in the UI.
	if (question && confidence < 0.55) kind = 'question';

	const proposedType = VALID_TYPES.includes(raw.proposed_type) ? raw.proposed_type : 'project';
	const proposedSalience = clamp(raw.proposed_salience, 0.5, 0.95, 0.7);

	let proposedAction = null;
	if (raw.proposed_action && typeof raw.proposed_action === 'object' && !Array.isArray(raw.proposed_action)) {
		// Store the proposal verbatim but bounded; Autopilot (Task 08) consumes it.
		const serialized = JSON.stringify(raw.proposed_action);
		if (serialized.length <= 4000) proposedAction = raw.proposed_action;
	}

	return {
		kind,
		statement,
		rationale: typeof raw.rationale === 'string' ? raw.rationale.trim().slice(0, 1200) : null,
		confidence,
		sourceIds,
		proposedType,
		proposedSalience,
		proposedAction,
		question,
	};
}

/**
 * Run one reflection pass for an agent. Always records an agent_reflection_runs
 * row (ok / skipped / error) so caps + debounce are enforceable and nothing is
 * silently dropped.
 *
 * @param {object}  opts
 * @param {string}  opts.agentId
 * @param {string}  opts.userId         owner (for LLM spend attribution)
 * @param {string}  opts.trigger        'cron' | 'on-demand' | 'manual'
 * @param {object}  opts.agent          { name, description } for prompt context
 * @param {boolean} opts.force          bypass debounce + daily cap (manual only)
 * @returns {Promise<{status:'ok'|'skipped'|'error', reason?:string, runId?:string,
 *                     created:Array, candidates:number}>}
 */
export async function runReflection({ agentId, userId = null, trigger = 'on-demand', agent = null, force = false }) {
	if (!agentId) throw new Error('agentId required');

	const ctx = await gatherReflectionContext(agentId, { force: force || trigger === 'manual' });
	if (!ctx.eligible) {
		await recordRun({ agentId, trigger, status: 'skipped', reason: ctx.reason });
		return { status: 'skipped', reason: ctx.reason, created: [], candidates: 0 };
	}

	const { memories, actions, rejected } = ctx;
	const validIds = new Set(memories.map((m) => m.id));

	let completion;
	try {
		completion = await llmComplete({
			system: SYSTEM_PROMPT,
			user: buildUserPrompt({ agent, memories, actions, rejected }),
			// Opus 5 thinks by default and max_tokens caps thinking + answer
			// together; 4096 leaves room for both (free-lane fallbacks just get a
			// roomier completion budget).
			maxTokens: 4096,
			anthropicModel: REFLECTION_MODEL,
			timeoutMs: 45_000,
			track: { userId, agentId, tool: 'reflection' },
		});
	} catch (err) {
		const reason = err instanceof LlmUnavailableError ? 'no LLM provider available' : (err?.message || 'llm error').slice(0, 300);
		await recordRun({ agentId, trigger, status: 'error', reason });
		return { status: 'error', reason, created: [], candidates: 0 };
	}

	const payload = parseInsightPayload(completion.text);
	if (!payload || !Array.isArray(payload.insights)) {
		await recordRun({
			agentId, trigger, status: 'error', reason: 'unparseable model output',
			model: completion.model, inputTokens: completion.usage?.input, outputTokens: completion.usage?.output,
		});
		return { status: 'error', reason: 'unparseable model output', created: [], candidates: 0 };
	}

	const candidates = payload.insights.slice(0, MAX_INSIGHTS);
	const valid = candidates.map((c) => validateInsight(c, validIds)).filter(Boolean);

	const run = await recordRun({
		agentId, trigger, status: 'ok',
		reason: valid.length === 0 ? 'no groundable insights this pass' : null,
		dreamsCreated: valid.length, candidates: candidates.length,
		model: completion.model, inputTokens: completion.usage?.input, outputTokens: completion.usage?.output,
	});

	const created = [];
	for (const v of valid) {
		const [row] = await sql`
			INSERT INTO agent_reflections
				(agent_id, status, kind, statement, rationale, confidence, source_memory_ids,
				 proposed_type, proposed_salience, proposed_action, question, run_id)
			VALUES (
				${agentId}, 'pending', ${v.kind}, ${v.statement}, ${v.rationale}, ${v.confidence},
				${v.sourceIds}::uuid[], ${v.proposedType}, ${v.proposedSalience},
				${v.proposedAction ? JSON.stringify(v.proposedAction) : null}::jsonb,
				${v.question}, ${run.id}
			)
			RETURNING *
		`;
		created.push(decorateReflection(row));
	}

	return { status: 'ok', runId: run.id, created, candidates: candidates.length };
}

async function recordRun({ agentId, trigger, status, reason = null, dreamsCreated = 0, candidates = 0, model = null, inputTokens = null, outputTokens = null }) {
	const [row] = await sql`
		INSERT INTO agent_reflection_runs
			(agent_id, trigger, status, reason, dreams_created, candidates, model, input_tokens, output_tokens)
		VALUES (${agentId}, ${trigger}, ${status}, ${reason}, ${dreamsCreated}, ${candidates}, ${model}, ${inputTokens}, ${outputTokens})
		RETURNING id, created_at
	`;
	if (status === 'skipped' || (status === 'ok' && dreamsCreated === 0)) {
		// No silent caps: surface why a pass produced nothing.
		console.log(`[reflection] agent=${agentId} trigger=${trigger} ${status}: ${reason || 'no dreams'}`);
	}
	return row;
}

/** Shape a DB reflection row for API/UI consumption. */
export function decorateReflection(row) {
	return {
		id: row.id,
		agentId: row.agent_id,
		status: row.status,
		kind: row.kind,
		statement: row.statement,
		rationale: row.rationale,
		confidence: row.confidence,
		sourceMemoryIds: row.source_memory_ids || [],
		proposedType: row.proposed_type,
		proposedSalience: row.proposed_salience,
		proposedAction: row.proposed_action || null,
		question: row.question || null,
		answer: row.answer || null,
		acceptedMemoryId: row.accepted_memory_id || null,
		createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
		reviewedAt: row.reviewed_at ? (row.reviewed_at instanceof Date ? row.reviewed_at.toISOString() : row.reviewed_at) : null,
	};
}
