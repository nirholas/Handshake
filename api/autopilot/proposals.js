// /api/autopilot/proposals — the proposal queue: generate, review, act (owner-only).
//
// GET  ?agentId=&status=pending  → { proposals, trust, config }
//        Each proposal carries its provenance (cited memories hydrated) so the UI
//        can show + link the evidence.
//
// POST { agentId, action, ... }
//   action = 'generate'  → run the mind: produce real proposals from high-salience
//                          memories + pending dreams. → { created, source, trust }
//   action = 'dryrun'    → { proposalId } non-mutating preview of what executing does.
//   action = 'execute'   → { proposalId, confirm? } take the real action (scope +
//                          confirmation enforced). → { proposal, receipt, action }
//   action = 'dismiss'   → { proposalId } drop it; records a feedback memory.
//   action = 'undo'      → { proposalId } reverse a reversible executed action;
//                          records a feedback memory (the agent learns the boundary).
//   action = 'adjust'    → { proposalId, params } edit a pending proposal's params.

import { sql } from '../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { cors, json, method, readJson, wrap, error, rateLimited } from '../_lib/http.js';
import { requireCsrf } from '../_lib/csrf.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import {
	generateProposals, executeProposal, dismissProposal, undoProposal, dryRunProposal,
	computeTrust, getAutopilotConfig, decorateProposal, validateProposal, AutopilotError,
	AUTOPILOT_PROPOSAL_ACTIONS, pageLimit,
} from '../_lib/autopilot.js';
import { isUuid } from '../_lib/validate.js';

export const maxDuration = 60;

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

async function ownedAgent(req, res, agentId, auth) {
	if (!agentId) {
		error(res, 400, 'validation_error', 'agentId required');
		return null;
	}
	if (!isUuid(agentId)) {
		error(res, 400, 'validation_error', 'agentId must be a uuid');
		return null;
	}
	const [agent] = await sql`
		SELECT id, user_id, name, description, meta FROM agent_identities WHERE id = ${agentId} AND deleted_at IS NULL
	`;
	if (!agent) {
		error(res, 404, 'not_found', 'agent not found');
		return null;
	}
	if (agent.user_id !== auth.userId) {
		error(res, 403, 'forbidden', 'not your agent');
		return null;
	}
	return agent;
}

// Hydrate the cited source memories so the UI can show + link the evidence.
async function attachSources(agentId, proposals) {
	const ids = [...new Set(proposals.flatMap((p) => p.sourceMemoryIds || []))];
	const rows = ids.length
		? await sql`SELECT id, type, content, salience FROM agent_memories WHERE agent_id = ${agentId} AND id = ANY(${ids}::uuid[])`
		: [];
	const byId = new Map(rows.map((m) => [m.id, { id: m.id, type: m.type, content: m.content, salience: Number(m.salience) }]));
	return proposals.map((p) => ({
		...p,
		sources: (p.sourceMemoryIds || []).map((id) => byId.get(id) || { id, forgotten: true }),
	}));
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	if (req.method === 'GET') return handleList(req, res, auth);
	return handleAct(req, res, auth);
});

async function handleList(req, res, auth) {
	const url = new URL(req.url, 'http://x');
	const agentId = url.searchParams.get('agentId') || url.searchParams.get('agent_id');
	const status = url.searchParams.get('status');
	const limit = pageLimit(url.searchParams.get('limit'));

	const agent = await ownedAgent(req, res, agentId, auth);
	if (!agent) return;

	const rows = ['pending', 'executed', 'dismissed', 'undone', 'failed'].includes(status)
		? await sql`SELECT * FROM agent_autopilot_proposals WHERE agent_id = ${agentId} AND status = ${status} ORDER BY created_at DESC LIMIT ${limit}`
		: await sql`SELECT * FROM agent_autopilot_proposals WHERE agent_id = ${agentId} ORDER BY created_at DESC LIMIT ${limit}`;

	const proposals = await attachSources(agentId, rows.map(decorateProposal));
	const trust = await computeTrust({ agentId });
	return json(res, 200, { proposals, trust, config: getAutopilotConfig(agent.meta) });
}

async function handleAct(req, res, auth) {
	if (!(await requireCsrf(req, res, auth.userId))) return;

	const body = await readJson(req);
	const agentId = body.agentId || body.agent_id;
	const action = body.action;
	if (!AUTOPILOT_PROPOSAL_ACTIONS.includes(action)) {
		return error(res, 400, 'validation_error', `action must be one of: ${AUTOPILOT_PROPOSAL_ACTIONS.join(', ')}`);
	}

	const agent = await ownedAgent(req, res, agentId, auth);
	if (!agent) return;

	if (action === 'generate') {
		const rl = await limits.authIp(clientIp(req));
		if (!rl.success) return rateLimited(res, rl, 'too many generation requests');
		const result = await generateProposals({ agentId, userId: auth.userId, agent: { name: agent.name, description: agent.description } });

		// Auto-run any freshly-created REVERSIBLE proposal the owner has scoped for
		// auto-execution. Irreversible ($THREE) actions never auto-run — they always
		// require an explicit confirmation, so they stay pending here. Each auto-run
		// is real, recorded, and undoable; a guard breach just leaves it pending.
		const config = getAutopilotConfig(agent.meta);
		const autoRan = [];
		if (config.enabled) {
			for (const p of result.created) {
				const reversible = p.kind === 'create_alert' || p.kind === 'briefing';
				if (!reversible || !config.scopes[p.kind] || !config.auto_execute?.[p.kind]) continue;
				try {
					const exec = await executeProposal({ proposal: p, agent, userId: auth.userId, meta: agent.meta });
					autoRan.push({ proposalId: p.id, receipt: exec.receipt, actionId: exec.action?.id != null ? String(exec.action.id) : null, kind: p.kind, ts: exec.action?.ts });
					p.status = 'executed';
				} catch (err) {
					if (!(err instanceof AutopilotError)) throw err; // unexpected — surface as 500
					// expected guard denial — leave the proposal pending for manual review
				}
			}
		}

		const created = await attachSources(agentId, result.created);
		const trust = await computeTrust({ agentId });
		return json(res, 200, { created, autoRan, source: result.source, scanned: result.scanned, trust });
	}

	// All remaining actions operate on a specific proposal.
	const proposalId = body.proposalId || body.proposal_id;
	if (!proposalId) return error(res, 400, 'validation_error', 'proposalId required');
	if (!isUuid(proposalId)) return error(res, 400, 'validation_error', 'proposalId must be a uuid');
	const [row] = await sql`SELECT * FROM agent_autopilot_proposals WHERE id = ${proposalId} AND agent_id = ${agentId}`;
	if (!row) return error(res, 404, 'not_found', 'proposal not found');
	const proposal = decorateProposal(row);

	try {
		if (action === 'dryrun') {
			const preview = await dryRunProposal({ proposal, agent, config: getAutopilotConfig(agent.meta) });
			return json(res, 200, { preview });
		}
		if (action === 'execute') {
			const result = await executeProposal({
				proposal, agent, userId: auth.userId, meta: agent.meta, confirmed: body.confirm === true,
			});
			const trust = await computeTrust({ agentId });
			return json(res, 200, { ...result, trust });
		}
		if (action === 'dismiss') {
			await dismissProposal({ proposal, agentId, userId: auth.userId });
			const [updated] = await sql`SELECT * FROM agent_autopilot_proposals WHERE id = ${proposalId}`;
			return json(res, 200, { proposal: decorateProposal(updated), trust: await computeTrust({ agentId }) });
		}
		if (action === 'undo') {
			await undoProposal({ proposal, agentId, userId: auth.userId });
			const [updated] = await sql`SELECT * FROM agent_autopilot_proposals WHERE id = ${proposalId}`;
			return json(res, 200, { proposal: decorateProposal(updated), trust: await computeTrust({ agentId }) });
		}
		if (action === 'adjust') {
			if (proposal.status !== 'pending') return error(res, 409, 'not_pending', 'only a pending proposal can be adjusted');
			const v = validateProposal(proposal.kind, body.params || {});
			if (!v.ok) return error(res, 400, 'validation_error', v.reason);
			const [updated] = await sql`
				UPDATE agent_autopilot_proposals SET params = ${JSON.stringify(v.params)}::jsonb
				WHERE id = ${proposalId} AND status = 'pending' RETURNING *
			`;
			return json(res, 200, { proposal: decorateProposal(updated) });
		}
		return error(res, 400, 'validation_error', "action must be one of: generate, dryrun, execute, dismiss, undo, adjust");
	} catch (err) {
		if (err instanceof AutopilotError) return error(res, err.status, err.code, err.message);
		throw err;
	}
}
