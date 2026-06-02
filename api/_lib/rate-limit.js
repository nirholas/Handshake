// Distributed rate limiting via Upstash Redis. Falls back to in-memory for local dev.

import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { env } from './env.js';

let redis = null;
if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
	redis = new Redis({ url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN });
}

const limiters = new Map();
const memoryBuckets = new Map();

function getLimiter(name, opts) {
	const key = `${name}:${opts.limit}:${opts.window}`;
	if (limiters.has(key)) return limiters.get(key);
	if (!redis) {
		const lim = memoryLimiter(opts);
		limiters.set(key, lim);
		return lim;
	}
	const rl = new Ratelimit({
		redis,
		limiter: Ratelimit.slidingWindow(opts.limit, opts.window),
		prefix: `rl:${name}`,
		analytics: false,
	});
	limiters.set(key, rl);
	return rl;
}

function memoryLimiter({ limit, window }) {
	const ms = parseWindowMs(window);
	return {
		async limit(id) {
			const now = Date.now();
			const bucket = memoryBuckets.get(id) || [];
			const cutoff = now - ms;
			const kept = bucket.filter((t) => t > cutoff);
			if (kept.length >= limit) {
				memoryBuckets.set(id, kept);
				return { success: false, limit, remaining: 0, reset: kept[0] + ms };
			}
			kept.push(now);
			memoryBuckets.set(id, kept);
			return { success: true, limit, remaining: limit - kept.length, reset: now + ms };
		},
	};
}

function parseWindowMs(w) {
	const m = /^(\d+)\s*(ms|s|m|h|d)$/.exec(w);
	if (!m) return 60_000;
	const n = parseInt(m[1], 10);
	const unit = m[2];
	return n * { ms: 1, s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 }[unit];
}

// Preset limiters. Tune once viral traffic shape is known.
export const limits = {
	authIp: (ip) => getLimiter('auth:ip', { limit: 30, window: '10 m' }).limit(ip),
	registerIp: (ip) => getLimiter('register:ip', { limit: 5, window: '1 h' }).limit(ip),
	// pump.fun coin metadata upload (name/symbol/image → R2 JSON). Cheap and
	// idempotent, so it gets its own bucket instead of draining the strict
	// `authIp` budget shared by on-chain buy/sell/launch actions. Iterating in
	// the launch wizard would otherwise lock the user out of trading for 10 min.
	pumpMetaIp: (ip) => getLimiter('pump:meta:ip', { limit: 60, window: '10 m' }).limit(ip),
	oauthRegisterIp: (ip) =>
		getLimiter('oauth:register:ip', { limit: 10, window: '1 h' }).limit(ip),
	mcpUser: (userId) => getLimiter('mcp:user', { limit: 1200, window: '1 m' }).limit(userId),
	mcpIp: (ip) => getLimiter('mcp:ip', { limit: 600, window: '1 m' }).limit(ip),
	mcpValidate: (key) => getLimiter('mcp:validate', { limit: 10, window: '1 m' }).limit(key),
	mcpInspect: (key) => getLimiter('mcp:inspect', { limit: 30, window: '1 m' }).limit(key),
	mcpOptimize: (key) => getLimiter('mcp:optimize', { limit: 10, window: '1 m' }).limit(key),
	// 3D Studio MCP. Generation submits a real GPU job on Replicate (text→image
	// and/or image→3D reconstruction) that costs real money, so it gets a hard
	// hourly ceiling per principal. Status polling is cheap and frequent.
	mcp3dGenerate: (key) => getLimiter('mcp3d:generate', { limit: 12, window: '1 h' }).limit(key),
	mcp3dStatus: (key) => getLimiter('mcp3d:status', { limit: 240, window: '1 m' }).limit(key),
	// x402 Bazaar MCP. Discovery calls fan out to external facilitators, so cap
	// per principal to keep that egress bounded without throttling normal use.
	mcpBazaar: (key) => getLimiter('mcp:bazaar', { limit: 60, window: '1 m' }).limit(key),
	// threews-agent MCP. Read/discovery calls are cheap; pay_and_call moves real
	// money, so it gets a much tighter ceiling on top of the per-spend caps.
	mcpAgent: (key) => getLimiter('mcp:agent', { limit: 60, window: '1 m' }).limit(key),
	mcpAgentPay: (key) => getLimiter('mcp:agent:pay', { limit: 20, window: '1 m' }).limit(key),
	oauthToken: (clientId) =>
		getLimiter('oauth:token', { limit: 120, window: '1 m' }).limit(clientId),
	upload: (userId) => getLimiter('upload', { limit: 60, window: '1 h' }).limit(userId),
	avatarPatch: (userId) => getLimiter('avatar:patch', { limit: 20, window: '1 h' }).limit(userId),
	prefsWrite: (userId) => getLimiter('prefs:write', { limit: 30, window: '1 h' }).limit(userId),
	avatarRollback: (userId) =>
		getLimiter('avatar:rollback', { limit: 10, window: '1 h' }).limit(userId),
	chatUser: (userId) => getLimiter('chat:user', { limit: 40, window: '1 m' }).limit(userId),
	chatIp: (ip) => getLimiter('chat:ip', { limit: 60, window: '1 m' }).limit(ip),
	// Direct messages between friends — its own bucket so DM spam can't starve
	// world-chat posting and vice versa. Mirrors world chat's order of magnitude.
	dmSend: (userId) => getLimiter('dm:send', { limit: 30, window: '1 m' }).limit(userId),
	// Demo /api/x402-pay — agent wallet pays real USDC per call, so we keep the
	// per-IP burst small (6/min ≈ $0.006/min) and rely on the agent wallet
	// balance as the global ceiling.
	x402PayIp: (ip) => getLimiter('x402:pay:ip', { limit: 6, window: '1 m' }).limit(ip),
	x402PayGlobal: () =>
		getLimiter('x402:pay:global', { limit: 600, window: '1 h' }).limit('global'),
	checkName: (ip) => getLimiter('check-name:ip', { limit: 60, window: '1 m' }).limit(ip),
	ensResolve: (ip) => getLimiter('ens:resolve:ip', { limit: 60, window: '1 m' }).limit(ip),
	snsResolve: (ip) => getLimiter('sns:resolve:ip', { limit: 60, window: '1 m' }).limit(ip),
	// Generic public read endpoints (explore, showcase, public agent fetch). 60/min per IP.
	publicIp: (ip) => getLimiter('public:ip', { limit: 60, window: '1 m' }).limit(ip),
	// Skills marketplace browse — isolated bucket so traffic on other public endpoints
	// can't starve the skills list. 60/min per IP.
	skillsBrowse: (ip) => getLimiter('skills:browse', { limit: 60, window: '1 m' }).limit(ip),
	// Marketplace agent preview chat — anonymous "try before fork" flow on the
	// agent detail page. Strict per-IP and per-agent caps so one client can't
	// drain LLM credits and one agent can't starve the global pool.
	previewIp: (ip) => getLimiter('preview:ip', { limit: 30, window: '1 h' }).limit(ip),
	previewAgent: (agentId) =>
		getLimiter('preview:agent', { limit: 200, window: '1 h' }).limit(agentId),
	widgetWrite: (userId) => getLimiter('widget:write', { limit: 60, window: '1 m' }).limit(userId),
	widgetRead: (ip) => getLimiter('widget:read', { limit: 600, window: '1 m' }).limit(ip),
	// Per-widget visitor chat. Limit is dynamic — one bucket per (widgetId, perMinute).
	widgetChat: ({ ip, widgetId, perMinute }) =>
		getLimiter('widget:chat', {
			limit: Math.max(1, Math.min(60, perMinute || 8)),
			window: '1 m',
		}).limit(`${widgetId}:${ip}`),
	// We-pay LLM proxy: 60 req/min per IP (global floor), and per-agent dynamic bucket.
	embedLlmIp: (ip) => getLimiter('embed:llm:ip', { limit: 60, window: '1 m' }).limit(ip),
	embedLlmAgent: (agentId, perMin) =>
		getLimiter('embed:llm:agent', {
			limit: Math.max(1, Math.min(1000, perMin || 10)),
			window: '1 m',
		}).limit(agentId),
	// Autonomous agent skill purchases: 10 per hour per buyer agent to prevent runaway spending.
	agentBuy: (agentId) => getLimiter('agent:buy', { limit: 10, window: '1 h' }).limit(agentId),
	// Gas-spending endpoints: 10 redeems per 5 minutes per IP
	strict: (key) =>
		getLimiter('permissions:redeem:strict', { limit: 10, window: '5 m' }).limit(key),
	pinUser: (userId) => getLimiter('pin:user', { limit: 30, window: '1 h' }).limit(userId),
	pinStatusIp: (ip) => getLimiter('pin:status:ip', { limit: 60, window: '1 m' }).limit(ip),
	agentByAddress: (ip) =>
		getLimiter('agents:by-address', { limit: 120, window: '1 m' }).limit(ip),
	pricingPerIp: (ip) => getLimiter('pricing:ip', { limit: 120, window: '1 m' }).limit(ip),
	walletLink: (userId) => getLimiter('wallet:link', { limit: 10, window: '10 m' }).limit(userId),
	// Agent wallet read endpoints (GET balance, activity). Per authenticated user.
	walletRead: (userId) => getLimiter('wallet:read', { limit: 60, window: '1 m' }).limit(userId),
	agentSuggest: (ip) => getLimiter('agents:suggest', { limit: 120, window: '1 m' }).limit(ip),
	read: (ip) => getLimiter('permissions:read', { limit: 300, window: '1 m' }).limit(ip),
	permissionsGrant: (userId) =>
		getLimiter('permissions:grant', { limit: 10, window: '1 h' }).limit(userId),
	permissionsRevoke: (userId) =>
		getLimiter('permissions:revoke', { limit: 20, window: '1 h' }).limit(userId),
	apiKeyManage: (userId) =>
		getLimiter('api-key:manage', { limit: 30, window: '1 h' }).limit(userId),
	verifyEmailIp: (ip) => getLimiter('verify-email:ip', { limit: 10, window: '15 m' }).limit(ip),
	forgotPasswordEmail: (email) =>
		getLimiter('forgot-password:email', { limit: 3, window: '15 m' }).limit(email),
	resendVerifyUser: (userId) =>
		getLimiter('resend-verify:user', { limit: 2, window: '10 m' }).limit(userId),
	newsletterIp: (ip) => getLimiter('newsletter:ip', { limit: 5, window: '1 h' }).limit(ip),
	// Voice cloning: expensive ElevenLabs API call — 3 per user per day.
	voiceClone: (userId) => getLimiter('voice:clone', { limit: 3, window: '1 d' }).limit(userId),
	// Persona extraction: Claude API call — 5 per user per day.
	personaExtract: (userId) =>
		getLimiter('persona:extract', { limit: 5, window: '1 d' }).limit(userId),
	agentDelegate: (key) => getLimiter('agent:delegate', { limit: 10, window: '1 m' }).limit(key),
	// GitHub memory seeding: expensive (GitHub API + Claude). 1 seed per agent per 24 hours.
	memorySeed: (agentId) => getLimiter('memory:seed', { limit: 1, window: '1 d' }).limit(agentId),
	// Edge TTS: free upstream but cached in R2 — limit unique synthesis requests per user/min.
	ttsEdge: (userId) => getLimiter('tts:edge', { limit: 20, window: '1 m' }).limit(userId),
	// X (Twitter) memory seeding: 1 seed per agent per 6 hours.
	xSeed: (agentId) => getLimiter('memory:seed:x', { limit: 1, window: '6 h' }).limit(agentId),
	// Withdrawal requests: 5 per user per day to prevent spam.
	withdrawalPerUser: (userId) =>
		getLimiter('withdrawal:user', { limit: 5, window: '1 d' }).limit(userId),
	// Per-user audit-log reads — the page polls on mount + "load older". 120/min
	// per user is generous for browse but discourages scraping the full year.
	auditLogRead: (userId) =>
		getLimiter('audit-log:read', { limit: 120, window: '1 m' }).limit(userId),
	// $THREE token payment layer (api/token/*).
	// quote: 30 per user per minute — prevents price-polling abuse; each quote
	//   hits a live price feed and signs a HMAC. Generous enough for interactive
	//   flows (spin UI, listing flow) and burst-resistant for agent consumers.
	tokenQuote: (userId) => getLimiter('token:quote', { limit: 30, window: '1 m' }).limit(userId),
	// settle: 10 per user per minute — each settle does an RPC round-trip + DB
	//   write. A real user sends 1 tx; the ceiling absorbs retries + latency.
	tokenSettle: (userId) => getLimiter('token:settle', { limit: 10, window: '1 m' }).limit(userId),
	// price: public endpoint, 120/min per IP — fast cache-served; upstream
	//   Jupiter is rate-limit-free, but the cache makes this essentially free.
	tokenPriceIp: (ip) => getLimiter('token:price:ip', { limit: 120, window: '1 m' }).limit(ip),
};

// Trust only proxy headers that Vercel itself sets and signs. Naively reading
// X-Forwarded-For lets clients supply it directly on direct invocations, which
// trivially bypasses per-IP rate limits by rotating the claimed address.
export function clientIp(req) {
	const vercel = req.headers['x-vercel-forwarded-for'];
	if (vercel) return String(vercel).split(',')[0].trim();
	const real = req.headers['x-real-ip'];
	if (real) return String(real).trim();
	// Last resort — socket address (only meaningful on direct connections).
	return req.socket?.remoteAddress || '0.0.0.0';
}
