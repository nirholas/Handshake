import { authenticateBearer, extractBearer, getSessionUser } from './_lib/auth.js';
import { cors, json, method, wrap, error, readJson } from './_lib/http.js';
import { limits } from './_lib/rate-limit.js';
import { LlmUnavailableError } from './_lib/llm.js';
import { runAgentDelegation, AgentNotFoundError } from './_lib/agent-delegate.js';

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

	try {
		const out = await runAgentDelegation({ toAgentId, message });
		return json(res, 200, out);
	} catch (err) {
		if (err instanceof AgentNotFoundError)
			return error(res, 404, 'not_found', 'target agent not found');
		if (err instanceof LlmUnavailableError)
			return error(
				res,
				503,
				'llm_unavailable',
				'agent delegation is not available right now',
			);
		return error(res, 502, 'upstream_error', `LLM call failed: ${err.message}`);
	}
});
