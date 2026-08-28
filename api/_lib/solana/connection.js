// Canonical Solana RPC endpoint resolution + a drop-in Connection with transparent
// multi-endpoint failover.
//
// `solanaConnection({ url, commitment })` returns a normal @solana/web3.js
// Connection whose underlying fetch rotates across a priority-ordered endpoint
// list. Every method on it (getBalance, getLatestBlockhash, sendRawTransaction,
// confirmTransaction, …) transparently fails over when an endpoint returns
// 429/5xx/auth errors or the network blips: no call-site change beyond swapping
// the constructor. Re-sending an already-signed transaction to a second RPC is
// safe: Solana dedupes by signature.
//
// Priority (per network): the caller's explicit url (if any) → Helius → Alchemy
// → dRPC (authenticated) → Ankr (authenticated only) → operator-supplied
// SOLANA_RPC_FALLBACK_URLS → the keyless free tail. We never depend on the
// public endpoint alone, it is the most aggressively rate-limited (the source of
// the `getBalance 429` log noise), and we never include a keyless Ankr URL, which
// Ankr now answers with a hard 403.
//
// The keyless tail is what keeps checkout serving when a paid plan lapses. Its
// membership and ORDER are set by measured per-method capability, not latency:
// see FREE_KEYLESS_MAINNET below and the table in docs/ops/solana-rpc-lanes.md.
// Re-probe it when lanes start cooling persistently, because which methods a free
// provider still serves changes without notice (MagicBlock was the recommended
// primary until it began 403ing our egress on every method, 2026-08-07).
//
// To survive a single provider's quota running dry (e.g. a paid Helius plan
// exhausting its monthly requests), register free-tier keys at several providers
// and list their URLs in SOLANA_RPC_FALLBACK_URLS: every connection rotates
// across the whole set, so the platform keeps serving even mid-outage.

import { Connection } from '@solana/web3.js';

// NOTE: the shared cache is deliberately NOT imported at module scope. This
// module is shared with the BROWSER bundle (public/agent/index.html →
// src/agent-skills.js → src/agent-skills-pumpfun.js → src/solana/sns.js →
// here), and api/_lib/cache.js statically imports node:zlib and node:util. A
// top-level import therefore broke `npm run build` outright, rollup resolves
// the Node built-ins to __vite-browser-external and fails on
// `"promisify" is not exported`. Loading it lazily behind isServer() also fixes
// the architectural half: the browser holds no Upstash credentials and must
// never reach L2, so in a browser the breaker is correctly local-only.
let _cachePromise = null;
function isServer() {
	return typeof window === 'undefined';
}
/** Resolve { cacheGet, cacheSet }, or null in a browser. Cached after first call. */
function sharedCache() {
	if (!isServer()) return null;
	if (!_cachePromise) _cachePromise = import('../cache.js').catch(() => null);
	return _cachePromise;
}

function deriveWsUrl(httpUrl) {
	return String(httpUrl)
		.replace(/^https:/, 'wss:')
		.replace(/^http:/, 'ws:');
}

// Coerce an env-sourced WebSocket endpoint into a ws(s):// URL that a Connection's
// `wsEndpoint` accepts, or '' when it can't be salvaged. Mirrors normalizeRpcUrl's
// repairs (quote-strip, http(s) → ws(s), scheme-less host → wss) but targets the
// socket scheme instead of http. Anything unsalvageable returns '' so the caller
// falls back to deriving the socket from the primary HTTP endpoint.
export function normalizeWsUrl(raw) {
	let v = (raw ?? '').trim();
	if (!v) return '';
	if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
		v = v.slice(1, -1).trim();
	}
	if (!v) return '';

	let candidate = v;
	if (/^https:\/\//i.test(candidate)) candidate = candidate.replace(/^https:/i, 'wss:');
	else if (/^http:\/\//i.test(candidate)) candidate = candidate.replace(/^http:/i, 'ws:');
	else if (!/^wss?:\/\//i.test(candidate)) {
		// Scheme-less: assume wss only for a host-shaped value (has a dot, or
		// localhost[:port]). A bare token is a typo, not a host, so drop it.
		const host = candidate.split(/[/?#]/)[0];
		if (!host.includes('.') && !/^localhost(:\d+)?$/i.test(host)) return '';
		candidate = `wss://${candidate}`;
	}

	let u;
	try {
		u = new URL(candidate);
	} catch {
		return '';
	}
	if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return '';
	return candidate;
}

// The WebSocket endpoint a Connection subscribes on. The ONLY server-side WS consumer
// is the bounded `onLogs` live-trades window in pump-fun-mcp.js (confirms are
// HTTP-polling by design; see solana/confirm.js: web3.js's signatureSubscribe WS
// bypasses the rotating-fetch failover and 429-storms a warm instance). By default the
// socket is derived from the primary HTTP endpoint. A mainnet SOLANA_RPC_WS_URL
// override points that one subscription at a dedicated, stable socket (e.g. a paid
// QuickNode wss lane) instead of the primary HTTP provider, which can rate-limit the WS
// upgrade. Unset → byte-identical to before. Never applied on devnet: the override is a
// mainnet endpoint, and a mainnet socket on a devnet Connection would cross clusters.
export function resolveWsEndpoint(primaryHttpUrl, network = 'mainnet') {
	if (network !== 'devnet') {
		const override = normalizeWsUrl(process.env.SOLANA_RPC_WS_URL);
		if (override) return override;
	}
	return deriveWsUrl(primaryHttpUrl);
}

// True only for a value @solana/web3.js's `new Connection` will accept, a parseable
// URL whose protocol is http: or https:. Connection's `assertEndpointUrl` rejects
// everything else (ws://, a scheme-less host, junk) by throwing
// "Endpoint URL must start with `http:` or `https:`.", which is exactly the
// unhandled 500 that hammered /api/pump/curve and /api/pump/safety in production.
// Every URL that reaches a Connection constructor in this module is filtered through
// this guard so that error can never recur.
export function isHttpUrl(u) {
	if (typeof u !== 'string' || !u) return false;
	try {
		const { protocol } = new URL(u);
		return protocol === 'http:' || protocol === 'https:';
	} catch {
		return false;
	}
}

// Coerce an env-sourced RPC value into a Connection-safe http(s) URL, or '' when it
// cannot be salvaged. Repairs the malformed shapes seen in production env config
// before they reach `new Connection` (where they 500 with "Endpoint URL must start
// with http: or https:"):
//   • surrounding quotes: a dashboard paste artifact (`SOLANA_RPC_URL="https://…"`)
//   • a websocket URL (ws/wss): a valid URL but not an HTTP JSON-RPC endpoint; the
//     RPC host serves both on the same origin, so we map it to its http(s) form
//   • a scheme-less host (`mainnet.helius-rpc.com/?api-key=…`), assume https
// It also keeps the original Helius host repair: the JSON-RPC host is
// `mainnet.helius-rpc.com` / `devnet.helius-rpc.com`; a recurring misconfiguration
// set SOLANA_RPC_URL to `api-mainnet.helius-rpc.com` (conflating it with the
// `api.helius.xyz` REST host), which 404s every request. Returning '' for an
// unsalvageable value lets a real fallback take over instead of crashing the
// constructor; callers treat '' as "not configured".
export function normalizeRpcUrl(raw) {
	let v = (raw ?? '').trim();
	if (!v) return '';
	// Strip a single pair of surrounding quotes.
	if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
		v = v.slice(1, -1).trim();
	}
	if (!v) return '';

	// Build a parseable candidate, repairing ws/wss and scheme-less inputs. String-
	// level repairs (not URL.toString()) so a clean input round-trips byte-for-byte -
	// no trailing-slash churn versus the hardcoded endpoint constants, which would
	// otherwise defeat dedupe and list the same node twice.
	let candidate = v;
	if (/^wss:\/\//i.test(candidate)) candidate = candidate.replace(/^wss:/i, 'https:');
	else if (/^ws:\/\//i.test(candidate)) candidate = candidate.replace(/^ws:/i, 'http:');
	else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
		// Scheme-less: assume https only for a host-shaped value (has a dot, or
		// localhost[:port]). A bare token like "helius" is a typo, not a host, drop
		// it so it never becomes a bogus `https://helius` lane that wastes a failover
		// round-trip before the real fallback answers.
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

	// Helius host repair, spliced into the authority only (never the path/query) so
	// the rest of the URL keeps its exact original form.
	const fixedHost = u.hostname.replace(
		/^api-(mainnet|devnet)\.helius-rpc\.com$/i,
		'$1.helius-rpc.com',
	);
	if (fixedHost !== u.hostname) {
		return candidate.replace(
			/^([a-z][a-z0-9+.-]*:\/\/)([^/?#]+)/i,
			(_m, scheme, authority) => scheme + authority.replace(u.hostname, fixedHost),
		);
	}
	return candidate;
}

// Cooldown durations by failure class. Quota exhaustion (e.g. Helius -32429
// "max usage reached") means the provider is dead for the billing window, so we
// park it for hours instead of re-hammering it on every RPC call and every cron
// tick: that re-hammering was the source of the 429 retry storm in the logs.
// Plain rate-limits, auth rejections, and transient 5xx/network blips cool down
// for shorter, proportionate windows.
// Per-attempt fetch bound inside the rotating fetch: one hung provider must cost
// at most this before the rotation moves to the next lane.
const ATTEMPT_TIMEOUT_MS = 10_000;
const QUOTA_COOLDOWN_MS = 6 * 3_600_000; // 6h: daily/monthly quota exhausted
const RATE_LIMIT_COOLDOWN_MS = 10 * 60_000; // 10m, transient 429
const AUTH_COOLDOWN_MS = 30 * 60_000; // 30m: bad/expired key on this provider only
const SERVER_COOLDOWN_MS = 2 * 60_000; // 2m: provider 5xx
const NETWORK_COOLDOWN_MS = 30_000; // 30s: fetch threw (DNS/connection blip)

// ---------------------------------------------------------------------------
// Whole-chain transport failure: re-sweep, then serve last-good
// ---------------------------------------------------------------------------
// On 2026-08-27 the fleet logged "[solana-rpc] all 10 endpoints failed this
// request, fetch failed" roughly 2,000 times an hour while a direct probe of the
// same lanes from the same region answered fine. Ten unrelated hosts do not die
// in the same millisecond; when every lane fails with a transport error (DNS,
// refused socket, reset) inside one request, the weather is on OUR side of the
// wire (instance egress, resolver, socket pool), and it clears in well under a
// second. Three fallbacks stack here, cheapest first:
//   1. The error carries the undici cause code (ECONNRESET, EAI_AGAIN, ...).
//      "fetch failed" alone told nobody where to look for a week.
//   2. One jittered re-sweep of every lane after a short pause, only when the
//      first sweep was transport-only (an HTTP 429 or a quota body is a verdict
//      about the lane, not the wire, and never triggers it).
//   3. Idempotent READ methods answer from the last body a lane returned for the
//      identical call, marked stale in a response header, instead of a 502. A
//      holdings list from a few minutes ago is what the wallet hub should show
//      during a thirty-second egress blip; "could not read the wallet balance"
//      is not. Blockhash and slot reads are excluded on purpose: a stale
//      blockhash produces a transaction that fails later and worse.
const RESWEEP_DELAY_MIN_MS = 250;
const RESWEEP_DELAY_MAX_MS = 700;
const LAST_GOOD_TTL_SECONDS = 15 * 60;
const LAST_GOOD_MAX_BYTES = 256 * 1024;
// A success re-publishes its body at most this often per call shape, so the
// steady state costs one cache write a minute per distinct read, not one per
// RPC call.
const LAST_GOOD_WRITE_INTERVAL_MS = 60_000;
const LAST_GOOD_WRITE_MEMO_MAX = 4000;
const LAST_GOOD_READ_METHODS = new Set([
	'getBalance',
	'getAccountInfo',
	'getMultipleAccounts',
	'getTokenAccountBalance',
	'getTokenAccountsByOwner',
	'getTokenAccountsByDelegate',
	'getTokenSupply',
	'getTokenLargestAccounts',
	'getProgramAccounts',
	'getSignaturesForAddress',
	'getTransaction',
	'getMinimumBalanceForRentExemption',
	'getAsset',
	'getAssetsByOwner',
	'getAssetsByGroup',
	'getTokenAccounts',
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The network-level cause behind a thrown fetch, or '' when the error was not a
 * transport failure (an abort, a timeout, an HTTP verdict already classified).
 * undici wraps every socket/DNS failure as `TypeError: fetch failed` with the
 * errno on `cause`; that code is the only diagnostic worth having.
 */
export function transportCause(err) {
	if (!err) return '';
	const code = err.cause?.code || err.code;
	if (typeof code === 'string' && code) return code;
	const msg = String(err.message || err);
	if (/fetch failed|socket hang up|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|network error/i.test(msg)) {
		return 'transport';
	}
	return '';
}

/** djb2 over a string. Keys the last-good cache; collisions are made harmless by including the method and length in the key. */
function hashText(text) {
	let h = 5381;
	for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
	return h.toString(36);
}

/**
 * The last-good cache key for a single (non-batch) read call, or null when the
 * body is a batch, a write, a subscription, or anything not on the read list.
 * The JSON-RPC id is excluded so every caller of the same read shares one entry.
 */
export function lastGoodKey(body) {
	if (typeof body !== 'string' || !body || body.length > LAST_GOOD_MAX_BYTES) return null;
	let parsed;
	try {
		parsed = JSON.parse(body);
	} catch {
		return null;
	}
	if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return null;
	if (!LAST_GOOD_READ_METHODS.has(parsed.method)) return null;
	const shape = JSON.stringify({ method: parsed.method, params: parsed.params ?? [] });
	return `rpclastgood:v1:${parsed.method}:${shape.length}:${hashText(shape)}`;
}

const _lastGoodWrittenAt = new Map(); // key → epoch ms of the last publish
async function publishLastGood(key, okBody) {
	if (!key || okBody.length > LAST_GOOD_MAX_BYTES) return;
	const now = Date.now();
	if (now - (_lastGoodWrittenAt.get(key) || 0) < LAST_GOOD_WRITE_INTERVAL_MS) return;
	let parsed;
	try {
		parsed = JSON.parse(okBody);
	} catch {
		return;
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.error || !('result' in parsed)) return;
	if (_lastGoodWrittenAt.size >= LAST_GOOD_WRITE_MEMO_MAX) _lastGoodWrittenAt.clear();
	_lastGoodWrittenAt.set(key, now);
	try {
		const cache = await sharedCache();
		if (!cache) return;
		await cache.cacheSet(key, { result: parsed.result, at: now }, LAST_GOOD_TTL_SECONDS);
	} catch {
		/* best effort: the live answer already went out */
	}
}

/**
 * The last body a lane returned for this exact read, re-addressed to the
 * caller's request id, or null. Returned as a Response so the rotation can hand
 * it to web3.js unchanged; `x-solana-rpc-stale` carries the age in ms so a
 * proxy or handler can surface "as of" to the user.
 */
async function serveLastGood(key, body) {
	if (!key) return null;
	try {
		const cache = await sharedCache();
		if (!cache) return null;
		const hit = await cache.cacheGet(key);
		if (!hit || typeof hit !== 'object' || !('result' in hit)) return null;
		const id = JSON.parse(body).id ?? null;
		return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: hit.result }), {
			status: 200,
			headers: {
				'content-type': 'application/json',
				'x-solana-rpc-stale': String(Math.max(0, Date.now() - (Number(hit.at) || 0))),
			},
		});
	} catch {
		return null;
	}
}

const _staleLogAt = new Map(); // method → epoch ms of the last stale-serve log
function logStaleServe(method, ageMs, cause) {
	const now = Date.now();
	if (now - (_staleLogAt.get(method) || 0) < 30_000) return;
	_staleLogAt.set(method, now);
	console.warn(
		`[solana-rpc] every lane failed ${method} (${cause}); serving last-good from ${formatCooldown(ageMs)} ago`,
	);
}

/** Test hook: forget every last-good publish timestamp so a fresh write is observable. */
export function _resetLastGoodMemo() {
	_lastGoodWrittenAt.clear();
	_staleLogAt.clear();
}
// A lane refusing ONE call shape is demoted for that method alone, never for the
// lane. Short, because a policy block is a provider setting that can change and
// re-probing costs exactly one request that transparently fails over, unlike a
// quota probe, which burns the very budget it is testing.
const METHOD_DEMOTION_MS = 15 * 60_000; // 15m: this lane refuses this method
const PUBLIC_MAINNET = 'https://api.mainnet-beta.solana.com';
const PUBLIC_DEVNET = 'https://api.devnet.solana.com';

// The keyless FREE mainnet lanes, in priority order. Declared once here because
// two callers need the same truth: solanaRpcEndpoints() splices them into the
// chain, and paidMainnetEndpoints() subtracts them to decide what counts as
// paid capacity. Keeping one list means an operator who pins a free node as
// SOLANA_RPC_URL cannot accidentally be counted as a healthy premium lane.
//
// PublicNode is keyless and un-throttled (the same node mcp-server uses) so
// failover lands on a working endpoint instead of depending on the aggressively
// rate-limited public mainnet-beta endpoint alone. Leo RPC's keyless FREE tier
// is a second un-throttled lane, so the chain still has depth when every paid
// key is exhausted (e.g. a Helius plan lapsing mid-billing-cycle).
//
// Tatum gates getBalance and getSignaturesForAddress behind a paid tier (a
// -16401 "available for paid plans only" JSON-RPC error), which
// isProviderTierError classifies as a fail-over signal, so it adds redundancy
// for the methods it serves without ever blinding a balance/signature caller.
// The free public-RPC pool has thinned (most providers now 401/403/429
// keyless), so this set is curated to ones that actually respond; re-verify any
// that start cooling persistently in the failover logs. Two pruned so far:
// solana.therpc.io on 2026-07-17 after going fully unreachable (DNS fetch
// failures on every probe of both getLatestBlockhash and getBalance), and
// rpc.magicblock.app on 2026-08-07 after it began answering EVERY method on
// EVERY call with HTTP 403 "Your IP or provider is blocked from this endpoint".
// A lane blocked at the caller level is worse than absent: the breadth guard
// parks it for 30m, then the next rotation spends another real request
// rediscovering the same block, which is capacity burned to learn nothing.
//
// ORDER IS BY MEASURED CAPABILITY ON THE HOT METHODS, not by latency. Re-probed
// 2026-08-07 (docs/ops/solana-rpc-lanes.md carries the full table): getBalance
// and getTokenAccountsByOwner are what the balance, holder-gate, and treasury
// readers actually call, so a lane that refuses those belongs at the back no
// matter how fast it answers the ones it does serve.
//
// Both Tatum hosts moved behind PUBLIC_MAINNET for exactly that reason: they
// answer getBalance and getTokenAccountsByOwner with -16401 "available for paid
// plans only" and cap the keyless tier at 5 requests per minute. Sitting them
// ahead of mainnet-beta meant every balance read burned two lanes discovering a
// refusal before reaching the lane that serves it, which is how a single
// throttled provider escalated into "all N endpoints failed this request"
// (2026-08-07). They stay in the chain as last-resort depth for the methods they
// do serve; the classifyRpcBody guard still fails them over on garbage.
//
// Solana Vibe Station's public lane was added 2026-08-12 for one measured reason:
// getTokenLargestAccounts, the call behind /api/crypto/holders and the holder half
// of /api/crypto/security, had NO healthy free lane left. PublicNode hangs on it
// forever, mainnet-beta 429s it, Leo answers -32603, and the Tatum pair serves it
// but at 5 requests per minute, so with Helius and Alchemy both at monthly
// capacity the read 503'd on most calls. Vibe Station answers it on real mainnet
// (genesis 5eykt4Us…, slot within 1 of mainnet-beta) and throttles to a handful of
// requests before -32005, which the capacity classifier already parks correctly.
// It sits behind Leo because that throttle makes it depth, not a primary.
const FREE_KEYLESS_MAINNET = [
	'https://solana-rpc.publicnode.com',
	PUBLIC_MAINNET,
	'https://solana.leorpc.com/?api_key=FREE',
	'https://public.rpc.solanavibestation.com',
	'https://api.tatum.io/v3/blockchain/node/solana-mainnet',
	'https://solana-mainnet.gateway.tatum.io',
];

// Hostnames of every keyless free lane, plus the public devnet cluster. A URL
// on one of these hosts is never metered capacity no matter which env var
// supplied it.
const FREE_KEYLESS_HOSTS = new Set(
	[...FREE_KEYLESS_MAINNET, PUBLIC_DEVNET].map((u) => {
		try {
			return new URL(u).host;
		} catch {
			return '';
		}
	}),
);

/**
 * True when `url` is a metered/keyed lane we pay for, rather than one of the
 * keyless free nodes. Judged by HOST, not by which env var it arrived in: an
 * operator repointing SOLANA_RPC_URL at a free node during a quota outage must
 * not make the paid-tier sensor read healthy.
 */
function isPaidLane(url) {
	if (!url) return false;
	try {
		return !FREE_KEYLESS_HOSTS.has(new URL(url).host);
	} catch {
		return false;
	}
}

// Process-wide endpoint cooldown, keyed by full URL. Shared across every
// Connection built in this instance (both solanaConnection() and RpcFallback),
// so once one provider reports quota-exhausted, ALL callers skip it until it
// recovers.
//
// The breaker is also FLEET-WIDE, mirrored through the shared cache. A
// per-instance map alone was correct on Vercel's short-lived lambdas but is a
// real cost on Cloud Run: the map dies with every cold start, so each fresh
// instance re-discovers an exhausted quota the hard way, burning one more
// doomed request against a provider that is already over its cap. On a DAILY
// cap (QuickNode's -32003) that is actively harmful, since the wasted probes
// are themselves what keeps the account pinned at its ceiling. Publishing the
// verdict to L2 and inheriting it on the first call collapses fleet-wide waste
// to roughly one probe per window. Same pattern, same reasoning as the
// market-data breaker in api/_lib/market/token-market.js.
const _endpointCooldown = new Map();
const COOLDOWN_CACHE_KEY = 'rpccool:v1';
// Re-read the shared verdict at most this often per instance; the first call on
// a cold instance always awaits one read (that is the case worth paying for).
const COOLDOWN_HYDRATE_MS = 60_000;
let _cooldownHydratedAt = 0;
let _cooldownHydrateInFlight = null;

// Merge still-active shared cooldowns into the in-process map. Best-effort: a
// cache miss or error leaves the local map as-is and the request proceeds.
async function readSharedCooldowns() {
	try {
		const cache = await sharedCache();
		if (!cache) return; // browser: the local breaker is the whole breaker
		const shared = await cache.cacheGet(COOLDOWN_CACHE_KEY);
		if (!shared || typeof shared !== 'object') return;
		const now = Date.now();
		for (const [url, until] of Object.entries(shared)) {
			const ms = Number(until);
			if (ms > now && ms > (_endpointCooldown.get(url) || 0)) _endpointCooldown.set(url, ms);
		}
	} catch {
		/* local breaker still applies */
	}
}

/**
 * Inherit the fleet's view of dead endpoints. Awaited once per cold instance so
 * the very first request already skips a quota-exhausted provider; refreshed in
 * the background afterwards so steady-state RPC calls pay no cache round trip.
 */
export async function hydrateEndpointCooldowns(now = Date.now()) {
	if (now - _cooldownHydratedAt < COOLDOWN_HYDRATE_MS) return;
	if (_cooldownHydrateInFlight) return _cooldownHydrateInFlight;
	_cooldownHydrateInFlight = readSharedCooldowns().finally(() => {
		_cooldownHydratedAt = Date.now();
		_cooldownHydrateInFlight = null;
	});
	return _cooldownHydrateInFlight;
}

// Publish the in-process cooldowns (only those still active) so siblings inherit
// them. TTL tracks the longest remaining window; once it lapses the key vanishes
// and endpoints are retried. Fire-and-forget by design: parking an endpoint must
// never wait on, or fail because of, the cache.
function publishCooldowns(now) {
	const active = {};
	let maxRemainingMs = 0;
	for (const [url, until] of _endpointCooldown) {
		if (until > now) {
			active[url] = until;
			maxRemainingMs = Math.max(maxRemainingMs, until - now);
		}
	}
	if (maxRemainingMs <= 0) return;
	const pending = sharedCache();
	if (!pending) return; // browser: nothing to publish to
	pending
		.then((cache) => cache?.cacheSet(COOLDOWN_CACHE_KEY, active, Math.ceil(maxRemainingMs / 1000)))
		.catch(() => {});
}

// A provider refusing one CALL SHAPE, naming the shape in the refusal. The node is
// healthy and the credential is fine; this request, and only this request, cannot
// be served here. Measured phrasings:
//   • PublicNode getTokenAccountsByOwner → `Request blocked. Details: blocked
//     parameter: params.1.programId`
//   • PublicNode getProgramAccounts → `… excluded from account secondary indexes;
//     this RPC method unavailable for key`
//   • an operator-disabled method → `method <x> is not available`
// Matching on wording rather than on the JSON-RPC code is deliberate: PublicNode
// returns -32602 for its policy block, the same code a genuine invalid-params
// error uses, and a genuine invalid-params error must never demote anything
// because every lane rejects it identically.
const CALL_SHAPE_REFUSAL =
	/request blocked|blocked parameter|excluded from account secondary indexes|this rpc method unavailable|method .*(?:not supported|is not available|disabled)/i;

// A provider refusing the CALLER: our address, our plan, our lack of a key, 
// rather than the call. The wording is the trap: the SAME sentence is emitted
// per-method by a healthy node and caller-wide by a node that has banned us.
// Measured 2026-08-01 with scripts/probe-rpc-lanes.mjs: MagicBlock and
// api.mainnet-beta.solana.com both answer `Your IP or provider is blocked from
// this endpoint` for getProgramAccounts alone while serving all six other shapes,
// and Tatum answers `available for paid plans only` for three shapes while still
// serving getLatestBlockhash and getSignatureStatuses. Nothing in the message
// separates those from a real ban, so the text cannot decide it; only the BREADTH
// can, which is what the rotating fetch's escalation counter measures. Benching the
// lane on first sight would have parked our best free primary (MagicBlock) for 30
// minutes over one holder-census call.
const CALLER_REFUSAL =
	/blocked from this endpoint|not available for anonymous access|available for paid plans only|upgrade your subscription|please register at/i;

/**
 * True when `text` is a provider declining to serve this request for a reason the
 * NEXT lane will not share and that says nothing about our credential, so the
 * request rotates and the (lane, method) pair is demoted, not the lane.
 */
export function isMethodRefusal(text) {
	const t = text || '';
	return CALL_SHAPE_REFUSAL.test(t) || CALLER_REFUSAL.test(t);
}

/**
 * True when `text` names a call shape the node refuses. Narrower than
 * isMethodRefusal on purpose: this is the question cooldownMsFor asks once a lane
 * IS being benched, where a caller refusal must take the full auth window (it will
 * refuse the next request too) and a shape refusal must not.
 */
function isCallShapeRefusal(text) {
	return CALL_SHAPE_REFUSAL.test(text || '');
}

function cooldownMsFor(status, bodyText) {
	if (status === 429) {
		// "request limit reached" / -32003 is how QuickNode signals a DAILY cap
		// exhausted (HTTP 429 + `{code:-32003,"daily request limit reached - upgrade
		// your account"}`); it means the endpoint is dead for the rest of the day, so
		// park it for the long window instead of re-probing it every 10 minutes.
		// Alchemy words the same class of failure completely differently: HTTP 429 +
		// `{code:429,"Monthly capacity limit exceeded. Visit …/billing to upgrade your
		// scaling policy"}`, matching none of the phrases above. Left unmatched it
		// took the 10m transient window, so a lane that was dead until the billing
		// month rolled over re-entered rotation every 10 minutes and re-failed; when
		// it was also SOLANA_RPC_URL, practically every Solana call in production
		// began by failing over (236 lane failures in 6h, measured 2026-07-30).
		return /max usage reached|-32429|-32003|request limit|capacity limit|capacity exceeded|quota|usage limit|credits?\s*exhausted/i.test(
			bodyText || '',
		)
			? QUOTA_COOLDOWN_MS
			: RATE_LIMIT_COOLDOWN_MS;
	}
	// A 403 normally means a bad/expired key, which is an endpoint-wide problem.
	// Some keyless nodes instead answer 403 to refuse ONE call shape while serving
	// everything else: PublicNode returns `{"code":-32602,"Request blocked.
	// Details: blocked parameter: params.1.programId"}` for getTokenAccountsByOwner
	// filtered by programId, a call the token/USDC balance readers make constantly.
	// Treated as an auth failure that parked the whole node for 30m, so a healthy
	// primary was evicted by its own routine traffic and the rotation cascaded onto
	// the exhausted paid lanes. The endpoint is fine, this one request is not: fail
	// over for the call, keep the lane.
	//
	// The rotating fetch no longer reaches this branch: it recognises the refusal
	// first and demotes the METHOD instead of the lane (see markMethodDemotion), so
	// the lane keeps serving every other call shape with no cooldown at all. The
	// branch stays because markEndpointCooldown is exported and must still classify
	// a blocked call shape as the cheapest window rather than a 30m auth bench.
	if (status === 403 && isCallShapeRefusal(bodyText)) return NETWORK_COOLDOWN_MS;
	if (status === 401 || status === 403) return AUTH_COOLDOWN_MS;
	// 404/410: the endpoint URL is dead or misrouted (expired Quicknode/Alchemy
	// app, wrong path): a persistent misconfiguration, so park it like an auth
	// failure rather than re-probing every few minutes.
	if (status === 404 || status === 410) return AUTH_COOLDOWN_MS;
	if (status >= 500) return SERVER_COOLDOWN_MS;
	return RATE_LIMIT_COOLDOWN_MS;
}

/** True when `url` is currently parked in cooldown and should be skipped. */
export function isEndpointCooling(url) {
	return (_endpointCooldown.get(url) || 0) > Date.now();
}

// ---------------------------------------------------------------------------
// Per-method lane capability
// ---------------------------------------------------------------------------
// The lane cooldown above is the right tool for a provider that cannot serve
// ANY call: quota spent, key rejected, node down. It is the wrong tool for the
// far more common free-lane failure: a provider that serves most of the chain
// happily and refuses exactly one call shape. PublicNode answers getBalance,
// getLatestBlockhash and getSignatureStatuses perfectly while refusing
// getTokenAccountsByOwner with a programId filter and getProgramAccounts
// outright; MagicBlock serves the token filters and IP-blocks
// getProgramAccounts. Parking the whole lane on those refusals meant a lane's
// own routine traffic evicted it, and the rotation cascaded down onto the
// exhausted paid lanes that the free chain exists to protect.
//
// So a method-level refusal demotes (url, method) and nothing else: the lane
// stays in rotation for every other shape, and only this shape skips it. It is
// never an auth fault, so it never earns the 30m auth bench and is never
// published as a fleet-wide bench.
//
// Deliberately process-local, unlike the quota breaker. Re-discovering a method
// block on a cold instance costs ONE request that transparently fails over.
// Re-discovering a quota block costs a request against a plan that is already
// over its cap, which is what keeps a daily cap pinned, that asymmetry is the
// whole reason the quota verdict is shared and this one is not.
const _methodDemotion = new Map(); // `${url}${METHOD_KEY_SEP}${method}` → expiry ms

// NUL, because neither a URL nor a JSON-RPC method name can contain one. Every
// read of this map goes through methodKey or splits on this one constant, so the
// write side and the prefix scan can never disagree about a key's shape. They did
// once, and a prefix scan looking for the wrong separator counted zero every time,
// silently disabling the escalation below without failing anything loudly.
const METHOD_KEY_SEP = '\u0000';
const methodKey = (url, method) => `${url}${METHOD_KEY_SEP}${method}`;

/**
 * The JSON-RPC method names carried by a request body, deduped. Handles the
 * single-call and batch forms web3.js emits. Returns [] for an unreadable body,
 * which makes every capability check a no-op: an unparseable request must never
 * silently skip a healthy lane.
 */
export function rpcMethodsFromBody(body) {
	if (typeof body !== 'string' || !body) return [];
	let parsed;
	try {
		parsed = JSON.parse(body);
	} catch {
		return [];
	}
	const items = Array.isArray(parsed) ? parsed : [parsed];
	const out = [];
	for (const item of items) {
		const m = item && typeof item === 'object' ? item.method : null;
		if (typeof m === 'string' && m && !out.includes(m)) out.push(m);
	}
	return out;
}

/** True when `url` is currently demoted for `method`. */
export function isMethodDemoted(url, method) {
	return (_methodDemotion.get(methodKey(url, method)) || 0) > Date.now();
}

/**
 * True when `url` is demoted for ANY method in `methods`. A JSON-RPC batch is
 * atomic from the caller's side: if one member would be refused, the whole batch
 * comes back partially broken, so the lane is skipped for the batch.
 */
export function isAnyMethodDemoted(url, methods) {
	return methods.some((m) => isMethodDemoted(url, m));
}

/** How many distinct methods `url` is currently demoted for. */
export function methodDemotionBreadth(url, now = Date.now()) {
	let n = 0;
	const prefix = `${url}${METHOD_KEY_SEP}`;
	for (const [key, until] of _methodDemotion) {
		if (until > now && key.startsWith(prefix)) n++;
	}
	return n;
}

// A node refusing the CALLER and a node refusing a CALL SHAPE use the same words
// (see CALLER_REFUSAL). Breadth is the only thing that tells them apart: a real IP
// ban or a dead free tier refuses everything we ask, a policy block refuses one or
// two shapes and serves the rest. Measured 2026-08-01, the widest LEGITIMATE
// refusal set on any lane we run is three (Tatum's free tier gates getBalance,
// getTokenAccountsByOwner and getProgramAccounts while still serving
// getLatestBlockhash and getSignatureStatuses, which are worth keeping). A lane
// past that is refusing us, not a shape, so it earns the full lane bench instead of
// leaking one wasted request per method per window.
const DEMOTION_BREADTH_BENCH = 4;

/**
 * Demote `url` for each of `methods` for METHOD_DEMOTION_MS, and bench the whole
 * lane if the demotions have spread wide enough to mean the node is refusing us
 * rather than a call shape. Returns `{ ms, benched }` so the caller can log which
 * of the two happened.
 */
export function markMethodDemotion(url, methods, now = Date.now()) {
	const until = now + METHOD_DEMOTION_MS;
	for (const m of methods) _methodDemotion.set(methodKey(url, m), until);
	if (methodDemotionBreadth(url, now) >= DEMOTION_BREADTH_BENCH) {
		// AUTH_COOLDOWN_MS, and marked through markEndpointCooldown, so this park is
		// published fleet-wide exactly like any other caller-level rejection. A node
		// that has banned our egress IP has banned every instance's.
		return { ms: markEndpointCooldown(url, 403, 'caller refused on every call shape'), benched: true };
	}
	return { ms: METHOD_DEMOTION_MS, benched: false };
}

/**
 * Every live (url, method) demotion, for the ops surface. Expired entries are
 * dropped as they are read, which is the only reaping this map needs: the key
 * space is bounded by lanes × methods.
 */
export function rpcMethodDemotions(now = Date.now()) {
	const out = [];
	for (const [key, until] of _methodDemotion) {
		if (until <= now) {
			_methodDemotion.delete(key);
			continue;
		}
		const [url, method] = key.split(METHOD_KEY_SEP);
		out.push({ url, method, remainingMs: until - now });
	}
	return out;
}

/**
 * Park `url` in cooldown for a window sized to the failure class. Returns the
 * chosen cooldown in ms so callers can log it. `bodyText` (a 429 body or error
 * message) is scanned for a quota signal to pick the long window.
 */
export function markEndpointCooldown(url, status, bodyText) {
	const ms = cooldownMsFor(status, bodyText);
	const now = Date.now();
	_endpointCooldown.set(url, now + ms);
	// Only quota/auth-class parks are worth telling the fleet about. A 30s network
	// blip would churn the shared key for no benefit, and a sibling re-probing a
	// briefly-flaky node is exactly the behaviour we want to keep.
	if (ms >= RATE_LIMIT_COOLDOWN_MS) publishCooldowns(now);
	return ms;
}

function dedupe(list) {
	const seen = new Set();
	return list.filter((u) => u && typeof u === 'string' && !seen.has(u) && seen.add(u));
}

// devnet is inferred from the caller's url so we never append a mainnet fallback
// to a devnet primary (or vice-versa): crossing clusters would return wrong data.
function inferNetwork(url) {
	return /devnet/i.test(String(url || '')) ? 'devnet' : 'mainnet';
}

// Operator-supplied extra fallback URLs (comma-separated SOLANA_RPC_FALLBACK_URLS).
// This is the zero-deploy lever for "spread load across as many free tiers as
// possible": sign up for free-tier keys at several providers (Alchemy, dRPC,
// Quicknode, Chainstack, Triton…), drop their URLs here, and EVERY Solana
// connection rotates across them: so no single free quota becomes the bottleneck
// and a provider running dry transparently fails over to the next.
function extraFallbackUrls() {
	// SOLANA_RPC_FALLBACKS was the balances-layer-only fallback var before the
	// balance reads moved onto this canonical chain (2026-07-23); it is read here
	// too so an operator value set under either name keeps working. Entries that
	// duplicate a keyed provider above dedupe away.
	return [process.env.SOLANA_RPC_FALLBACK_URLS, process.env.SOLANA_RPC_FALLBACKS]
		.filter(Boolean)
		.join(',')
		.split(',')
		.map((s) => normalizeRpcUrl(s))
		.filter(Boolean);
}

// Operator-supplied LAST-RESORT URLs (comma-separated SOLANA_RPC_LAST_RESORT_URLS).
// The inverse economics of SOLANA_RPC_FALLBACK_URLS: paid metered endpoints
// (e.g. the Quicknode credit-funded endpoint) whose quota should be PRESERVED,
// not load-balanced. They sit after every free/keyless public node, so they are
// only hit when the entire free chain is down or throttled, the endpoint acts
// as an insurance rung and its monthly credits stretch as long as possible.
function lastResortUrls() {
	return (process.env.SOLANA_RPC_LAST_RESORT_URLS || '')
		.split(',')
		.map((s) => normalizeRpcUrl(s))
		.filter(Boolean);
}

// The caller's explicit `url` is pinned at priority 1, but ~35 call sites spell
// their default as `process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'`,
// so whenever SOLANA_RPC_URL is unset they would pin the single most-throttled
// endpoint in the chain AHEAD of Helius and every paid lane, silently inverting
// the whole priority order. A bare public-cluster URL is that default leaking
// through, never a deliberate choice, so it does not earn the pin. The endpoint
// is NOT dropped: it still serves at its natural position near the end of the
// free set, so behaviour degrades to the designed order instead of to nothing.
function pinnedUrl(url) {
	const v = normalizeRpcUrl(url);
	if (!v) return '';
	return v === PUBLIC_MAINNET || v === PUBLIC_DEVNET ? '' : v;
}

/**
 * Priority-ordered endpoint list for a network. An explicit `url` (the value a
 * call site already resolved) is pinned first; keyed providers, then any
 * operator-supplied SOLANA_RPC_FALLBACK_URLS, then the keyless public endpoints
 * follow as fallbacks, with the most-throttled public endpoint at the end of the
 * free set. Any SOLANA_RPC_LAST_RESORT_URLS (paid metered endpoints held in
 * reserve) come after ALL free endpoints, so they only serve when everything
 * free is down.
 */
export function solanaRpcEndpoints(network = 'mainnet', url = null) {
	const key = process.env.HELIUS_API_KEY;
	const alch = process.env.ALCHEMY_API_KEY;
	const ankr = process.env.ANKR_API_KEY;
	// dRPC: free tier requires a key (keyless now returns "chain is not available
	// on freetier"). Added in its authenticated form only when DRPC_API_KEY is set.
	const drpc = process.env.DRPC_API_KEY;
	if (network === 'devnet') {
		// .filter(isHttpUrl) is the hard guarantee: only a value `new Connection`
		// accepts survives, so a malformed env entry can never reach the constructor.
		return dedupe([
			pinnedUrl(url),
			normalizeRpcUrl(process.env.SOLANA_RPC_URL_DEVNET),
			// QuickNode: a full dedicated endpoint URL (key embedded in the path), so
			// it takes a URL var rather than an api-key. Premium/reliable, placed high.
			normalizeRpcUrl(process.env.QUICKNODE_RPC_URL_DEVNET),
			key && `https://devnet.helius-rpc.com/?api-key=${key}`,
			alch && `https://solana-devnet.g.alchemy.com/v2/${alch}`,
			drpc && `https://lb.drpc.org/ogrpc?network=solana-devnet&dkey=${drpc}`,
			PUBLIC_DEVNET,
		]).filter(isHttpUrl);
	}
	return dedupe([
		pinnedUrl(url),
		normalizeRpcUrl(process.env.SOLANA_RPC_URL),
		// QuickNode: a full dedicated endpoint URL (key embedded in the path), so it
		// takes a URL var rather than an api-key. A premium paid lane: placed right
		// after the operator's explicit SOLANA_RPC_URL and ahead of the shared-key
		// providers so it absorbs load first. Its WSS is derived by deriveWsUrl
		// (https:->wss:), which matches QuickNode's own wss:// host/path exactly.
		normalizeRpcUrl(process.env.QUICKNODE_RPC_URL),
		key && `https://mainnet.helius-rpc.com/?api-key=${key}`,
		alch && `https://solana-mainnet.g.alchemy.com/v2/${alch}`,
		drpc && `https://lb.drpc.org/ogrpc?network=solana&dkey=${drpc}`,
		// Ankr sunset keyless access: every keyless rpc.ankr.com/<chain> now 403s
		// ("authenticate with an API key"), so include it only in its authenticated
		// form when ANKR_API_KEY is set. Mirrors idxRpcUrls() in api/cron/[name].js;
		// a keyless entry here was a guaranteed 403 + cooldown log every cron tick.
		ankr && `https://rpc.ankr.com/solana/${ankr}`,
		// Operator's own free-tier fallbacks (mainnet only: devnet URLs would cross
		// clusters and return wrong data). Tried before the public nodes so the
		// configured providers absorb load first.
		...extraFallbackUrls(),
		// The curated keyless free chain (see FREE_KEYLESS_MAINNET above), ending
		// with the most-throttled public cluster.
		...FREE_KEYLESS_MAINNET,
		// Paid metered reserve (mainnet only: devnet URLs would cross clusters).
		// Dead last BY DESIGN: these bill against a monthly quota, so they serve
		// only when every free lane above is down or throttled at once.
		...lastResortUrls(),
		// .filter(isHttpUrl) is the hard guarantee: only a value `new Connection`
		// accepts survives, so a malformed env entry can never reach the constructor.
	]).filter(isHttpUrl);
}

/**
 * The keyed / metered mainnet lanes: every endpoint we PAY for, in the same
 * forms solanaRpcEndpoints() builds them. Free keyless nodes are excluded.
 * Used by the lane-health sensor to answer "are we still on paid capacity, or
 * has the whole premium tier gone dark and left us on free public nodes?"
 *
 * The operator vars are filtered through isPaidLane() because repointing
 * SOLANA_RPC_URL at a keyless node is the standard mitigation during a quota
 * outage (done 2026-07-30, when Alchemy/Helius/QuickNode were exhausted at
 * once). Counting that free node as premium capacity would make this sensor
 * report a healthy paid tier at exactly the moment the whole tier is dark,
 * the same blind spot the sensor was written to close.
 */
function paidMainnetEndpoints() {
	const key = process.env.HELIUS_API_KEY;
	const alch = process.env.ALCHEMY_API_KEY;
	return dedupe([
		normalizeRpcUrl(process.env.SOLANA_RPC_URL),
		normalizeRpcUrl(process.env.QUICKNODE_RPC_URL),
		key && `https://mainnet.helius-rpc.com/?api-key=${key}`,
		alch && `https://solana-mainnet.g.alchemy.com/v2/${alch}`,
		...lastResortUrls(),
	])
		.filter(isHttpUrl)
		.filter(isPaidLane);
}

/**
 * Health of the Solana RPC lanes as this instance (plus whatever the fleet has
 * published) currently understands them. Reports which endpoints are parked in
 * cooldown and, critically, whether ANY paid lane is still serving.
 *
 * The blind spot this closes: before 2026-07-29 the only RPC sensor watched
 * Helius, and it read per-instance memory: so a fresh instance reported
 * "premium RPC healthy" while the plan was hard-exhausted, and QuickNode's daily
 * cap and Alchemy's monthly cap had no sensor at all. All three were exhausted
 * simultaneously and nothing surfaced it. Because the cooldown map is now
 * fleet-wide, this reads the whole tier honestly.
 *
 * @returns {{ total, cooling, paidTotal, paidCooling, allPaidCooling, lanes }}
 */
export function rpcLaneHealth(now = Date.now()) {
	const paid = new Set(paidMainnetEndpoints());
	// Group live method demotions by lane so each lane reports the call shapes it
	// is currently skipped for. A lane can be fully healthy AND carry demotions, 
	// that is the normal state of a free lane, not a degradation.
	const demotionsByUrl = new Map();
	for (const d of rpcMethodDemotions(now)) {
		if (!demotionsByUrl.has(d.url)) demotionsByUrl.set(d.url, []);
		demotionsByUrl.get(d.url).push({ method: d.method, remainingMs: d.remainingMs });
	}
	const lanes = solanaRpcEndpoints('mainnet').map((url) => {
		const until = _endpointCooldown.get(url) || 0;
		const cooling = until > now;
		return {
			url: maskUrl(url),
			paid: paid.has(url),
			cooling,
			cooldownRemainingMs: cooling ? until - now : 0,
			// Absolute wall-clock recovery, so an operator reading a parked snapshot
			// (the /status page renders a cron-parked copy, minutes old) gets a time
			// that stays true instead of a countdown that silently over-reports.
			recoversAt: cooling ? until : null,
			blockedMethods: demotionsByUrl.get(url) || [],
		};
	});
	const paidLanes = lanes.filter((l) => l.paid);
	const paidCooling = paidLanes.filter((l) => l.cooling).length;
	return {
		total: lanes.length,
		cooling: lanes.filter((l) => l.cooling).length,
		paidTotal: paidLanes.length,
		paidCooling,
		// Only meaningful when paid lanes are configured at all; a keyless
		// deployment is a valid choice, not a degradation.
		allPaidCooling: paidLanes.length > 0 && paidCooling === paidLanes.length,
		lanes,
	};
}

function maskUrl(url) {
	try {
		const u = new URL(url);
		return `${u.protocol}//${u.host}`;
	} catch {
		return String(url).slice(0, 24);
	}
}

// Render a cooldown for the failover log. Whole minutes read fine for the long
// windows, but rounding sub-minute ones to `1m` overstates them by double, and
// the shortest window (a policy block that keeps the lane in service) is exactly
// the one an operator must not confuse with a real bench. Seconds below a minute.
export function formatCooldown(ms) {
	return ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`;
}

// JSON-RPC error codes that mean "this provider can't serve you right now", a
// capacity/quota/auth/staleness problem the NEXT provider may not share, so we
// fail over instead of surfacing it. Crucially this is how an exhausted paid plan
// answers: HTTP 200 with `{"error":{"code":-32429,"message":"max usage reached"}}`
//: no rotate-worthy HTTP status, so without this it leaks straight to the caller.
// Method/data errors (-32600 invalid request, -32601 method not found, -32602
// invalid params, -32002 tx simulation failed) are deterministic across providers
// and are intentionally excluded: rotating on those would just retry a guaranteed
// failure on every lane.
const PROVIDER_CAPACITY_CODES = new Set([
	-32429, // Helius / common: max usage / quota reached
	-32029, // OnFinality / common: too many requests
	-32052, // Ankr: key not allowed / forbidden
	-32005, // node is behind by N slots: a fresher node may answer
	-32004, // block/slot not available yet: another node may have it
	-32003, // QuickNode: daily/request limit reached (capped), the next lane serves
	429, // Alchemy: monthly capacity exceeded, reported as a JSON-RPC code
]);

// -32603 is the JSON-RPC spec's "Internal error": the node accepted the call and
// then failed on its own side. It is NOT deterministic across providers, which is
// what separates it from the -32600/-32601/-32602 family excluded above, and in
// practice it is per (lane, method): measured 2026-08-12, Leo RPC answers EVERY
// getTokenLargestAccounts with -32603 while serving getAccountInfo and
// getMultipleAccounts normally.
//
// Unclassified it was not a failover signal at all, so the error envelope reached
// the caller as though it were the chain's answer, with lanes that do serve the
// method (both Tatum hosts, keylessly) never tried. That is the whole reason
// /api/crypto/holders answered 503 and /api/crypto/security reported
// riskLevel:"unknown" with "holder concentration could not be read" on live mints
// while Helius and Alchemy sat quota-exhausted. Disposition is a (lane, method)
// demotion, never a lane bench: the lane is healthy for every other shape.
const JSONRPC_INTERNAL_ERROR = -32603;

// A provider that refuses one call shape: by paid-tier gate, by policy, or by
// switching the method off: answers with a method-shaped JSON-RPC error, and the
// dangerous variant answers HTTP 200 so no status-driven rotation fires. Measured
// on the live free lanes 2026-07-30:
//   • PublicNode getProgramAccounts → 200 + {code:-32010, "… excluded from account
//     secondary indexes; this RPC method unavailable for key"}
//   • PublicNode getTokenAccountsByOwner → {code:-32602, "Request blocked.
//     Details: blocked parameter: params.1.programId"}, a -32602 that is NOT
//     invalid params, so the code alone would wrongly read as deterministic
//   • MagicBlock getProgramAccounts → {code:403, "Your IP or provider is blocked
//     from this endpoint"}
//   • Tatum getBalance / getSignaturesForAddress → -16401 "available for paid
//     plans only", a code otherwise indistinguishable from a genuinely absent
//     method (which IS deterministic and must never rotate)
// Every one is lane-and-method specific, so the disposition is: fail this request
// over to the next lane, and demote THIS method on THIS lane, never the lane.
// Unclassified, the 200-status ones surfaced straight to the caller and hard-failed
// the $THREE holder-gating and token-balance readers (api/_lib/balances.js,
// api/_lib/coin/holders.js, api/_lib/embed-gate.js, api/scene/gate-check.js)
// whenever the rotation was sitting on that lane; classified as a LANE fault, they
// benched a healthy free primary on its own routine traffic. isMethodRefusal (the
// single matcher, defined near the cooldown table) decides the class.
function isProviderTierError(rpcError) {
	return isMethodRefusal(String(rpcError?.message || ''));
}

function isProviderCapacityError(rpcError) {
	if (!rpcError || typeof rpcError !== 'object') return false;
	if (PROVIDER_CAPACITY_CODES.has(rpcError.code)) return true;
	if (isProviderTierError(rpcError)) return true;
	return /too many requests|rate.?limit|request limit|capacity limit|capacity exceeded|quota|usage limit|credits?\s*exhausted|forbidden|api key|unauthor|max usage/i.test(
		String(rpcError.message || ''),
	);
}

// Classify a 200-status RPC body. Returns null when it's a usable JSON-RPC
// response web3.js can parse; otherwise a {status, reason, log, bodyText} telling
// the rotating fetch to fail over. This is the guard that turns the recurring
// `StructError: Expected the value to satisfy a union … but received:` into a
// transparent failover: that error is web3.js choking on a 200 body that is NOT a
// well-formed JSON-RPC response (empty, HTML interstitial, truncated JSON, or a
// `{jsonrpc,id}` envelope with neither `result` nor `error`). We detect every one
// of those shapes here: plus provider-capacity JSON-RPC errors, and route past
// the bad node instead of handing the caller something it cannot parse.
export function classifyRpcBody(body) {
	const trimmed = (body || '').trim();
	if (trimmed === '')
		return { status: 502, reason: 'empty body', log: '200 but empty body', bodyText: '' };
	if (trimmed[0] === '<')
		return { status: 502, reason: 'HTML body', log: '200 but HTML body', bodyText: '' };
	let parsed;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return {
			status: 502,
			reason: 'unparseable body',
			log: '200 but unparseable JSON',
			bodyText: '',
		};
	}
	// Single response or a JSON-RPC batch array: every element must be a valid envelope.
	const items = Array.isArray(parsed) ? parsed : [parsed];
	if (items.length === 0) {
		return {
			status: 502,
			reason: 'empty batch',
			log: '200 but empty JSON-RPC batch',
			bodyText: '',
		};
	}
	for (const item of items) {
		if (!item || typeof item !== 'object') {
			return {
				status: 502,
				reason: 'malformed envelope',
				log: '200 but malformed JSON-RPC envelope',
				bodyText: '',
			};
		}
		const hasResult = 'result' in item;
		const hasError = 'error' in item;
		if (!hasResult && !hasError) {
			// Neither field present: the exact shape that produces the empty-`received:`
			// StructError. `result: null` is fine (the key is present); this catches a
			// genuinely truncated/garbage envelope.
			return {
				status: 502,
				reason: 'missing result/error',
				log: '200 but JSON-RPC envelope missing result/error',
				bodyText: '',
			};
		}
		if (hasError && isProviderCapacityError(item.error)) {
			const code = item.error?.code ?? '';
			const msg = String(item.error?.message || '');
			// status 429 → cooldownMsFor scans the message for a quota signal and parks
			// a truly-exhausted plan for hours rather than re-hitting it every call.
			// `methodBlock` splits that: the lane is not out of capacity, it is refusing
			// this one call shape, so the rotating fetch demotes the method and leaves
			// the lane in rotation. Both still fail the request over to the next lane.
			return {
				status: 429,
				reason: `provider error ${code}`.trim(),
				log: `200 + provider error ${code} ${msg.slice(0, 48)}`.trim(),
				bodyText: msg,
				methodBlock: isMethodRefusal(msg),
			};
		}
		// The node's own internal fault on this call shape (see JSONRPC_INTERNAL_ERROR).
		// Fail the request over and demote the shape on this lane so the next caller
		// spends its budget on a lane that answers it.
		if (hasError && item.error?.code === JSONRPC_INTERNAL_ERROR) {
			const msg = String(item.error?.message || '');
			return {
				status: 502,
				reason: 'node internal error',
				log: `200 + node internal error -32603 ${msg.slice(0, 48)}`.trim(),
				bodyText: msg,
				methodBlock: true,
			};
		}
	}
	return null;
}

// Rotate this endpoint out of service on a 401/403 (bad/expired key on this
// provider only), 404/408/410 (the endpoint URL itself is dead, misrouted, or
// timing out: a live JSON-RPC node answers a POST with method-not-found as a
// 200 + JSON-RPC error body, never an HTTP 404, so a 404 means the configured
// URL is wrong, not the request), 429 (rate-limited), or 5xx (provider down) -
// all of which the next provider may not share. Other 4xx are real request
// errors, identical on every provider, so they're returned to the caller as-is.
export function shouldRotate(status) {
	return (
		status === 401 ||
		status === 403 ||
		status === 404 ||
		status === 408 ||
		status === 410 ||
		status === 429 ||
		status >= 500
	);
}

// True when an error is the RPC *infrastructure* failing rather than the caller
// asking for something impossible: a provider rate-limit/quota (429, -32429
// "max usage reached"), a gateway 5xx, a network blip, or the whole lane chain
// running out (`all solana rpc endpoints failed`, thrown by makeRotatingFetch
// above once every endpoint has refused one request).
//
// Callers use this to tell "the chain says no" from "we could not ask". The
// distinction is load-bearing on money surfaces: on 2026-08-07 every Solana
// lane was cooling at once, and the treasury top-up cron turned that into a
// hard 500 while the wallet audit turned it into four fake below-floor
// emergencies. Neither was a code fault, and neither was a funding fact.
//
// `solana rpc provider error` is in the set because rotation does not always
// get to report its own exhaustion. When the chain runs out, the LAST lane's
// raw JSON-RPC error is what reaches the caller, not the tidy "all solana rpc
// endpoints failed" summary: observed in production 2026-08-08, "failed to get
// balance of account Wwwu...: Error: solana rpc provider error -16401 @
// solana-mainnet.gateway.tatum.io", which took treasury-topup down with a 500
// every few ticks. A named provider answering with its own error code is a lane
// fault by construction (isProviderTierError already treats this very code as a
// failover signal), so it is upstream weather, never a caller defect. Matching
// the wrapper rather than any single vendor code keeps this true for the next
// provider that invents one.
//
// `StructError` is in the set for the same reason, one layer up. classifyRpcBody
// above catches the 200 bodies it can recognize as garbage (empty, HTML,
// unparseable, an envelope with neither result nor error), but it deliberately
// accepts envelopes that are valid JSON-RPC yet NOT what web3.js will parse:
// a numeric `id`, a missing `jsonrpc`, or an `error` whose `message` is not a
// string all satisfy classifyRpcBody and then fail web3.js's superstruct check
// (createRpcResult pins `id: string()` and `jsonrpc: literal('2.0')`). Loosening
// classifyRpcBody is not the fix, because the same guard serves the pass-through
// proxy in api/solana-rpc.js, where those envelopes are perfectly good answers.
// So the lane-level throw has to be readable here instead. Production
// 2026-08-13T10:32Z, one treasury-topup tick 500ed on exactly this:
//   [api] unhandled Error: failed to get balance of account Wwwu...WwW:
//     StructError: Expected the value to satisfy a union of `type | type`,
//     but received: [object Object]
// Every superstruct call in web3.js validates something the NODE sent (RPC
// responses, subscription notifications, parsed account data), never a caller
// argument, so a StructError reaching us is always "we could not read the
// answer", which is the same upstream weather as a 429.
export function isTransientRpcError(err) {
	return /\b(429|500|502|503|504)\b|-32429|max usage reached|rate.?limit|quota|exhausted|timed?\s*out|fetch failed|socket hang up|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|all solana rpc endpoints failed|all rpc endpoints exhausted|solana rpc provider error|StructError|Expected the value to satisfy/i.test(
		String(err && err.message ? err.message : err),
	);
}

/**
 * What a THROWN attempt says about the lane, and therefore what to charge it.
 * Three genuinely different events reach the same catch, and collapsing them cost
 * us the free chain's primary lane:
 *
 *   'ignore':        the CALLER's budget expired. Rotation is over either way
 *                    and this attempt learned nothing about the endpoint, so
 *                    charging it would bench a healthy node for the caller's deadline.
 *   'demote-method': the lane accepted the request and never answered within
 *                    the attempt bound. Measured 2026-08-12: PublicNode hangs
 *                    indefinitely on getTokenLargestAccounts (no response at 35s)
 *                    while answering getAccountInfo in milliseconds, which is a
 *                    silent per-shape refusal. Cooling the whole lane for it benched
 *                    the primary free lane for every other method, and that is how
 *                    one unanswerable shape starved /api/crypto/holders and the
 *                    holder half of /api/crypto/security. markMethodDemotion's
 *                    breadth guard still benches a lane that hangs on everything.
 *   'cool-lane':     a genuine transport failure (DNS, refused connection,
 *                    socket hang up), or a hang on a request whose call shapes we
 *                    could not read. Brief cooldown, as before.
 *
 * @param {{ callerAborted: boolean, attemptTimedOut: boolean, hasMethods: boolean }} signals
 * @returns {'ignore'|'demote-method'|'cool-lane'}
 */
export function throwDisposition({ callerAborted, attemptTimedOut, hasMethods }) {
	if (callerAborted) return 'ignore';
	if (attemptTimedOut && hasMethods) return 'demote-method';
	return 'cool-lane';
}

// ---------------------------------------------------------------------------
// Per-lane JSON-RPC batch caps
// ---------------------------------------------------------------------------
// web3.js batches: getTransactions/getParsedTransactions send ONE JSON-RPC array
// carrying N getTransaction calls, and getMultipleAccounts does the same for
// account reads. Some free lanes cap how many calls of a shape they will serve
// per batch and reject the whole array. Measured 2026-08-15 on
// solana-rpc.publicnode.com: HTTP 400 + `{code:-32600,"Maximum number of
// 'getTransaction' calls in a batch request is 1. To increase limits, get a
// personal token here: https://www.allnodes.com/publicnode"}`.
//
// That answer is neither a lane fault nor a method refusal, and misreading it as
// either loses data we can trivially fetch: the node is healthy, the credential
// is fine, and it serves the very same call happily one at a time. A plain 400
// also does not rotate (see shouldRotate: other 4xx are caller errors identical
// on every lane), so left unclassified it surfaced raw and hard-failed the
// caller: which is exactly how the pump.fun MCP `get_token_trades` tool died
// with "400 Bad Request: Maximum number of 'getTransaction' calls in a batch
// request is 1" on every attempt, while every other tool on the same lane worked.
//
// So the disposition is: re-send this batch to the SAME lane as single requests
// and merge the envelopes back into the array the caller expects. The (lane,
// method) pair is remembered for a while so the next batch skips the wasted
// probe and goes straight to unbatched.
const BATCH_LIMIT_REFUSAL =
	/maximum number of .{0,64}(?:calls|requests) in a batch|batch (?:request )?(?:size|limit)[^.]{0,48}(?:exceed|too (?:large|big|many)|is \d+)|too many (?:calls|requests) in (?:a |one )?batch|batch too large/i;

// How many single requests a split is allowed to become. A batch wider than this
// costs more in round-trips than it is worth against a lane that caps at 1, so
// the request rotates to a lane that takes the batch whole instead.
const MAX_BATCH_SPLIT = 64;
// Concurrent single requests during a split. Enough to keep a chunked read fast,
// low enough that splitting one batch never looks like a burst to the lane that
// just told us it wants them one at a time.
const BATCH_SPLIT_CONCURRENCY = 4;
const BATCH_CAP_TTL_MS = 30 * 60_000;

/** @type {Map<string, number>} `${url}\0${method}` → expiry ms */
const _batchCapped = new Map();

/**
 * True when `text` is a provider refusing a batch because of its OWN per-batch
 * limit, rather than because the request is malformed. PURE, so the policy is
 * unit-testable without a node.
 *
 * @param {string} text
 */
export function isBatchLimitRefusal(text) {
	return BATCH_LIMIT_REFUSAL.test(String(text || ''));
}

/**
 * The elements of a JSON-RPC batch body, or null when `body` is not a batch of
 * more than one call. Splitting is only ever worth it for a real batch.
 *
 * @param {unknown} body
 * @returns {object[]|null}
 */
export function batchElements(body) {
	if (typeof body !== 'string') return null;
	if (body.trimStart()[0] !== '[') return null;
	try {
		const parsed = JSON.parse(body);
		if (!Array.isArray(parsed) || parsed.length < 2) return null;
		return parsed.every((el) => el && typeof el === 'object') ? parsed : null;
	} catch {
		return null;
	}
}

/** True when this lane is known to cap batches for every shape in `methods`. */
function isBatchCapped(url, methods) {
	if (!methods.length) return false;
	const now = Date.now();
	return methods.every((m) => {
		const until = _batchCapped.get(methodKey(url, m)) || 0;
		if (until && until <= now) {
			_batchCapped.delete(methodKey(url, m));
			return false;
		}
		return until > now;
	});
}

function markBatchCapped(url, methods) {
	const until = Date.now() + BATCH_CAP_TTL_MS;
	for (const m of methods) _batchCapped.set(methodKey(url, m), until);
}

/** Read-only view of the lanes known to cap batches, for the ops/health surface. */
export function rpcBatchCaps(now = Date.now()) {
	const out = [];
	for (const [key, until] of _batchCapped) {
		if (until <= now) continue;
		const [url, method] = key.split(METHOD_KEY_SEP);
		out.push({ host: maskUrl(url), method, expiresInMs: until - now });
	}
	return out;
}

// Rotating fetch backing a Connection. It NEVER surfaces a rotate-worthy status
// (401/403/429/5xx) to @solana/web3.js: it either returns a healthy response or
// throws: so web3.js's internal 429 backoff loop ("Server responded with 429 …
// Retrying after Nms") never fires. Cooldowns live in the process-wide map, so a
// quota-dead provider is skipped on the very next call (and next cron tick), not
// re-probed every time.
//
// Log severity tracks actionability, not event count. A single provider getting
// parked while the call transparently lands on the next one is the failover doing
// its job: the request still succeeds (HTTP 200), so it logs at INFO. Emitting it
// at WARN flooded Vercel's `level:warning` view with non-actionable failover
// chatter (the source of the recurring "[solana-rpc] … 429, cooling" warnings).
// The genuinely actionable condition: every provider in the chain failing within
// one request, so the caller gets nothing back: is the only WARN.
// Brownout: report each lane attempt against the request that caused it, so a
// response assembled through RPC failover can say which node answered and how
// many refused first. Loaded the same lazy way as the shared cache above, for
// the same reason: this module is in the browser bundle and node:async_hooks is
// not. In a browser both hooks are inert.
let _brownoutMod = null;
let _brownoutPromise;
function brownoutModule() {
	if (_brownoutPromise !== undefined) return _brownoutPromise;
	_brownoutPromise = null;
	if (isServer()) {
		_brownoutPromise = import('../brownout/index.js')
			.then((m) => {
				_brownoutMod = m;
				return m;
			})
			.catch(() => null);
	}
	return _brownoutPromise;
}
brownoutModule();

/** Record one lane attempt. Synchronous once the module is in hand, so a record can never arrive after its own response. */
function noteRpc(url, outcome, ms, tier, detail) {
	if (!_brownoutMod) return;
	_brownoutMod.recordSource?.({ name: `solana-rpc:${maskUrl(url).replace(/^https?:\/\//, '')}`, outcome, ms, tier, detail });
}

/** A fault declared for the Solana RPC lane, or for one specific host in it. */
function rpcFault(url) {
	if (!_brownoutMod) return null;
	return (
		_brownoutMod.faultFor?.('solana-rpc') ??
		_brownoutMod.faultFor?.(`solana-rpc:${maskUrl(url).replace(/^https?:\/\//, '')}`) ??
		null
	);
}

export function makeRotatingFetch(endpoints) {
	return async function rotatingFetch(_info, init) {
		// The call shapes in this request. Empty for an unreadable body, which makes
		// every capability check a no-op rather than guessing.
		const methods = rpcMethodsFromBody(typeof init?.body === 'string' ? init.body : '');

		// Park the lane, or demote just this call shape on it, and log the choice
		// once. A method refusal is NOT a lane fault: the lane keeps serving every
		// other shape and never enters cooldown, so it can never be benched by its
		// own routine traffic. Returns nothing; the caller always rotates.
		const penalise = (url, status, bodyText, methodBlock, log) => {
			if (methodBlock && methods.length) {
				const fresh = methods.filter((m) => !isMethodDemoted(url, m));
				const { ms, benched } = markMethodDemotion(url, methods);
				// Only the first caller to hit the refusal logs it; the rest see the
				// demotion already in place and stay quiet.
				if (fresh.length) {
					console.log(
						benched
							? `[solana-rpc] ${maskUrl(url)} refused ${fresh.join(',')} and ${DEMOTION_BREADTH_BENCH}+ shapes in all, refusing the caller, not the call; cooling ${formatCooldown(ms)}, failing over`
							: `[solana-rpc] ${maskUrl(url)} refused ${fresh.join(',')}, demoting that method for ${formatCooldown(ms)}, failing over`,
					);
				}
				return;
			}
			// Check BEFORE marking: if parallel rotatingFetch calls race onto the same
			// endpoint simultaneously, only the first to resolve logs, all subsequent
			// callers see alreadyCooling=true and skip the line.
			const alreadyCooling = isEndpointCooling(url);
			const ms = markEndpointCooldown(url, status, bodyText);
			if (!alreadyCooling) {
				// INFO, not WARN: the request continues to the next provider and still
				// succeeds. This is the redundancy working, not a fault.
				console.log(`[solana-rpc] ${maskUrl(url)} ${log}, cooling ${formatCooldown(ms)}, failing over`);
			}
		};

		// One fully-validated attempt against a single endpoint. Returns
		// `{ response }` with a usable JSON-RPC body, or `{ error }` after penalising
		// the endpoint so the caller rotates on. It NEVER returns an
		// unvalidated body: a 200 carrying an empty/HTML/truncated payload, a
		// `{jsonrpc,id}` envelope missing `result`, or a 200 + JSON-RPC capacity
		// error is treated as a failure: web3.js would otherwise choke on it with a
		// `StructError`, and the /api/solana-rpc proxy would forward the garbage (an
		// empty `[]`) straight to the browser.
		// The batch this request carries, if it is one. Null for a single call, which
		// makes every batch-cap check below a no-op.
		const batch = batchElements(typeof init?.body === 'string' ? init.body : '');

		// Re-send `batch` to `url` as single JSON-RPC requests and merge the envelopes
		// back into the array the caller is waiting for. Order is preserved (web3.js
		// matches on id, but a caller reading positionally must not be surprised).
		// Throws on the first sub-request that fails validation, so the caller rotates
		// exactly as it would for any other lane failure: never a partial array.
		const sendUnbatched = async (url, signal) => {
			const envelopes = new Array(batch.length);
			let cursor = 0;
			const worker = async () => {
				for (let i = cursor++; i < batch.length; i = cursor++) {
					const resp = await fetch(url, { ...init, signal, body: JSON.stringify(batch[i]) });
					if (!resp.ok) throw new Error(`solana rpc ${resp.status} @ ${maskUrl(url)} (unbatched)`);
					const text = await resp.text();
					const bad = classifyRpcBody(text);
					if (bad) throw new Error(`solana rpc ${bad.reason} @ ${maskUrl(url)} (unbatched)`);
					envelopes[i] = JSON.parse(text);
				}
			};
			await Promise.all(
				Array.from({ length: Math.min(BATCH_SPLIT_CONCURRENCY, batch.length) }, worker),
			);
			return new Response(JSON.stringify(envelopes), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		};

		const tryEndpoint = async (url) => {
			const attemptStartedAt = Date.now();
			// Bound every attempt so one hanging provider can never absorb the whole
			// request budget (undici's default timeouts run to minutes): the attempt
			// aborts, cools briefly, and the rotation moves on. A caller-supplied
			// signal still applies on top via AbortSignal.any. Declared OUTSIDE the
			// try on purpose: the catch reads `attemptSignal.aborted`, and a const
			// inside the try block is not in scope there, so a thrown attempt raised
			// ReferenceError instead of rotating and killed the whole failover chain
			// (the play-gate 502 of 2026-08-13).
			const attemptSignal = AbortSignal.timeout(ATTEMPT_TIMEOUT_MS);
			const signal = init?.signal
				? AbortSignal.any([init.signal, attemptSignal])
				: attemptSignal;
			// A batch splits into at most MAX_BATCH_SPLIT single requests; a wider one
			// is cheaper to rotate than to unroll against a lane that caps at 1.
			const splittable = !!batch && batch.length <= MAX_BATCH_SPLIT;
			try {
				// This lane already told us it caps batches for these shapes, skip the
				// probe request that only re-learns it and go straight to singles.
				if (splittable && isBatchCapped(url, methods)) return { response: await sendUnbatched(url, signal) };

				// A declared fault stands in for the lane failing, inside the same try
				// the real failure would land in, so cooldowns, method demotion and
				// the re-sweep all behave exactly as they would in an outage.
				const fault = rpcFault(url);
				const injected = fault ? await _brownoutMod.applyFault(fault, url) : null;
				const resp = injected || (await fetch(url, { ...init, signal }));
				// A per-batch cap is the lane's own policy, not a caller error and not a
				// lane fault, so it neither rotates nor cools: unroll and re-send here.
				if (splittable && !resp.ok) {
					const bodyText = await resp
						.clone()
						.text()
						.catch(() => '');
					if (isBatchLimitRefusal(bodyText)) {
						markBatchCapped(url, methods);
						console.log(
							`[solana-rpc] ${maskUrl(url)} caps batches for ${methods.join(',') || 'this shape'}, re-sending ${batch.length} calls unbatched`,
						);
						return { response: await sendUnbatched(url, signal) };
					}
				}
				if (shouldRotate(resp.status)) {
					// Read the body only on the failure path (we never return it) so a
					// quota signal can pick the long cooldown, and so a 401/403 can be told
					// apart from a policy refusal. Reading it on 403 is load-bearing, not a
					// nicety: PublicNode answers a programId-filtered getTokenAccountsByOwner
					// with 403 + `blocked parameter`, and with the body unread that refusal
					// classified as a bad key and benched a healthy free primary for 30
					// minutes on its own routine traffic.
					const bodyText =
						resp.status === 429 || resp.status === 403 || resp.status === 401
							? await resp
									.clone()
									.text()
									.catch(() => '')
							: '';
					penalise(url, resp.status, bodyText, isMethodRefusal(bodyText), String(resp.status));
					noteRpc(url, 'fail', Date.now() - attemptStartedAt, 'live', resp.status);
					return { error: new Error(`solana rpc ${resp.status} @ ${maskUrl(url)}`) };
				}
				const okBody = await resp.text();
				// Same cap, stated politely: some nodes answer a too-wide batch with a
				// 200 carrying one error envelope instead of an HTTP 400.
				if (splittable && isBatchLimitRefusal(okBody)) {
					markBatchCapped(url, methods);
					console.log(
						`[solana-rpc] ${maskUrl(url)} caps batches for ${methods.join(',') || 'this shape'}, re-sending ${batch.length} calls unbatched`,
					);
					return { response: await sendUnbatched(url, signal) };
				}
				const bad = classifyRpcBody(okBody);
				if (bad) {
					penalise(url, bad.status, bad.bodyText || '', bad.methodBlock === true, bad.log);
					return { error: new Error(`solana rpc ${bad.reason} @ ${maskUrl(url)}`) };
				}
				// Body already consumed above; hand the caller a fresh Response carrying
				// the same payload. Only content-type is preserved; copying
				// content-encoding/content-length would mislead the consumer since the
				// transport already decoded the body into `okBody`.
				noteRpc(url, 'ok', Date.now() - attemptStartedAt, 'live');
				return {
					response: new Response(okBody, {
						status: resp.status,
						statusText: resp.statusText,
						headers: {
							'content-type': resp.headers.get('content-type') || 'application/json',
						},
					}),
					okBody,
				};
			} catch (err) {
				const disposition = throwDisposition({
					callerAborted: init?.signal?.aborted === true,
					attemptTimedOut: attemptSignal.aborted,
					hasMethods: methods.length > 0,
				});
				if (disposition === 'demote-method') {
					penalise(url, 504, '', true, `no answer within ${Math.round(ATTEMPT_TIMEOUT_MS / 1000)}s`);
				} else if (disposition === 'cool-lane') {
					_endpointCooldown.set(url, Date.now() + NETWORK_COOLDOWN_MS);
				}
				// A transport failure is re-thrown with its errno and the lane on the
				// message, so the exhausted-chain warning names the real fault
				// (EAI_AGAIN is a resolver problem, ECONNRESET a socket one) instead of
				// undici's bare "fetch failed". The original stays on `cause`.
				noteRpc(url, 'fail', Date.now() - attemptStartedAt, 'live', err?.name === 'TimeoutError' ? 'timeout' : 'network');
				const cause = disposition === 'cool-lane' ? transportCause(err) : '';
				if (cause) {
					const tagged = new Error(`${err?.message || 'fetch failed'} (${cause}) @ ${maskUrl(url)}`, { cause: err });
					return { error: tagged, transport: true };
				}
				return { error: err };
			}
		};

		// Inherit the fleet's verdict before choosing an endpoint, so a cold
		// instance's very first call already skips a quota-dead provider instead of
		// re-burning it. Awaited only on the first call of this instance; later
		// refreshes run in the background (see hydrateEndpointCooldowns).
		if (_cooldownHydratedAt === 0) await hydrateEndpointCooldowns();
		else hydrateEndpointCooldowns();

		let lastErr = null;
		// The last-good key for this call (null for a batch, a write, or a read not
		// on the list), and whether every failed attempt so far was a transport
		// error. Both feed the two whole-chain fallbacks after the passes.
		const staleKey = lastGoodKey(typeof init?.body === 'string' ? init.body : '');
		let transportOnly = true;
		const succeed = (out) => {
			if (out.okBody !== undefined) publishLastGood(staleKey, out.okBody);
			return out.response;
		};
		// Passes widen the candidate set only when the narrower one had nothing to
		// try. Pass 1 skips both lane cooldowns and lanes demoted for this call shape.
		// Pass 2 forgives cooldowns so a just-recovered node still gets exercised but
		// still respects capability, because a lane that refuses this shape will
		// refuse it again. Pass 3 forgives everything, so a request whose method every
		// lane has refused at some point still gets one honest attempt instead of
		// failing on stale bookkeeping. Every pass routes through tryEndpoint(), so
		// the widened cases validate like any other and can never fall back to a raw,
		// unvalidated passthrough, the bug that leaked an empty `[]` body straight to
		// the browser and broke web3.js reads.
		const PASSES = [
			{ ignoreCooldown: false, ignoreCapability: false },
			{ ignoreCooldown: true, ignoreCapability: false },
			{ ignoreCooldown: true, ignoreCapability: true },
		];
		for (const pass of PASSES) {
			let attempted = false;
			for (const url of endpoints) {
				if (!pass.ignoreCooldown && isEndpointCooling(url)) continue;
				if (!pass.ignoreCapability && isAnyMethodDemoted(url, methods)) continue;
				attempted = true;
				const out = await tryEndpoint(url);
				if (out.response) return succeed(out);
				lastErr = out.error;
				if (!out.transport) transportOnly = false;
			}
			// This pass actually exercised at least one candidate and they all failed
			// this request: the chain is genuinely down for it right now, so don't
			// force a wider sweep that would just re-hammer known-bad lanes.
			if (attempted) break;
		}
		// Every lane died at the transport layer inside one request. That is not
		// ten providers failing, it is this instance's egress hiccuping, and it is
		// usually over before the caller's own timeout: one jittered re-sweep of
		// every lane (the cooldowns just set were set by THIS request, so they are
		// ignored) turns most of those into a normal answer. Never for a caller
		// that has already walked away.
		if (transportOnly && lastErr && init?.signal?.aborted !== true) {
			await sleep(RESWEEP_DELAY_MIN_MS + Math.random() * (RESWEEP_DELAY_MAX_MS - RESWEEP_DELAY_MIN_MS));
			for (const url of endpoints) {
				if (init?.signal?.aborted === true) break;
				if (isAnyMethodDemoted(url, methods)) continue;
				const out = await tryEndpoint(url);
				if (out.response) return succeed(out);
				lastErr = out.error;
			}
		}
		// Still nothing. A read that a lane answered recently is served from that
		// answer, stale-marked, rather than as a 502: the page keeps its data and
		// the caller can say "as of N minutes ago". Writes and blockhash reads fall
		// through to the error, because a stale answer to those is worse than none.
		const stale = await serveLastGood(staleKey, init?.body);
		if (stale) {
			noteRpc('last-good', 'ok', Number(stale.headers.get('x-solana-rpc-stale')) || 0, 'stale', 'stale');
			logStaleServe(methods[0] || 'read', Number(stale.headers.get('x-solana-rpc-stale')) || 0, lastErr?.message || 'unknown error');
			return stale;
		}
		// Reached the end with every provider failing in this one request, the caller
		// gets a thrown error (→ a clean 502 from the proxy), never garbage. THIS is
		// worth a warning: the whole failover chain is down, not just one lane.
		console.warn(
			`[solana-rpc] all ${endpoints.length} endpoints failed this request, ${lastErr?.message || 'unknown error'}`,
		);
		throw lastErr || new Error('all solana rpc endpoints failed');
	};
}

/**
 * Drop-in replacement for `new Connection(url, commitment)` that adds transparent
 * RPC failover. Pass the url the call site already resolved as `url`; it stays
 * the highest-priority endpoint and the keyed/public fallbacks are appended.
 */
export function solanaConnection({ url = null, commitment = 'confirmed', network = null } = {}) {
	const net = network || inferNetwork(url);
	const endpoints = solanaRpcEndpoints(net, url);
	const primary = endpoints[0] || (net === 'devnet' ? PUBLIC_DEVNET : PUBLIC_MAINNET);
	return new Connection(primary, {
		commitment,
		wsEndpoint: resolveWsEndpoint(primary, net),
		// Never let web3.js run its own 429 backoff loop: with >1 endpoint the
		// rotating fetch already hides 429s, and with a single endpoint we want to
		// fail fast to the caller rather than spend seconds retrying a dead lane.
		disableRetryOnRateLimit: true,
		...(endpoints.length > 1 ? { fetch: makeRotatingFetch(endpoints) } : {}),
	});
}
