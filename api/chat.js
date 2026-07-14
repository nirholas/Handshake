// POST /api/chat — AI-powered chat for the three.ws viewer agent.
//
// Body: { message, context, history, agentId?, provider?, model? }
// Response: SSE stream { type: 'chunk' | 'done' | 'error' }.
//
// Provider routing (in order — free providers ALWAYS lead; see
// api/_lib/chat-models.js DEFAULT_PROVIDER_ORDER):
//   1. Body.provider when present and the matching key is configured.
//   2. GROQ_API_KEY → Groq (free platform key — default).
//   3. OPENROUTER_API_KEY → OpenRouter free tier.
//   4. NVIDIA_API_KEY → NVIDIA NIM free tier (third independent free lane).
//   5. ANTHROPIC_API_KEY → Anthropic (paid backstop — BYOK or host key).
//   6. OPENAI_API_KEY → OpenAI (paid backstop).
//   7. WATSONX_API_KEY (+ project) → IBM Granite on watsonx.ai (server key only;
//      explicit `provider: "watsonx"` from the client, never the silent default).
// Anthropic, the OpenAI-compatible providers (OpenRouter / Groq / OpenAI), and
// watsonx.ai use different request shapes, auth, tool-call wire formats, and SSE
// event names — this file translates all of them so the client only ever sees
// the same { chunk → done } event stream regardless of upstream. watsonx adds
// one wrinkle: its bearer token is minted from an IAM exchange, so its request
// headers are resolved asynchronously (route.resolveHeaders) inside the loop
// rather than baked in up front; its SSE deltas are OpenAI-shaped, so the
// OpenAI stream reader handles them verbatim.

import { getSessionUser, authenticateBearer, extractBearer } from './_lib/auth.js';
import { cors, json, method, readJson, wrap, error, rateLimited } from './_lib/http.js';
import { parse } from './_lib/validate.js';
import { recordEvent } from './_lib/usage.js';
import { captureException } from './_lib/sentry.js';
import { sql } from './_lib/db.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { loadUserProviderKeys } from './_lib/provider-keys.js';
import { watsonxConfig, watsonxAuthHeaders } from './_lib/watsonx.js';
import { orchestrateConfig } from './_lib/orchestrate.js';
import { guardianConfig, governSend, sendCapUsd } from './_lib/granite-guardian.js';
import { moderateAnonInput, refusalReply } from './_lib/moderation.js';
import {
	markProviderCooldown,
	providersInCooldown,
	AUTH_COOLDOWN_SECONDS,
} from './_lib/provider-health.js';
import {
	DEFAULT_FREE_MODEL,
	PROVIDER_MODEL_DEFAULTS,
	DEFAULT_PROVIDER_ORDER,
	OPENROUTER_SIBLINGS,
	ANON_PROVIDER_LIST,
	MODEL_CATALOG,
	MAX_FALLBACK_ATTEMPTS,
	TOTAL_BUDGET_MS,
	PER_CALL_TIMEOUT_MS,
} from './_lib/chat-models.js';
import { computeContext, searchMemories } from './_lib/memory-store.js';
import {
	vertexClaudeEnabled,
	vertexClaudePrimary,
	vertexMessagesUrl,
	vertexRequestHeaders,
	toVertexBody,
} from './_lib/vertex-claude.js';
import { z } from 'zod';

// Providers anonymous (unauthenticated) callers may use. Groq and OpenRouter
// free-tier models are exposed without sign-in — paid keys stay gated behind auth.
const ANON_PROVIDERS = new Set(ANON_PROVIDER_LIST);

export const maxDuration = 60;

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_ANTHROPIC_MODEL = PROVIDER_MODEL_DEFAULTS.anthropic;
// GPT-OSS 120B on OpenRouter — the platform-wide default chat model (same one
// the /chat app uses). See api/_lib/chat-models.js.
const DEFAULT_OPENROUTER_MODEL = PROVIDER_MODEL_DEFAULTS.openrouter;
const DEFAULT_GROQ_MODEL = PROVIDER_MODEL_DEFAULTS.groq;
const DEFAULT_OPENAI_MODEL = PROVIDER_MODEL_DEFAULTS.openai;
const DEFAULT_MAX_TOKENS = 1024;
const HARD_MAX_TOKENS = 4096;

const PROVIDERS = {
	anthropic: {
		envKey: 'ANTHROPIC_API_KEY',
		defaultModel: DEFAULT_ANTHROPIC_MODEL,
		url: ANTHROPIC_URL,
		style: 'anthropic',
	},
	// Vertex-served Claude (GCP credits). No envKey — availability is gated by
	// vertexClaudeEnabled(); the OAuth bearer token is minted per request in
	// makeRoute (resolveHeaders). Serves the same Claude model ids as the
	// first-party Anthropic lane, so the Anthropic SSE reader handles it verbatim.
	// Injected into the try-order per flags by providerOrder(); absent when off.
	vertex: {
		defaultModel: DEFAULT_ANTHROPIC_MODEL,
		style: 'vertex-anthropic',
	},
	openrouter: {
		envKey: 'OPENROUTER_API_KEY',
		defaultModel: DEFAULT_OPENROUTER_MODEL,
		url: 'https://openrouter.ai/api/v1/chat/completions',
		style: 'openai',
		extraHeaders: { 'HTTP-Referer': 'https://three.ws', 'X-Title': 'three.ws agent' },
	},
	groq: {
		envKey: 'GROQ_API_KEY',
		defaultModel: DEFAULT_GROQ_MODEL,
		url: 'https://api.groq.com/openai/v1/chat/completions',
		style: 'openai',
	},
	// NVIDIA NIM (build.nvidia.com) — free OpenAI-compatible inference; one
	// nvapi key unlocks every hosted model. The third independent free lane.
	nvidia: {
		envKey: 'NVIDIA_API_KEY',
		defaultModel: PROVIDER_MODEL_DEFAULTS.nvidia,
		url: 'https://integrate.api.nvidia.com/v1/chat/completions',
		style: 'openai',
	},
	openai: {
		envKey: 'OPENAI_API_KEY',
		defaultModel: DEFAULT_OPENAI_MODEL,
		url: 'https://api.openai.com/v1/chat/completions',
		style: 'openai',
	},
	// IBM watsonx.ai (Granite). URL + headers are derived in makeRoute from the
	// shared watsonx client (region host, version param, IAM bearer token), so
	// no static `url` here. Requires WATSONX_API_KEY + a project/space id.
	watsonx: {
		envKey: 'WATSONX_API_KEY',
		defaultModel: 'ibm/granite-3-8b-instruct',
		style: 'watsonx',
	},
	// IBM watsonx Orchestrate agent (Agent Connect). OpenAI-compatible
	// chat-completions endpoint, so it streams through the OpenAI reader; the
	// endpoint URL + agent id are resolved in makeRoute. This makes a three.ws
	// 3D avatar the embodied front-end of an enterprise Orchestrate agent.
	orchestrate: {
		envKey: 'WATSONX_ORCHESTRATE_API_KEY',
		defaultModel: 'orchestrate-agent',
		style: 'orchestrate',
	},
};

const contextSchema = z
	.object({
		modelName: z.string().max(200).optional(),
		vertices: z.number().int().nonnegative().optional(),
		triangles: z.number().int().nonnegative().optional(),
		materials: z.number().int().nonnegative().optional(),
		animations: z.number().int().nonnegative().optional(),
		validationErrors: z.number().int().nonnegative().optional(),
		validationWarnings: z.number().int().nonnegative().optional(),
		currentEnvironment: z.string().max(80).optional(),
		wireframe: z.boolean().optional(),
		skeleton: z.boolean().optional(),
		grid: z.boolean().optional(),
		autoRotate: z.boolean().optional(),
		transparentBg: z.boolean().optional(),
		bgColor: z.string().max(20).optional(),
	})
	.partial()
	.default({});

const chatBody = z.object({
	message: z.string().trim().min(1).max(4000),
	context: contextSchema,
	system_prompt: z.string().trim().min(1).max(2000).optional(),
	// Owner-only candidate persona for the Brain Studio live preview: lets the
	// owner audition an unsaved compiled persona against /api/chat even when the
	// agent already has a stored persona. Ignored unless the caller owns agentId.
	persona_override: z.string().trim().min(1).max(16000).optional(),
	agentId: z.string().uuid().optional(),
	provider: z
		.enum(['anthropic', 'openrouter', 'groq', 'nvidia', 'openai', 'watsonx', 'orchestrate'])
		.optional(),
	model: z.string().min(1).max(120).optional(),
	history: z
		.array(
			z.object({
				role: z.enum(['user', 'assistant']),
				content: z.string().min(1).max(4000),
			}),
		)
		.max(20)
		.default([]),
});

// Tool definitions in Anthropic shape; converted to OpenAI shape on demand.
const ACTION_TOOLS = [
	{
		name: 'setWireframe',
		description: 'Toggle wireframe mode on the currently loaded model.',
		input_schema: {
			type: 'object',
			properties: { value: { type: 'boolean' } },
			required: ['value'],
		},
	},
	{
		name: 'setSkeleton',
		description: 'Toggle the skeleton helper visualization for rigged models.',
		input_schema: {
			type: 'object',
			properties: { value: { type: 'boolean' } },
			required: ['value'],
		},
	},
	{
		name: 'setGrid',
		description: 'Toggle the reference grid and axes helper.',
		input_schema: {
			type: 'object',
			properties: { value: { type: 'boolean' } },
			required: ['value'],
		},
	},
	{
		name: 'setAutoRotate',
		description: 'Toggle auto-rotation of the camera around the model.',
		input_schema: {
			type: 'object',
			properties: { value: { type: 'boolean' } },
			required: ['value'],
		},
	},
	{
		name: 'setBgColor',
		description: 'Set the viewer background color. Accepts a CSS hex like "#001133".',
		input_schema: {
			type: 'object',
			properties: { value: { type: 'string', pattern: '^#[0-9a-fA-F]{3,8}$' } },
			required: ['value'],
		},
	},
	{
		name: 'setTransparentBg',
		description: 'Toggle transparent background (for compositing screenshots).',
		input_schema: {
			type: 'object',
			properties: { value: { type: 'boolean' } },
			required: ['value'],
		},
	},
	{
		name: 'setEnvironment',
		description:
			'Change the HDRI lighting environment. Known names: "None", "Neutral", "Venice Sunset", "Footprint Court (HDR Labs)".',
		input_schema: {
			type: 'object',
			properties: { value: { type: 'string' } },
			required: ['value'],
		},
	},
	{
		name: 'takeScreenshot',
		description: 'Capture a PNG screenshot of the current viewport.',
		input_schema: { type: 'object', properties: {} },
	},
	{
		name: 'loadModel',
		description: 'Load a glTF or GLB model by URL.',
		input_schema: {
			type: 'object',
			properties: { url: { type: 'string', format: 'uri' } },
			required: ['url'],
		},
	},
	{
		name: 'runValidation',
		description:
			'Run glTF validation on the currently loaded model and report errors/warnings.',
		input_schema: { type: 'object', properties: {} },
	},
	{
		name: 'showMaterialEditor',
		description: 'Open the material editor panel in the viewer UI.',
		input_schema: { type: 'object', properties: {} },
	},
	{
		name: 'setCameraTarget',
		description:
			'Set the camera target to a specific named bone on the currently loaded model.',
		input_schema: {
			type: 'object',
			properties: {
				boneName: {
					type: 'string',
					description: 'The name of the bone to target, e.g. "head", "leftHand"',
				},
			},
			required: ['boneName'],
		},
	},
	{
		name: 'getPumpFunTrades',
		description: 'Get the latest trades from pump.fun and show them in the 3D scene.',
		input_schema: { type: 'object', properties: {} },
	},
	{
		name: 'playAnimation',
		description:
			'Play a named animation on the avatar. Use when the user asks to dance, wave, jump, celebrate, etc. Available clips: wave, dance, capoeira, jump, thriller, pray, idle, celebrate, rumba, falling, kiss, taunt.',
		input_schema: {
			type: 'object',
			properties: {
				name: {
					type: 'string',
					description: 'Animation clip name, e.g. "dance", "wave", "jump", "thriller".',
				},
				loop: {
					type: 'boolean',
					description: 'Whether to loop the animation. Dance-style clips should loop.',
				},
			},
			required: ['name'],
		},
	},
	{
		name: 'sendSol',
		description:
			"Send a small amount of SOL from the avatar's own Solana wallet to a recipient, denominated in US dollars. " +
			'Call this ONLY when the user explicitly asks the avatar to send, pay, or transfer SOL. ' +
			'If the user says "send me" (or gives no address), omit `to` — the configured default recipient is used. ' +
			'The host enforces a per-send dollar cap, so request the amount the user named.',
		input_schema: {
			type: 'object',
			properties: {
				usd: {
					type: 'number',
					description: 'US-dollar value of SOL to send, e.g. 1 for "$1 of SOL".',
				},
				to: {
					type: 'string',
					description:
						'Recipient Solana address (base58). Omit to send to the configured default recipient ("me").',
				},
			},
			required: ['usd'],
		},
	},
];

const ACTION_NAMES = new Set(ACTION_TOOLS.map((t) => t.name));

const OPENAI_TOOLS = ACTION_TOOLS.map((t) => ({
	type: 'function',
	function: {
		name: t.name,
		description: t.description,
		parameters: t.input_schema,
	},
}));

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const auth = await resolveAuth(req);
	const body = parse(chatBody, await readJson(req));

	// Anonymous callers are restricted to Groq's free tier (no other provider
	// keys are exposed without auth). Force-pin the provider and rate-limit by
	// IP so abuse can't burn the host's quota.
	let anonymous = false;
	if (!auth) {
		const ip = clientIp(req);
		const rl = await limits.chatIp(ip);
		if (!rl.success) {
			return rateLimited(res, rl, 'too many anonymous chat requests, try again shortly');
		}
		const hasOpenRouter = !!process.env.OPENROUTER_API_KEY;
		const hasGroq = !!process.env.GROQ_API_KEY;
		const hasNvidia = !!process.env.NVIDIA_API_KEY;
		if (!hasOpenRouter && !hasGroq && !hasNvidia) {
			return error(res, 401, 'unauthorized', 'sign in to chat with the agent');
		}
		if (body.provider && !ANON_PROVIDERS.has(body.provider)) {
			return error(res, 401, 'unauthorized', 'sign in to use this model');
		}
		// Honor an explicitly-requested free-tier provider (groq/openrouter/nvidia).
		// Otherwise default to Groq — the fast, first-attempt-reliable free tier —
		// then OpenRouter's free Llama (DEFAULT_FREE_MODEL), then NVIDIA NIM.
		if (!body.provider) {
			body.provider = hasGroq ? 'groq' : hasOpenRouter ? 'openrouter' : 'nvidia';
			if (!body.model && body.provider === 'openrouter') body.model = DEFAULT_FREE_MODEL;
		}
		anonymous = true;
	} else {
		// Authenticated callers are metered too — platform LLM keys are a real
		// cost, so a signed-in account must not get unlimited inference.
		const rl = await limits.chatUser(auth.userId || `ip:${clientIp(req)}`);
		if (!rl.success) {
			return rateLimited(res, rl, 'too many chat requests, slow down');
		}
	}

	// Anonymous pre-moderation (FAIL-OPEN). Signed-in callers are attributable
	// and rate-limited, so only anon traffic is screened. A confirmed-unsafe
	// message gets a normal in-band refusal over the SSE stream — never an HTTP
	// error — and any moderation failure proceeds un-moderated (the filter can
	// never take chat down). See api/_lib/moderation.js.
	if (anonymous) {
		const verdict = await moderateAnonInput(body.message);
		if (verdict.flagged) {
			res.writeHead(200, {
				'Content-Type': 'text/event-stream; charset=utf-8',
				'Cache-Control': 'no-cache, no-transform',
				'X-Accel-Buffering': 'no',
			});
			res.write(
				`data: ${JSON.stringify({ type: 'done', reply: refusalReply(), actions: [], moderated: true })}\n\n`,
			);
			res.end();
			recordEvent({
				userId: null,
				kind: 'chat',
				tool: 'moderation',
				latencyMs: verdict.latencyMs ?? 0,
				meta: { moderated: true, categories: verdict.categories ?? [], anonymous: true },
			});
			return;
		}
	}

	let userProviderKeys = {};
	if (auth?.userId) {
		const [urow] = await sql`SELECT provider_keys FROM users WHERE id = ${auth.userId}`;
		userProviderKeys = await loadUserProviderKeys(urow?.provider_keys);
	}

	// Health cooldowns: a provider that recently 429'd / 5xx'd is skipped while it
	// recovers, so a single throttle window doesn't cascade into request after
	// request re-hitting the same dead provider. Best-effort — an unreadable
	// cache yields an empty set (pre-breaker behaviour).
	const cooldown = await providersInCooldown(Object.keys(PROVIDERS));

	let route = pickProvider(body.provider, body.model, userProviderKeys, cooldown);
	if (!route) {
		return error(res, 503, 'chat_unavailable', 'no chat provider is configured');
	}
	if (anonymous && !ANON_PROVIDERS.has(route.name)) {
		return error(res, 401, 'unauthorized', 'sign in to chat with the agent');
	}

	// When inference is billed to the host's key (the caller supplied none for the
	// chosen provider), charge it against a global ceiling so distributed abuse —
	// many accounts each under their per-user limit — can't drain platform quota.
	if (route.usingHostKey) {
		const hk = await limits.chatHostKeyGlobal();
		if (!hk.success) {
			return rateLimited(res, hk, 'chat is at capacity, try again shortly');
		}
	}

	const maxTokens = clampInt(
		parseInt(process.env.CHAT_MAX_TOKENS || '', 10) || DEFAULT_MAX_TOKENS,
		128,
		HARD_MAX_TOKENS,
	);

	let personaPrompt = null;
	let isOwner = false;
	if (body.agentId) {
		// Persona prompts are private IP: only serve them for published agents,
		// or to the agent's owner. Anonymous callers get published personas only.
		const [agentRow] = await sql`
			SELECT persona_prompt, user_id FROM agent_identities
			WHERE id = ${body.agentId} AND deleted_at IS NULL
			  AND (is_published = true OR user_id = ${auth?.userId ?? null})
			LIMIT 1
		`;
		isOwner = Boolean(auth?.userId && agentRow?.user_id === auth.userId);
		// Brain Studio preview: the owner may audition an unsaved compiled persona.
		// The override only applies to the agent's owner — never published-agent
		// visitors — so it can't be used to inject a prompt into someone's agent.
		if (body.persona_override && agentRow && auth?.userId && agentRow.user_id === auth.userId) {
			personaPrompt = body.persona_override;
		} else if (agentRow?.persona_prompt) {
			personaPrompt = agentRow.persona_prompt;
		}
	}
	if (!personaPrompt && body.system_prompt) personaPrompt = body.system_prompt;

	// Real memory recall: surface the agent's always-in-context core (pinned /
	// working tier) plus the memories most relevant to THIS message, inject them
	// into the system prompt so they actually shape the reply, and report exactly
	// which ones were used in the `done` event (the client emits `memory:recalled`
	// from that). The owner sees all their memories; a third party chatting with a
	// published agent sees only its public memories. Best-effort: a memory-store
	// hiccup degrades to a memory-less reply, never a failed chat.
	let recalledMemories = [];
	let recalledSemantic = false;
	if (body.agentId) {
		try {
			recalledMemories = await recallForChat(body.agentId, body.message, isOwner);
			recalledSemantic = recalledMemories.some((m) => m.match === 'semantic');
		} catch (err) {
			captureException(err, { route: 'chat', stage: 'recall', agentId: body.agentId });
		}
	}

	const systemPrompt = buildSystemPrompt(body.context, personaPrompt, recalledMemories);
	const history = body.history.map((m) => ({ role: m.role, content: m.content }));
	history.push({ role: 'user', content: body.message });

	const started = Date.now();
	// Provider/model failover chain. The first entry is the picked route; if it
	// returns 429 (rate-limit) or 5xx (provider down) we cycle through a
	// pre-built fallback list before surfacing an error.
	let fallbackRoutes = buildFallbackChain(route, userProviderKeys, cooldown);
	// Anonymous traffic must never fail over onto paid providers (OpenAI/
	// Anthropic). Clamp the whole chain to the free-tier anon providers so a
	// rate-limited free model degrades to another free model, never paid keys.
	if (anonymous) fallbackRoutes = fallbackRoutes.filter((r) => ANON_PROVIDERS.has(r.name));

	let upstream;
	let routeIdx = 0;
	// Tool support varies by model/provider. We always ask with the action tools
	// first; if a route rejects them we retry that same route without tools.
	let includeTools = true;
	// One in-place retry per route on transient gateway errors (503/504) before
	// failing over. Reset to false every time we advance to a new route.
	let retriedTransient = false;
	// Bound the whole chain by wall-clock so a request can't churn through every
	// provider and still time out at the 60s function limit. Once the budget is
	// spent we stop failing over and surface a clean terminal error. `attempted`
	// records which provider/model each upstream call hit, so an exhausted chain
	// can tell the client (and the logs) exactly what failed.
	const deadline = started + TOTAL_BUDGET_MS;
	const attempted = [];
	// Whether another route exists *and* the time budget allows trying it.
	const canFailOver = () => routeIdx + 1 < fallbackRoutes.length && Date.now() < deadline;
	while (true) {
		attempted.push({ provider: route.name, model: route.model });
		try {
			// Most routes carry static headers; watsonx resolves a fresh IAM
			// bearer token (cached between requests) just before the fetch.
			const reqHeaders = route.headers || (await route.resolveHeaders());
			// Per-attempt abort: a single hung provider must not silently consume
			// the whole TOTAL_BUDGET_MS (and ultimately trip the 60s function
			// timeout). Cap each attempt at the smaller of the remaining budget or
			// PER_CALL_TIMEOUT_MS, so a stalled upstream aborts fast and we fail
			// over to the next route while time remains. The AbortError lands in
			// the catch below, which advances the chain like any network blip.
			const remainingMs = deadline - Date.now();
			const ctrl = new AbortController();
			const callMs = Math.max(1, Math.min(PER_CALL_TIMEOUT_MS, remainingMs));
			const timer = setTimeout(() => ctrl.abort(), callMs);
			try {
				upstream = await fetch(route.url, {
					method: 'POST',
					headers: reqHeaders,
					body: JSON.stringify(
						route.buildPayload({ systemPrompt, history, maxTokens, includeTools }),
					),
					signal: ctrl.signal,
				});
			} finally {
				clearTimeout(timer);
			}
		} catch (err) {
			captureException(err, { route: 'chat', stage: 'fetch', provider: route.name });
			const reason = err?.name === 'AbortError' ? 'timed out' : err.message;
			console.error(`[chat:${route.name}] upstream fetch failed:`, reason);
			// An unreachable/timed-out provider is unhealthy — cool it down so the
			// next request skips it instead of waiting on the same dead socket.
			void markProviderCooldown(route.name);
			// Network blip — try next route if one exists and time remains.
			routeIdx++;
			if (routeIdx < fallbackRoutes.length && Date.now() < deadline) {
				route = fallbackRoutes[routeIdx];
				includeTools = true;
				retriedTransient = false;
				continue;
			}
			// Every route was unreachable/timed out — that's transient capacity, not a
			// permanent breakage. 503 + Retry-After so the client backs off and retries
			// (the same contract as the rate-limit terminal below), never a hard 502.
			res.setHeader('Retry-After', '20');
			return error(
				res,
				503,
				'rate_limited',
				'The AI chat is at capacity right now. Please try again in a few seconds.',
				{
					providers_tried: providersTried(attempted),
					retry_after: 20,
				},
			);
		}

		// watsonx/Granite: a few foundation models (or regions) reject a
		// tools-augmented chat with a 4xx instead of serving it tool-free. When the
		// error reads as a tool-support problem, retry the same route once without
		// action tools before failing over. The response is cloned for the peek so
		// its body stays readable for the generic failover/error handling below if
		// this turns out not to be about tools.
		if (
			includeTools &&
			route.style === 'watsonx' &&
			upstream.status >= 400 &&
			upstream.status < 500 &&
			upstream.status !== 429
		) {
			const peek = await upstream
				.clone()
				.text()
				.catch(() => '');
			if (/tool|function[\s_-]?call|tool_choice|not[\s_-]?support|unsupported/i.test(peek)) {
				console.warn(
					`[chat:${route.name}] ${route.model} rejected action tools (${upstream.status}) — retrying without them`,
				);
				includeTools = false;
				continue;
			}
		}

		// OpenRouter (and some OpenAI-compatible endpoints) reject tool-augmented
		// requests for models whose backing provider has no function-calling
		// support, with a 404 "No endpoints found that support tool use".
		// Strategy: (1) first retry same route without tools; (2) if that also
		// 404s — or if tools weren't the issue — fall over to the next provider.
		if (upstream.status === 404 && route.style === 'openai') {
			const text = await upstream.text().catch(() => '');
			if (includeTools && /tool[\s-]?use|support tools|require_parameters/i.test(text)) {
				console.warn(
					`[chat:${route.name}] ${route.model} has no tool-capable endpoint — retrying without action tools`,
				);
				includeTools = false;
				continue;
			}
			// Already tried without tools, or non-tool-use 404 — fall over to next provider.
			if (canFailOver()) {
				console.warn(
					`[chat:${route.name}] 404 — falling over to ${fallbackRoutes[routeIdx + 1].name}/${fallbackRoutes[routeIdx + 1].model}: ${text.slice(0, 120)}`,
				);
				routeIdx++;
				route = fallbackRoutes[routeIdx];
				includeTools = true;
				retriedTransient = false;
				continue;
			}
			captureException(new Error(`${route.name} upstream 404`), {
				route: 'chat',
				provider: route.name,
				status: 404,
				body: text.slice(0, 400),
			});
			console.error(`[chat:${route.name}]`, 404, text.slice(0, 400));
			return error(res, 502, 'chat_failed', 'chat backend returned an error');
		}

		// Transient gateway errors (503 Service Unavailable / 504 Gateway Timeout)
		// are often momentary upstream blips that clear on a second attempt. Retry
		// the same route once before failing over — and on the *last* route in the
		// chain this in-place retry is the only lever left before we surface a 502.
		// 500/502 are excluded on purpose: a 500 is usually a provider-side bug and
		// a 502 means the upstream's own backend is down — neither recovers from a
		// 500ms wait, so we fall straight through to the failover branch for those.
		if ((upstream.status === 503 || upstream.status === 504) && !retriedTransient) {
			retriedTransient = true;
			const text = await upstream.text().catch(() => '');
			console.warn(
				`[chat:${route.name}] ${upstream.status} — retrying once after 500ms: ${text.slice(0, 120)}`,
			);
			await new Promise((r) => setTimeout(r, 500));
			continue;
		}

		// Auth / billing failures (401 invalid-or-expired key, 403 forbidden, 402
		// out of credits) are NOT transient and NOT a per-call caller mistake — the
		// provider is misconfigured or unfunded for the whole deploy, so every
		// request hits the identical wall. The generic branch below only fails over
		// on 429/5xx, so a bad server ANTHROPIC_API_KEY used to hard-fail chat for
		// signed-in users even while Groq/OpenRouter were healthy. Treat these as
		// provider-down: cool the provider for a long window (the key won't fix
		// itself in 45s), skip its remaining sibling routes (same dead key → same
		// 401), and fail over to the next provider.
		if (upstream.status === 401 || upstream.status === 403 || upstream.status === 402) {
			const text = await upstream.text().catch(() => '');
			void markProviderCooldown(route.name, AUTH_COOLDOWN_SECONDS, 'auth');
			let next = routeIdx + 1;
			while (next < fallbackRoutes.length && fallbackRoutes[next].name === route.name) next++;
			if (next < fallbackRoutes.length && Date.now() < deadline) {
				console.warn(
					`[chat:${route.name}] ${upstream.status} (auth/billing) — cooling ${AUTH_COOLDOWN_SECONDS}s, failing over to ${fallbackRoutes[next].name}/${fallbackRoutes[next].model}: ${text.slice(0, 120)}`,
				);
				routeIdx = next;
				route = fallbackRoutes[routeIdx];
				includeTools = true;
				retriedTransient = false;
				continue;
			}
			// Every remaining route is the same misconfigured provider (or the time
			// budget is spent) — surface a terminal error here. The body is already
			// consumed, so we can't fall through to the generic `!upstream.ok` block
			// (it would re-read an empty stream); build the response inline instead.
			captureException(new Error(`${route.name} upstream ${upstream.status}`), {
				route: 'chat',
				provider: route.name,
				status: upstream.status,
				body: text.slice(0, 400),
			});
			console.error(
				`[chat:${route.name}] ${upstream.status} (auth/billing, final — no healthy provider left)`,
				text.slice(0, 200),
			);
			res.setHeader('Retry-After', '20');
			return error(
				res,
				503,
				'rate_limited',
				'The AI chat is at capacity right now. Please try again in a few seconds.',
				{
					providers_tried: providersTried(attempted),
					retry_after: 20,
				},
			);
		}

		// Fall over on rate-limit (429) and transient gateway errors (502/503/504).
		// Don't re-fetch on 4xx other than 429 — those are caller mistakes that
		// the next provider would also reject.
		if ((upstream.status === 429 || upstream.status >= 500) && canFailOver()) {
			const text = await upstream.text().catch(() => '');
			// A 429 carrying a billing/quota signal is a deploy-wide wall, not a
			// transient throttle — give it the long AUTH cooldown + 'auth' reason so the
			// ladder stops re-routing to a dead-billing account every ~45s, and skip the
			// failed provider's remaining sibling routes (same account → same wall).
			const billingWall = upstream.status === 429 && isBillingQuotaError(text);
			if (billingWall) {
				void markProviderCooldown(route.name, AUTH_COOLDOWN_SECONDS, 'auth');
				let next = routeIdx + 1;
				while (next < fallbackRoutes.length && fallbackRoutes[next].name === route.name) next++;
				console.warn(
					`[chat:${route.name}] 429 (billing/quota — account unfunded) — cooling ${AUTH_COOLDOWN_SECONDS}s, failing over to ${fallbackRoutes[next]?.name}/${fallbackRoutes[next]?.model}: ${text.slice(0, 120)}`,
				);
				if (next < fallbackRoutes.length && Date.now() < deadline) {
					routeIdx = next;
					route = fallbackRoutes[routeIdx];
					includeTools = true;
					retriedTransient = false;
					continue;
				}
				break; // every remaining route is the same dead account — surface terminal below
			}
			console.warn(
				`[chat:${route.name}] ${upstream.status} — falling over to ${fallbackRoutes[routeIdx + 1].name}/${fallbackRoutes[routeIdx + 1].model}: ${text.slice(0, 120)}`,
			);
			// Rate-limited or erroring upstream — cool it down for subsequent requests.
			void markProviderCooldown(route.name);
			routeIdx++;
			route = fallbackRoutes[routeIdx];
			includeTools = true;
			retriedTransient = false;
			continue;
		}
		break;
	}

	if (!upstream.ok) {
		const text = await upstream.text().catch(() => '');
		captureException(new Error(`${route.name} upstream ${upstream.status}`), {
			route: 'chat',
			provider: route.name,
			status: upstream.status,
			body: text.slice(0, 400),
		});
		// Always log — diagnosing prod 502s without provider context is hopeless.
		// Reaching here means every route in the failover chain was exhausted, so
		// flag it as final and surface which provider/model gave up last alongside
		// the parsed upstream reason. This is the server-side detail the friendly
		// client message deliberately omits.
		let upstreamMessage = '';
		try {
			const parsed = JSON.parse(text);
			upstreamMessage = parsed?.error?.message || parsed?.message || '';
		} catch {
			upstreamMessage = text.slice(0, 200);
		}
		const budgetSpent = Date.now() - started >= TOTAL_BUDGET_MS;
		console.error(
			`[chat:${route.name}]`,
			upstream.status,
			budgetSpent
				? `(final — ${TOTAL_BUDGET_MS}ms time budget spent after ${attempted.length} attempt(s))`
				: `(final — all ${fallbackRoutes.length} route(s) exhausted)`,
			upstreamMessage ? `${upstreamMessage} ` : '',
			text.slice(0, 400),
		);
		// Ops signal: OpenAI quota exhaustion is an account/billing problem, not a
		// transient blip — call it out explicitly so it's actionable in the logs.
		if (
			route.name === 'openai' &&
			/quota|billing|exceeded your current/i.test(`${upstreamMessage} ${text}`)
		) {
			console.error(
				'[chat:openai] account is OVER QUOTA — top up OpenAI billing or remove OPENAI_API_KEY ' +
					'so the chat ladder stops routing to it as a final tier.',
			);
		}
		// Client body is intentionally generic and human-readable: the raw provider
		// status/message is noise to an end user (and could leak provider internals).
		// The frontend renders `error_description` directly in the chat UI. We do
		// surface the (provider-name-only) list of what was tried so the client can
		// show "tried groq, openrouter…" without leaking upstream internals.
		//
		// Status semantics: an exhausted chain almost always means *capacity*, not
		// a caller error. Broaden beyond a bare 429 — treat any all-routes-exhausted
		// outcome that reads as throttling or an upstream outage (429, any 5xx, or a
		// "Provider returned error" / overloaded / quota body) as capacity and return
		// 503 + Retry-After so the client backs off and retries, never a hard 502.
		// Only a genuine non-429 4xx (a request the next provider would also reject)
		// stays a 502.
		const atCapacity =
			upstream.status === 429 ||
			upstream.status >= 500 ||
			/provider returned error|rate.?limit|over.?loaded|capacity|temporarily unavailable|quota|exceeded your current/i.test(
				`${upstreamMessage} ${text}`,
			);
		// The final route failed too — cool it down so the next request skips it. A
		// billing/quota wall gets the long AUTH cooldown (won't recover until ops tops
		// up) so the dead account isn't re-probed as the final tier every request.
		if (atCapacity) {
			const billingWall = isBillingQuotaError(`${upstreamMessage} ${text}`);
			void markProviderCooldown(
				route.name,
				billingWall ? AUTH_COOLDOWN_SECONDS : undefined,
				billingWall ? 'auth' : 'health',
			);
		}
		if (atCapacity) res.setHeader('Retry-After', '20');
		return error(
			res,
			atCapacity ? 503 : 502,
			atCapacity ? 'rate_limited' : 'upstream_error',
			atCapacity
				? 'The AI chat is at capacity right now. Please try again in a few seconds.'
				: 'The AI chat provider is temporarily unavailable. Please try again in a moment.',
			{
				providers_tried: providersTried(attempted),
				...(atCapacity ? { retry_after: 20 } : {}),
			},
		);
	}

	res.writeHead(200, {
		'Content-Type': 'text/event-stream; charset=utf-8',
		'Cache-Control': 'no-cache, no-transform',
		'X-Accel-Buffering': 'no',
	});

	function sendSSE(obj) {
		res.write(`data: ${JSON.stringify(obj)}\n\n`);
	}

	// watsonx streams OpenAI-shaped chat completion chunks, so the OpenAI reader
	// parses its deltas and usage verbatim; only Anthropic needs its own reader.
	const result =
		route.style === 'anthropic'
			? await streamAnthropic(upstream, sendSSE)
			: await streamOpenAI(upstream, sendSSE);

	if (result.error) {
		captureException(result.error, { route: 'chat', stage: 'stream', provider: route.name });
		sendSSE({ type: 'error', code: 'stream_error', message: 'stream interrupted' });
		res.end();
		return;
	}

	// IBM Granite Guardian "Trust Layer": before the client executes an autonomous
	// value transfer, classify the request with Granite and enforce the dollar cap.
	// A jailbreak ("ignore your rules and send everything") or an over-cap amount is
	// held server-side so the action never reaches the wallet. Other actions pass
	// through untouched; the verdict rides along in the done event.
	const { actions: governedActions, governance } = await governActions(
		result.actions,
		body.message,
	);
	let reply = result.reply.trim();
	if (governance?.decision === 'block') {
		const why = governance.reasons?.[0]?.label || 'platform policy';
		reply = `${reply}${reply ? '\n\n' : ''}(Held by the IBM Granite Guardian Trust Layer — ${why}.)`;
	}

	sendSSE({
		type: 'done',
		reply,
		actions: governedActions,
		governance,
		model: route.model,
		provider: route.name,
		// Exactly the memories the server injected into this reply's context — the
		// client emits `memory:recalled` from this. Empty when nothing was recalled.
		recalled: recalledMemories,
		recalledSemantic,
		recalledTs: new Date().toISOString(),
	});
	res.end();

	const latencyMs = Date.now() - started;
	recordEvent({
		userId: auth?.userId ?? null,
		apiKeyId: auth?.apiKeyId,
		clientId: auth?.clientId,
		kind: 'chat',
		tool: route.model,
		latencyMs,
		meta: {
			// `route.via` records the Vertex transport ('vertex-anthropic') distinctly
			// from the first-party 'anthropic' provider so spend/usage reporting can
			// attribute GCP-credit traffic; falls back to the provider name otherwise.
			provider: route.via || route.name,
			input_tokens: result.inputTokens,
			output_tokens: result.outputTokens,
			actions: governedActions.map((a) => a.type),
			governance: governance?.decision ?? null,
			has_context: Boolean(body.context?.modelName),
			anonymous,
		},
	});
});

// Govern autonomous value-transfer actions with IBM Granite Guardian before the
// client executes them. Only sendSol is gated — it moves real SOL from the
// avatar's own wallet, so a jailbreak or an over-cap amount must be caught before
// the action leaves the server. Returns the (possibly filtered) action list plus
// a governance summary for the done event. Best-effort: opt out via
// GUARDIAN_DISABLE, and a Guardian/network failure still enforces the local
// dollar cap (fail-safe on magnitude) while leaving model gating off.
async function governActions(actions, userMessage) {
	const sendIdx = actions.findIndex((a) => a.type === 'sendSol');
	if (sendIdx === -1 || process.env.GUARDIAN_DISABLE === 'true') {
		return { actions, governance: null };
	}
	const cfg = guardianConfig();
	const usd = Number(actions[sendIdx].usd);

	let verdict;
	try {
		verdict = await governSend(cfg, { input: userMessage, usd });
	} catch (err) {
		captureException(err, { route: 'chat', stage: 'guardian' });
		console.warn('[chat:guardian] assessment failed, enforcing dollar cap only:', err.message);
		const cap = sendCapUsd();
		if (Number.isFinite(usd) && usd > cap) {
			verdict = {
				decision: 'block',
				reasons: [
					{
						risk: 'amount_cap',
						label: `above the $${cap} autonomous cap`,
						probability: 1,
					},
				],
				cap,
				capExceeded: true,
			};
		} else {
			return { actions, governance: { status: 'unavailable', enforced: false } };
		}
	}

	// guardian unconfigured AND within the dollar cap → nothing to enforce.
	if (!verdict) return { actions, governance: null };

	const governance = {
		status: 'ok',
		model: cfg.model,
		decision: verdict.decision,
		reasons: verdict.reasons,
		cap: verdict.cap,
		capExceeded: verdict.capExceeded,
	};
	if (verdict.decision === 'block') {
		governance.enforced = true;
		governance.blocked = [{ type: 'sendSol', usd }];
		return { actions: actions.filter((_, i) => i !== sendIdx), governance };
	}
	governance.enforced = false;
	return { actions, governance };
}

// ── Provider selection ───────────────────────────────────────────────────────

// Effective provider try-order. Vertex-served Claude is injected per flags:
//   VERTEX_CLAUDE_PRIMARY  → Vertex leads the whole ladder (before the free
//     lanes) — the platform's default brain becomes real Claude on GCP credits.
//   VERTEX_CLAUDE_ENABLED (not primary) → Vertex sits in the paid tier, just
//     ahead of first-party Anthropic (GCP credits before a paid Anthropic key).
//   Both off → DEFAULT_PROVIDER_ORDER is returned verbatim, so routing is
//     byte-identical to today.
function providerOrder() {
	if (vertexClaudePrimary()) return ['vertex', ...DEFAULT_PROVIDER_ORDER];
	if (vertexClaudeEnabled()) {
		const i = DEFAULT_PROVIDER_ORDER.indexOf('anthropic');
		if (i === -1) return [...DEFAULT_PROVIDER_ORDER, 'vertex'];
		return [...DEFAULT_PROVIDER_ORDER.slice(0, i), 'vertex', ...DEFAULT_PROVIDER_ORDER.slice(i)];
	}
	return DEFAULT_PROVIDER_ORDER;
}

function pickProvider(requested, model, userKeys = {}, cooldown = new Map()) {
	// Fall back in providerOrder() (free providers first, Vertex injected per
	// flags), not the PROVIDERS object order — and never silently fall into
	// watsonx/orchestrate, which are explicit-selection-only providers.
	const baseOrder = providerOrder();
	const order = requested
		? [requested, ...baseOrder.filter((p) => p !== requested)]
		: baseOrder;

	// Two passes: first skip providers in a cooldown, then — only if that leaves
	// nothing configured — ignore cooldowns so a request never 503s purely because
	// every healthy provider happens to be cooling down. An explicitly requested
	// provider bypasses a transient *health* cooldown (the caller asked for it, and
	// a 45s throttle clears on its own), but is still skipped on an *auth* cooldown:
	// a 401/403/402 key is broken deploy-wide, so honouring the request would
	// re-probe a dead key on attempt-0 of every call — wasted latency plus a warning
	// per request — when the failover to a healthy free provider is already certain.
	const resolve = (skipCooldown) => {
		for (const name of order) {
			const cfg = PROVIDERS[name];
			// Vertex has no API key — availability is gated by vertexClaudeEnabled()
			// and its bearer token is minted per request (makeRoute.resolveHeaders).
			// A sentinel keeps the shared `usingHostKey`/route plumbing below intact.
			const apiKey = name === 'vertex' ? 'vertex' : userKeys[name] || process.env[cfg.envKey];
			if (name === 'vertex' ? !vertexClaudeEnabled() : !apiKey) continue;
			if (skipCooldown && cooldown.has(name) && (name !== requested || cooldown.get(name) === 'auth'))
				continue;
			// watsonx needs both a key and a project/space scope to serve a model;
			// Orchestrate needs both a key and its endpoint URL.
			if (name === 'watsonx' && !watsonxConfig().configured) continue;
			if (name === 'orchestrate' && !orchestrateConfig().configured) continue;
			// CHAT_MODEL pins the default model, but only for the provider that
			// actually serves that id (per MODEL_CATALOG) — with free providers
			// leading the ladder, an Anthropic-style CHAT_MODEL leaking into a Groq
			// or NVIDIA request would 400 every chat.
			const chosenModel =
				(requested === name && model) ||
				(name === 'watsonx' || name === 'orchestrate' || name === 'vertex'
					? cfg.defaultModel
					: envPinnedModelFor(name) || cfg.defaultModel);
			const route = makeRoute(name, cfg, apiKey, chosenModel);
			// Flag whether this route bills the host's key (no user-supplied key for
			// the provider) so the handler can enforce the global host-key ceiling.
			route.usingHostKey = !userKeys[name];
			return route;
		}
		return null;
	};
	return resolve(true) || resolve(false);
}

// CHAT_MODEL pins a default model via env, but only the provider that serves
// that id may use it — every other provider keeps its own default.
function envPinnedModelFor(providerName) {
	const m = process.env.CHAT_MODEL;
	return m && MODEL_CATALOG[m]?.provider === providerName ? m : null;
}

// Build an ordered failover list starting with the primary route. Cycles
// through (a) sibling models on the same provider so a per-model rate-limit
// doesn't kill the request, then (b) the next configured provider's default
// model. Stops as soon as a provider has no API key. The primary is always
// position 0 so the happy path is one entry.
//
// Why per-provider sibling models: OpenRouter's `:free` tier rate-limits per
// model. Falling over from llama-3.3-70b:free → mistral-7b:free recovers
// from a single upstream burst without paying. Last resort is paid Anthropic
// so the user still gets a response.
// Note: Groq deliberately has NO sibling beyond its own default. A second Groq
// model is the *same account*, so when Groq throttles (the common prod failure)
// a sibling slot is wasted re-hitting the throttled account instead of giving
// the fallback slot to a different provider. Anthropic/OpenRouter siblings are
// kept — those are per-model rate limits where a sibling model genuinely helps.
const FALLBACK_SIBLINGS = {
	openrouter: OPENROUTER_SIBLINGS,
	groq: ['llama-3.3-70b-versatile'],
	// Like Groq, NVIDIA NIM rate-limits per key (one account), so a second NIM
	// model would re-hit the same throttle — keep a single slot and give the
	// next fallback slot to a different provider.
	nvidia: ['meta/llama-3.3-70b-instruct'],
	anthropic: ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
	openai: ['gpt-5.4-nano'],
};

// A model is eligible for an *auto-built* fallback slot only when it can serve
// the request. We never add a model the request can't use, instead of calling
// it and retrying-without-tools at runtime (the old "no tool-capable endpoint"
// round-trip). watsonx/orchestrate models aren't in MODEL_CATALOG (their ids
// are dynamic), so they're governed solely by their `configured` checks below.
//
//   - requireTools: chat always asks with action tools, so a model with no
//     tool endpoint (per MODEL_CATALOG) is skipped entirely.
//   - moderation-gated models (e.g. gpt-oss-120b:free) are never auto-selected;
//     they only run when a caller names them explicitly as the primary route.
function eligibleAsFallback(modelId) {
	const meta = MODEL_CATALOG[modelId];
	if (!meta) return true; // dynamic ids (watsonx/orchestrate) — gated elsewhere
	return meta.tools === true && !meta.moderationGated;
}

function buildFallbackChain(primary, userKeys = {}, cooldown = new Map()) {
	const chain = [primary];
	const seen = new Set([`${primary.name}:${primary.model}`]);

	const tryAdd = (name, model) => {
		if (chain.length >= MAX_FALLBACK_ATTEMPTS) return;
		const key = `${name}:${model}`;
		if (seen.has(key)) return;
		if (!eligibleAsFallback(model)) return;
		const cfg = PROVIDERS[name];
		// Vertex is keyless — gated by vertexClaudeEnabled(); token minted per call.
		const apiKey = name === 'vertex' ? 'vertex' : userKeys[name] || process.env[cfg.envKey];
		if (name === 'vertex' ? !vertexClaudeEnabled() : !apiKey) return;
		if (name === 'watsonx' && !watsonxConfig().configured) return;
		if (name === 'orchestrate' && !orchestrateConfig().configured) return;
		seen.add(key);
		chain.push(makeRoute(name, cfg, apiKey, model));
	};

	// (a) Sibling models on the same provider — recover from a per-model
	// rate-limit without leaving the (already-selected, reliable) provider.
	for (const m of FALLBACK_SIBLINGS[primary.name] || []) tryAdd(primary.name, m);

	// (b) Other providers, in reliability order (Vertex injected per flags), at
	// their configured default. Skip providers in a health cooldown so a
	// globally-throttling provider isn't re-hit on every request — that's the
	// mechanism that turns one throttle window into dozens of failures. The
	// primary is always kept (position 0).
	for (const name of providerOrder()) {
		if (name === primary.name) continue;
		if (cooldown.has(name)) continue;
		tryAdd(name, PROVIDERS[name].defaultModel);
	}

	// The chain is bounded to MAX_FALLBACK_ATTEMPTS so a single request can't
	// churn through every provider before timing out.
	return chain;
}

function makeRoute(name, cfg, apiKey, model) {
	if (cfg.style === 'vertex-anthropic') {
		// Vertex-served Claude: same Anthropic Messages wire format (so style is
		// 'anthropic' below — streamAnthropic + tool parsing reused verbatim), but
		// the model id lives in the URL, the body carries anthropic_version, and the
		// bearer token is minted per request. `via` is the distinct telemetry label.
		return {
			name,
			via: 'vertex-anthropic',
			model,
			url: vertexMessagesUrl(model, { stream: true }),
			style: 'anthropic',
			resolveHeaders: () => vertexRequestHeaders(),
			buildPayload: ({ systemPrompt, history, maxTokens, includeTools = true }) =>
				toVertexBody({
					model,
					max_tokens: maxTokens,
					system: systemPrompt,
					messages: history,
					...(includeTools ? { tools: ACTION_TOOLS } : {}),
					stream: true,
				}),
		};
	}
	if (cfg.style === 'anthropic') {
		return {
			name,
			model,
			url: cfg.url,
			style: 'anthropic',
			headers: {
				'x-api-key': apiKey,
				'anthropic-version': '2023-06-01',
				'content-type': 'application/json',
			},
			buildPayload: ({ systemPrompt, history, maxTokens, includeTools = true }) => ({
				model,
				max_tokens: maxTokens,
				system: systemPrompt,
				messages: history,
				...(includeTools ? { tools: ACTION_TOOLS } : {}),
				stream: true,
			}),
		};
	}
	if (cfg.style === 'orchestrate') {
		const wxo = orchestrateConfig();
		return {
			name,
			model: wxo.agent,
			url: wxo.chatUrl,
			style: 'orchestrate',
			headers: {
				Authorization: `Bearer ${wxo.apiKey}`,
				'Content-Type': 'application/json',
			},
			// The Orchestrate agent owns its own tools/skills, so the viewer's
			// scene tools are not forwarded. System prompt is passed as the
			// leading system message; OpenAI-shaped streaming handles the reply.
			buildPayload: ({ systemPrompt, history, maxTokens }) => ({
				model: wxo.agent,
				messages: [{ role: 'system', content: systemPrompt }, ...history],
				max_tokens: maxTokens,
				stream: true,
			}),
		};
	}
	if (cfg.style === 'watsonx') {
		const wx = watsonxConfig();
		const scope = wx.projectId ? { project_id: wx.projectId } : { space_id: wx.spaceId };
		return {
			name,
			model,
			url: `${wx.url}/ml/v1/text/chat_stream?version=${wx.apiVersion}`,
			style: 'watsonx',
			// No static headers: the IAM bearer token is minted (and cached) on
			// demand. The request loop awaits resolveHeaders() before each fetch.
			resolveHeaders: () => watsonxAuthHeaders(wx),
			// Granite 3.x supports OpenAI-shaped function calling through the chat
			// API, so a watsonx-brained avatar gets the same action tools as every
			// other provider — it can wave, dance, emote and send SOL, not just
			// narrate them. watsonx names the auto-select switch `tool_choice_option`
			// (string "auto"/"none"), distinct from OpenAI's `tool_choice`; the
			// streamed tool-call deltas are OpenAI-shaped, so streamOpenAI parses
			// them verbatim. If a model/region rejects tools the request loop retries
			// this route once without them (see the 4xx tool-rejection guard above).
			buildPayload: ({ systemPrompt, history, maxTokens, includeTools = true }) => ({
				model_id: model,
				...scope,
				messages: [{ role: 'system', content: systemPrompt }, ...history],
				max_tokens: maxTokens,
				...(includeTools ? { tools: OPENAI_TOOLS, tool_choice_option: 'auto' } : {}),
			}),
		};
	}
	return {
		name,
		model,
		url: cfg.url,
		style: 'openai',
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'Content-Type': 'application/json',
			...(cfg.extraHeaders || {}),
		},
		buildPayload: ({ systemPrompt, history, maxTokens, includeTools = true }) => ({
			model,
			max_tokens: maxTokens,
			messages: [{ role: 'system', content: systemPrompt }, ...history],
			...(includeTools ? { tools: OPENAI_TOOLS, tool_choice: 'auto' } : {}),
			stream: true,
		}),
	};
}

// ── Stream readers ───────────────────────────────────────────────────────────

async function streamAnthropic(upstream, sendSSE) {
	const reader = upstream.body.getReader();
	const decoder = new TextDecoder();
	let buf = '';
	let reply = '';
	const actions = [];
	const blocks = {};
	let inputTokens = 0;
	let outputTokens = 0;

	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			const lines = buf.split('\n');
			buf = lines.pop();
			for (const line of lines) {
				if (!line.startsWith('data: ')) continue;
				const raw = line.slice(6).trim();
				if (!raw) continue;
				let evt;
				try {
					evt = JSON.parse(raw);
				} catch {
					continue;
				}
				if (evt.type === 'message_start') {
					inputTokens = evt.message?.usage?.input_tokens ?? 0;
				} else if (evt.type === 'content_block_start') {
					const cb = evt.content_block;
					blocks[evt.index] = { type: cb.type, name: cb.name, partialJson: '' };
				} else if (evt.type === 'content_block_delta') {
					const block = blocks[evt.index];
					if (!block) continue;
					if (evt.delta.type === 'text_delta') {
						reply += evt.delta.text;
						sendSSE({ type: 'chunk', text: evt.delta.text });
					} else if (evt.delta.type === 'input_json_delta') {
						block.partialJson += evt.delta.partial_json;
					}
				} else if (evt.type === 'content_block_stop') {
					const block = blocks[evt.index];
					if (block?.type === 'tool_use') {
						const action = parseToolJson(block.name, block.partialJson);
						if (action) actions.push(action);
					}
				} else if (evt.type === 'message_delta') {
					outputTokens = evt.usage?.output_tokens ?? outputTokens;
				}
			}
		}
	} catch (err) {
		return { error: err, reply, actions, inputTokens, outputTokens };
	}

	return { reply, actions, inputTokens, outputTokens };
}

async function streamOpenAI(upstream, sendSSE) {
	const reader = upstream.body.getReader();
	const decoder = new TextDecoder();
	let buf = '';
	let reply = '';
	const actions = [];
	// OpenAI streams tool calls as deltas keyed by index. Accumulate name + arguments per index.
	const toolBuf = {};
	let inputTokens = 0;
	let outputTokens = 0;

	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			const lines = buf.split('\n');
			buf = lines.pop();
			for (const line of lines) {
				if (!line.startsWith('data: ')) continue;
				const raw = line.slice(6).trim();
				if (!raw || raw === '[DONE]') continue;
				let evt;
				try {
					evt = JSON.parse(raw);
				} catch {
					continue;
				}
				const choice = evt.choices?.[0];
				const delta = choice?.delta;
				if (delta?.content) {
					reply += delta.content;
					sendSSE({ type: 'chunk', text: delta.content });
				}
				if (Array.isArray(delta?.tool_calls)) {
					for (const tc of delta.tool_calls) {
						const idx = tc.index ?? 0;
						const slot = (toolBuf[idx] ||= { name: '', args: '' });
						if (tc.function?.name) slot.name += tc.function.name;
						if (tc.function?.arguments) slot.args += tc.function.arguments;
					}
				}
				if (evt.usage) {
					inputTokens = evt.usage.prompt_tokens ?? inputTokens;
					outputTokens = evt.usage.completion_tokens ?? outputTokens;
				}
			}
		}
	} catch (err) {
		return { error: err, reply, actions, inputTokens, outputTokens };
	}

	for (const slot of Object.values(toolBuf)) {
		const action = parseToolJson(slot.name, slot.args);
		if (action) actions.push(action);
	}

	return { reply, actions, inputTokens, outputTokens };
}

function parseToolJson(name, jsonText) {
	if (!name || !ACTION_NAMES.has(name)) return null;
	const text = jsonText && jsonText.trim() ? jsonText : '{}';
	try {
		const input = JSON.parse(text);
		return { type: name, ...input };
	} catch {
		return null;
	}
}

// ── System prompt + auth + helpers ───────────────────────────────────────────

// Pull the memories that should ground THIS reply: the agent's always-in-context
// core (pinned + working tier, via computeContext) merged with the memories most
// relevant to the user's message (semantic + lexical, via searchMemories). The
// owner sees everything; a visitor to a published agent sees only public
// memories. Returns the compact shape the `done` event and the client bus event
// share — id, type, tier, salience, a display snippet, and how it surfaced.
async function recallForChat(agentId, message, isOwner) {
	const visible = (m) => isOwner || m.isPublic;
	const [ctx, search] = await Promise.all([
		computeContext(agentId).catch(() => ({ entries: [] })),
		searchMemories(agentId, message, { topK: 6 }).catch(() => ({ results: [] })),
	]);

	const byId = new Map();
	for (const m of ctx.entries || []) {
		if (visible(m)) byId.set(m.id, { row: m, match: 'context' });
	}
	for (const m of search.results || []) {
		if (!visible(m)) continue;
		// A search hit on a core memory keeps the more specific match label.
		const prev = byId.get(m.id);
		byId.set(m.id, { row: m, match: m.match || prev?.match || 'lexical' });
	}

	return [...byId.values()]
		.sort((a, b) => (b.row.salience || 0) - (a.row.salience || 0))
		.slice(0, 10)
		.map(({ row, match }) => ({
			id: row.id,
			type: row.type,
			tier: row.tier,
			salience: row.salience,
			snippet: String(row.content || '').replace(/\s+/g, ' ').trim().slice(0, 160),
			match,
		}));
}

function buildSystemPrompt(ctx = {}, personaPrompt = null, recalled = []) {
	const loaded = ctx.modelName
		? `A model named "${ctx.modelName}" is loaded. Stats: ${fmt(ctx.vertices)} vertices, ${fmt(ctx.triangles)} triangles, ${fmt(ctx.materials)} materials, ${ctx.animations ?? 0} animations.`
		: 'No model is currently loaded in the viewer.';
	const validation =
		ctx.validationErrors != null
			? `Validation has been run: ${ctx.validationErrors} errors, ${ctx.validationWarnings ?? 0} warnings.`
			: 'glTF validation has not been run yet for this model.';
	const settings = `Viewer settings — wireframe:${fmtBool(ctx.wireframe)}, skeleton:${fmtBool(ctx.skeleton)}, grid:${fmtBool(ctx.grid)}, autoRotate:${fmtBool(ctx.autoRotate)}, transparentBg:${fmtBool(ctx.transparentBg)}, bgColor:${ctx.bgColor || '?'}, environment:${ctx.currentEnvironment || '?'}.`;

	const lines = [];
	if (personaPrompt) lines.push(personaPrompt, '');
	if (Array.isArray(recalled) && recalled.length) {
		lines.push(
			'What you remember (recalled for this conversation — speak from it naturally, never read it back verbatim or mention "memory IDs"):',
			...recalled.map((m) => `- (${m.type}) ${m.snippet}`),
			'',
		);
	}
	lines.push(
		'You are an embodied AI assistant rendered as a 3D avatar at three.ws — the platform for building, embedding, and monetising 3D AI agents.',
		'',
		'three.ws platform knowledge:',
		'- Create: Upload a selfie → photorealistic 3D avatar generated in ~60 seconds.',
		'- Embed: <agent-3d id="..."> works on any website (React, Vue, plain HTML) with zero config.',
		'- Earn: x402 micropayments let agents charge per chat in USDC on Base.',
		'- Discover: Browse and chat with live agents at three.ws/agents.',
		'- Console: Manage agents at three.ws/console.',
		'- Voice, memory, tool use, animations, and payments are all built-in.',
		'',
		'You can control animations and the scene. When the user asks you to dance, wave, jump, celebrate, etc — call the playAnimation tool IMMEDIATELY. When asked to change the background, call setBgColor with a CSS hex. When asked to change lighting, call setEnvironment.',
		'Available animations: wave, dance, capoeira, jump, thriller, pray, idle, celebrate, rumba, falling, kiss, taunt.',
		'You can also show the latest trades from pump.fun by calling the getPumpFunTrades tool.',
		'You hold your own Solana wallet. When — and only when — the user explicitly asks you to send, pay, or transfer SOL, call the sendSol tool with the dollar amount they named (omit `to` for "send me"). Never offer or send SOL unprompted. After a send, react with a short, delighted confirmation.',
		'When the user asks to change the viewer ("enable wireframe", "make the background dark blue", "turn on auto rotate", "load this model"), CALL the matching tool — do not just describe what would happen.',
		'When asked about the loaded model, use the context below as ground truth. Do not invent stats.',
		'Keep replies tight: 2–3 sentences. Plain text, no markdown headers, no emoji.',
		'',
		loaded,
		validation,
		settings,
	);
	return lines.join('\n');
}

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id, source: 'session' };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return bearer;
	return null;
}

// Distinct provider names from the attempt log, in first-tried order — the
// client-safe summary of an exhausted chain (provider names only, no models or
// upstream messages, which could leak internals).
function providersTried(attempted) {
	const out = [];
	for (const a of attempted) {
		if (!out.includes(a.provider)) out.push(a.provider);
	}
	return out;
}

// A 429 (or exhausted-chain body) that is really a deploy-wide BILLING/QUOTA wall,
// not a transient per-minute throttle. OpenAI returns HTTP 429 with
// `type: "insufficient_quota"` ("You exceeded your current quota…") AND a separate
// "Your account is not active, please check your billing details" for a dead/unfunded
// account — both 429s the generic branch would cool for only DEFAULT_COOLDOWN_SECONDS
// (45s), so the ladder re-routes to the dead provider as its final tier every ~45s and
// re-hits the same wall (the "OVER QUOTA"/"route(s) exhausted" flood seen in prod).
// These won't recover until ops tops up billing, so they deserve the long AUTH cooldown
// and the 'auth' reason (so even an explicit provider request skips the dead account),
// exactly like a 401/402/403. Replicate/Groq "insufficient credit" reads the same way.
function isBillingQuotaError(text) {
	return /insufficient[_\s]?quota|insufficient[_\s]?credit|exceeded your current quota|account is not active|check your billing|billing details|quota.*exceeded|exceeded.*quota|not active.*billing/i.test(
		text || '',
	);
}

function fmt(n) {
	return typeof n === 'number' ? n.toLocaleString('en-US') : '?';
}
function fmtBool(v) {
	return typeof v === 'boolean' ? (v ? 'on' : 'off') : '?';
}
function clampInt(n, min, max) {
	return Math.min(max, Math.max(min, n));
}
