/**
 * Agent Reflection Digest — the data behind the Diary panel (Task 17).
 * ====================================================================
 * At the end of its day the agent opens its real memory and reflects: what it
 * learned, who it touched, what it keeps coming back to. This endpoint shapes
 * that reflection from real rows only — it never invents anything.
 *
 * GET /api/agent-reflect-digest?agentId=&since=<ms>
 *
 *   owner-scoped (same auth + ownership check as api/agent-memory.js).
 *   • highlights — the day's top memories by salience since `since`
 *   • entities   — the most-mentioned nodes from the real entity graph
 *   • links      — navigable destinations for addressable entities (coins,
 *                  resolved agents)
 *   • counts     — learned / decided / interacted, derived from the rows
 *   • diaryText  — a short first-person paragraph the LLM composes STRICTLY
 *                  from the rows above (system prompt forbids fabrication). If
 *                  no LLM provider answers, a grounded factual summary built
 *                  from the same rows is returned instead — never invented prose.
 *
 * Memory is read-only here; the diary never writes.
 */

import { getSessionUser, authenticateBearer, extractBearer } from './_lib/auth.js';
import { sql } from './_lib/db.js';
import { cors, json, method, wrap, error } from './_lib/http.js';
import { buildGraph } from './_lib/memory-store.js';
import { llmComplete, llmConfigured, LlmUnavailableError } from './_lib/llm.js';
import { isUuid } from './_lib/validate.js';
import { shapeDigestEntities, digestCounts } from '../src/agent-memory-graph.js';

// How far back to look when the caller doesn't pass `since` — a rolling day.
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
// Cap the day's highlights so a chatty agent can't blow the token budget or the
// panel layout; the most salient memories lead.
const MAX_HIGHLIGHTS = 12;
const MAX_ENTITIES = 14;

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const url = new URL(req.url, 'http://x');
	const agentId = url.searchParams.get('agentId') || url.searchParams.get('agent_id');
	if (!agentId) return error(res, 400, 'validation_error', 'agentId required');
	// agent_identities.id is a uuid column: handing Postgres a non-uuid throws
	// 22P02, which turns a plain client typo into a 500 plus a Sentry event and an
	// ops alert. Reject the shape here, alongside the missing-id check.
	if (!isUuid(agentId)) return error(res, 400, 'validation_error', 'agentId must be a uuid');

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in to read your agent\'s diary');

	const [agentRow] = await sql`
		SELECT id, user_id, name, description
		FROM agent_identities
		WHERE id = ${agentId} AND deleted_at IS NULL
	`;
	if (!agentRow) return error(res, 404, 'not_found', 'agent not found');
	if (agentRow.user_id !== auth.userId) return error(res, 403, 'forbidden', 'not your agent');

	const sinceMs = clampSince(url.searchParams.get('since'));
	const sinceIso = new Date(sinceMs).toISOString();

	// ── Real rows: the day's salient memories ────────────────────────────────
	const memories = await sql`
		SELECT id, type, content, tags, context, salience, created_at
		FROM agent_memories
		WHERE agent_id = ${agentId}
		  AND (expires_at IS NULL OR expires_at > now())
		  AND created_at > ${sinceIso}
		ORDER BY salience DESC, created_at DESC
		LIMIT ${MAX_HIGHLIGHTS}
	`;

	const highlights = memories.map((m) => ({
		id: m.id,
		type: m.type,
		content: String(m.content || '').slice(0, 600),
		tags: m.tags || [],
		salience: Number(m.salience) || 0,
		createdAt: m.created_at instanceof Date ? m.created_at.getTime() : new Date(m.created_at).getTime(),
	}));

	// ── Real entity graph (lazily mined) ─────────────────────────────────────
	const graph = await buildGraph(agentId).catch(() => ({ nodes: [], edges: [], stats: { entities: 0, edges: 0 } }));

	// Resolve person/agent entity labels to real agent ids so their chips link
	// to the agent's own screen — a real lookup, never a fabricated destination.
	const agentIndex = await buildAgentIndex(graph.nodes);

	const entities = shapeDigestEntities(graph.nodes, { topN: MAX_ENTITIES, agentIndex });
	const links = entities.filter((e) => e.href).map((e) => ({ entityId: e.id, kind: e.kind, label: e.label, href: e.href }));
	const counts = digestCounts(memories, entities);

	// ── Compose the diary paragraph (LLM, grounded; template fallback) ───────
	let diaryText = '';
	let composed = 'empty';
	if (highlights.length) {
		const grounded = await composeDiary({ agent: agentRow, highlights, entities, counts, userId: auth.userId, agentId });
		diaryText = grounded.text;
		composed = grounded.composed;
	}

	return json(res, 200, {
		agentId,
		since: sinceMs,
		generatedAt: Date.now(),
		counts,
		highlights,
		entities,
		links,
		diaryText,
		composed, // 'llm' | 'template' | 'empty'
		graph: { stats: graph.stats },
	});
});

// ── Helpers ───────────────────────────────────────────────────────────────

function clampSince(raw) {
	const n = Number(raw);
	const now = Date.now();
	if (Number.isFinite(n) && n > 0 && n <= now) return n;
	return now - DEFAULT_WINDOW_MS;
}

/**
 * Map lowercased agent names → agent id for the person/agent entities in the
 * graph, so their chips can deep-link to the agent's screen. Real rows only;
 * an unmatched person stays a plain chip.
 */
async function buildAgentIndex(nodes = []) {
	const labels = [...new Set(
		(nodes || [])
			.filter((n) => n && (n.kind === 'person' || n.kind === 'agent') && n.label)
			.map((n) => String(n.label).trim())
			.filter(Boolean),
	)].slice(0, 60);
	if (!labels.length) return new Map();
	const lowered = labels.map((l) => l.toLowerCase());
	let rows = [];
	try {
		rows = await sql`
			SELECT id, name FROM agent_identities
			WHERE deleted_at IS NULL AND lower(name) = ANY(${lowered}::text[])
		`;
	} catch {
		return new Map();
	}
	const idx = new Map();
	for (const r of rows) {
		const key = String(r.name || '').trim().toLowerCase();
		if (key && !idx.has(key)) idx.set(key, r.id);
	}
	return idx;
}

const DIARY_SYSTEM = [
	'You are the reflective inner voice of an autonomous AI agent writing a short',
	'diary entry at the end of its day. Speak in the FIRST PERSON, past tense,',
	'warm but concise — like an agent that genuinely remembers its day.',
	'',
	'STRICT GROUNDING: Write ONLY about what is in the MEMORIES, ENTITIES, and',
	'COUNTS provided. Do not invent facts, names, numbers, coins, trades, or',
	'outcomes that are not present. If the material is thin, keep the entry short',
	'rather than padding it with anything fabricated.',
	'',
	'Refer to the people/agents and topics by the labels given. The only coin you',
	'may ever name is $THREE — and only if it actually appears in the material;',
	'never name any other token.',
	'',
	'Write 3–5 sentences as a single paragraph. No headings, no markdown, no lists,',
	'no preamble like "Today I" is required but natural. Output only the paragraph.',
].join('\n');

function buildDiaryUserPrompt({ agent, highlights, entities, counts }) {
	const lines = [];
	lines.push(`AGENT: ${agent?.name || 'Agent'}${agent?.description ? ` — ${agent.description}` : ''}`);
	lines.push(`COUNTS: learned ${counts.learned}, decided ${counts.decided}, interacted with ${counts.interacted} people/agents.`);
	lines.push('');
	lines.push('MEMORIES (most salient first — the raw material; summarize, do not copy verbatim):');
	for (const m of highlights) {
		const tags = Array.isArray(m.tags) && m.tags.length ? ` [${m.tags.join(', ')}]` : '';
		lines.push(`- (${m.type}, importance ${m.salience.toFixed(2)})${tags}: ${m.content}`);
	}
	if (entities.length) {
		lines.push('');
		lines.push('ENTITIES IT KEEPS RETURNING TO (label ×mentions):');
		for (const e of entities.slice(0, 10)) lines.push(`- ${e.label} (${e.kind}) ×${e.mentions}`);
	}
	lines.push('');
	lines.push('Write the diary paragraph now, grounded strictly in the above.');
	return lines.join('\n');
}

/**
 * Compose the diary paragraph. Tries the shared free-first LLM router; on any
 * failure (or no provider) falls back to a deterministic, fully-grounded
 * summary built from the same rows — honest, never fabricated prose.
 */
async function composeDiary({ agent, highlights, entities, counts, userId, agentId }) {
	if (llmConfigured()) {
		try {
			const completion = await llmComplete({
				system: DIARY_SYSTEM,
				user: buildDiaryUserPrompt({ agent, highlights, entities, counts }),
				maxTokens: 320,
				timeoutMs: 30_000,
				track: { userId, agentId, tool: 'diary' },
			});
			const text = (completion.text || '').trim();
			if (text) return { text, composed: 'llm' };
		} catch (err) {
			if (!(err instanceof LlmUnavailableError)) {
				console.warn('[agent-reflect-digest] diary LLM failed, using grounded summary:', err?.message);
			}
		}
	}
	return { text: templateDiary({ highlights, entities, counts }), composed: 'template' };
}

/**
 * Deterministic grounded summary — used only when no LLM answers. It reports
 * real counts and the agent's top memory/entity verbatim-ish; it states facts
 * from the rows, it does not invent.
 */
function templateDiary({ highlights, entities, counts }) {
	const parts = [];
	const learned = counts.learned;
	parts.push(`Today I formed ${learned} ${learned === 1 ? 'memory' : 'memories'}`);
	if (counts.decided) parts.push(`, ${counts.decided} of them ${counts.decided === 1 ? 'a decision' : 'decisions'}`);
	if (counts.interacted) parts.push(`, working alongside ${counts.interacted} ${counts.interacted === 1 ? 'other' : 'others'}`);
	parts.push('.');
	let entry = parts.join('');
	if (highlights[0]) {
		entry += ` What stayed with me most: ${oneSentence(highlights[0].content)}`;
	}
	const top = entities[0];
	if (top) {
		entry += ` I kept returning to ${top.label}${top.mentions > 1 ? ` (${top.mentions} times)` : ''}.`;
	}
	return entry.trim();
}

function oneSentence(text) {
	const s = String(text || '').trim().replace(/\s+/g, ' ');
	const cut = s.split(/(?<=[.!?])\s/)[0] || s;
	const out = cut.length > 220 ? cut.slice(0, 219) + '…' : cut;
	return /[.!?…]$/.test(out) ? out : out + '.';
}
