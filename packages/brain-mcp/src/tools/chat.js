// `chat` — run a chat completion through the three.ws multi-provider router. Read-only.
//
// Wraps POST /api/brain/chat. The route streams Server-Sent Events; an MCP tool
// result is a single payload, so lib/streamBrainChat accumulates the stream
// server-side and we return the finished message plus the route metadata,
// token usage, and timing the router reported.

import { z } from 'zod';

import { streamBrainChat } from '../lib/api.js';

const messageSchema = z.object({
	role: z.enum(['user', 'assistant']).describe('Who authored the turn.'),
	content: z.string().min(1).max(16000).describe('The turn text.'),
});

export const def = {
	name: 'chat',
	title: 'Run a chat completion',
	// Running a completion returns generated text; it does not mutate any
	// three.ws platform state — hence read-only. Open-world (live model), and
	// not idempotent (the same messages yield different generations each call).
	annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
	description:
		'Run a chat completion through the three.ws LLM router and get back the full reply as a single message. ' +
		'Pick `provider` from `list_providers` (default `gpt-oss-120b`, a free open-weight model). `messages` is ' +
		'the conversation so far (roles `user`/`assistant`); add system instructions via `system`. The route ' +
		'streams and auto-falls-back across mirrors/free tiers if the chosen model is briefly down — this tool ' +
		'collapses that into one reply and reports the actual route taken, token usage, and timing. ' +
		'Paid first-party flagships (Claude, GPT-5, o3, Grok, Qwen Plus, DeepSeek) need a three.ws API key ' +
		'(set THREE_WS_API_KEY); the free open-weight tiers (GPT-OSS 120B, NVIDIA NIM models) need none. ' +
		'Read-only: a completion does not change any platform state.',
	inputSchema: {
		messages: z
			.array(messageSchema)
			.min(1)
			.max(100)
			.describe('Conversation turns in order, each { role: "user"|"assistant", content }. At least one.'),
		provider: z
			.string()
			.min(1)
			.optional()
			.describe('Provider/model key from list_providers (e.g. "claude-sonnet-5", "gpt-5.4", "deepseek-r1"). Defaults to "gpt-oss-120b".'),
		system: z
			.string()
			.max(8000)
			.optional()
			.describe('Optional system prompt / instructions prepended to the conversation.'),
		maxTokens: z
			.number()
			.int()
			.min(64)
			.max(16384)
			.optional()
			.describe('Maximum output tokens. Clamped to the chosen model’s ceiling by the router. Defaults to 4096.'),
	},
	async handler(args) {
		const provider = String(args?.provider || 'gpt-oss-120b').trim();
		const messages = (Array.isArray(args?.messages) ? args.messages : []).map((m) => ({
			role: m?.role === 'assistant' ? 'assistant' : 'user',
			content: String(m?.content ?? ''),
		}));
		const body = { provider, messages };
		if (typeof args?.system === 'string' && args.system.trim()) body.system = args.system;
		if (Number.isFinite(args?.maxTokens)) body.maxTokens = Math.trunc(args.maxTokens);

		const { text, meta, usage, fallbackRoute, timing } = await streamBrainChat(body);

		return {
			ok: true,
			provider: meta?.provider ?? provider,
			model: meta?.label ?? null,
			network: meta?.network ?? null,
			tier: meta?.tier ?? null,
			// The route the answer actually came from. null when the requested
			// provider served it directly; otherwise the mirror/free-tier fallback.
			routed_via: fallbackRoute,
			content: text,
			usage: usage
				? {
						input_tokens: usage.inputTokens ?? null,
						output_tokens: usage.outputTokens ?? null,
						total_tokens: usage.totalTokens ?? null,
				  }
				: null,
			timing_ms: {
				first_token: timing?.firstTokenMs ?? null,
				total: timing?.elapsedMs ?? null,
			},
		};
	},
};
