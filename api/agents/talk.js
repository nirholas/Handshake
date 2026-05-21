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
import { cors, error, json, method, readJson, wrap } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { normalizeLegacyPolicy } from '../_lib/embed-policy.js';
import { env } from '../_lib/env.js';

const ALLOWED_MODELS = new Set([
	'claude-haiku-4-5-20251001',
	'claude-sonnet-4-5',
	'claude-sonnet-4-6',
	'claude-opus-4-7',
	'claude-3-5-haiku-20241022',
]);

const bodySchema = z.object({
	agentId: z.string().min(1).max(120),
	message: z.string().min(1).max(4000),
	model: z.string().min(1).max(100).optional(),
});

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: false })) return;
	if (!method(req, res, ['POST'])) return;

	if (parseInt(req.headers['x-delegate-depth'] || '0', 10) > 0) {
		return error(res, 400, 'recursion_denied', 'nested agent delegation is not allowed');
	}

	const rl = await limits.agentDelegate(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'agent delegate rate limit');

	let raw;
	try {
		raw = await readJson(req);
	} catch {
		return error(res, 400, 'invalid_json', 'body must be JSON');
	}
	const parsed = bodySchema.safeParse(raw);
	if (!parsed.success) {
		return error(res, 400, 'validation_error', parsed.error.issues[0]?.message ?? 'invalid body');
	}
	const { agentId, message, model: requestedModel } = parsed.data;

	const [agent] = await sql`
		SELECT id, name, description, embed_policy, meta
		FROM agent_identities
		WHERE id = ${agentId} AND deleted_at IS NULL
	`;
	if (!agent) return error(res, 404, 'agent_not_found', 'agent not found');

	const policy = normalizeLegacyPolicy(agent.embed_policy);
	if (policy?.surfaces?.mcp === false) {
		return error(res, 403, 'mcp_disabled', 'this agent has opted out of MCP delegation');
	}

	const defaultModel = policy?.brain?.model || 'claude-haiku-4-5-20251001';
	const model = requestedModel && ALLOWED_MODELS.has(requestedModel) ? requestedModel : defaultModel;

	const systemPrompt =
		agent.meta?.brain?.instructions ||
		`You are ${agent.name}. ${agent.description || ''}`.trim();

	if (!env.ANTHROPIC_API_KEY) {
		return error(res, 503, 'not_configured', 'agent delegation is unavailable: ANTHROPIC_API_KEY not configured');
	}

	const started = Date.now();
	let upstream;
	try {
		upstream = await fetch('https://api.anthropic.com/v1/messages', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'anthropic-version': '2023-06-01',
				'x-api-key': env.ANTHROPIC_API_KEY,
				'x-delegate-depth': '1',
			},
			body: JSON.stringify({
				model,
				max_tokens: 1024,
				system: systemPrompt,
				messages: [{ role: 'user', content: message }],
			}),
		});
	} catch (err) {
		return error(res, 502, 'upstream_unreachable', err?.message || 'anthropic fetch failed');
	}
	if (!upstream.ok) {
		const msg = await upstream.text().catch(() => '');
		return error(res, 502, 'upstream_error', `LLM call failed: ${upstream.status} ${msg.slice(0, 200)}`);
	}
	const data = await upstream.json().catch(() => ({}));
	const response = data?.content?.[0]?.text || '';

	return json(res, 200, {
		ok: true,
		agentId: agent.id,
		agentName: agent.name,
		response,
		model,
		usage: data?.usage || null,
		durationMs: Date.now() - started,
		fetchedAt: new Date().toISOString(),
	});
});
