import { sql } from './_lib/db.js';
import { authenticateBearer, extractBearer, getSessionUser } from './_lib/auth.js';
import { cors, json, method, wrap, error, readJson } from './_lib/http.js';
import { limits } from './_lib/rate-limit.js';
import { normalizeLegacyPolicy } from './_lib/embed-policy.js';
import { llmComplete, LlmUnavailableError } from './_lib/llm.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;

	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	if (!session && !bearer) return error(res, 401, 'unauthorized', 'sign in required');
	const userId = session?.id ?? bearer?.userId;

	// Recursion guard — reject if any caller already set the depth header
	const depth = parseInt(req.headers['x-delegate-depth'] || '0', 10);
	if (depth > 0)
		return error(res, 400, 'recursion_denied', 'nested agent delegation is not allowed');

	const body = await readJson(req);
	const { fromAgentId, toAgentId, message } = body || {};
	if (!toAgentId || typeof toAgentId !== 'string')
		return error(res, 400, 'validation_error', 'toAgentId required');
	if (!message || typeof message !== 'string')
		return error(res, 400, 'validation_error', 'message required');

	// Rate limit per calling agent (or user session as fallback)
	const rl = await limits.agentDelegate(fromAgentId || userId || 'anon');
	if (!rl.success) return error(res, 429, 'rate_limited', 'delegate rate limit exceeded');

	const [agent] = await sql`
		SELECT id, name, description, embed_policy, meta
		FROM agent_identities
		WHERE id = ${toAgentId} AND deleted_at IS NULL
	`;
	if (!agent) return error(res, 404, 'not_found', 'target agent not found');

	const policy = normalizeLegacyPolicy(agent.embed_policy);
	const model = policy?.brain?.model || 'claude-haiku-4-5-20251001';
	const systemPrompt =
		agent.meta?.brain?.instructions ||
		`You are ${agent.name}. ${agent.description || ''}`.trim();

	let result;
	try {
		result = await llmComplete({ system: systemPrompt, user: message, maxTokens: 1024, anthropicModel: model });
	} catch (err) {
		if (err instanceof LlmUnavailableError) {
			return error(res, 503, 'llm_unavailable', 'agent delegation is not available right now');
		}
		return error(res, 502, 'upstream_error', `LLM call failed: ${err.message}`);
	}

	return json(res, 200, { response: result.text, agentId: toAgentId, model: result.model });
});
