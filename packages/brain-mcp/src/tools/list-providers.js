// `list_providers` — discover the LLM providers/models the router can reach. Read-only.
//
// Wraps GET /api/brain/chat, which returns every configured provider with its
// label, network, tier, max output, and a live `available` flag (true when the
// server holds a working key or OpenRouter mirror for it).

import { apiRequest } from '../lib/api.js';

export const def = {
	name: 'list_providers',
	title: 'List LLM providers and models',
	annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
	description:
		'List every LLM the three.ws router can run a completion through — one entry per provider/model. ' +
		'Each entry has: `key` (the id you pass to `chat`), `label` (human name), `network` (e.g. Anthropic, ' +
		'OpenAI, xAI, DashScope, NVIDIA NIM, IBM watsonx.ai), `tier` (flagship | balanced | fast | reasoning | ' +
		'pro | coding), ' +
		'`maxOutput` (max output tokens), `description`, `available` (true when the server currently holds a ' +
		'working key/route for it), and `requiresAuth` (true when it is a paid first-party model that needs a ' +
		'three.ws API key — set THREE_WS_API_KEY; false for the free open-weight tiers). Call this first to ' +
		'pick a `key` for `chat`. The set is live, so availability moves between calls — not idempotent.',
	inputSchema: {},
	async handler() {
		const data = await apiRequest('/api/brain/chat');
		const providers = Array.isArray(data?.providers) ? data.providers : [];
		// The router serves the free open-weight tiers anonymously; everything else
		// is a paid first-party model that needs a three.ws API key. Mirrors the
		// ANON_BRAIN_PROVIDERS gate in api/brain/chat.js.
		const ANON = new Set([
			'gpt-oss-120b',
			'nvidia-nemotron-120b',
			'nvidia-nemotron-super-49b',
			'nvidia-nemotron-nano',
			'nvidia-deepseek-v4',
			'nvidia-kimi-k2',
			'nvidia-llama4-maverick',
			'nvidia-minimax-m2',
		]);
		const shaped = providers.map((p) => ({
			key: p.key,
			label: p.label,
			network: p.network,
			tier: p.tier,
			maxOutput: p.maxOutput,
			description: p.description,
			available: Boolean(p.available),
			requiresAuth: !ANON.has(p.key),
		}));
		return {
			ok: true,
			count: shaped.length,
			available: shaped.filter((p) => p.available).length,
			default_provider: 'gpt-oss-120b',
			providers: shaped,
		};
	},
};
