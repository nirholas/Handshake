// MCP memory tools: remember / recall / forget.
//
// Exposes the agent-memory backend (api/agent-memory.js, table agent_memories)
// as MCP tools so an agent connected to /api/mcp can persist, retrieve, and
// delete its own long-term memories. Ownership is enforced on every tool by
// the same query the REST endpoint uses: a memory belongs to an agent, and an
// agent belongs to a user (agent_identities.user_id). A caller may only touch
// agents they own; pay-per-call x402 principals (auth.userId === null) have no
// account and are refused with a designed, actionable message.

import { sql } from '../../_lib/db.js';

const VALID_TYPES = ['user', 'feedback', 'project', 'reference'];

// 7-day half-life recency decay, mirroring src/agent-memory.js so server-side
// recall ranks memories the same way the client store does.
const RECENCY_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

// Designed "not your agent / not signed in" result. The task requires a helpful
// message, not a throw. Anonymous x402 callers have no account at all, owners
// of a different agent get the same opaque answer so we don't leak existence.
function ownershipError() {
	return {
		content: [
			{
				type: 'text',
				text: 'Memory is account-scoped. Sign in with three.ws OAuth (scope memory:read / memory:write) and pass an agent_id you own.',
			},
		],
		isError: true,
	};
}

// Returns true when auth.userId owns the agent. Reuses the REST endpoint's
// ownership query verbatim so the trust boundary stays identical.
async function ownsAgent(agentId, auth) {
	if (!auth?.userId) return false;
	const [row] = await sql`
		SELECT user_id FROM agent_identities WHERE id = ${agentId} AND deleted_at IS NULL
	`;
	return !!row && row.user_id === auth.userId;
}

function decorate(row) {
	return {
		id: row.id,
		agent_id: row.agent_id,
		type: row.type,
		content: row.content,
		tags: row.tags || [],
		context: row.context || {},
		salience: row.salience,
		created_at: row.created_at,
		expires_at: row.expires_at || null,
	};
}

function tokenize(text) {
	return String(text || '')
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((t) => t.length > 1);
}

// Blend lexical relevance to the query with salience and recency. With no
// per-memory embeddings stored server-side, lexical overlap stands in for
// semantic similarity; when a query matches nothing, lexical=0 and the order
// degrades cleanly to the salience+recency ranking the REST endpoint uses,
// never a failure mode. Returns a score in roughly [0,1].
function scoreMemory(row, queryTokens, nowMs) {
	const haystack = new Set(tokenize(`${row.content} ${(row.tags || []).join(' ')}`));
	let hits = 0;
	for (const t of queryTokens) if (haystack.has(t)) hits++;
	const lexical = queryTokens.length ? hits / queryTokens.length : 0;

	const createdMs = row.created_at ? new Date(row.created_at).getTime() : nowMs;
	const ageMs = Math.max(0, nowMs - createdMs);
	const recency = Math.exp((-0.693 * ageMs) / RECENCY_HALF_LIFE_MS);

	const salience = typeof row.salience === 'number' ? row.salience : 0.5;

	return 0.5 * lexical + 0.35 * salience + 0.15 * recency;
}

export const toolDefs = [
	{
		name: 'remember',
		title: 'Remember',
		// Inserts a new row every call: additive write, never destructive.
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		description:
			'Store a long-term memory for one of your agents. Use for durable facts: who the user is (type=user), guidance/corrections (feedback), ongoing work (project), or external pointers (reference). Returns the stored memory.',
		inputSchema: {
			type: 'object',
			properties: {
				agent_id: { type: 'string', format: 'uuid' },
				content: { type: 'string', minLength: 1, maxLength: 4000 },
				type: { type: 'string', enum: VALID_TYPES, default: 'reference' },
				tags: {
					type: 'array',
					items: { type: 'string', maxLength: 100 },
					maxItems: 20,
				},
				context: {
					type: 'string',
					maxLength: 2000,
					description: 'Optional freeform metadata about where this memory came from.',
				},
				salience: { type: 'number', minimum: 0, maximum: 1, default: 0.5 },
				expires_at: {
					type: 'string',
					format: 'date-time',
					description:
						'Optional ISO-8601 expiry; the memory is excluded from recall after this time.',
				},
			},
			required: ['agent_id', 'content'],
			additionalProperties: false,
		},
		scope: 'memory:write',
		async handler(args, auth) {
			if (!(await ownsAgent(args.agent_id, auth))) return ownershipError();

			const type = VALID_TYPES.includes(args.type) ? args.type : 'reference';
			const tags = Array.isArray(args.tags) ? args.tags : [];
			const context = args.context ? { note: args.context } : {};
			const salience = typeof args.salience === 'number' ? args.salience : 0.5;
			const expiresAt = args.expires_at ? new Date(args.expires_at).toISOString() : null;

			const [row] = await sql`
				INSERT INTO agent_memories (id, agent_id, type, content, tags, context, salience, expires_at)
				VALUES (
					gen_random_uuid(),
					${args.agent_id},
					${type},
					${args.content.trim()},
					${tags},
					${JSON.stringify(context)}::jsonb,
					${salience},
					${expiresAt}
				)
				RETURNING *
			`;

			const mem = decorate(row);
			return {
				content: [{ type: 'text', text: `Remembered (${mem.type}): ${mem.content}` }],
				structuredContent: { memory: mem },
			};
		},
	},
	{
		name: 'recall',
		title: 'Recall',
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		description:
			'Retrieve the most relevant memories for a query from one of your agents. Ranks by relevance to the query blended with salience and recency, excluding expired memories. Returns an ordered list.',
		inputSchema: {
			type: 'object',
			properties: {
				agent_id: { type: 'string', format: 'uuid' },
				query: { type: 'string', minLength: 1, maxLength: 1000 },
				limit: { type: 'integer', minimum: 1, maximum: 50, default: 8 },
				type: { type: 'string', enum: VALID_TYPES },
			},
			required: ['agent_id', 'query'],
			additionalProperties: false,
		},
		scope: 'memory:read',
		async handler(args, auth) {
			if (!(await ownsAgent(args.agent_id, auth))) return ownershipError();

			const limit = Math.min(Math.max(Number(args.limit) || 8, 1), 50);
			// Pull a bounded candidate pool ordered the way the REST list endpoint
			// does, then re-rank in memory against the query. The pool cap keeps the
			// query cheap while covering far more than any limit a caller will ask for.
			const candidates = args.type
				? await sql`
					SELECT * FROM agent_memories
					WHERE agent_id = ${args.agent_id}
					  AND type = ${args.type}
					  AND (expires_at IS NULL OR expires_at > now())
					ORDER BY salience DESC, created_at DESC
					LIMIT 200
				`
				: await sql`
					SELECT * FROM agent_memories
					WHERE agent_id = ${args.agent_id}
					  AND (expires_at IS NULL OR expires_at > now())
					ORDER BY salience DESC, created_at DESC
					LIMIT 200
				`;

			if (!candidates.length) {
				return {
					content: [
						{
							type: 'text',
							text: 'No memories stored for this agent yet. Use the remember tool to add some.',
						},
					],
					structuredContent: { memories: [] },
				};
			}

			const nowMs = Date.now();
			const queryTokens = tokenize(args.query);
			const ranked = candidates
				.map((row) => ({ row, score: scoreMemory(row, queryTokens, nowMs) }))
				.sort((a, b) => b.score - a.score)
				.slice(0, limit)
				.map(({ row, score }) => {
					const mem = decorate(row);
					return {
						id: mem.id,
						type: mem.type,
						content: mem.content,
						tags: mem.tags,
						salience: mem.salience,
						score: Math.round(score * 1000) / 1000,
					};
				});

			const summary = ranked.map((m, i) => `${i + 1}. [${m.type}] ${m.content}`).join('\n');
			return {
				content: [{ type: 'text', text: summary }],
				structuredContent: { memories: ranked },
			};
		},
	},
	{
		name: 'forget',
		title: 'Forget',
		// Permanently deletes a stored memory: destructive.
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: true,
		},
		description: 'Delete a memory you own by its id.',
		inputSchema: {
			type: 'object',
			properties: {
				memory_id: { type: 'string', format: 'uuid' },
				agent_id: { type: 'string', format: 'uuid' },
			},
			required: ['memory_id'],
			additionalProperties: false,
		},
		scope: 'memory:write',
		async handler(args, auth) {
			if (!auth?.userId) return ownershipError();

			// Ownership via the same join handleDelete uses: memory → agent → user.
			const [row] = await sql`
				SELECT m.id, a.user_id
				FROM agent_memories m
				JOIN agent_identities a ON a.id = m.agent_id
				WHERE m.id = ${args.memory_id}
			`;

			if (!row || row.user_id !== auth.userId) {
				return {
					content: [
						{ type: 'text', text: 'No such memory, or it does not belong to you.' },
					],
					isError: true,
				};
			}

			await sql`DELETE FROM agent_memories WHERE id = ${args.memory_id}`;
			return {
				content: [{ type: 'text', text: `Forgot memory ${args.memory_id}.` }],
				structuredContent: { ok: true, id: args.memory_id },
			};
		},
	},
];
