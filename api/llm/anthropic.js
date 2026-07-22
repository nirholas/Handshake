// We-pay LLM proxy. The browser always sends an Anthropic-shape body
// ({ system, messages, tools, model, ... }) regardless of the upstream
// model — this file inspects `model` and either forwards to Anthropic
// unchanged, or translates request/response to/from the OpenAI shape
// used by Groq and OpenRouter. Embed-policy origin / quota / rate-limit
// checks run identically for every route.
//
// Why "everything as Anthropic-shape": the browser-side AnthropicProvider
// (src/runtime/providers.js) parses Anthropic SSE events directly. Hiding
// the upstream difference here means free-tier Groq/OpenRouter models work
// in every avatar embed without changing a line of client code.

import { z } from 'zod';
import { env } from '../_lib/env.js';
import { getRedis as _getSharedRedis } from '../_lib/redis.js';
import { cors, error, method, wrap, readJson, json, rateLimited } from '../_lib/http.js';
import { parse } from '../_lib/validate.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { recordEvent, logger } from '../_lib/usage.js';
import { costMicroUsd } from '../_lib/llm-pricing.js';
import {
	readEmbedPolicy,
	readEmbedPolicyByAvatarId,
	defaultEmbedPolicy,
} from '../_lib/embed-policy.js';
import { getAvatar } from '../_lib/avatars.js';
import {
	vertexClaudeEnabled,
	vertexMessagesUrl,
	vertexRequestHeaders,
	toVertexBody,
} from '../_lib/vertex-claude.js';
import {
	vertexGeminiAvailable,
	vertexGeminiModel,
	vertexGeminiChatUrl,
	vertexGeminiHeaders,
} from '../_lib/vertex-gemini.js';

const log = logger('llm.anthropic');

// ── Redis client (for monthly quota counters) ────────────────────────────────

function getRedis() { return _getSharedRedis(); }

// ── Model → upstream routing ─────────────────────────────────────────────────
//
// Adding a model: append it here. `kind` decides how the request body and
// response stream are shaped. Groq/OpenRouter both speak OpenAI's wire
// format so they share the 'openai' branch; only the upstream URL and the
// env var differ.

const MODELS = {
	// Anthropic (paid — host's key)
	'claude-fable-5': { kind: 'anthropic', envKey: 'ANTHROPIC_API_KEY' },
	'claude-mythos-5': { kind: 'anthropic', envKey: 'ANTHROPIC_API_KEY' },
	'claude-opus-4-7': { kind: 'anthropic', envKey: 'ANTHROPIC_API_KEY' },
	'claude-opus-4-6': { kind: 'anthropic', envKey: 'ANTHROPIC_API_KEY' },
	'claude-sonnet-4-6': { kind: 'anthropic', envKey: 'ANTHROPIC_API_KEY' },
	'claude-haiku-4-5-20251001': { kind: 'anthropic', envKey: 'ANTHROPIC_API_KEY' },

	// OpenRouter free tier (no per-token cost; daily rate cap shared across host).
	// All are tool-call capable in OpenRouter's catalog.
	'meta-llama/llama-3.3-70b-instruct:free': {
		kind: 'openai',
		provider: 'openrouter',
		envKey: 'OPENROUTER_API_KEY',
	},
	'openai/gpt-oss-120b:free': {
		kind: 'openai',
		provider: 'openrouter',
		envKey: 'OPENROUTER_API_KEY',
	},
	'nousresearch/hermes-3-llama-3.1-405b:free': {
		kind: 'openai',
		provider: 'openrouter',
		envKey: 'OPENROUTER_API_KEY',
	},

	// Groq free tier (sub-second latency; per-IP+per-key minute caps).
	'llama-3.3-70b-versatile': { kind: 'openai', provider: 'groq', envKey: 'GROQ_API_KEY' },
	'llama-3.1-8b-instant': { kind: 'openai', provider: 'groq', envKey: 'GROQ_API_KEY' },

	// NVIDIA NIM free tier (build.nvidia.com). One nvapi key, OpenAI-compatible,
	// tool-call capable. Used both as directly-selectable models and as a free
	// fallback ahead of paid Anthropic in the chain below.
	'nvidia/llama-3.3-nemotron-super-49b-v1.5': {
		kind: 'openai',
		provider: 'nvidia',
		envKey: 'NVIDIA_API_KEY',
	},
	'nvidia/nvidia-nemotron-nano-9b-v2': {
		kind: 'openai',
		provider: 'nvidia',
		envKey: 'NVIDIA_API_KEY',
	},
	'meta/llama-4-maverick-17b-128e-instruct': {
		kind: 'openai',
		provider: 'nvidia',
		envKey: 'NVIDIA_API_KEY',
	},

	// xAI Grok (paid, host's key). OpenAI-compatible and tool-call capable, so
	// it shares the 'openai' branch. Selectable only; never a free fallback.
	'grok-4.5': { kind: 'openai', provider: 'grok', envKey: 'GROK_API_KEY' },
	'grok-4.3': { kind: 'openai', provider: 'grok', envKey: 'GROK_API_KEY' },
	'grok-4.1-fast': { kind: 'openai', provider: 'grok', envKey: 'GROK_API_KEY' },
};

const UPSTREAM_URL = {
	anthropic: 'https://api.anthropic.com/v1/messages',
	openrouter: 'https://openrouter.ai/api/v1/chat/completions',
	groq: 'https://api.groq.com/openai/v1/chat/completions',
	nvidia: 'https://integrate.api.nvidia.com/v1/chat/completions',
	grok: 'https://api.x.ai/v1/chat/completions',
};

// Resolve a model id to its upstream route. Static allowlist first; the Vertex
// Gemini credits anchor resolves dynamically because its model id is env-tunable
// (VERTEX_GEMINI_MODEL) and its availability is gated by GOOGLE_CLOUD_PROJECT,
// not an API key. It shares the 'openai' branch — the Vertex OpenAI-compatible
// endpoint speaks the same wire format (tools included), so request translation
// and the Anthropic-shape response/SSE conversion below work verbatim.
// Exported for the anchor regression tests (tests/api/llm-vertex-anchor-surfaces).
export function resolveModelRoute(modelId) {
	if (MODELS[modelId]) return MODELS[modelId];
	if (vertexGeminiAvailable() && modelId === vertexGeminiModel()) {
		return { kind: 'openai', provider: 'vertex-gemini' };
	}
	return null;
}

// Ordered model fallback chain for a request. Free lanes degrade in-order; the
// credits-funded Vertex Gemini anchor is ALWAYS the final rung when the GCP
// project is set (api/chat.js semantics — see api/_lib/vertex-gemini.js): it is
// keyless, has no third-party quota, and no present provider key may evict it,
// so an embedded agent's brain cannot 5xx while GCP credits can still answer.
// The paid Anthropic rung stays ahead of it — when that key works it is the
// caller-visible model family — but a dead paid key degrades to the anchor
// instead of surfacing an error. Exported for the anchor regression tests.
export function modelFallbackChain(requestedModel) {
	const chain = [
		requestedModel,
		...[
			'meta-llama/llama-3.1-8b-instruct:free',
			'meta/llama-4-maverick-17b-128e-instruct',
			'claude-haiku-4-5-20251001',
		].filter((m) => m !== requestedModel),
	];
	if (vertexGeminiAvailable() && !chain.includes(vertexGeminiModel())) {
		chain.push(vertexGeminiModel());
	}
	return chain;
}

const FIRST_PARTY = ['three.ws', 'localhost'];

const DEFAULT_MONTHLY_TOKEN_BUDGET = 1_000_000;
const CENTS_PER_1K_TOKENS = 1.5;

function tokenBudgetFromPolicy(policy) {
	const cents = policy?.brain?.cost_limit_cents;
	if (typeof cents === 'number' && cents > 0) {
		return Math.floor((cents / CENTS_PER_1K_TOKENS) * 1000);
	}
	return DEFAULT_MONTHLY_TOKEN_BUDGET;
}

function monthKey() {
	const now = new Date();
	return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function originAllowed(originHeader, policy) {
	if (!originHeader) return true;
	let host;
	try {
		host = new URL(originHeader).hostname.toLowerCase();
	} catch {
		return false;
	}
	if (FIRST_PARTY.some((fp) => host === fp || host.endsWith('.' + fp))) return true;
	const hosts = policy?.origins?.hosts ?? [];
	const mode = policy?.origins?.mode ?? 'allowlist';
	const matches = hosts.some((h) => {
		const lower = h.toLowerCase();
		if (lower.startsWith('*.')) return host.endsWith(lower.slice(1)) && host !== lower.slice(2);
		return host === lower;
	});
	return mode === 'allowlist' ? matches : !matches;
}

function buildCorsAllowlist(policy) {
	const out = new Set();
	if (env.APP_ORIGIN) out.add(env.APP_ORIGIN);
	try {
		if (env.ISSUER) out.add(env.ISSUER);
	} catch {
		// ISSUER derives from APP_ORIGIN; ignore if unset.
	}
	const hosts = policy?.origins?.hosts ?? [];
	for (const h of hosts) {
		const lower = String(h).toLowerCase();
		if (lower.startsWith('*.')) {
			const base = lower.slice(2).replace(/[.+?^${}()|[\]\\]/g, '\\$&');
			out.add(new RegExp(`^https?://([a-z0-9-]+\\.)+${base}$`));
		} else {
			out.add(`https://${lower}`);
			out.add(`http://${lower}`);
		}
	}
	if (process.env.NODE_ENV !== 'production') {
		out.add(/^https?:\/\/localhost(:\d+)?$/);
	}
	return Array.from(out);
}

// A Redis outage hits every request, so unthrottled logging would itself storm
// the logs. Warn at most once per cooldown, mirroring rate-limit.js's degrade
// throttle.
let _quotaWarnedAt = 0;
function warnQuotaDegraded(err) {
	const t = Date.now();
	if (t - _quotaWarnedAt < 60_000) return;
	_quotaWarnedAt = t;
	console.warn(
		'[llm/anthropic] quota-counter redis degraded, failing open:',
		err?.message || err,
	);
}

async function incrementMonthlyQuota(agentId) {
	const r = getRedis();
	if (!r) return 0;
	const key = `llm:quota:${agentId}:${monthKey()}`;
	try {
		const count = await r.incr(key);
		if (count === 1) await r.expire(key, 40 * 24 * 3600);
		return count;
	} catch (err) {
		// Fail open like the per-IP/per-agent limiters this handler already uses:
		// a counter-store outage must not 500 the proxy. Spend stays bounded by
		// those (resilient) limiters during the outage window.
		warnQuotaDegraded(err);
		return 0;
	}
}

// Read-only peek at the monthly call counter — used for the pre-flight quota
// check so a request that never reaches a provider (validation error, upstream
// 429/5xx across the whole fallback chain) doesn't consume quota. The counter
// is only incremented after a successful upstream response, mirroring the
// token-budget pattern (getMonthlyTokens before / addMonthlyTokens after).
async function getMonthlyQuotaUsed(agentId) {
	const r = getRedis();
	if (!r) return 0;
	const key = `llm:quota:${agentId}:${monthKey()}`;
	try {
		const v = await r.get(key);
		return typeof v === 'number' ? v : parseInt(v || '0', 10) || 0;
	} catch (err) {
		warnQuotaDegraded(err);
		return 0;
	}
}

async function getMonthlyTokens(agentId) {
	const r = getRedis();
	if (!r) return 0;
	const key = `llm:tokens:${agentId}:${monthKey()}`;
	try {
		const v = await r.get(key);
		return typeof v === 'number' ? v : parseInt(v || '0', 10) || 0;
	} catch (err) {
		warnQuotaDegraded(err);
		return 0;
	}
}

async function addMonthlyTokens(agentId, delta) {
	const r = getRedis();
	if (!r || !delta) return 0;
	const key = `llm:tokens:${agentId}:${monthKey()}`;
	try {
		const total = await r.incrby(key, delta);
		if (total === delta) await r.expire(key, 40 * 24 * 3600);
		return total;
	} catch (err) {
		// Best-effort post-call accounting — the response was already streamed, so
		// a failed write must never throw into the (finished) request.
		warnQuotaDegraded(err);
		return 0;
	}
}

// ── Request schema ────────────────────────────────────────────────────────────

const messageContentSchema = z.union([z.string(), z.array(z.any())]);

const bodySchema = z.object({
	system: z.string().max(64_000).optional(),
	messages: z
		.array(
			z.object({
				role: z.enum(['user', 'assistant']),
				content: messageContentSchema,
			}),
		)
		.min(1)
		.max(200),
	tools: z.array(z.any()).max(64).optional(),
	model: z.string().max(100).optional(),
	max_tokens: z.number().int().positive().max(16_000).optional(),
	temperature: z.number().min(0).max(2).optional(),
	thinking: z.any().optional(),
	stream: z.boolean().optional(),
});

// ── Handler ───────────────────────────────────────────────────────────────────

// Resolve the embed policy for the `agent` query param. The param carries
// whatever uuid the embed was pointed at, which is one of three things:
//   1. an agent_identity id        — the canonical agent embed
//   2. an avatar id with an agent   — an agent_identity linked via avatar_id
//   3. a bare public avatar id      — `/api/avatars/:id`, the documented embed
//      source (see src/manifest.js). These have no agent_identity row, so they
//      fall through to the default we-pay free-model policy. Without this the
//      homepage avatar widget (and any bare-avatar embed) chats into a 404.
// Private/unlisted avatars and unknown ids resolve to null → caller 404s.
async function resolveEmbedPolicy(id) {
	const byAgentId = await readEmbedPolicy(id);
	if (byAgentId) return byAgentId;

	const byAvatarId = await readEmbedPolicyByAvatarId(id);
	if (byAvatarId) return byAvatarId;

	const avatar = await getAvatar({ id });
	if (avatar && avatar.visibility === 'public') return defaultEmbedPolicy();

	return null;
}

export default wrap(async (req, res) => {
	const url = new URL(req.url, 'http://x');
	const agentId = url.searchParams.get('agent');

	let policy = null;
	if (agentId) policy = await resolveEmbedPolicy(agentId);

	const corsOrigins = buildCorsAllowlist(policy);
	if (cors(req, res, { origins: corsOrigins, methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;

	if (!agentId) return error(res, 400, 'validation_error', 'agent query param required');
	if (!policy) return error(res, 404, 'not_found', 'agent not found');

	if (policy.brain?.mode !== 'we-pay') {
		return error(
			res,
			402,
			'payment_required',
			`brain.mode is "${policy.brain?.mode ?? 'unset'}"; caller must supply its own key or proxy`,
		);
	}

	if (policy.surfaces?.script === false) {
		return error(res, 403, 'embed_denied_surface', 'script surface disabled for this agent');
	}

	const originHeader = req.headers.origin || req.headers.referer || '';
	if (!originAllowed(originHeader, policy)) {
		return error(
			res,
			403,
			'embed_denied_origin',
			"origin not permitted by this agent's embed policy",
		);
	}

	const ipRl = await limits.embedLlmIp(clientIp(req));
	if (!ipRl.success) return rateLimited(res, ipRl, 'too many requests from this IP');

	const perMin = policy.brain?.rate_limit_per_min;
	if (perMin && perMin > 0) {
		const agentRl = await limits.embedLlmAgent(agentId, perMin);
		if (!agentRl.success) return rateLimited(res, agentRl, 'agent rate limit exceeded');
	}

	const quota = policy.brain?.monthly_quota;
	const quotaEnforced = typeof quota === 'number' && quota !== null;
	if (quotaEnforced) {
		const used = await getMonthlyQuotaUsed(agentId);
		if (used >= quota) {
			return error(res, 429, 'quota_exceeded', `monthly quota of ${quota} calls reached`);
		}
	}

	const tokenBudget = tokenBudgetFromPolicy(policy);
	const tokensUsedSoFar = await getMonthlyTokens(agentId);
	if (tokensUsedSoFar >= tokenBudget) {
		return error(res, 429, 'quota_exceeded', `monthly token budget of ${tokenBudget} reached`);
	}

	const rawBody = await readJson(req);
	const body = parse(bodySchema, rawBody);
	const requestedModel =
		body.model || policy.brain?.model || 'meta-llama/llama-3.3-70b-instruct:free';

	// Ordered fallback chain for 429 / 5xx from OpenRouter free tier:
	//   1. Requested model (e.g. llama-3.3-70b:free)
	//   2. meta-llama/llama-3.1-8b-instruct:free      (smaller free model)
	//   3. meta/llama-4-maverick-17b-128e-instruct    (free NVIDIA NIM tier)
	//   4. claude-haiku-4-5-20251001                  (paid Anthropic)
	//   5. Vertex Gemini credits anchor               (keyless last resort)
	// The NVIDIA free tier sits ahead of paid Anthropic so a rate-limited OpenRouter
	// free model exhausts every free option before any per-token cost is incurred.
	// A non-reasoning model is used here on purpose: a reasoning model can spend a
	// small max_tokens budget entirely on (dropped) reasoning_content and return an
	// empty completion to the embedded agent. See modelFallbackChain for the
	// anchor's never-evicted guarantee.
	const modelFallbacks = modelFallbackChain(requestedModel);

	const isStreaming = body.stream === true;
	const t0 = Date.now();

	// Vertex Claude transport: when VERTEX_CLAUDE_ENABLED, `provider: anthropic`
	// models stream from Google Vertex (GCP credits) with first-party Anthropic as
	// the fallback. Vertex SSE is byte-identical to first-party, so the streaming
	// passthrough below is unchanged.
	const vertexOn = vertexClaudeEnabled();

	let upstream;
	let usedModel = requestedModel;
	let usedRoute = null;
	let usedVia = null;

	for (let attempt = 0; attempt < modelFallbacks.length; attempt++) {
		usedModel = modelFallbacks[attempt];
		const route = resolveModelRoute(usedModel);
		if (!route) {
			if (attempt === 0) {
				return error(res, 400, 'validation_error', `model "${usedModel}" not in allowlist`);
			}
			continue;
		}

		// Ordered transports for this model. Anthropic models can be served by
		// Vertex (GCP credits) and/or first-party; try Vertex first when enabled,
		// then first-party Anthropic as the fallback. OpenAI-compatible providers
		// (Groq/OpenRouter/NVIDIA) have a single transport.
		const transports = [];
		if (route.kind === 'anthropic') {
			if (vertexOn) {
				transports.push({
					via: 'vertex-anthropic',
					build: async () => ({
						url: vertexMessagesUrl(usedModel, { stream: isStreaming }),
						headers: await vertexRequestHeaders(),
						body: JSON.stringify(toVertexBody({ ...body, model: usedModel })),
					}),
				});
			}
			const apiKey = process.env[route.envKey];
			if (apiKey) {
				transports.push({
					via: 'anthropic',
					build: async () => ({
						url: UPSTREAM_URL.anthropic,
						headers: {
							'content-type': 'application/json',
							'anthropic-version': '2023-06-01',
							'x-api-key': apiKey,
						},
						body: JSON.stringify({ ...body, model: usedModel }),
					}),
				});
			}
		} else if (route.provider === 'vertex-gemini') {
			// Credits anchor: keyless — the GCP OAuth bearer token is minted in
			// build() per attempt, and a token-exchange failure degrades through
			// the chain exactly like an unreachable upstream (upstream_prepare_failed).
			// Same OpenAI wire shape as the other non-Anthropic lanes, so the
			// request translation and Anthropic-shape response conversion are reused.
			transports.push({
				via: 'vertex-gemini',
				build: async () => ({
					url: vertexGeminiChatUrl(),
					headers: await vertexGeminiHeaders(),
					body: JSON.stringify(anthropicBodyToOpenAI({ ...body, model: usedModel })),
				}),
			});
		} else {
			const apiKey = process.env[route.envKey];
			if (apiKey) {
				transports.push({
					via: route.provider,
					build: async () => ({
						url: UPSTREAM_URL[route.provider],
						headers: {
							'content-type': 'application/json',
							authorization: `Bearer ${apiKey}`,
							...(route.provider === 'openrouter'
								? { 'HTTP-Referer': 'https://three.ws', 'X-Title': 'three.ws agent' }
								: {}),
						},
						body: JSON.stringify(anthropicBodyToOpenAI({ ...body, model: usedModel })),
					}),
				});
			}
		}

		if (!transports.length) {
			// An unconfigured provider is never terminal — even for the requested
			// model. Degrade through the chain (free lanes follow); the post-loop
			// guard 503s only when no lane was usable at all.
			continue;
		}

		usedRoute = route;
		upstream = null;
		for (let ti = 0; ti < transports.length; ti++) {
			const transport = transports[ti];
			let reqParts;
			try {
				reqParts = await transport.build();
			} catch (err) {
				// Header/token resolution failed (e.g. Vertex GCP token exchange) —
				// try the next transport (first-party Anthropic), then the next model.
				log.warn('upstream_prepare_failed', {
					agentId,
					model: usedModel,
					provider: transport.via,
					error: err?.message || String(err),
				});
				continue;
			}

			const ttfbCtrl = new AbortController();
			// Bound connect / time-to-first-byte so a lane that accepts the socket but
			// never responds can't burn the whole invocation and starve the rest of the
			// fallback chain. Cleared the moment headers arrive (finally), so the SSE
			// body below still streams for as long as the model needs — never truncated.
			const ttfbTimer = setTimeout(() => ttfbCtrl.abort(), 20000);
			let res2;
			try {
				res2 = await fetch(reqParts.url, {
					method: 'POST',
					headers: reqParts.headers,
					body: reqParts.body,
					signal: ttfbCtrl.signal,
				});
			} catch (err) {
				// A thrown fetch (DNS/connection blip, or the TTFB abort above) is never
				// terminal — degrade to the next transport / lane exactly as an HTTP
				// error does below.
				log.warn('upstream_fetch_failed', {
					agentId,
					model: usedModel,
					provider: transport.via,
					error: err?.message || String(err),
				});
				clearTimeout(ttfbTimer);
				continue;
			}
			clearTimeout(ttfbTimer);

			usedVia = transport.via;
			if (res2.ok) {
				upstream = res2;
				break;
			}
			// Non-ok response. When another transport remains (Vertex 5xx/429 →
			// first-party Anthropic), try it before advancing to the next model.
			if (ti + 1 < transports.length) {
				const errText = await res2.text().catch(() => '');
				log.warn('upstream_error', {
					agentId,
					model: usedModel,
					provider: transport.via,
					status: res2.status,
					body: errText.slice(0, 400),
				});
				console.warn(
					`[llm/anthropic] ${transport.via}/${usedModel} returned ${res2.status} — ` +
						'trying next transport',
				);
				continue;
			}
			// Last transport failed — hand the response to the model-level failover.
			upstream = res2;
		}

		if (!upstream) {
			// Every transport for this model threw (network/token). Degrade to the
			// next model; the post-loop guard 503s if the whole chain is exhausted.
			continue;
		}

		if (!upstream.ok) {
			// Any upstream failure degrades to the next lane. Account-level
			// failures (401 dead key, 402 no credits, 403, 429) and outages (5xx)
			// look identical to the embedded agent, and every remaining lane is a
			// different account AND model — request-shape errors can't reach here
			// because the body was validated by bodySchema and is rebuilt per
			// provider. Terminal only when the whole chain is exhausted.
			const status = upstream.status;
			const errText = await upstream.text().catch(() => '');
			const provider = usedVia || route.provider || 'anthropic';
			log.warn('upstream_error', {
				agentId,
				model: usedModel,
				provider,
				status,
				attempt,
				body: errText.slice(0, 400),
			});
			if (attempt + 1 < modelFallbacks.length) {
				console.warn(
					`[llm/anthropic] ${provider}/${usedModel} returned ${status} — ` +
						`falling back to ${modelFallbacks[attempt + 1]}`,
				);
				// Don't let a failed response leak past the loop if every later
				// lane turns out to be unconfigured.
				upstream = null;
				continue;
			}
			// All fallbacks exhausted — surface error.
			log.error('upstream_error', {
				agentId,
				model: usedModel,
				kind: route.kind,
				provider,
				status,
				body: errText.slice(0, 2000),
			});
			return json(res, 502, { error: 'upstream_error', status });
		}

		// Success — log the model used if it differed from the requested one.
		if (usedModel !== requestedModel) {
			console.info(
				`[llm/anthropic] agentId=${agentId} used fallback model ${usedModel} ` +
					`(requested: ${requestedModel})`,
			);
		}
		break;
	}

	if (!usedRoute || !upstream) {
		return json(res, 503, {
			error: 'provider_unavailable',
			message: 'no configured fallback model is available',
		});
	}

	const route = usedRoute;
	// Provider attribution for the spend ledger. `usedVia` distinguishes the
	// Vertex transport ('vertex-anthropic') from first-party Anthropic so prompt
	// 07's spend reporting can attribute GCP-credit traffic separately.
	const via = usedVia || route.provider || 'anthropic';
	const toolLabel =
		via === 'vertex-anthropic'
			? 'vertex.messages'
			: route.kind === 'anthropic'
				? 'anthropic.messages'
				: `${route.provider}.chat`;

	// Charge the monthly call quota only now that an upstream provider actually
	// accepted the request — failed/rate-limited upstream attempts stay free.
	// incrementMonthlyQuota fails open internally, so a counter outage can't 500
	// an already-accepted call.
	if (quotaEnforced) await incrementMonthlyQuota(agentId);

	// ── Streaming path ────────────────────────────────────────────────────────
	if (isStreaming) {
		res.statusCode = 200;
		res.setHeader('content-type', 'text/event-stream');
		res.setHeader('cache-control', 'no-cache');
		res.setHeader('x-accel-buffering', 'no');
		// Provider/transport attribution — lets smoke tests and observability tell
		// Vertex-served Claude ('vertex-anthropic') apart from first-party.
		res.setHeader('x-llm-transport', via);

		let inputTokens = 0;
		let outputTokens = 0;

		if (route.kind === 'anthropic') {
			// Pass upstream Anthropic SSE through verbatim; sniff usage events
			// for token accounting.
			const reader = upstream.body.getReader();
			const decoder = new TextDecoder();
			let sseBuffer = '';
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					res.write(value);
					sseBuffer += decoder.decode(value, { stream: true });
					const lines = sseBuffer.split('\n');
					sseBuffer = lines.pop();
					for (const line of lines) {
						if (!line.startsWith('data: ')) continue;
						try {
							const ev = JSON.parse(line.slice(6));
							if (ev.type === 'message_start')
								inputTokens = ev.message?.usage?.input_tokens ?? 0;
							if (ev.type === 'message_delta')
								outputTokens = ev.usage?.output_tokens ?? 0;
						} catch {
							// not every data line is JSON (e.g. [DONE]) — skip
						}
					}
				}
			} finally {
				res.end();
			}
		} else {
			// OpenAI-shape upstream → translate to Anthropic SSE shape on the fly.
			const usage = await pipeOpenAIAsAnthropic(upstream, res, { model: usedModel });
			inputTokens = usage.inputTokens;
			outputTokens = usage.outputTokens;
		}

		const latencyMs = Date.now() - t0;
		if (inputTokens || outputTokens) {
			try {
				await addMonthlyTokens(agentId, inputTokens + outputTokens);
			} catch (err) {
				log.warn('token_counter_write_failed', { agentId, msg: err?.message });
			}
		}
		recordEvent({
			kind: 'llm',
			tool: toolLabel,
			agentId,
			bytes: 0,
			latencyMs,
			status: 'ok',
			provider: via,
			model: usedModel,
			inputTokens,
			outputTokens,
			costMicroUsd: costMicroUsd({
				provider: via,
				model: usedModel,
				input: inputTokens,
				output: outputTokens,
			}),
			meta: {
				model: usedModel,
				requested_model: requestedModel,
				input_tokens: inputTokens,
				output_tokens: outputTokens,
				upstream_status: upstream.status,
			},
		});
		return;
	}

	// ── Non-streaming path ────────────────────────────────────────────────────
	const upstreamText = await upstream.text();
	const latencyMs = Date.now() - t0;

	let upstreamJson = null;
	try {
		upstreamJson = JSON.parse(upstreamText);
	} catch {
		// Non-JSON body — leave as opaque pass-through.
	}

	let inputTokens = 0;
	let outputTokens = 0;
	let outBody = upstreamText;
	let outContentType = upstream.headers.get('content-type') || 'application/json';

	if (route.kind === 'anthropic') {
		inputTokens = upstreamJson?.usage?.input_tokens ?? 0;
		outputTokens = upstreamJson?.usage?.output_tokens ?? 0;
	} else if (upstreamJson) {
		inputTokens = upstreamJson?.usage?.prompt_tokens ?? 0;
		outputTokens = upstreamJson?.usage?.completion_tokens ?? 0;
		const translated = openAIResponseToAnthropic(upstreamJson, { model: usedModel });
		outBody = JSON.stringify(translated);
		outContentType = 'application/json';
	}

	if (inputTokens || outputTokens) {
		try {
			await addMonthlyTokens(agentId, inputTokens + outputTokens);
		} catch (err) {
			log.warn('token_counter_write_failed', { agentId, msg: err?.message });
		}
	}

	recordEvent({
		kind: 'llm',
		tool: toolLabel,
		agentId,
		bytes: upstreamText.length,
		latencyMs,
		status: 'ok',
		provider: via,
		model: usedModel,
		inputTokens,
		outputTokens,
		costMicroUsd: costMicroUsd({
			provider: via,
			model: usedModel,
			input: inputTokens,
			output: outputTokens,
		}),
		meta: {
			model: usedModel,
			requested_model: requestedModel,
			input_tokens: inputTokens,
			output_tokens: outputTokens,
			upstream_status: upstream.status,
		},
	});

	res.statusCode = 200;
	res.setHeader('content-type', outContentType);
	res.setHeader('x-llm-transport', via);
	return res.end(outBody);
});

// ── Shape translation: Anthropic ⇄ OpenAI ────────────────────────────────────

function anthropicBodyToOpenAI(body) {
	const messages = [];
	if (body.system) messages.push({ role: 'system', content: body.system });

	for (const m of body.messages) {
		if (typeof m.content === 'string') {
			messages.push({ role: m.role, content: m.content });
			continue;
		}
		if (!Array.isArray(m.content)) continue;

		if (m.role === 'user') {
			const textParts = [];
			for (const block of m.content) {
				if (block?.type === 'text' && typeof block.text === 'string') {
					textParts.push(block.text);
				} else if (block?.type === 'tool_result') {
					messages.push({
						role: 'tool',
						tool_call_id: block.tool_use_id,
						content:
							typeof block.content === 'string'
								? block.content
								: JSON.stringify(block.content ?? ''),
					});
				}
			}
			if (textParts.length) messages.push({ role: 'user', content: textParts.join('\n') });
		} else if (m.role === 'assistant') {
			const textParts = [];
			const toolCalls = [];
			for (const block of m.content) {
				if (block?.type === 'text' && typeof block.text === 'string') {
					textParts.push(block.text);
				} else if (block?.type === 'tool_use') {
					toolCalls.push({
						id: block.id,
						type: 'function',
						function: {
							name: block.name,
							arguments: JSON.stringify(block.input ?? {}),
						},
					});
				}
			}
			const msg = { role: 'assistant', content: textParts.join('\n') || null };
			if (toolCalls.length) msg.tool_calls = toolCalls;
			messages.push(msg);
		}
	}

	const out = {
		model: body.model,
		max_tokens: body.max_tokens ?? 4096,
		messages,
		stream: !!body.stream,
	};
	if (typeof body.temperature === 'number') out.temperature = body.temperature;

	if (Array.isArray(body.tools) && body.tools.length) {
		out.tools = body.tools.map((t) => ({
			type: 'function',
			function: {
				name: t.name,
				description: t.description,
				parameters: t.input_schema,
			},
		}));
		out.tool_choice = 'auto';
	}
	return out;
}

function openAIResponseToAnthropic(resp, { model }) {
	const choice = resp?.choices?.[0];
	const msg = choice?.message || {};
	const content = [];
	if (typeof msg.content === 'string' && msg.content.length) {
		content.push({ type: 'text', text: msg.content });
	}
	for (const tc of msg.tool_calls || []) {
		let input = {};
		try {
			input = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
		} catch {
			input = {};
		}
		content.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input });
	}
	return {
		id: resp.id || `msg_${Date.now()}`,
		type: 'message',
		role: 'assistant',
		model,
		content,
		stop_reason: choice?.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn',
		stop_sequence: null,
		usage: {
			input_tokens: resp?.usage?.prompt_tokens ?? 0,
			output_tokens: resp?.usage?.completion_tokens ?? 0,
		},
	};
}

// Stream an OpenAI-shape SSE upstream into the client as Anthropic-shape SSE.
// Returns { inputTokens, outputTokens } extracted from the final usage event.
async function pipeOpenAIAsAnthropic(upstream, res, { model }) {
	const reader = upstream.body.getReader();
	const decoder = new TextDecoder();
	let buf = '';

	let inputTokens = 0;
	let outputTokens = 0;

	const messageId = `msg_${Date.now()}`;
	let messageStartSent = false;
	let textBlockOpen = false;
	let textIndex = 0;
	// Map OpenAI tool-call index → { anthropicIndex, started, finished, name, id, argsBuf }
	const toolBlocks = new Map();
	let nextBlockIndex = 1; // index 0 reserved for the text block
	let stopReason = 'end_turn';

	function write(obj, eventName) {
		const evt = eventName ? `event: ${eventName}\n` : '';
		res.write(`${evt}data: ${JSON.stringify(obj)}\n\n`);
	}

	function ensureMessageStart() {
		if (messageStartSent) return;
		messageStartSent = true;
		write(
			{
				type: 'message_start',
				message: {
					id: messageId,
					type: 'message',
					role: 'assistant',
					content: [],
					model,
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: 0, output_tokens: 0 },
				},
			},
			'message_start',
		);
	}

	function ensureTextBlockStart() {
		ensureMessageStart();
		if (textBlockOpen) return;
		textBlockOpen = true;
		textIndex = 0;
		write(
			{
				type: 'content_block_start',
				index: textIndex,
				content_block: { type: 'text', text: '' },
			},
			'content_block_start',
		);
	}

	function closeTextBlockIfOpen() {
		if (!textBlockOpen) return;
		write({ type: 'content_block_stop', index: textIndex }, 'content_block_stop');
		textBlockOpen = false;
	}

	function startToolBlock(slot, openAIToolCall) {
		ensureMessageStart();
		closeTextBlockIfOpen();
		slot.anthropicIndex = nextBlockIndex++;
		slot.started = true;
		slot.id = openAIToolCall.id || `tool_${slot.anthropicIndex}`;
		slot.name = openAIToolCall.function?.name || slot.name || '';
		write(
			{
				type: 'content_block_start',
				index: slot.anthropicIndex,
				content_block: { type: 'tool_use', id: slot.id, name: slot.name, input: {} },
			},
			'content_block_start',
		);
	}

	function finishToolBlocks() {
		for (const slot of toolBlocks.values()) {
			if (slot.started && !slot.finished) {
				write(
					{ type: 'content_block_stop', index: slot.anthropicIndex },
					'content_block_stop',
				);
				slot.finished = true;
			}
		}
	}

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			const lines = buf.split('\n');
			buf = lines.pop();
			for (const rawLine of lines) {
				const line = rawLine.trim();
				if (!line.startsWith('data:')) continue;
				const payload = line.slice(5).trim();
				if (!payload || payload === '[DONE]') continue;
				let ev;
				try {
					ev = JSON.parse(payload);
				} catch {
					continue;
				}

				if (ev.usage) {
					inputTokens = ev.usage.prompt_tokens ?? inputTokens;
					outputTokens = ev.usage.completion_tokens ?? outputTokens;
				}

				const choice = ev.choices?.[0];
				const delta = choice?.delta;

				if (delta?.content) {
					ensureTextBlockStart();
					write(
						{
							type: 'content_block_delta',
							index: textIndex,
							delta: { type: 'text_delta', text: delta.content },
						},
						'content_block_delta',
					);
				}

				if (Array.isArray(delta?.tool_calls)) {
					for (const tc of delta.tool_calls) {
						const idx = tc.index ?? 0;
						let slot = toolBlocks.get(idx);
						if (!slot) {
							slot = {
								started: false,
								finished: false,
								name: '',
								id: null,
								argsBuf: '',
							};
							toolBlocks.set(idx, slot);
						}
						if (!slot.started && (tc.id || tc.function?.name)) {
							startToolBlock(slot, tc);
						} else if (tc.function?.name && !slot.started) {
							slot.name += tc.function.name;
						}
						if (tc.function?.arguments) {
							slot.argsBuf += tc.function.arguments;
							if (slot.started) {
								write(
									{
										type: 'content_block_delta',
										index: slot.anthropicIndex,
										delta: {
											type: 'input_json_delta',
											partial_json: tc.function.arguments,
										},
									},
									'content_block_delta',
								);
							}
						}
					}
				}

				if (choice?.finish_reason) {
					stopReason = choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn';
				}
			}
		}
	} finally {
		closeTextBlockIfOpen();
		finishToolBlocks();
		if (messageStartSent) {
			write(
				{
					type: 'message_delta',
					delta: { stop_reason: stopReason, stop_sequence: null },
					usage: { output_tokens: outputTokens },
				},
				'message_delta',
			);
			write({ type: 'message_stop' }, 'message_stop');
		}
		res.end();
	}

	return { inputTokens, outputTokens };
}
