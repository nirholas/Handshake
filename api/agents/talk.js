// POST /api/agents/talk
//
// Open agent-conversation endpoint, the public counterpart to
// /api/agent-delegate.js. The original endpoint required session auth and
// was scoped to user-owned agents; this one is auth-optional and is
// callable from the paid `agent_delegate_action` MCP tool (which gates
// access via x402 USDC payment).
//
// Body:
//   { agentId: string, message: string, model?: string }
//
// Response:
//   { ok, agentId, agentName, response, model, durationMs, fetchedAt }
//
// Safety: agents with surfaces.mcp === false (their owner's embed policy)
// are refused — owners can opt their agent out of public MCP use.

import { z } from 'zod';
import { sql } from '../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { cors, error, json, method, readJson, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { normalizeLegacyPolicy } from '../_lib/embed-policy.js';
import { llmComplete, LlmUnavailableError } from '../_lib/llm.js';
import { hasSkillAccess } from '../_lib/skill-access.js';
import { isUuid } from '../_lib/validate.js';
import { patronChatContext, patronStanding, listPerks, entitledPerks } from '../_lib/patronage.js';

const ALLOWED_MODELS = new Set([
	'claude-haiku-4-5-20251001',
	'claude-sonnet-4-5',
	'claude-sonnet-4-6',
	'claude-sonnet-5',
	'claude-opus-4-7',
	'claude-opus-5',
]);

const bodySchema = z.object({
	agentId: z.string().min(1).max(120),
	message: z.string().min(1).max(4000),
	model: z.string().min(1).max(100).optional(),
});

// Build the agent's skill_ownership context for one requesting user. Every skill
// the agent declares is classified as premium (priced + active in
// agent_skill_prices) or free; for premium skills we resolve the caller's real
// access via hasSkillAccess (purchase / subscription / trial). Anonymous callers
// (userId === null) own no premium skill. Returns a compact, structured prompt
// section, or null when the agent has no skills worth describing.
async function buildSkillOwnershipBlock(agent, userId, patronSkills = new Set()) {
	const skills = Array.isArray(agent.skills) ? agent.skills.filter(Boolean) : [];
	if (skills.length === 0) return null;

	// One query for all of this agent's active prices, then classify in memory —
	// avoids a per-skill price lookup. hasSkillAccess re-checks the price row, but
	// only for skills we already know are premium.
	const priceRows = await sql`
		SELECT skill FROM agent_skill_prices
		WHERE agent_id = ${agent.id} AND is_active = true
	`;
	const pricedSkills = new Set(priceRows.map((r) => r.skill));

	const ownership = {};
	for (const skill of skills) {
		if (!pricedSkills.has(skill)) {
			ownership[skill] = { is_premium: false, is_owned: true };
			continue;
		}
		// A patron whose verified on-chain support clears a skill-perk threshold uses
		// that premium skill for free — the same gate the Support surface advertises.
		if (patronSkills.has(skill)) {
			ownership[skill] = { is_premium: true, is_owned: true, via_patron: true };
			continue;
		}
		if (!userId) {
			ownership[skill] = { is_premium: true, is_owned: false };
			continue;
		}
		const access = await hasSkillAccess(userId, agent.id, skill);
		ownership[skill] = { is_premium: true, is_owned: Boolean(access.owned) };
	}

	const hasPremium = Object.values(ownership).some((o) => o.is_premium);
	if (!hasPremium) return null; // nothing to monetize — keep the prompt lean.

	return [
		'## Skill access (current user)',
		'The JSON below maps each of your skills to whether it is premium (paid) and whether THIS user has already unlocked it:',
		JSON.stringify(ownership),
		'Behaviour rules:',
		'- Use any skill where is_owned is true freely, without mentioning payment.',
		'- If the user asks to use a skill where is_premium is true and is_owned is false, do NOT perform it. Politely explain it is a paid skill and invite them to unlock it from your agent profile page, then offer the free skills you can do instead.',
		'- Never invent prices, never reveal another user\'s access, and never claim a skill is unlocked when is_owned is false.',
	].join('\n');
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: false })) return;
	if (!method(req, res, ['POST'])) return;

	if (parseInt(req.headers['x-delegate-depth'] || '0', 10) > 0) {
		return error(res, 400, 'recursion_denied', 'nested agent delegation is not allowed');
	}

	// Each call burns platform LLM credit, so require an authenticated principal.
	// The x402-paid public path lives in the MCP tool, not here.
	const session = await getSessionUser(req);
	const principal = session ?? (await authenticateBearer(extractBearer(req)));
	if (!principal) return error(res, 401, 'unauthorized', 'sign in required');
	const userId = session?.id ?? principal?.userId ?? null;

	const rl = await limits.agentDelegate(clientIp(req));
	if (!rl.success) return rateLimited(res, rl, 'agent delegate rate limit');

	let raw;
	try {
		raw = await readJson(req);
	} catch {
		return error(res, 400, 'invalid_json', 'body must be JSON');
	}
	const parsed = bodySchema.safeParse(raw);
	if (!parsed.success) {
		return error(
			res,
			400,
			'validation_error',
			parsed.error.issues[0]?.message ?? 'invalid body',
		);
	}
	const { agentId, message, model: requestedModel } = parsed.data;

	// agent_identities.id is a uuid column — a malformed id otherwise leaks
	// Postgres error 22P02 to the caller as a 500. Return a clean 404 instead.
	if (!isUuid(agentId)) return error(res, 404, 'agent_not_found', 'agent not found');

	const [agent] = await sql`
		SELECT id, name, description, embed_policy, meta, skills
		FROM agent_identities
		WHERE id = ${agentId} AND deleted_at IS NULL
	`;
	if (!agent) return error(res, 404, 'agent_not_found', 'agent not found');

	const policy = normalizeLegacyPolicy(agent.embed_policy);
	if (policy?.surfaces?.mcp === false) {
		return error(res, 403, 'mcp_disabled', 'this agent has opted out of MCP delegation');
	}

	const defaultModel = policy?.brain?.model || 'claude-haiku-4-5-20251001';
	const model =
		requestedModel && ALLOWED_MODELS.has(requestedModel) ? requestedModel : defaultModel;

	const basePrompt =
		agent.meta?.brain?.instructions ||
		`You are ${agent.name}. ${agent.description || ''}`.trim();

	// Patronage: recognize the caller as a real on-chain patron (greet them by name,
	// reference the relationship) and free any premium skill their support has earned.
	// The caller's identity is their linked wallet; standing derives from chain truth.
	const callerWallet = session?.wallet_address || null;
	const patronSkills = new Set();
	if (callerWallet) {
		try {
			const [standing, perks] = await Promise.all([
				patronStanding(agent.id, callerWallet),
				listPerks(agent.id, { activeOnly: true }),
			]);
			for (const p of entitledPerks(perks, standing.usd)) {
				if (p.perkType === 'skill' && p.payload?.skill) patronSkills.add(p.payload.skill);
			}
		} catch { /* patronage is enrichment — never block the reply */ }
	}
	const patronBlock = await patronChatContext(agent.id, callerWallet).catch(() => null);

	// Real per-user skill-ownership context: lets the agent know which of its
	// skills are premium and whether THIS caller has already unlocked them, so it
	// can use owned skills freely and offer to sell the ones the user lacks.
	const ownershipBlock = await buildSkillOwnershipBlock(agent, userId, patronSkills);
	const systemPrompt = [basePrompt, patronBlock, ownershipBlock].filter(Boolean).join('\n\n');

	const started = Date.now();
	let result;
	try {
		result = await llmComplete({
			system: systemPrompt,
			user: message,
			maxTokens: 1024,
			// Free providers serve first; if every one fails, the paid backstop
			// uses the agent's chosen Claude model on the platform key.
			anthropicModel: model,
			track: { agentId: agent.id, tool: 'agent.talk' },
		});
	} catch (err) {
		if (err instanceof LlmUnavailableError) {
			return error(
				res,
				503,
				'llm_unavailable',
				'agent delegation is not available right now',
			);
		}
		return error(res, 502, 'upstream_error', `LLM call failed: ${err.message}`);
	}

	return json(res, 200, {
		ok: true,
		agentId: agent.id,
		agentName: agent.name,
		response: result.text,
		model: result.model,
		usage: result.usage,
		durationMs: Date.now() - started,
		fetchedAt: new Date().toISOString(),
	});
});
