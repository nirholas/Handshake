// POST /api/agent-collab — hand a lead agent one goal and watch its team take it on.
//
// The lead decomposes the goal, DELEGATES sub-tasks (free LLM turns) and HIRES
// teammate agents for paid skills over the real x402 rails (each hire bounded by a
// per-node slice of the goal's hard USD cap and stamped with a real on-chain
// invocation receipt). As the task tree transitions, the full current graph is
// published to the lead's live screen (api/_lib/agent-screen-frame.js → Redis), so
// a viewer on /agents-live or /agent-screen reads it back over agent-screen-stream.
//
// Body (JSON): { leadAgentId, goal, maxUsd? }
// Returns:     { taskId, tree }  (the final task tree, with real signatures/links)
//
// Real integrations, no mocks:
//   • runAgentDelegation — real LLM-driven decomposition + sub-agent turns.
//   • POST /api/agents/a2a-hire — real USDC payment + on-chain receipt. Called
//     server-to-server with a short-lived access token minted for the caller, so
//     every spend guard (owner gate, spend policy, kill switch) still runs there.

import { authenticateBearer, extractBearer, getSessionUser, mintAccessToken } from './_lib/auth.js';
import { cors, error, json, method, rateLimited, readJson, wrap } from './_lib/http.js';
import { requireCsrf } from './_lib/csrf.js';
import { isUuid } from './_lib/validate.js';
import { limits } from './_lib/rate-limit.js';
import { sql } from './_lib/db.js';
import { env } from './_lib/env.js';
import { runAgentDelegation, AgentNotFoundError } from './_lib/agent-delegate.js';
import { listOffersWithStats } from './_lib/agent-economy.js';
import { writeScreenFrame } from './_lib/agent-screen-frame.js';
import {
	orchestrateGoal,
	clampBudget,
	HARD_MAX_USD,
} from './_lib/agent-orchestrate.js';

export const maxDuration = 300;

// The live graph rides in the frame's `meta` sidecar (capped at 4 KB by
// writeScreenFrame). Strip the heavy free-text fields — the graph only needs
// structure, status, cost, and explorer links; full results return in the HTTP
// response. Keeps every snapshot comfortably under the meta limit.
function compactTree(tree) {
	return {
		v: 1,
		kind: 'collab',
		taskId: tree.taskId,
		goal: String(tree.goal || '').slice(0, 160),
		leadAgentId: tree.leadAgentId,
		status: tree.status,
		maxUsd: tree.maxUsd,
		spentUsd: Math.round((tree.budgetSpentUsd || 0) * 100) / 100,
		nodes: tree.nodes.map((n) => ({
			id: n.id,
			agentId: n.agentId || null,
			name: n.name ? String(n.name).slice(0, 40) : null,
			kind: n.kind,
			title: String(n.title || '').slice(0, 80),
			status: n.status,
			costUsd: n.costUsd != null ? n.costUsd : null,
			sig: n.signature ? String(n.signature).slice(0, 16) : null,
			url: n.explorerUrl || null,
		})),
		edges: tree.edges,
	};
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	if (!session && !bearer) return error(res, 401, 'unauthorized', 'sign in to run a team task');
	const userId = session?.id ?? bearer?.userId;

	if (session && !(await requireCsrf(req, res, userId))) return;

	const rl = await limits.agentDelegate(userId);
	if (!rl.success) return rateLimited(res, rl, 'team-task rate limit exceeded');

	const body = (await readJson(req)) || {};
	const { leadAgentId, goal } = body;
	if (!leadAgentId || typeof leadAgentId !== 'string') {
		return error(res, 400, 'validation_error', 'leadAgentId is required');
	}
	// agent_identities.id is a uuid column: an unvalidated id reaches the owner
	// gate below as an uncastable literal and answers 500 instead of 400.
	if (!isUuid(leadAgentId)) {
		return error(res, 400, 'validation_error', 'leadAgentId must be a uuid');
	}
	if (!goal || typeof goal !== 'string' || !goal.trim()) {
		return error(res, 400, 'validation_error', 'goal is required');
	}
	if (goal.length > 2000) {
		return error(res, 400, 'validation_error', 'goal exceeds 2000 characters');
	}
	const maxUsd = clampBudget(body.maxUsd);

	// Owner gate: only the agent's owner can spend its wallet on a team task.
	const [lead] = await sql`
		SELECT id, user_id, name FROM agent_identities
		WHERE id = ${leadAgentId} AND deleted_at IS NULL
	`;
	if (!lead) return error(res, 404, 'not_found', 'lead agent not found');
	if (lead.user_id !== userId) return error(res, 403, 'forbidden', 'you do not own this agent');

	// Live catalog of hireable teammate services the lead may pick from.
	const catalog = await listOffersWithStats({ limit: 20 }).catch(() => []);
	const catalogForPlan = catalog
		// The lead must never hire its own service — drop it from the menu up front.
		.filter((o) => o.provider?.id && o.provider.id !== leadAgentId)
		.map((o) => ({ slug: o.slug, name: o.name, description: o.description, price_usdc: o.price_usdc }));

	// Short-lived access token so the paid-hire path runs through the REAL,
	// fully-guarded /api/agents/a2a-hire endpoint (bearer auth → CSRF-exempt),
	// without us re-implementing any spend logic here.
	const hireToken = await mintAccessToken({ userId, resource: env.MCP_RESOURCE }).catch(() => null);
	const hireBase = internalBaseUrl(req);

	const runHire = async ({ hirerAgentId, serviceSlug, input, maxUsd: nodeMax }) => {
		if (!hireToken) throw Object.assign(new Error('agent spending unavailable'), { code: 'spend_disabled' });
		const resp = await fetch(`${hireBase}/api/agents/a2a-hire`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${hireToken}`,
			},
			body: JSON.stringify({ hirerAgentId, serviceSlug, input, maxUsd: nodeMax }),
		});
		const data = await resp.json().catch(() => ({}));
		if (!resp.ok) {
			throw Object.assign(new Error(data.error_description || data.error || 'hire failed'), {
				code: data.error || 'hire_failed',
				status: resp.status,
			});
		}
		return { hire: data.hire, result: data.result };
	};

	// Publish each task-tree snapshot to the lead's live screen, and narrate the
	// handoff on whichever agent the transition concerns. Fire-and-forget — a
	// publishing hiccup must never interrupt a real, paid hire mid-flight.
	const emit = (tree, ctx) => {
		const meta = { collab: compactTree(tree) };
		writeScreenFrame(leadAgentId, {
			activity: ctx?.narration || 'Team task',
			type: 'analysis',
			meta,
		}).catch(() => {});
		// When a sub-task resolves on a teammate, narrate it on that teammate's
		// screen too, so the wall card for the hired agent reflects the collaboration.
		const node = ctx?.node;
		if (node && node.agentId && node.agentId !== leadAgentId) {
			writeScreenFrame(node.agentId, {
				activity: node.kind === 'hire'
					? `Hired by ${lead.name || 'a lead agent'} — ${String(node.title || '').slice(0, 60)}`
					: `Helping ${lead.name || 'a lead agent'} — ${String(node.title || '').slice(0, 60)}`,
				type: 'analysis',
			}).catch(() => {});
		}
	};

	// Return a truthful partial tree well before the 300s serverless wall (see
	// maxDuration above) rather than letting a long, real multi-agent run get
	// killed mid-flight with a 504. 230s leaves ample headroom for the final
	// synthesis turn (only started when the node loop finishes under budget) plus
	// response serialization. The live SSE screen keeps painting throughout.
	const ORCHESTRATION_BUDGET_MS = 230_000;
	const deadlineMs = Date.now() + ORCHESTRATION_BUDGET_MS;

	let tree;
	try {
		tree = await orchestrateGoal(
			{ userId, leadAgentId, leadName: lead.name || null, goal: goal.trim(), maxUsd, catalog: catalogForPlan, emit, deadlineMs },
			{ runDelegate: runAgentDelegation, runHire },
		);
	} catch (err) {
		if (err instanceof AgentNotFoundError) return error(res, 404, 'not_found', 'lead agent not found');
		console.error('[agent-collab] orchestration failed:', err?.message || err);
		return error(res, 502, 'orchestration_failed', 'the team task could not be completed — try again shortly');
	}

	return json(res, 200, { ok: true, taskId: tree.taskId, max_usd: maxUsd, hard_cap_usd: HARD_MAX_USD, tree });
});

// Build the same-origin base URL for the internal hire call from the inbound
// request, so a server-to-server call hits THIS running instance (not a stale
// PUBLIC_APP_ORIGIN). Falls back to the configured app origin when no host header.
function internalBaseUrl(req) {
	const host = req.headers['x-forwarded-host'] || req.headers.host;
	if (!host) return env.APP_ORIGIN;
	const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
		|| (host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https');
	return `${proto}://${host}`;
}
