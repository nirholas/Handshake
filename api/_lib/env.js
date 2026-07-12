// Centralized env access. Lazy by design: missing env vars fail at first use,
// not at module import, so unrelated endpoints (e.g. OAuth discovery) still
// respond when the deployment is partially configured.

function req(name) {
	const v = process.env[name];
	if (!v) throw new Error(`Missing required env var: ${name}`);
	return v;
}

function opt(name, fallback = undefined) {
	return process.env[name] ?? fallback;
}

function trimSlash(s) {
	return s ? s.replace(/\/$/, '') : s;
}

// Blockchain addresses pasted into dashboards (Vercel/Helius/etc.) frequently
// carry a trailing newline or stray spaces. An untrimmed address breaks every
// spec-compliant x402 client the instant it does `new PublicKey(payTo)` —
// "Non-base58 character" — or silently routes funds via a malformed EVM
// checksum. Trim address-like env values at the source so no consumer ever
// emits whitespace into a 402 challenge. Returns undefined when blank so the
// `if (env.X402_PAY_TO_SOLANA)` guards downstream still skip cleanly.
function addr(value) {
	if (value == null) return value;
	const v = String(value).trim();
	return v || undefined;
}

// Canonical fallback origin — used when PUBLIC_APP_ORIGIN is unset, empty, or
// not a parseable absolute URL.
const DEFAULT_APP_ORIGIN = 'https://three.ws';

// Coerce PUBLIC_APP_ORIGIN into a valid absolute origin. A bare host (e.g.
// PUBLIC_APP_ORIGIN=three.ws — a real Vercel misconfiguration that 500'd every
// SIWS/SIWE nonce request and emitted schemeless OIDC discovery URLs) gets an
// https:// scheme prepended, and the result is validated through the URL
// parser. Anything still unparseable falls back to the canonical origin rather
// than letting `new URL(env.APP_ORIGIN)` throw ERR_INVALID_URL deep inside a
// handler. Returns a normalized origin with no trailing slash or path.
function normalizeAppOrigin(raw) {
	let v = (raw ?? '').trim();
	if (!v) return DEFAULT_APP_ORIGIN;
	if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(v)) v = `https://${v}`;
	try {
		return trimSlash(new URL(v).origin);
	} catch {
		return DEFAULT_APP_ORIGIN;
	}
}

// Returns a Connection-safe http(s) URL, or '' when the value can't be salvaged.
// Kept dependency-free so env.js stays light — mirrors normalizeRpcUrl()/isHttpUrl()
// in solana/connection.js. Also repairs the recurring `api-mainnet.helius-rpc.com` /
// `api-devnet.helius-rpc.com` misconfiguration (Helius's JSON-RPC host is
// `mainnet.helius-rpc.com`, not the `api.helius.xyz` REST host); a bad host 404s
// every request and gets parked in cooldown, so rewriting it keeps SOLANA_RPC_URL a
// working primary.
// Repairs the malformed shapes seen in prod env config before they reach a
// `new Connection`/`fetch` consumer (where a scheme-less or ws:// value 500s with
// "Endpoint URL must start with http: or https:"): surrounding quotes, a websocket
// scheme (mapped to its http(s) form), and a missing scheme (assumed https). The
// getters below coalesce '' to the public default so every consumer always sees a
// valid URL. Mirrors normalizeRpcUrl()/isHttpUrl() in solana/connection.js.
function normalizeRpcUrl(raw) {
	let v = (raw ?? '').trim();
	if (!v) return '';
	if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
		v = v.slice(1, -1).trim();
	}
	if (!v) return '';
	let candidate = v;
	if (/^wss:\/\//i.test(candidate)) candidate = candidate.replace(/^wss:/i, 'https:');
	else if (/^ws:\/\//i.test(candidate)) candidate = candidate.replace(/^ws:/i, 'http:');
	else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
		const host = candidate.split(/[/?#]/)[0];
		if (!host.includes('.') && !/^localhost(:\d+)?$/i.test(host)) return '';
		candidate = `https://${candidate}`;
	}
	let u;
	try {
		u = new URL(candidate);
	} catch {
		return '';
	}
	if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
	const fixed = u.hostname.replace(/^api-(mainnet|devnet)\.helius-rpc\.com$/i, '$1.helius-rpc.com');
	if (fixed !== u.hostname) {
		return candidate.replace(/^([a-z][a-z0-9+.-]*:\/\/)([^/?#]+)/i, (_m, scheme, authority) =>
			scheme + authority.replace(u.hostname, fixed),
		);
	}
	return candidate;
}

// Platform owner wallets with standing admin access, independent of env config.
// Public addresses, safe to commit. Unioned with ADMIN_ADDRESSES (see below).
const BUILT_IN_ADMIN_ADDRESSES = ['9MjzHaTB6Jko4YKo9mDzJSaGnktzhbebgsnqPpYWnXC7'];

// PEM / certificate env values are frequently stored with literal "\n" escapes
// (Vercel/IBM/Okta dashboards collapse real newlines). Restore them so the
// crypto libraries get a valid multi-line PEM. Returns undefined when unset.
function pem(name) {
	const v = process.env[name];
	if (!v) return undefined;
	return v.includes('\\n') ? v.replace(/\\n/g, '\n') : v;
}

// Bearer-token / endpoint credentials (Upstash REST URL + token, etc.) pasted
// into the Vercel/Upstash dashboards frequently carry a trailing newline or stray
// spaces. The @upstash/redis client drops the token straight into an
// `Authorization: Bearer <token>` header and the URL into `fetch(`${url}/...`)`,
// so a single trailing "\n" produces the exact production symptom we hit —
// "WRONGPASS invalid or missing auth token" on a token that is otherwise correct,
// while the URL still resolves (Upstash is reached, only the header is rejected).
// That one stray character fails every critical limiter CLOSED (denying paid
// endpoints) and silently disables the usage buffer + caches. Trim at the source
// so no Redis consumer ever sees whitespace. Returns undefined when blank so the
// `if (url && token)` guard in redis.js still skips cleanly. Mirrors
// addr()/normalizeRpcUrl()/pem().
function cred(value) {
	if (value == null) return value;
	const v = String(value).trim();
	return v || undefined;
}

// Resolve a URL+token credential as an ATOMIC PAIR from the same source. Each
// `sources` entry is [urlVarName, tokenVarName] in priority order; the first
// entry where BOTH halves are present (after cred() trimming) wins, and its url
// AND token are returned together. Resolving the two halves through independent
// `||` chains (the prior shape) let a URL set on one alias (Upstash store A) pair
// with a token that fell through to a different alias (store B) — URL-A + token-B
// authenticates as "WRONGPASS invalid or missing auth token" even though both
// vars are individually "set". That cross-store mismatch is indistinguishable
// from a stale token in the logs and degraded the limiter/cache/usage/x402-feed
// to memory fallback fleet-wide. Pairing by source makes a mismatch impossible:
// a token can never be matched against a different store's URL. Returns
// { url, token } with undefined halves when no source is fully configured.
function pickPair(sources) {
	for (const [urlVar, tokenVar] of sources) {
		const url = cred(opt(urlVar));
		const token = cred(opt(tokenVar));
		if (url && token) return { url, token };
	}
	return { url: undefined, token: undefined };
}

// Upstash REST credential sources for the shared rate-limiter/usage store, in
// priority order. Manual UPSTASH_* first, then the Vercel-KV marketplace
// integration's prefixed (`three_`) and bare (`KV_`) injected names.
const REDIS_REST_SOURCES = [
	['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'],
	['three_KV_REST_API_URL', 'three_KV_REST_API_TOKEN'],
	['KV_REST_API_URL', 'KV_REST_API_TOKEN'],
];

// Optional dedicated cache store (api/_lib/cache.js), same atomic-pairing rule.
const REDIS_CACHE_SOURCES = [
	['UPSTASH_CACHE_REST_URL', 'UPSTASH_CACHE_REST_TOKEN'],
	['cache_KV_REST_API_URL', 'cache_KV_REST_API_TOKEN'],
];

// Postgres connection-string aliases, in priority order. The bare DATABASE_URL
// is what every consumer expects, but the Vercel Postgres / Neon Marketplace
// integration injects the live connection string under DIFFERENT names —
// POSTGRES_URL (pooled), DATABASE_URL_UNPOOLED / POSTGRES_URL_NON_POOLING
// (direct), POSTGRES_PRISMA_URL (pgbouncer params), NEON_DATABASE_URL — and
// only mirrors it to DATABASE_URL if you wire that alias by hand. When the
// integration is connected but DATABASE_URL was never duplicated, every
// DB-backed read throws "Missing required env var: DATABASE_URL" and the whole
// data plane (galaxy, pulse, marketplace, holder snapshots) silently degrades
// to empty — the June 2026 incident. Resolving from the aliases makes the
// connection work the instant the integration is attached, with no dashboard
// step, exactly as pickPair() does for the Vercel-KV/Upstash Redis aliases.
// Pooled URLs come first: the @neondatabase/serverless HTTP driver is
// serverless-friendly and a pooled endpoint survives request fan-out best.
const DATABASE_URL_SOURCES = [
	'DATABASE_URL',
	'POSTGRES_URL',
	'DATABASE_URL_UNPOOLED',
	'POSTGRES_URL_NON_POOLING',
	'NEON_DATABASE_URL',
	'POSTGRES_PRISMA_URL',
];

// Repair the dashboard-paste corruptions that survive a whitespace trim but still
// break the neon() client. Two shapes, both seen on real Vercel env values (the
// same class of paste damage normalizeRpcUrl()/addr() already repair for RPC URLs
// and wallet addresses):
//   · a single layer of matching surrounding quotes — "postgresql://…" / 'postgresql://…'
//   · an accidental `psql ` / `psql -d ` shell-copy prefix
// Either one makes neon() throw SYNCHRONOUSLY at client construction ("is not a
// valid URL"), and because the lazy Neon client is built inside a query thenable
// that throw bypasses every per-query `.catch()` guard and 500s every DB-backed
// read at once. Worse, both also fail the `/^postgres/` scheme guard below, so the
// alias is silently skipped and resolveDatabaseUrl() reports the connection string
// as MISSING even though a perfectly good URL is sitting in the env. Stripping the
// wrappers here turns a fat-fingered paste into a working connection instead of a
// site-wide outage. Returns undefined for a value that's empty after unwrapping.
function unwrapDbCandidate(v) {
	if (!v) return v;
	// Drop an accidental `psql `/`psql -d ` prefix first (the URL after it may be quoted).
	let s = v.replace(/^psql\s+(?:-d\s+)?/i, '').trim();
	// Strip one layer of matching surrounding quotes.
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
		s = s.slice(1, -1).trim();
	}
	return s || undefined;
}

// Resolve the first alias that holds a usable Postgres connection string.
// Trims dashboard-pasted whitespace/newlines (cred()) — an untrimmed trailing
// "\n" makes neon() throw "is not a valid URL" — unwraps surrounding quotes / a
// `psql ` prefix (unwrapDbCandidate), and requires a postgres(ql):// scheme so a
// stray, unrelated value on one alias can't shadow a real URL on a lower-priority
// one. Returns undefined when no alias is configured. Exported so standalone
// workers that build their own Neon client (agora-citizens) resolve the
// connection string from the same alias set the serverless API does.
export function resolveDatabaseUrl() {
	for (const name of DATABASE_URL_SOURCES) {
		const v = unwrapDbCandidate(cred(opt(name)));
		if (v && /^postgres(ql)?:\/\//i.test(v)) return v;
	}
	return undefined;
}

// Public predicate for the "is the DB configured?" gates scattered across the
// store modules (forge-store, persona-store, …). They historically read
// `process.env.DATABASE_URL` directly, which reports "unconfigured" — silently
// disabling persistence — whenever the connection string lives under an alias.
// Routing them through this keeps a single source of truth for what counts as a
// configured database.
export function databaseConfigured() {
	return Boolean(resolveDatabaseUrl());
}

export const env = {
	get APP_ORIGIN() {
		return normalizeAppOrigin(opt('PUBLIC_APP_ORIGIN'));
	},

	// Runtime environment signals. NODE_ENV is set to 'production' by Vercel's
	// build/runtime; VERCEL_ENV is 'production' | 'preview' | 'development' on
	// Vercel deployments. Tests and local dev leave both unset, so prod-only
	// behavior (e.g. fail-closed rate limiting) never trips in CI or dev.
	get NODE_ENV() {
		return opt('NODE_ENV');
	},
	get VERCEL_ENV() {
		return opt('VERCEL_ENV');
	},
	// True on real production deployments (Cloud Run/Vercel set NODE_ENV or
	// VERCEL_ENV to 'production'); false in tests and local dev, which leave both
	// unset. Use to fence prod-only posture like HTTPS-only outbound fetches.
	get isProduction() {
		return opt('NODE_ENV') === 'production' || opt('VERCEL_ENV') === 'production';
	},

	// Resolved from DATABASE_URL or any standard Vercel-Postgres/Neon integration
	// alias (see DATABASE_URL_SOURCES). Still throws when NONE is set so the
	// db.js graceful-degradation path (isDbUnavailableError → shared 503) keeps
	// working — the message is unchanged on purpose so that classifier matches.
	get DATABASE_URL() {
		const url = resolveDatabaseUrl();
		if (!url) throw new Error('Missing required env var: DATABASE_URL');
		return url;
	},

	get S3_ENDPOINT() {
		return trimSlash(req('S3_ENDPOINT'));
	},
	get S3_ACCESS_KEY_ID() {
		return req('S3_ACCESS_KEY_ID');
	},
	get S3_SECRET_ACCESS_KEY() {
		return req('S3_SECRET_ACCESS_KEY');
	},
	get S3_BUCKET() {
		return req('S3_BUCKET');
	},
	get S3_PUBLIC_DOMAIN() {
		return trimSlash(req('S3_PUBLIC_DOMAIN'));
	},

	// Resolved as an atomic pair (see pickPair) so URL and token always come from
	// the SAME Upstash store — never a store-A URL with a store-B token (WRONGPASS).
	get UPSTASH_REDIS_REST_URL() {
		return pickPair(REDIS_REST_SOURCES).url;
	},
	get UPSTASH_REDIS_REST_TOKEN() {
		return pickPair(REDIS_REST_SOURCES).token;
	},

	// Optional dedicated cache store, separate from the rate-limiter store above.
	// The rate limiter must fail closed and lives on UPSTASH_REDIS_REST_*. The
	// best-effort caches (cacheGet/Set/Wrap) write large bodies — e.g. the galaxy
	// money-feed — that, sharing one free store with the limiter, both contend for
	// connections and burn the limiter's 500k/mo command quota; that contention is
	// the failure mode behind the SET timeouts on /api/galaxy/flows. Point these at
	// a SECOND Upstash store (ideally co-located with the prod Vercel region) to move
	// all cache traffic off the limiter. Unset → the cache (api/_lib/cache.js) falls
	// back to the shared store, then to in-memory — no behavior change. The Vercel-KV
	// marketplace names for a second store prefixed `cache` are accepted too.
	get UPSTASH_CACHE_REST_URL() {
		return pickPair(REDIS_CACHE_SOURCES).url;
	},
	get UPSTASH_CACHE_REST_TOKEN() {
		return pickPair(REDIS_CACHE_SOURCES).token;
	},

	// Per-command timeout (ms) for the best-effort cache's Upstash REST calls
	// (api/_lib/cache.js). A cache round-trip must be fast or fall back to memory;
	// the cap stops a TCP stall from hanging a fast endpoint until its hard
	// maxDuration. The default (3000) is far longer than a healthy REST GET/SET,
	// but when the cache store sits in a region far from the function region
	// (e.g. Upstash not co-located with iad1) large best-effort SETs can
	// legitimately exceed it and surface as "operation aborted due to timeout".
	// Exposed as an env knob so ops can raise it (region latency) or lower it
	// (fail faster to memory) without a code deploy. Clamped to [500, 30000];
	// anything blank or unparseable falls back to the default (a blank
	// `CACHE_REDIS_CMD_TIMEOUT_MS=` in the dashboard must NOT become 0 → clamped to
	// the 500ms floor, which would make timeouts WORSE — the opposite of the knob's
	// intent).
	get CACHE_REDIS_CMD_TIMEOUT_MS() {
		const raw = opt('CACHE_REDIS_CMD_TIMEOUT_MS');
		if (raw == null || String(raw).trim() === '') return 3000;
		const n = Number(raw);
		if (!Number.isFinite(n)) return 3000;
		return Math.min(30_000, Math.max(500, Math.round(n)));
	},

	// Largest value (serialized bytes) the cache will send to Upstash REST
	// (api/_lib/cache.js). A multi-hundred-KB JSON body over REST is the classic
	// guaranteed-timeout write: it can't complete inside CACHE_REDIS_CMD_TIMEOUT_MS
	// from a non-co-located region, so it burns the SET failure streak and flaps
	// the write-suppression gate all day (the July 2026 log export: ~1.9k SET
	// timeouts in 10h). Values over the cap go to the in-memory fallback only.
	// Clamped to [16KB, 8MB]; default 256KB — comfortably under Upstash's request
	// limits and large enough for every legitimate cached payload observed.
	get CACHE_REDIS_MAX_VALUE_BYTES() {
		const raw = opt('CACHE_REDIS_MAX_VALUE_BYTES');
		if (raw == null || String(raw).trim() === '') return 262_144;
		const n = Number(raw);
		if (!Number.isFinite(n)) return 262_144;
		return Math.min(8_388_608, Math.max(16_384, Math.round(n)));
	},

	// ── Upstash quota-burn visibility (api/_lib/redis-usage.js) ──────────────
	// The free plan ceils at 500k commands/month; when it is exhausted every
	// critical limiter fails closed and all paid forge + x402 flows 503 (the
	// June 2026 incident). To read the real daily command count BEFORE the
	// ceiling we use the Upstash Management API (api.upstash.com), which is a
	// SEPARATE credential from the per-store REST token above — the REST token
	// can run commands but cannot read account usage. All three are optional:
	// when unset, burn reporting degrades to `unknown` and never fabricates a
	// number. The store id is the only non-secret one, so it carries the known
	// default for the live `three-ratelimit` store.
	get UPSTASH_EMAIL() {
		return opt('UPSTASH_EMAIL');
	},
	get UPSTASH_MANAGEMENT_API_KEY() {
		return opt('UPSTASH_MANAGEMENT_API_KEY') || opt('UPSTASH_API_KEY');
	},
	get UPSTASH_REDIS_STORE_ID() {
		return opt('UPSTASH_REDIS_STORE_ID', 'store_QnjIWaKv4d5MvmA9');
	},

	get JWT_SECRET() {
		return req('JWT_SECRET');
	},
	get JWT_KID() {
		return opt('JWT_KID', 'k1');
	},

	// Dedicated secret for encrypting custodial agent wallet private keys at rest
	// (api/_lib/agent-wallet.js). Decoupled from JWT_SECRET on purpose: JWT_SECRET
	// is the highest-circulation secret on the platform, so binding wallet
	// confidentiality to it gives a single leak the keys to every custodial wallet,
	// and rotating session auth would otherwise re-key every wallet. Returns
	// undefined when unset; the wallet module then falls back to JWT_SECRET with a
	// warning. Set a distinct value (>=16 chars) in every environment with custody.
	get WALLET_ENCRYPTION_KEY() {
		return opt('WALLET_ENCRYPTION_KEY');
	},

	// HMAC key that makes scoped session-key (capability) grants tamper-evident
	// (api/_lib/wallet-capabilities.js). Each capability stores an HMAC over its
	// immutable scope keyed by this secret; the spend path re-verifies on every
	// use, so a DB-write attacker who forges or edits a grant produces one that no
	// longer verifies and is rejected (fail safe). Decoupled from the encryption
	// key by preference; falls back to WALLET_ENCRYPTION_KEY then JWT_SECRET so the
	// feature works in every environment. NEVER log this value.
	get WALLET_CAPABILITY_SECRET() {
		return opt('WALLET_CAPABILITY_SECRET') || opt('WALLET_ENCRYPTION_KEY') || this.JWT_SECRET;
	},

	// Long-lived Ed25519 signing seed for the provably-fair vanity grinder
	// (api/_lib/vanity-service-key.js). Stored as a secret-box ciphertext (v2:…)
	// or a raw 32-byte seed in hex/Base58. Signs every verifiable-grind receipt;
	// the public key is published at /.well-known/three-vanity.json and pinned in
	// the SDK + verifier. Returns undefined when unset — the service module then
	// derives a deterministic dev key from JWT_SECRET (with a one-time warning) so
	// local/CI works, while production must set a dedicated value.
	get VANITY_SERVICE_KEY() {
		return opt('VANITY_SERVICE_KEY');
	},

	// Master seed for deterministic persona↔wallet derivation
	// (api/_lib/persona-wallet.js): the same persona_id always re-derives the same
	// Solana keypair via HMAC-SHA256(secret, persona_id), so no private key is ever
	// stored — it exists only transiently in memory while signing, then is
	// discarded. Dedicated by preference; falls back to WALLET_ENCRYPTION_KEY then
	// JWT_SECRET so the feature works in dev/CI without extra config. Production
	// should set a distinct value: rotating it re-derives every persona to a NEW
	// wallet, so treat it as append-only once personas hold real funds.
	get PERSONA_WALLET_SECRET() {
		return opt('PERSONA_WALLET_SECRET') || opt('WALLET_ENCRYPTION_KEY') || this.JWT_SECRET;
	},

	// ── Agent-to-agent (A2A) autonomous payments ────────────────────────────
	// Secret that signs Intent Mandates (AP2-style budgeted spend authorizations).
	// Dedicated by preference; falls back to JWT_SECRET so the feature works in
	// dev/CI without extra config. Production should set a distinct value so
	// rotating session auth never invalidates outstanding mandates and vice versa.
	get A2A_MANDATE_SECRET() {
		return opt('A2A_MANDATE_SECRET') || this.JWT_SECRET;
	},
	// EVM private key for the autonomous payer wallet that signs EIP-3009
	// authorizations when an agent pays a peer under a mandate. MUST be a wallet
	// the platform funds with USDC — never a payment-receiving X402_PAY_TO_* key.
	// Unset → the a2a-call endpoint returns a designed 501 instead of paying.
	get A2A_PAYER_PRIVATE_KEY() {
		return opt('A2A_PAYER_PRIVATE_KEY');
	},

	// ── ERC-8004 ValidationRegistry attestations ────────────────────────────
	// EVM private key for the platform validator that signs glTF/schema
	// validation attestations and calls recordValidation() on each chain. MUST
	// be allow-listed via addValidator(<addr>) by the registry owner (task 01
	// step 6) on every chain it attests on, and funded with gas. Never a
	// payment-receiving key. Unset → the attestor returns a designed ops error
	// (`validator_key_not_configured`) and registration proceeds unvalidated.
	get VALIDATOR_PRIVATE_KEY() {
		return opt('VALIDATOR_PRIVATE_KEY') || opt('ERC8004_VALIDATOR_PRIVATE_KEY');
	},
	// Solana secret key for the autonomous payer wallet that signs SPL
	// TransferChecked payments when an agent pays a peer under a mandate on
	// Solana — the primary A2A settlement rail. Accepts the same encodings as
	// every other Solana secret in this codebase: base58 (Phantom export),
	// base64, or a JSON byte array. MUST be a platform-funded wallet holding
	// USDC, never a payment-receiving X402_PAY_TO_* key. Unset → the a2a-call
	// endpoint returns a designed 501 for Solana payments instead of paying.
	get A2A_PAYER_SOLANA_SECRET() {
		return opt('A2A_PAYER_SOLANA_SECRET') || opt('A2A_PAYER_SOLANA_PRIVATE_KEY');
	},
	// RPC URL used for read-only ERC-8004 reputation lookups when gating which
	// peers an agent is allowed to pay. Optional — reputation gating is opt-in
	// per call and skipped when no RPC is configured and no threshold is set.
	get A2A_REPUTATION_RPC_URL() {
		return opt('A2A_REPUTATION_RPC_URL') || opt('EVM_RPC_URL');
	},

	get PASSWORD_ROUNDS() {
		return parseInt(opt('PASSWORD_ROUNDS', '11'), 10);
	},

	get ISSUER() {
		return this.APP_ORIGIN;
	},
	get MCP_RESOURCE() {
		return `${this.APP_ORIGIN}/api/mcp`;
	},

	// Avaturn — photo-to-avatar pipeline. Only read when /api/onboarding/avaturn-session
	// is hit; keeping these optional so unrelated endpoints still respond when unset.
	get AVATURN_API_KEY() {
		return opt('AVATURN_API_KEY');
	},
	get AVATURN_API_URL() {
		return trimSlash(opt('AVATURN_API_URL', 'https://api.avaturn.me'));
	},
	// avaturn-seed cron — set to '1' to enable the per-minute headless seeder that
	// grows the public gallery with randomized, Avaturn-rigged avatars. Off by
	// default so the cron is a no-op until the operator opts in (and has quota).
	get AVATURN_SEED_ENABLED() {
		return opt('AVATURN_SEED_ENABLED', '') === '1';
	},

	// launcher house-seed cron — set to '1' to enable the per-minute headless
	// seeder that grows the AUTONOMOUS LAUNCHER's pool of house-owned agents:
	// each tick forges one fresh Avaturn-rigged avatar, files it under the house
	// account, mints an agent flagged `meta.launcher_house=true`, and provisions
	// its custodial Solana wallet. Those agents — and only those — are what the
	// global launcher draws from to sign coin launches, so coins mint from agents
	// the platform owns and can claim creator rewards for. Off by default.
	get LAUNCHER_HOUSE_ENABLED() {
		return opt('LAUNCHER_HOUSE_ENABLED', '') === '1';
	},

	// How many house-owned launch agents to maintain. The house-seed cron stops
	// forging once this many wallet-bearing, avatar-bearing house agents exist.
	get LAUNCHER_HOUSE_TARGET() {
		const n = Number.parseInt(opt('LAUNCHER_HOUSE_TARGET', '8'), 10);
		return Number.isFinite(n) && n > 0 ? Math.min(n, 250) : 8;
	},

	// Anthropic API key — used by persona / memory-seeding endpoints and
	// the we-pay LLM proxy (/api/llm/anthropic) when an agent selects a
	// Claude model. Optional: when unset, brain/persona endpoints fall back
	// to OpenRouter or Groq so user-facing features work without it.
	get ANTHROPIC_API_KEY() {
		return opt('ANTHROPIC_API_KEY');
	},

	// Groq API key — fast open-weight inference (Llama, etc.).
	// Used by brain/chat, viewer chat, and as a fallback for persona extraction.
	get GROQ_API_KEY() {
		return opt('GROQ_API_KEY');
	},

	// Cerebras API key (cloud.cerebras.ai) — free-tier OpenAI-compatible Llama
	// 3.3 70B inference, extremely fast. Optional rung in the shared LLM chain
	// (api/_lib/llm.js); when unset the chain simply skips it.
	get CEREBRAS_API_KEY() {
		return opt('CEREBRAS_API_KEY');
	},

	// Google AI Studio key (aistudio.google.com) — free-tier Gemini via its
	// OpenAI-compatible endpoint. Optional rung in the shared LLM chain;
	// distinct from the Vertex Gemini lane, which authenticates with the GCP
	// service account and needs no key here.
	get GEMINI_API_KEY() {
		return opt('GEMINI_API_KEY');
	},

	// NVIDIA NIM API key (build.nvidia.com) — free OpenAI-compatible inference for
	// 100+ hosted models (Nemotron, DeepSeek, Kimi, GLM, Llama 4, Qwen). Used by
	// brain/chat as selectable native providers and by the embed we-pay proxy
	// (api/llm/anthropic.js) as a free fallback tier. Endpoint:
	// https://integrate.api.nvidia.com/v1 — rate-limited free tier, no SLA, so it
	// is positioned as a budget/fallback lane that degrades back to paid providers.
	get NVIDIA_API_KEY() {
		return opt('NVIDIA_API_KEY');
	},

	// NVCF function id for the hosted Riva ASR model (Parakeet/Canary) used by the
	// free speech-to-text lane (api/_lib/asr-nvidia.js, api/asr.js). Unlike the
	// pinned Magpie TTS id, the ASR model/version a deployment wants varies, so
	// the id is configuration — discover the live id for your account with
	// `node scripts/verify-nvidia-asr.mjs --list`. When unset the ASR lane reports
	// itself unconfigured and callers fall back to the browser SpeechRecognition.
	get NVIDIA_ASR_FUNCTION_ID() {
		return opt('NVIDIA_ASR_FUNCTION_ID');
	},

	// NVCF function id for the hosted Audio2Face-3D model used by the free facial-
	// animation lane (api/_lib/a2f-nvidia.js, api/a2f.js) that turns Magpie speech
	// into a per-frame ARKit blendshape track. Unlike the ASR id this is OPTIONAL:
	// the module defaults to the published "James" model id from NVIDIA's official
	// sample, so the lane works with only NVIDIA_API_KEY set. Override to pin a
	// different model (Mark/Claire) — discover live ids with
	// `node scripts/verify-nvidia-a2f.mjs --list`.
	get NVIDIA_A2F_FUNCTION_ID() {
		return opt('NVIDIA_A2F_FUNCTION_ID');
	},

	// Optional override for the hosted NVIDIA Cosmos world-model invoke URL used by
	// the Cosmos text→world video lane (api/_providers/nvidia-cosmos.js, api/cosmos.js).
	// Defaults to the published cosmos gateway path for cosmos-predict
	// (https://ai.api.nvidia.com/v1/cosmos/nvidia/cosmos-predict1-7b); set this only
	// to pin a different Cosmos model/version or a self-hosted NIM without a code
	// deploy. Confirm the live contract for an account with
	// `node scripts/verify-nvidia-cosmos.mjs`. Auth reuses NVIDIA_API_KEY.
	get NVIDIA_COSMOS_INVOKE_URL() {
		return opt('NVIDIA_COSMOS_INVOKE_URL');
	},

	// IBM watsonx.ai (Granite foundation models) — selectable brain in
	// /api/chat and /api/brain/chat. Requires the API key AND a project (or
	// space) id; the shared client in _lib/watsonx.js exchanges the key for an
	// IAM bearer token and scopes every call. Optional — when unset, Granite is
	// reported as unavailable and other providers are used.
	get WATSONX_API_KEY() {
		return opt('WATSONX_API_KEY');
	},
	get WATSONX_PROJECT_ID() {
		return opt('WATSONX_PROJECT_ID');
	},
	get WATSONX_SPACE_ID() {
		return opt('WATSONX_SPACE_ID');
	},
	get WATSONX_URL() {
		return opt('WATSONX_URL');
	},
	get WATSONX_MODEL_ID() {
		return opt('WATSONX_MODEL_ID');
	},
	get WATSONX_API_VERSION() {
		return opt('WATSONX_API_VERSION');
	},

	// IBM Granite Guardian — the watsonx "Trust Layer". Reuses the watsonx
	// credentials above (same IBM Cloud key + project); this only names the
	// guardrail classifier model. Powers /api/guardian/assess and the autonomous-
	// send gate in /api/chat. Defaults to ibm/granite-guardian-3-8b.
	get WATSONX_GUARDIAN_MODEL_ID() {
		return opt('WATSONX_GUARDIAN_MODEL_ID');
	},
	// Hard dollar cap on an avatar's autonomous SOL send, enforced independently
	// of the model so a well-phrased request can't drain the wallet. Default $25.
	get GUARDIAN_SEND_CAP_USD() {
		return opt('GUARDIAN_SEND_CAP_USD');
	},
	// Set to "true" to bypass Granite Guardian gating in /api/chat (model gating
	// off; the dollar cap is unaffected). Off by default — governance is on.
	get GUARDIAN_DISABLE() {
		return opt('GUARDIAN_DISABLE');
	},

	// IBM watsonx Orchestrate agent (Agent Connect) — adds a "watsonx
	// Orchestrate" brain to /api/chat so a 3D avatar fronts an enterprise
	// Orchestrate agent. URL is the agent's chat-completions endpoint (instance
	// Test URL); the key is the bearer token. Optional — unset = unavailable.
	get WATSONX_ORCHESTRATE_URL() {
		return opt('WATSONX_ORCHESTRATE_URL');
	},
	get WATSONX_ORCHESTRATE_API_KEY() {
		return opt('WATSONX_ORCHESTRATE_API_KEY');
	},
	get WATSONX_ORCHESTRATE_AGENT() {
		return opt('WATSONX_ORCHESTRATE_AGENT');
	},

	// Etherscan V2 — unified multichain explorer API (one key, all chains).
	// Used by api/cron/erc8004-crawl.js to index ERC-8004 Registered events.
	get ETHERSCAN_API_KEY() {
		return opt('ETHERSCAN_API_KEY');
	},

	// Secret for Vercel Cron Authorization header (crons call with `Bearer $CRON_SECRET`).
	get CRON_SECRET() {
		return opt('CRON_SECRET');
	},

	// ── multiplayer bridge (presence + live DM delivery) ─────────────────────
	// Shared HMAC secret between this API and the standalone Colyseus server. The
	// API mints short-lived presence tickets (api/friends/presence-ticket) the
	// realm rooms verify before publishing a player's presence, and signs the
	// internal notify webhook. Falls back to HOLDER_PASS_SECRET (already shared
	// with the multiplayer process) so a single secret configures both gates.
	get MULTIPLAYER_SHARED_SECRET() {
		const s = opt('MULTIPLAYER_SHARED_SECRET') || opt('HOLDER_PASS_SECRET');
		if (s) return s;
		// Fail closed in production exactly like holder-pass.js / token/quote.js:
		// this secret is the HMAC key for world-service auth tokens, presence
		// tickets, and the internal notify webhook signature. Returning a publicly
		// known constant would let anyone forge a `{svc:'world'}` service token
		// (bypassing world-store permissions), forge presence tickets for any
		// userId, and forge the notify webhook signature. Refuse rather than do that.
		if (opt('NODE_ENV') === 'production' || opt('VERCEL_ENV') === 'production') {
			throw new Error(
				'[multiplayer] MULTIPLAYER_SHARED_SECRET (or HOLDER_PASS_SECRET) is required in production — ' +
					'refusing to sign world-service tokens and presence tickets with the dev secret.',
			);
		}
		return 'dev-insecure-multiplayer-secret';
	},
	// Base URL of the multiplayer server's internal API, used to push live DMs /
	// friend events to connected clients. Optional: when unset, delivery falls
	// back to the client's polling backstop and the durable offline queue.
	get MULTIPLAYER_INTERNAL_URL() {
		return trimSlash(opt('MULTIPLAYER_INTERNAL_URL') || opt('MULTIPLAYER_URL'));
	},

	// Platform fee basis points for agent monetization (100 bps = 1%).
	// Read by api/_lib/fee.js on cold-start. Default 250 (2.5%).
	get PLATFORM_FEE_BPS() {
		return parseInt(opt('PLATFORM_FEE_BPS', '250'), 10);
	},

	// Platform treasury keypair for monetization withdrawals.
	// Alias for TREASURY_KEYPAIR — either one is accepted by the
	// process-withdrawals cron.
	get PLATFORM_TREASURY_KEYPAIR() {
		return opt('PLATFORM_TREASURY_KEYPAIR') || opt('TREASURY_KEYPAIR');
	},

	// Mainnet RPC URL for ENS resolution. Falls back to ethers public default provider.
	// Recommended: set to an Alchemy / Infura URL for reliability.
	get MAINNET_RPC_URL() {
		return opt('MAINNET_RPC_URL');
	},

	// Base mainnet RPC URL — used by the SIWX server-side verifier (see
	// api/_lib/siwx-server.js) to validate EIP-1271 / EIP-6492 smart-contract
	// wallet signatures via viem's publicClient.verifyMessage. Without this,
	// SIWX falls back to EOA-only verification (still works for MetaMask /
	// Phantom EOAs; rejects Coinbase Smart Wallet, Safe, etc.). Falls back to
	// the club-payouts cron RPC, then the per-chain RPC_URL_8453 the delegation
	// + indexing crons use, so one provisioned Base RPC serves all of them.
	get BASE_RPC_URL() {
		return opt('BASE_RPC_URL', opt('CLUB_BASE_RPC_URL', opt('RPC_URL_8453')));
	},

	// ── ERC-7710 Delegation Relayer ──────────────────────────────────────────
	// Private key of the server-held EOA that pays gas for redeemDelegations.
	// NEVER log this value. Rotate via Vercel env; derive AGENT_RELAYER_ADDRESS
	// from the key using: node -e "require('ethers').Wallet.createRandom().address"
	get AGENT_RELAYER_KEY() {
		return req('AGENT_RELAYER_KEY');
	},

	// Derived: checksummed address of the relayer EOA. Fund with testnet ETH.
	// Optional — can be computed from AGENT_RELAYER_KEY; provided here for ops convenience.
	get AGENT_RELAYER_ADDRESS() {
		return opt('AGENT_RELAYER_ADDRESS');
	},

	// Comma-separated wallet addresses (EVM or Solana) that have admin access.
	// Bootstrap: set to your own wallet address. Can also be promoted via DB is_admin flag.
	// BUILT_IN_ADMIN_ADDRESSES are platform owners baked in so admin access survives
	// without env config; they are unioned with anything ADMIN_ADDRESSES supplies.
	// Addresses are normalised to lower-case to match the lookup in requireAdmin.
	get ADMIN_ADDRESSES() {
		const raw = opt('ADMIN_ADDRESSES', '');
		return new Set(
			[...BUILT_IN_ADMIN_ADDRESSES, ...raw.split(',')]
				.map((a) => a.trim().toLowerCase())
				.filter(Boolean),
		);
	},

	// Feature flag. Set to "true" to enable POST /api/permissions/redeem.
	// Defaults to false so the endpoint is opt-in per environment.
	get PERMISSIONS_RELAYER_ENABLED() {
		return opt('PERMISSIONS_RELAYER_ENABLED', 'false') === 'true';
	},

	// IPFS pinning provider credentials. Optional — when unset, pin endpoints
	// fall back to R2 storage and return a public HTTPS metadataURI.
	// Set PINATA_JWT in production for real IPFS CIDs on-chain.
	get PINATA_JWT() {
		return opt('PINATA_JWT');
	},

	// Per-chain RPC URLs for on-chain delegation calls.
	// Pattern: RPC_URL_<CHAINID> e.g. RPC_URL_84532 for Base Sepolia.
	// Falls back to public RPC nodes when unset; set Alchemy/Infura URLs for production.
	// ── x402 (HTTP 402 micropayments) ───────────────────────────────────────
	// Per-network payTo wallets that receive USDC for paid /api/mcp calls.
	// NO hardcoded default: an unset receiver fails closed — buildRequirements()
	// stops advertising that network — rather than silently routing real USDC to
	// a baked-in address if a fork or misconfigured deploy forgets to set it.
	// Asset/mint addresses below keep their public-constant defaults; only the
	// money-routing receivers (payTo + feePayer) are required-by-config.
	get X402_PAY_TO_SOLANA() {
		return addr(opt('X402_PAY_TO_SOLANA', opt('X402_PAY_TO')));
	},
	get X402_PAY_TO_BASE() {
		return addr(opt('X402_PAY_TO_BASE'));
	},
	// USDC asset addresses per network.
	get X402_ASSET_MINT_SOLANA() {
		return addr(
			opt(
				'X402_ASSET_MINT_SOLANA',
				opt('X402_ASSET_MINT', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
			),
		);
	},
	get X402_ASSET_ADDRESS_BASE() {
		return addr(opt('X402_ASSET_ADDRESS_BASE', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'));
	},
	// ── OKX Agent Payments Protocol rail (X Layer, eip155:196) ──────────────
	// payTo follows the same fail-closed rule: unset → the X Layer accept is
	// not advertised. Production sets the agent #2632 owner wallet.
	get X402_PAY_TO_XLAYER() {
		return addr(opt('X402_PAY_TO_XLAYER'));
	},
	// USD₮0 on X Layer — the OKX.AI marketplace fee token (6 decimals,
	// EIP-3009). Public constant, verified on-chain (symbol()/decimals() via
	// eth_call) and against live approved-seller 402 challenges.
	get X402_ASSET_ADDRESS_XLAYER() {
		return addr(opt('X402_ASSET_ADDRESS_XLAYER', '0x779ded0c9e1022225f8e0630b35a9b54be713736'));
	},
	// OKX SA API credentials (dev-portal API key) — auth for the official OKX
	// facilitator at https://web3.okx.com/api/v6/pay/x402/{verify,settle}
	// (HMAC-SHA256 per OKX REST auth). The primary settlement route for the
	// X Layer rail; env names match the official @okxweb3 SDK examples.
	get OKX_API_KEY() {
		return opt('OKX_API_KEY');
	},
	get OKX_SECRET_KEY() {
		return opt('OKX_SECRET_KEY');
	},
	get OKX_PASSPHRASE() {
		return opt('OKX_PASSPHRASE');
	},
	// Fallback relayer private key that redeems buyers' EIP-3009
	// authorizations on X Layer directly (broadcasts transferWithAuthorization;
	// pays OKB gas) when OKX facilitator credentials are absent. Secret. With
	// neither this nor the OKX API creds set, X Layer accepts are not
	// advertised (same never-advertise-what-we-can't-settle rule as
	// baseSettleable / solanaSettleable).
	get X402_XLAYER_RELAYER_KEY() {
		return opt('X402_XLAYER_RELAYER_KEY');
	},
	// Price per /api/mcp call, in the asset's base units (USDC = 6 decimals; "1000" = 0.001 USDC).
	get X402_MAX_AMOUNT_REQUIRED() {
		return opt('X402_MAX_AMOUNT_REQUIRED', '1000');
	},
	// USE-15 — TTL (seconds) for the payment-identifier idempotency cache.
	// Keyed by ${route}|${paymentId}; a second hit with the same id within the
	// window replays the cached response without re-charging. 1h default matches
	// the x402 docs' "long TTL" guidance for infrequently changing resources.
	// Per-route override via paidEndpoint({ paymentIdentifier: { ttlSeconds } }).
	get X402_IDEMPOTENCY_TTL_SECONDS() {
		return opt('X402_IDEMPOTENCY_TTL_SECONDS', '3600');
	},
	// Per-network facilitators. PayAI supports both Solana and Base mainnet;
	// x402.org's reference facilitator only supports base-sepolia, so it cannot
	// be the default for Base mainnet payments.
	get X402_FACILITATOR_URL_SOLANA() {
		return trimSlash(
			opt(
				'X402_FACILITATOR_URL_SOLANA',
				opt('X402_FACILITATOR_URL', 'https://facilitator.payai.network'),
			),
		);
	},
	get X402_FACILITATOR_URL_BASE() {
		return trimSlash(
			opt(
				'X402_FACILITATOR_URL_BASE',
				opt('X402_FACILITATOR_URL', 'https://facilitator.payai.network'),
			),
		);
	},
	// Explicit opt-in to advertise the Base (eip155:8453) payment rail WITHOUT CDP
	// credentials. Off by default: a bare X402_FACILITATOR_URL_BASE being set is NOT
	// proof the facilitator settles — prod had it pointed at a facilitator host that
	// answers every /verify with 404, so every Base-preferring buyer paid, failed
	// verification, and got a 502. Turn this on
	// only after confirming your non-CDP Base facilitator actually verifies+settles.
	// With CDP creds set, Base routes to CDP and this flag is unnecessary. Solana
	// (self-hosted facilitator) routes per api/_lib/x402/ring-config.js (explicit URL wins, else self-hosted
		// facilitator when X402_SELF_FACILITATOR_ENABLED=true, else external PayAI).
		// See baseSettleable().
	get X402_ADVERTISE_BASE() {
		return opt('X402_ADVERTISE_BASE', 'false') === 'true';
	},
	get X402_FACILITATOR_TOKEN_SOLANA() {
		return opt('X402_FACILITATOR_TOKEN_SOLANA', opt('X402_FACILITATOR_TOKEN'));
	},
	get X402_FACILITATOR_TOKEN_BASE() {
		return opt('X402_FACILITATOR_TOKEN_BASE', opt('X402_FACILITATOR_TOKEN'));
	},
	// Coinbase Developer Platform x402 facilitator. When both keys are set,
	// Base-mainnet payments route through CDP (required for CDP Bazaar /
	// agentic.market listing — only endpoints whose first verify+settle is
	// processed by CDP get cataloged). Solana routing is
		// independent — see api/_lib/x402/ring-config.js.
	get CDP_API_KEY_ID() {
		return opt('CDP_API_KEY_ID');
	},
	get CDP_API_KEY_SECRET() {
		return opt('CDP_API_KEY_SECRET');
	},
	get X402_CDP_FACILITATOR_URL() {
		return trimSlash(
			opt('X402_CDP_FACILITATOR_URL', 'https://api.cdp.coinbase.com/platform/v2/x402'),
		);
	},
	// Solana fee payer advertised in the 402 challenge's `extra.feePayer`.
	// Clients build the SPL transfer with this account paying SOL fees; the
	// facilitator co-signs on /settle. Must match whatever facilitator.payai.network
	// returns at /supported for `network:"solana"`.
	get X402_FEE_PAYER_SOLANA() {
		// No hardcoded default — see X402_PAY_TO_SOLANA. Without a fee payer the
		// Solana accept can't be co-signed, so it must come from config.
		return addr(opt('X402_FEE_PAYER_SOLANA'));
	},
	// $THREE as a second Solana settlement asset, offered alongside USDC so
	// holders can pay any three.ws paid endpoint in the platform token — the
	// modal renders a token chooser whenever both are advertised. ON by default
	// now that $THREE is the platform's only coin and every paid surface should
	// take it. Reuses the platform $THREE mint + decimals (THREE_TOKEN_MINT /
	// THREE_TOKEN_DECIMALS).
	//   ⚠️ OPERATIONAL PREREQUISITE: the advertised accept is co-signed and
	//   settled by X402_FACILITATOR_URL_SOLANA. That facilitator MUST settle the
	//   $THREE mint — three.ws's own checkout (api/x402-checkout.js) transfers any
	//   SPL mint, so it does; a vanilla USDC-only facilitator does NOT, and every
	//   $THREE payment would verify-sign then fail at /settle. If your Solana
	//   facilitator is USDC-only, set this to 'false' until it supports $THREE.
	get X402_ACCEPT_THREE_SOLANA() {
		return opt('X402_ACCEPT_THREE_SOLANA', 'true') === 'true';
	},
	// USE-21 auth-hints advertisement in 402 challenges. When 'true' (default),
	// endpoints that declare authHints append zero-amount accepts[] entries plus
	// the auth-hints extension so buyer clients can discover the free auth
	// alternative. External x402 directory validators (402index confirmed;
	// likely other amount-must-be-positive crawlers) reject any challenge that
	// contains amount="0" entries as "no valid x402 challenge" — set 'false' to
	// suppress the advertisement on a deployment that prioritizes directory
	// listability. Auth bypass itself is unaffected either way: the
	// access-control hook honors Bearer/SIWX headers before the payment dance
	// regardless of what the 402 advertises.
	get X402_AUTH_HINT_ACCEPTS() {
		return opt('X402_AUTH_HINT_ACCEPTS', 'true') === 'true';
	},
	// Flat THREE price per paid call, in atomic THREE units (6 decimals).
	// 10_000_000 = 10 $THREE. A single flat amount for every endpoint regardless
	// of its USDC price (a $0.01 oracle call and a $0.50 Forge both cost 10 THREE)
	// — adjust to taste, or set X402_THREE_AMOUNT_SOLANA in the environment to
	// override. Unset → falls back to reusing the USDC atomic amount.
	get X402_THREE_AMOUNT_SOLANA() {
		return opt('X402_THREE_AMOUNT_SOLANA', '10000000');
	},

	// ERC-8021 builder-code app identifier. When set, every 402 challenge
	// advertises the `builder-code` extension declaring this as `info.a`,
	// every paid request must echo it (anti-tamper), and the facilitator
	// appends a CBOR suffix to settlement-tx calldata so off-chain parsers
	// can attribute payment volume to this app. Pattern: `^[a-z0-9_]{1,32}$`.
	// Leave unset to disable on-chain attribution.
	get X402_BUILDER_CODE_APP() {
		return opt('X402_BUILDER_CODE_APP');
	},
	// Wallet builder code our outbound buyer clients self-attribute with.
	// Populates PaymentPayload.extensions["builder-code"].w so settlement
	// CBOR records the wallet that paid alongside the app that exposed.
	get X402_BUILDER_CODE_WALLET() {
		return opt('X402_BUILDER_CODE_WALLET');
	},

	// Spending caps for buyer clients (USE-22). Atomic micro-USD; leave
	// unset to disable that cap. Read by x402-spending-cap.js when callers
	// don't pass an explicit per-route override.
	get X402_MAX_PER_CALL_ATOMIC() {
		return opt('X402_MAX_PER_CALL_ATOMIC');
	},
	get X402_MAX_PER_HOUR_ATOMIC() {
		return opt('X402_MAX_PER_HOUR_ATOMIC');
	},
	get X402_MAX_PER_DAY_ATOMIC() {
		return opt('X402_MAX_PER_DAY_ATOMIC');
	},

	// USE-23: shared secret that lets internal Vercel functions skip the 402
	// challenge on our own paid endpoints by sending X-API-Key: <this value>.
	// Compared with constant-time equality in api/_lib/x402/access-control.js.
	// Generate with: openssl rand -base64 32
	get INTERNAL_API_KEY() {
		return opt('INTERNAL_API_KEY');
	},

	// EVM mainnet chains accepted by /api/x402/* paid endpoints — defaults to
	// Base + Arbitrum because those are the two CDP-Bazaar-supported networks
	// the seller wizard currently exposes. Comma-separated CAIP-2 IDs.
	get X402_EVM_NETWORKS() {
		return opt('X402_EVM_NETWORKS', 'eip155:8453,eip155:42161')
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
	},
	// Native (non-bridged) USDC on Arbitrum One mainnet.
	get X402_ASSET_ADDRESS_ARBITRUM() {
		return addr(opt('X402_ASSET_ADDRESS_ARBITRUM', '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'));
	},
	// Binance-Peg USD Coin (USDC) on BSC mainnet. Standard ERC-20; does NOT
	// implement EIP-3009 transferWithAuthorization, which is why BSC x402
	// payments use the contract-mediated "direct" scheme (see x402-bsc-direct.js).
	get X402_ASSET_ADDRESS_BSC() {
		return addr(opt('X402_ASSET_ADDRESS_BSC', '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d'));
	},
	// ThreeWSPayments x402 receiver contract on BSC. Client calls
	// pay(bytes32 ref) after approving USDC; the contract pulls pricePerCall
	// (1000 base units = $0.001) and emits Payment(payer, amount, ref).
	// Source + deploy tx: contracts/DEPLOYMENTS.md
	get X402_PAY_TO_BSC() {
		// No hardcoded default — see X402_PAY_TO_SOLANA. The ThreeWSPayments
		// receiver contract address must be set explicitly per deploy.
		return addr(opt('X402_PAY_TO_BSC'));
	},
	// Dedicated EIP-712 signing key for the offer-receipt extension (USE-17).
	// MUST NOT be any X402_PAY_TO_* key — those receive funds; this one only
	// signs off-chain commitments. When unset, api/_lib/x402-offer-receipt.js
	// exports a no-op issuer (null) and signed offers/receipts are not emitted.
	// Unset is the rollback toggle — no redeploy needed.
	get X402_RECEIPT_SIGNING_KEY() {
		return opt('X402_RECEIPT_SIGNING_KEY');
	},
	// ── AWS Marketplace ──────────────────────────────────────────────────────
	// IAM credentials with marketplaceMetering:ResolveCustomer,
	// marketplaceMetering:MeterUsage, and aws-marketplace:GetEntitlements.
	// Keep separate from S3_* credentials so each key has minimal permissions.
	get AWS_MP_ACCESS_KEY_ID() {
		return req('AWS_MP_ACCESS_KEY_ID');
	},
	get AWS_MP_SECRET_ACCESS_KEY() {
		return req('AWS_MP_SECRET_ACCESS_KEY');
	},
	get AWS_MP_REGION() {
		return opt('AWS_MP_REGION', 'us-east-1');
	},
	// Product code from the AWS Marketplace listing (shown in Seller portal).
	get AWS_MP_PRODUCT_CODE() {
		return req('AWS_MP_PRODUCT_CODE');
	},
	// SNS topic ARN that AWS sends subscription notifications to. Used to
	// reject SNS messages that did not originate from the Marketplace topic.
	get AWS_MP_SNS_TOPIC_ARN() {
		return opt('AWS_MP_SNS_TOPIC_ARN');
	},
	// Rate limit applied to the auto-issued x402 subscription minted when an
	// AWS Marketplace customer links their account. Tune per-tier by reading
	// from offer-identifier in subscription.js if you split listings.
	get AWS_MP_DEFAULT_RATE_LIMIT_PER_MINUTE() {
		return Number(opt('AWS_MP_DEFAULT_RATE_LIMIT_PER_MINUTE', '600'));
	},
	// When set, every successful paid-endpoint call by an AWS Marketplace
	// subscription fires MeterUsage on this dimension with quantity=1. Leave
	// blank for Contract products (flat-rate entitlement; no usage metering).
	get AWS_MP_METERING_DIMENSION() {
		return opt('AWS_MP_METERING_DIMENSION');
	},

	// Contract (entitlement-based) products only: when 'true', key issuance is
	// gated on a live GetEntitlements check against AWS. Leave unset for
	// usage-based products (which have no entitlements; metering is the billing).
	get AWS_MP_ENTITLEMENT_REQUIRED() {
		return /^(1|true|yes)$/i.test(String(opt('AWS_MP_ENTITLEMENT_REQUIRED', '') || ''));
	},

	// Optional operator EOA private key for scripts/erc8004-mint-bsc.mjs.
	// Used to register marketplace agents on the BSC IdentityRegistry. Never
	// referenced by request handlers — keep it out of the serverless surface.
	get BSC_OPERATOR_KEY() {
		return opt('BSC_OPERATOR_KEY');
	},

	// Greenfield vault platform account (BNB vault track, prompts 09/11). This
	// key creates buckets/objects on Greenfield on behalf of sellers — a
	// managed-storage model where sellers hold only a BSC address for payment
	// (recorded as `sellerAddress` in the vault manifest), never a Greenfield
	// keypair. Same secp256k1 curve/derivation as a BSC EOA, so it falls back to
	// BNB_TESTNET_DEPLOYER_KEY: one funded throwaway key can drive both the BSC
	// and Greenfield legs of this campaign's testnet proofs. UNLIKE
	// BSC_OPERATOR_KEY above, this IS read by a request handler
	// (api/bnb/vault-upload.js) — when unset, that endpoint returns a typed 503
	// rather than silently mocking a signer.
	get GREENFIELD_VAULT_OPERATOR_KEY() {
		return opt('GREENFIELD_VAULT_OPERATOR_KEY') || opt('BNB_TESTNET_DEPLOYER_KEY');
	},
	// Bucket that hosts every vault object, per network. Defaults match the
	// example bucket name in specs/vault-manifest.md.
	get GREENFIELD_VAULT_BUCKET_TESTNET() {
		return opt('GREENFIELD_VAULT_BUCKET_TESTNET', 'three-ws-vault-testnet');
	},
	get GREENFIELD_VAULT_BUCKET_MAINNET() {
		return opt('GREENFIELD_VAULT_BUCKET_MAINNET', 'three-ws-vault-mainnet');
	},

	// ── x402 Offer & Receipt extension (USE-17) ─────────────────────────────
	// DEDICATED signing key for the offer-receipt extension. MUST NOT be any
	// X402_PAY_TO_* key — those receive funds; this one only signs commitments.
	// Generate with: node -e "console.log(require('viem/accounts').generatePrivateKey())"
	// When unset, the extension is silently disabled (no signed offers/receipts
	// are emitted; 402/200 bodies stay protocol-compatible without them).
	get OFFER_RECEIPT_SIGNING_PRIVATE_KEY() {
		return opt('OFFER_RECEIPT_SIGNING_PRIVATE_KEY');
	},
	// "eip712" (default — uses the dedicated EOA above as a did:pkh signer) or
	// "jws" (uses a JWK private key from OFFER_RECEIPT_JWK to sign Ed25519 /
	// ES256K with a did:web kid resolved at /.well-known/did.json).
	get OFFER_RECEIPT_FORMAT() {
		return opt('OFFER_RECEIPT_FORMAT', 'eip712');
	},
	// JWK private key (JSON string) used when OFFER_RECEIPT_FORMAT=jws. The
	// public components are published in /.well-known/did.json so verifiers can
	// resolve the kid back to a key. Generate with `jose newkey -s 256 -t OKP -c EdDSA`.
	get OFFER_RECEIPT_JWK() {
		return opt('OFFER_RECEIPT_JWK');
	},
	// JWS algorithm (default EdDSA — Ed25519). Other supported: ES256K (secp256k1).
	get OFFER_RECEIPT_JWS_ALG() {
		return opt('OFFER_RECEIPT_JWS_ALG', 'EdDSA');
	},
	// Bare hostname for did:web identifiers (omit scheme + path). Used to build
	// kid = `did:web:<SERVER_DOMAIN>#key-1` and the matching `id` field in
	// /.well-known/did.json. Defaults to the host parsed from APP_ORIGIN.
	get SERVER_DOMAIN() {
		const explicit = opt('SERVER_DOMAIN');
		if (explicit) return explicit;
		try {
			return new URL(this.APP_ORIGIN).host;
		} catch {
			return 'three.ws';
		}
	},

	// zauthx402 SDK — optional telemetry for x402 endpoints. When unset,
	// the SDK is not initialized and request monitoring is skipped.
	get ZAUTH_API_KEY() {
		return opt('ZAUTH_API_KEY');
	},

	// Set to "1" to enable verbose [zauthSDK:*] logs in Vercel.
	get ZAUTH_DEBUG() {
		return opt('ZAUTH_DEBUG');
	},

	// Set to "1" to include request/response bodies in zauth telemetry. OFF by
	// default: these endpoints carry payment payloads and MCP tool args, which
	// must not be shipped to a third-party backend. Enable only for short-lived
	// debugging. Endpoint health (status/timing/validation verdict) is reported
	// regardless — body capture is not needed for WORKING/FAILING classification.
	get ZAUTH_INCLUDE_BODIES() {
		return opt('ZAUTH_INCLUDE_BODIES');
	},

	// Solana RPC URL — single source of truth for all Solana RPC calls.
	// Set to a Helius/QuickNode/Triton URL in production to avoid public RPC rate limits.
	get SOLANA_RPC_URL() {
		// Coalesce to the public endpoint when unset OR when a configured value is
		// malformed beyond repair — every direct consumer (fetch / new Connection)
		// then always receives a valid http(s) URL.
		return normalizeRpcUrl(opt('SOLANA_RPC_URL', '')) || 'https://api.mainnet-beta.solana.com';
	},

	// Helius API key — extracted from SOLANA_RPC_URL when it's a Helius endpoint,
	// or set independently. Used by helius-stats, nft/resolve, and scene/gate-check
	// to call Helius DAS APIs (getAsset, etc.) that are Helius-specific.
	get HELIUS_API_KEY() {
		const direct = opt('HELIUS_API_KEY');
		if (direct) return direct;
		// Auto-derive from SOLANA_RPC_URL if it's a Helius endpoint
		const rpc = opt('SOLANA_RPC_URL', '');
		const match = rpc.match(/[?&]api-key=([^&]+)/);
		return match ? match[1] : '';
	},

	// Solana devnet RPC URL. Falls back to the public devnet endpoint.
	get SOLANA_RPC_URL_DEVNET() {
		return normalizeRpcUrl(opt('SOLANA_RPC_URL_DEVNET', '')) || 'https://api.devnet.solana.com';
	},

	// ── threews.sol subdomain minting ─────────────────────────────────────
	// Parent .sol domain we mint subdomains under (e.g. `threews.sol`). The
	// platform must own this domain on-chain via THREEWS_SOL_PARENT_SECRET_BASE58.
	get THREEWS_SOL_PARENT_DOMAIN() {
		return opt('THREEWS_SOL_PARENT_DOMAIN', 'threews.sol');
	},
	// Base58-encoded 64-byte ed25519 secret for the keypair that owns the
	// parent .sol domain. Signs createSubdomain + URL-record + transfer
	// for both /api/threews/subdomain (user claims) and /api/sns-subdomain
	// (agent claims). Unset → subdomain minting returns 503.
	get THREEWS_SOL_PARENT_SECRET_BASE58() {
		return opt('THREEWS_SOL_PARENT_SECRET_BASE58');
	},
	// Public origin written into the SNS URL record so Brave-resolved
	// subdomains land on the correct deployment. Defaults to https://three.ws.
	get STOREFRONT_ORIGIN() {
		return trimSlash(opt('STOREFRONT_ORIGIN', 'https://three.ws'));
	},

	// ── Grind-bounty market (api/vanity/bounties.js) ──────────────────────
	// Solana USDC payout wallet for the grind-bounty market. Holds the escrowed
	// USDC the platform received via x402 when requesters funded their bounties,
	// and pays the winning worker (or refunds the requester on expiry) in real
	// on-chain SPL transfers. Never logged, never returned. Accepts a Base58
	// 64-byte secret key directly; the payout module also accepts the existing
	// base64 CLUB_SOLANA_TREASURY_SECRET_KEY_B64 as a fallback so the market
	// settles in environments that already fund that treasury.
	get VANITY_BOUNTY_PAYOUT_KEY() {
		return opt('VANITY_BOUNTY_PAYOUT_KEY');
	},

	// Solana funding wallet for sealed wallet drops (api/vanity/drops.js). Funds
	// each freshly-ground drop address on-chain (SOL/USDC/$THREE) and pays the
	// network fee on the expiry-reclaim sweep back to the sender. Never logged,
	// never returned. Accepts a Base58 64-byte secret; the funding module also
	// accepts VANITY_BOUNTY_PAYOUT_KEY and the base64 CLUB_SOLANA_TREASURY_SECRET_KEY_B64
	// as fallbacks so drops fund wherever the platform already holds a hot wallet.
	get VANITY_DROP_FUNDING_KEY() {
		return opt('VANITY_DROP_FUNDING_KEY');
	},

	// ── Lottery + Reflection coin (api/_lib/coin/*) ───────────────────────
	// Treasury keypair (base64-encoded 64-byte secret). Fee payer for every
	// lottery winner transfer + reflection batch transfer. Holds the SOL that
	// was claimed from the pump.fun creator vault.
	get COIN_TREASURY_SECRET_KEY_B64() {
		return opt('COIN_TREASURY_SECRET_KEY_B64');
	},
	// Per-mint pump.fun creator keypair, indexed by mint pubkey:
	//   COIN_CREATOR_SECRET_KEY_B64_<MINT_PUBKEY>=<base64-64-byte-secret>
	// Loaded lazily by api/_lib/coin/treasury.js#loadCoinCreatorFromCoin().
	// Alternative: store the base64 in coin_launches.metadata.creator_secret_b64
	// at register time (less secure than env; v2 should move to a KMS).

	// ── Mint-mark kill-switch ─────────────────────────────────────────────
	// Controls whether launch-prep and launch-agent enforce the three.ws "3ws"
	// mint mark. Default: ON (any value other than '0' or 'false' enforces).
	// Flip to '0' ONLY during an incident where grindVanityNode is broken and
	// launches must continue unblocked. Re-enable immediately after resolution.
	// When OFF, mints may be generated without the mark (pure-legacy path).
	get THREE_WS_MARK_ENFORCE() {
		return opt('THREE_WS_MARK_ENFORCE', '1');
	},

	// ── x402 pay-per-call pump.fun launcher (api/x402/pump-launch.js) ─────
	// Base64-encoded 64-byte Solana secret for the server keypair that PAYS
	// the SOL deploy cost (~0.022 SOL) and signs the create-coin tx on behalf
	// of anonymous x402 buyers. The buyer pays USDC via the 402 challenge; this
	// keypair fronts the SOL. Keep it funded. When unset, /api/x402/pump-launch
	// returns 503 not_configured. NEVER log this value.
	get PUMP_X402_LAUNCHER_SECRET_KEY_B64() {
		return opt('PUMP_X402_LAUNCHER_SECRET_KEY_B64');
	},

	// ── Pole Club tip sweep (api/_lib/club/*) ─────────────────────────────
	// Solana treasury keypair (base64-encoded 64-byte secret) that holds the
	// USDC received from /api/x402/dance-tip on Solana. Used by the
	// club-payouts cron to send accumulated tips to each dancer's wallet.
	get CLUB_SOLANA_TREASURY_SECRET_KEY_B64() {
		return opt('CLUB_SOLANA_TREASURY_SECRET_KEY_B64');
	},
	// EVM (Base mainnet) treasury private key (0x-prefixed hex). Holds the
	// USDC received from /api/x402/dance-tip on Base. Used by the club-payouts
	// cron to send accumulated tips to each dancer's EVM wallet.
	get CLUB_EVM_TREASURY_PRIVATE_KEY() {
		return opt('CLUB_EVM_TREASURY_PRIVATE_KEY');
	},
	// Base mainnet RPC URL. Falls back to the public node, but rate limits
	// will bite at >5 sweeps/minute — set this in production.
	get CLUB_BASE_RPC_URL() {
		return opt('CLUB_BASE_RPC_URL', 'https://mainnet.base.org');
	},

	// NFT.Storage API token — required for MintScene tool (uploads GLB + thumbnail + metadata to IPFS).
	// Obtain at https://nft.storage. When unset, /api/nft/mint-scene returns 503 not_configured.
	get NFT_STORAGE_TOKEN() {
		return opt('NFT_STORAGE_TOKEN');
	},

	// Metaplex Bubblegum compressed-NFT tree config — optional. When both are set, MintScene
	// uses the cNFT path (Bubblegum); otherwise falls back to a regular MPL Core NFT.
	get BUBBLEGUM_MERKLE_TREE() {
		return opt('BUBBLEGUM_MERKLE_TREE');
	},
	get BUBBLEGUM_TREE_AUTHORITY() {
		return opt('BUBBLEGUM_TREE_AUTHORITY');
	},

	// Privy — embedded wallet + social auth. App ID is public (used on the frontend);
	// app secret is server-only. JWKS endpoint is derived from the app ID by default.
	get PRIVY_APP_ID() {
		return opt('VITE_PRIVY_APP_ID') || opt('PRIVY_APP_ID');
	},
	get PRIVY_APP_SECRET() {
		return opt('PRIVY_APP_SECRET');
	},
	get PRIVY_JWKS_ENDPOINT() {
		return opt(
			'PRIVY_JWKS_ENDPOINT',
			this.PRIVY_APP_ID
				? `https://auth.privy.io/api/v1/apps/${this.PRIVY_APP_ID}/jwks.json`
				: undefined,
		);
	},

	// GitHub OAuth — social memory seeding. When unset, /api/auth/github/connect returns 501.
	get GITHUB_OAUTH_CLIENT_ID() {
		return opt('GITHUB_OAUTH_CLIENT_ID');
	},
	get GITHUB_OAUTH_CLIENT_SECRET() {
		return opt('GITHUB_OAUTH_CLIENT_SECRET');
	},

	// Admin key for three.ws chat brand config endpoint. Optional — when unset
	// the POST /api/chat/config endpoint returns 503.
	get CHAT_ADMIN_KEY() {
		return opt('CHAT_ADMIN_KEY');
	},

	// OpenRouter API key used by the server-side chat proxy (/api/chat/proxy).
	// Free-tier models are forwarded without exposing this key to the browser.
	get OPENROUTER_API_KEY() {
		return opt('OPENROUTER_API_KEY');
	},

	// Additional OpenRouter keys, comma-separated, tried in order after
	// OPENROUTER_API_KEY fails (credits exhausted, rate-limited, revoked).
	// Unfunded free-tier keys belong here: the llm.js failover pairs fallback
	// keys with the model's :free variant so they can still serve.
	get OPENROUTER_FALLBACK_KEYS() {
		return (opt('OPENROUTER_FALLBACK_KEYS') || '')
			.split(',')
			.map((k) => k.trim())
			.filter(Boolean);
	},

	// Alibaba Cloud DashScope (international) — direct Qwen access. Used by
	// /api/brain/chat when the user selects a Qwen provider. Falls back to
	// OPENROUTER_API_KEY when unset.
	get DASHSCOPE_API_KEY() {
		return opt('DASHSCOPE_API_KEY');
	},

	// ModelScope inference token — for Qwen3-Coder-480B on ModelScope's
	// OpenAI-compatible endpoint. Optional companion to DASHSCOPE_API_KEY.
	get MODELSCOPE_API_KEY() {
		return opt('MODELSCOPE_API_KEY');
	},

	// ── $THREE on-chain token layer (api/_lib/token/*) ────────────────────────
	// Shared primitives for premium token-priced actions (paid spins, token
	// marketplace sales). Centralized here so no mint/treasury/burn literals are
	// scattered across endpoints. The platform $THREE mint is the same constant
	// used by api/rider/* and api/three-token; override for devnet/test mints.
	get THREE_TOKEN_MINT() {
		return opt('THREE_TOKEN_MINT', 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump');
	},
	// pump.fun mints are 6-decimal. Override only if a non-pump mint is configured.
	get THREE_TOKEN_DECIMALS() {
		return parseInt(opt('THREE_TOKEN_DECIMALS', '6'), 10);
	},
	// Treasury wallet that receives the treasury share of every split. REQUIRED in
	// production — token/config.js fails loudly (mirrors HOLDER_PASS_SECRET) rather
	// than silently routing funds to a placeholder.
	get THREE_TREASURY_WALLET() {
		return opt('THREE_TREASURY_WALLET');
	},
	// Holder-rewards (reflections) wallet that receives the `rewards` share of every
	// split. The rewards cron (api/cron/rewards-distribute.js) drains this pool back
	// to holders pro-rata. REQUIRED in production — token/config.js fails closed
	// (mirrors THREE_TREASURY_WALLET) rather than silently routing rewards to a
	// placeholder. This is the platform's deflation-free alternative to burning.
	get THREE_REWARDS_WALLET() {
		return opt('THREE_REWARDS_WALLET');
	},
	// Solana prize wallet for the Social Trading Arena (api/tournaments/*). Holds the
	// $THREE used to pay tournament winners; the settlement module pays each winning
	// entry a real on-chain SPL transfer from this wallet. Never logged, never
	// returned. Accepts a Base58 64-byte secret (or base64); the settlement module
	// also accepts the base64 CLUB_SOLANA_TREASURY_SECRET_KEY_B64 as a fallback. When
	// unset, prizes settle as BLOCKED(payout_unconfigured) — the tournament still runs
	// and ranks, it just can't pay until this is configured.
	get THREE_PRIZE_PAYOUT_KEY() {
		return opt('THREE_PRIZE_PAYOUT_KEY');
	},
	// Burn address — defaults to the Solana incinerator, whose associated token
	// account is unspendable (no key exists), so tokens transferred there are
	// permanently removed from circulation. Verifiable as a plain destination.
	get THREE_BURN_ADDRESS() {
		return opt('THREE_BURN_ADDRESS', '1nc1nerator11111111111111111111111111111111');
	},
	// HMAC secret used to sign payment quotes so a client cannot tamper with the
	// quoted token amount or split after the server prices it. REQUIRED in
	// production (token/quote.js boot guard). NEVER log this value.
	get THREE_QUOTE_SECRET() {
		return opt('THREE_QUOTE_SECRET');
	},
	// Platform delegate keypair (base64 of a 64-byte secret key) for the $THREE
	// spend-allowance rail (api/_lib/token/allowance.js). This is the `delegatee`
	// users authorize via Solana's native Subscriptions program: once set + funded
	// (it pays tx fees / receiver-ATA rent on pulls), paid actions can debit a
	// holder's pre-approved cap with no per-action wallet popup. OPTIONAL — when
	// unset, every charge cleanly falls back to the signed quote→settle flow, so
	// the allowance fast path is strictly additive. NEVER log this value.
	get THREE_ALLOWANCE_DELEGATE_SECRET_KEY_B64() {
		return opt('THREE_ALLOWANCE_DELEGATE_SECRET_KEY_B64');
	},
	// Validity window (seconds) for an issued quote. Short enough that a quoted
	// price can't be exploited after the market moves; long enough to sign + send
	// one transaction. Default 90s.
	get THREE_QUOTE_TTL_S() {
		return parseInt(opt('THREE_QUOTE_TTL_S', '90'), 10);
	},

	// Rider payment gate — Solana wallet that receives $THREE, and Helius webhook secret.
	get RIDER_VAULT_ADDRESS() {
		return opt('RIDER_VAULT_ADDRESS');
	},
	get RIDER_HELIUS_WEBHOOK_SECRET() {
		return opt('RIDER_HELIUS_WEBHOOK_SECRET');
	},

	// Neynar API key — used by POST /api/agents/:id/memory/seed/farcaster.
	// When unset, the endpoint returns 501 not_configured.
	get NEYNAR_API_KEY() {
		return opt('NEYNAR_API_KEY');
	},

	// OpenAI API key — used by TTS proxy (/api/tts/speak) and chat endpoints.
	// Never sent to the browser.
	get OPENAI_API_KEY() {
		return opt('OPENAI_API_KEY');
	},

	// ElevenLabs API key — used by TTS proxy and voice cloning endpoints.
	// Never sent to the browser.
	get ELEVENLABS_API_KEY() {
		return opt('ELEVENLABS_API_KEY');
	},

	// VoyageAI API key — paid lane for /api/agents/:id/embed (voyage-3-lite).
	// Optional: the endpoint leads with the free NVIDIA NIM embedder and only
	// falls back to Voyage when keyed, so absence must not crash the route.
	get VOYAGE_API_KEY() {
		return opt('VOYAGE_API_KEY');
	},

	// X (Twitter) OAuth 2.0 PKCE — required for /api/auth/x/* and memory seeding.
	// Create an app at https://developer.twitter.com with Read permissions + OAuth 2.0 enabled.
	// When unset, /api/auth/x/connect returns 501 not_configured.
	get X_OAUTH_CLIENT_ID() {
		return opt('X_OAUTH_CLIENT_ID');
	},
	get X_OAUTH_CLIENT_SECRET() {
		return opt('X_OAUTH_CLIENT_SECRET');
	},

	// Livepeer AI Gateway — optional. When set, /api/inference/livepeer routes
	// to https://livepeer.studio/api/generate/llm with bearer auth (higher quota).
	// When unset, the demo falls back to the public dream gateway at
	// https://dream-gateway.livepeer.cloud/llm (no key, rate-limited).
	get LIVEPEER_API_KEY() {
		return opt('LIVEPEER_API_KEY');
	},

	// Dev.to syndication — required for the news admin's "Publish to Dev.to"
	// hook to do anything. Generate at https://dev.to/settings/extensions
	// (look for "Generate API Key"). When unset, syndication is skipped
	// silently and the admin shows "skipped: DEV_TO_API_KEY not set".
	get DEV_TO_API_KEY() {
		return opt('DEV_TO_API_KEY');
	},

	// Medium syndication — generate an integration token at
	// https://medium.com/me/settings/security (note: Medium's API is
	// deprecated for new accounts as of 2024 but still functions for
	// accounts that had API access enabled). MEDIUM_AUTHOR_ID is optional;
	// the syndicator auto-discovers it via /v1/me and caches in-memory.
	get MEDIUM_INTEGRATION_TOKEN() {
		return opt('MEDIUM_INTEGRATION_TOKEN');
	},
	get MEDIUM_AUTHOR_ID() {
		return opt('MEDIUM_AUTHOR_ID');
	},

	// Override URL for the @sparticuz/chromium-min binary pack. The "-min"
	// build excludes the chromium tarball from the npm package to keep the
	// function bundle small; this URL is downloaded once per warm container
	// and cached in /tmp. Default in render-glb.js tracks the version pinned
	// in package.json — set this only when upgrading chromium-min and the
	// upstream Sparticuz release tag drifts.
	get CHROMIUM_PACK_URL() {
		return opt('CHROMIUM_PACK_URL');
	},

	// CZ Agent campaign — on-chain registry contract for the transfer flow.
	// Set CZ_REGISTRY_CONTRACT to the deployed identity registry address.
	// CZ_AGENT_ID and CZ_AGENT_NAME can override the defaults.
	get CZ_REGISTRY_CONTRACT() {
		return opt('CZ_REGISTRY_CONTRACT', '0x0000000000000000000000000000000000000000');
	},
	get CZ_AGENT_ID() {
		return opt('CZ_AGENT_ID', 'cz-preview');
	},
	get CZ_AGENT_NAME() {
		return opt('CZ_AGENT_NAME', 'CZ Agent');
	},

	// ── aixbt intelligence bridge (api/_lib/aixbt.js) ─────────────────────
	// REST v2 API key for aixbt.tech. Powers /api/aixbt/* and the aixbt agent
	// skills + MCP tools. Without it the endpoints return a designed
	// "not configured" 503 (never fake data). Obtain a key with a full
	// aixbt.tech subscription or by paying for a time-boxed x402 key pass at
	// POST https://api.aixbt.tech/x402/v2/api-keys/{1d|1w|4w} (USDC on Base).
	get AIXBT_API_KEY() {
		return opt('AIXBT_API_KEY', '');
	},
	get AIXBT_API_BASE() {
		return trimSlash(opt('AIXBT_API_BASE', 'https://api.aixbt.tech/v2'));
	},
	get AIXBT_ENABLED() {
		return Boolean(this.AIXBT_API_KEY);
	},

	// ── SAML 2.0 SSO (three.ws as Service Provider) ───────────────────────────
	// Lets platform users sign in through an enterprise IdP (IBM Cloud App ID,
	// Okta, Azure AD, …). Two ways to point at the IdP:
	//   1. Paste its metadata URL  → SAML_IDP_METADATA_URL (sso url + signing
	//      cert are fetched + cached server-side).
	//   2. Set the fields directly → SAML_IDP_SSO_URL + SAML_IDP_CERT (+ entity
	//      id / slo url). Explicit fields win when both are present.
	// Unset → /api/auth/saml/* returns "not configured" and the SSO button is
	// hidden on /login. See .env.example for the full setup walkthrough.
	get SAML_IDP_ENTITY_ID() {
		return opt('SAML_IDP_ENTITY_ID');
	},
	get SAML_IDP_SSO_URL() {
		return opt('SAML_IDP_SSO_URL');
	},
	get SAML_IDP_SLO_URL() {
		return opt('SAML_IDP_SLO_URL');
	},
	// IdP signing certificate. Accepts a PEM block or a bare base64 body, with
	// literal "\n" escapes (common in dashboard-pasted env vars) normalized to
	// real newlines; api/_lib/saml.js strips it back to base64 for node-saml.
	get SAML_IDP_CERT() {
		return pem('SAML_IDP_CERT');
	},
	get SAML_IDP_METADATA_URL() {
		return opt('SAML_IDP_METADATA_URL');
	},

	// SP (our) identity advertised to the IdP. EntityID defaults to our metadata
	// URL; the ACS + SLO URLs are derived from APP_ORIGIN in api/_lib/saml.js.
	get SAML_SP_ENTITY_ID() {
		return opt('SAML_SP_ENTITY_ID', `${this.APP_ORIGIN}/api/auth/saml/metadata`);
	},
	// Optional SP keypair. When set, AuthnRequests are signed and encrypted
	// assertions can be decrypted. PEM, with "\n" escapes tolerated.
	get SAML_SP_PRIVATE_KEY() {
		return pem('SAML_SP_PRIVATE_KEY');
	},
	get SAML_SP_CERT() {
		return pem('SAML_SP_CERT');
	},

	// Security posture. The assertion (which carries identity) must be signed by
	// default; the response envelope signature is opt-in since many IdPs only
	// sign the assertion. Both can be required for stricter deployments.
	get SAML_WANT_ASSERTIONS_SIGNED() {
		return opt('SAML_WANT_ASSERTIONS_SIGNED', 'true') !== 'false';
	},
	get SAML_WANT_RESPONSE_SIGNED() {
		return opt('SAML_WANT_RESPONSE_SIGNED', 'false') === 'true';
	},
	get SAML_SIGNATURE_ALGORITHM() {
		return opt('SAML_SIGNATURE_ALGORITHM', 'sha256');
	},
	// NameID format requested in the AuthnRequest. Default: unspecified (omit the
	// Format so the IdP returns whatever it's configured for — broadest compat).
	// Set to e.g. urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress to pin it.
	get SAML_IDENTIFIER_FORMAT() {
		const v = opt('SAML_IDENTIFIER_FORMAT');
		return v && v !== 'none' && v !== 'unspecified' ? v : null;
	},
	get SAML_CLOCK_SKEW_MS() {
		return parseInt(opt('SAML_CLOCK_SKEW_MS', '5000'), 10);
	},
	// SP-initiated only by default (InResponseTo enforced → replay-resistant).
	// Set true to also accept unsolicited IdP-initiated responses.
	get SAML_ALLOW_IDP_INITIATED() {
		return opt('SAML_ALLOW_IDP_INITIATED', 'false') === 'true';
	},
	// Label shown on the /login SSO button (e.g. "Sign in with Acme SSO").
	get SAML_BUTTON_LABEL() {
		return opt('SAML_BUTTON_LABEL', 'Single sign-on (SSO)');
	},

	getRpcUrl(chainId) {
		return (
			opt(`RPC_URL_${chainId}`) ||
			(chainId === 84532 ? opt('BASE_SEPOLIA_RPC_URL') : null) ||
			(chainId === 11155111 ? opt('SEPOLIA_RPC_URL') : null) ||
			null
		);
	},
};
