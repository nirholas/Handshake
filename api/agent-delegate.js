import { authenticateBearer, extractBearer, getSessionUser } from './_lib/auth.js';
import { cors, json, method, wrap, error, readJson, rateLimited } from './_lib/http.js';
import { limits } from './_lib/rate-limit.js';
import { isUuid } from './_lib/validate.js';
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

	const body = await readJson(req, 32_000);
	const { toAgentId, message } = body || {};
	if (!toAgentId || typeof toAgentId !== 'string')
		return error(res, 400, 'validation_error', 'toAgentId required');
	// agent_identities.id is a uuid column, so a non-uuid id died inside the
	// lookup and came back as a generic 502 upstream_error, blaming the LLM for
	// what is plainly a malformed request.
	if (!isUuid(toAgentId))
		return error(res, 400, 'validation_error', 'toAgentId must be a uuid');
	if (!message || typeof message !== 'string')
		return error(res, 400, 'validation_error', 'message required');
	// Each delegation runs a real LLM completion on the platform key — cap the
	// prompt so one call can't carry a maximal payload into paid inference.
	if (message.length > 8000)
		return error(res, 400, 'validation_error', 'message exceeds 8000 characters');

	// Rate limit by the AUTHENTICATED principal, never a client-supplied id. Keying
	// on body.fromAgentId let a caller mint a fresh bucket per request (rotating the
	// id) and bypass the cap entirely — an unbounded LLM-cost amplification vector.
	const rl = await limits.agentDelegate(userId);
	if (!rl.success) return rateLimited(res, rl, 'delegate rate limit exceeded');

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
		// An LLM/provider error can embed keyed RPC/provider URLs — keep it out of
		// the client response; the detail is logged server-side for triage.
		console.error('[agent-delegate] LLM call failed:', err?.message || err);
		return error(res, 502, 'upstream_error', 'Agent delegation failed temporarily. Try again shortly.');
	}
});
