// POST /api/seed/synthesize
//
// Takes the raw connector payloads from the three.ws memory-seeding demo
// (any subset of github / x / farcaster) and writes a 200-300 word memory
// seed: a markdown blob describing the user's likely interests, expertise,
// voice, and recent activity. This is what the agent's vector store would be
// seeded with on first sign-in.
//
// The completion runs through _lib/llm.js, so it inherits the platform's
// free-providers-first chain and its keyless rungs. No single provider key is
// required for this endpoint to work.
//
// Auth: session OR bearer token.

import { z } from 'zod';
import { cors, json, method, readJson, wrap, error, rateLimited } from '../_lib/http.js';
import { parse } from '../_lib/validate.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { llmComplete, LlmUnavailableError, promptTokens } from '../_lib/llm.js';
import { limits, clientIp } from '../_lib/rate-limit.js';

const bodySchema = z
	.object({
		connectors: z
			.object({
				github: z.unknown().optional(),
				x: z.unknown().optional(),
				farcaster: z.unknown().optional(),
			})
			.refine(
				(c) => c.github || c.x || c.farcaster,
				{ message: 'at least one connector payload required' },
			),
	})
	.strict();

const SYSTEM_PROMPT = `You are the memory-synthesis component of three.ws, a service that builds long-term context for personal AI agents. Given one or more public-profile snapshots from a user's connected accounts, write a single markdown "memory seed" the agent should ingest as durable context.

Constraints:
- 200-300 words.
- Markdown, with at most three short sections (Interests, Voice, Recent activity) or a tight prose paragraph if that reads more naturally.
- Write in third person ("They build…", not "I build…").
- Ground every claim in the supplied data; mark genuine uncertainty with "likely" or "appears to".
- Do NOT include URLs, follower counts, or raw metrics; turn them into qualitative signals.
- Do NOT mention the source platform names; refer to "their public footprint" instead.
- No preamble, no closing. Output only the markdown body of the seed.`;

function summarizeConnector(name, data) {
	if (!data || typeof data !== 'object') return null;
	if (data.ok === false) return null;
	// Compact representation: we strip noisy fields so Haiku focuses on signal.
	if (name === 'github') {
		return {
			handle: data.handle,
			name: data.name,
			bio: data.bio,
			location: data.location,
			company: data.company,
			public_repos: data.public_repos,
			top_repos: (data.top_repos || []).slice(0, 8).map((r) => ({
				name: r.name,
				description: r.description,
				stars: r.stars,
				language: r.language,
			})),
			top_readme_excerpt: (data.top_readme_excerpt || '').slice(0, 1200),
		};
	}
	if (name === 'x') {
		return {
			handle: data.handle,
			name: data.name,
			bio: data.bio,
			location: data.location,
			follower_count: data.follower_count,
			top_topics: data.top_topics,
			recent_tweets: (data.recent_tweets || [])
				.slice(0, 20)
				.map((t) => t.text)
				.filter(Boolean),
		};
	}
	if (name === 'farcaster') {
		return {
			handle: data.handle,
			fid: data.fid,
			display_name: data.display_name,
			bio: data.bio,
			follower_count: data.follower_count,
			recent_casts: (data.recent_casts || [])
				.slice(0, 20)
				.map((c) => c.text)
				.filter(Boolean),
		};
	}
	return null;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	const userId = session?.id ?? bearer?.userId ?? null;
	if (!userId)
		return error(res, 401, 'unauthorized', 'sign in or provide a valid bearer token');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl, 'too many synthesis requests');

	const body = parse(bodySchema, await readJson(req));

	const sources = {};
	const sourcesUsed = [];
	for (const name of ['github', 'x', 'farcaster']) {
		const summary = summarizeConnector(name, body.connectors[name]);
		if (summary) {
			sources[name] = summary;
			sourcesUsed.push(name);
		}
	}

	if (!sourcesUsed.length)
		return error(res, 400, 'no_signal', 'no usable connector payloads supplied');

	const userMessage =
		`Public-footprint snapshots from ${sourcesUsed.length} connected ` +
		`${sourcesUsed.length === 1 ? 'account' : 'accounts'}:\n\n` +
		JSON.stringify(sources, null, 2);

	let result;
	try {
		// Per-provider timeout well under the function's 60s maxDuration so a slow
		// or hung upstream falls through to the next provider (and the handler
		// still returns a clean 502/503 below) instead of the function getting
		// killed mid-flight and surfacing a raw 504 to the browser.
		result = await llmComplete({
			system: SYSTEM_PROMPT,
			user: userMessage,
			maxTokens: 1024,
			timeoutMs: 18_000,
			track: { userId, tool: 'seed/synthesize' },
		});
	} catch (err) {
		if (err instanceof LlmUnavailableError) {
			return error(res, 503, 'llm_unavailable', 'synthesis is not available right now');
		}
		if (err?.code === 'daily_spend_cap_exceeded') {
			return error(res, 429, 'daily_spend_cap_exceeded', err.message);
		}
		console.error('[seed/synthesize] LLM error', err.status || '', err.message);
		return error(res, 502, 'upstream_error', 'synthesis failed');
	}

	const memorySeed = result.text;
	if (!memorySeed)
		return error(res, 502, 'empty_synthesis', 'model returned no text content');

	const inputTokens = promptTokens(result.usage);
	const tokensUsed = inputTokens + result.usage.output;

	return json(res, 200, {
		ok: true,
		memory_seed: memorySeed,
		sources_used: sourcesUsed,
		tokens_used: tokensUsed,
		usage: {
			input_tokens: inputTokens,
			output_tokens: result.usage.output,
		},
		model: result.model,
	});
});
