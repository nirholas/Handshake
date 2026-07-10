// Canonical Solana RPC endpoint resolution + a drop-in Connection with transparent
// multi-endpoint failover.
//
// `solanaConnection({ url, commitment })` returns a normal @solana/web3.js
// Connection whose underlying fetch rotates across a priority-ordered endpoint
// list. Every method on it (getBalance, getLatestBlockhash, sendRawTransaction,
// confirmTransaction, …) transparently fails over when an endpoint returns
// 429/5xx/auth errors or the network blips — no call-site change beyond swapping
// the constructor. Re-sending an already-signed transaction to a second RPC is
// safe: Solana dedupes by signature.
//
// Priority (per network): the caller's explicit url (if any) → Helius → Alchemy
// → dRPC (authenticated) → Ankr (authenticated only) → operator-supplied
// SOLANA_RPC_FALLBACK_URLS → PublicNode → Leo RPC (keyless FREE tier) → Tatum →
// therpc → the official mainnet-beta endpoint, always last. We never depend on the
// public endpoint alone — it is the most aggressively rate-limited (the source of
// the `getBalance 429` log noise) — and we never include a keyless Ankr URL, which
// Ankr now answers with a hard 403. The keyless tail (PublicNode + Leo RPC + Tatum
// + therpc + mainnet-beta) is what keeps checkout serving when a paid plan lapses:
// all five were verified serving live getLatestBlockhash/getAccountInfo on Solana
// mainnet, so even with every API key dead the chain still resolves a working node
// instead of erroring out.
//
// To survive a single provider's quota running dry (e.g. a paid Helius plan
// exhausting its monthly requests), register free-tier keys at several providers
// and list their URLs in SOLANA_RPC_FALLBACK_URLS — every connection rotates
// across the whole set, so the platform keeps serving even mid-outage.

import { Connection } from '@solana/web3.js';

function deriveWsUrl(httpUrl) {
	return String(httpUrl).replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
}

// True only for a value @solana/web3.js's `new Connection` will accept — a parseable
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
//   • surrounding quotes — a dashboard paste artifact (`SOLANA_RPC_URL="https://…"`)
//   • a websocket URL (ws/wss) — a valid URL but not an HTTP JSON-RPC endpoint; the
//     RPC host serves both on the same origin, so we map it to its http(s) form
//   • a scheme-less host (`mainnet.helius-rpc.com/?api-key=…`) — assume https
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
	// level repairs (not URL.toString()) so a clean input round-trips byte-for-byte —
	// no trailing-slash churn versus the hardcoded endpoint constants, which would
	// otherwise defeat dedupe and list the same node twice.
	let candidate = v;
	if (/^wss:\/\//i.test(candidate)) candidate = candidate.replace(/^wss:/i, 'https:');
	else if (/^ws:\/\//i.test(candidate)) candidate = candidate.replace(/^ws:/i, 'http:');
	else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
		// Scheme-less: assume https only for a host-shaped value (has a dot, or
		// localhost[:port]). A bare token like "helius" is a typo, not a host — drop
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
	const fixedHost = u.hostname.replace(/^api-(mainnet|devnet)\.helius-rpc\.com$/i, '$1.helius-rpc.com');
	if (fixedHost !== u.hostname) {
		return candidate.replace(/^([a-z][a-z0-9+.-]*:\/\/)([^/?#]+)/i, (_m, scheme, authority) =>
			scheme + authority.replace(u.hostname, fixedHost),
		);
	}
	return candidate;
}

// Cooldown durations by failure class. Quota exhaustion (e.g. Helius -32429
// "max usage reached") means the provider is dead for the billing window, so we
// park it for hours instead of re-hammering it on every RPC call and every cron
// tick — that re-hammering was the source of the 429 retry storm in the logs.
// Plain rate-limits, auth rejections, and transient 5xx/network blips cool down
// for shorter, proportionate windows.
const QUOTA_COOLDOWN_MS = 6 * 3_600_000; // 6h — daily/monthly quota exhausted
const RATE_LIMIT_COOLDOWN_MS = 10 * 60_000; // 10m — transient 429
const AUTH_COOLDOWN_MS = 30 * 60_000; // 30m — bad/expired key on this provider only
const SERVER_COOLDOWN_MS = 2 * 60_000; // 2m — provider 5xx
const NETWORK_COOLDOWN_MS = 30_000; // 30s — fetch threw (DNS/connection blip)
const PUBLIC_MAINNET = 'https://api.mainnet-beta.solana.com';
const PUBLIC_DEVNET = 'https://api.devnet.solana.com';

// Process-wide endpoint cooldown, keyed by full URL. Shared across every
// Connection built in this lambda instance — both solanaConnection() and
// RpcFallback — so once one provider reports quota-exhausted, ALL callers skip
// it until it recovers. Per-instance state is correct on Vercel: it self-heals
// on cooldown expiry and a cold start simply re-probes.
const _endpointCooldown = new Map();

function cooldownMsFor(status, bodyText) {
	if (status === 429) {
		return /max usage reached|-32429|quota|usage limit|credits?\s*exhausted/i.test(bodyText || '')
			? QUOTA_COOLDOWN_MS
			: RATE_LIMIT_COOLDOWN_MS;
	}
	if (status === 401 || status === 403) return AUTH_COOLDOWN_MS;
	// 404/410: the endpoint URL is dead or misrouted (expired QuickNode/Alchemy
	// app, wrong path) — a persistent misconfiguration, so park it like an auth
	// failure rather than re-probing every few minutes.
	if (status === 404 || status === 410) return AUTH_COOLDOWN_MS;
	if (status >= 500) return SERVER_COOLDOWN_MS;
	return RATE_LIMIT_COOLDOWN_MS;
}

/** True when `url` is currently parked in cooldown and should be skipped. */
export function isEndpointCooling(url) {
	return (_endpointCooldown.get(url) || 0) > Date.now();
}

/**
 * Park `url` in cooldown for a window sized to the failure class. Returns the
 * chosen cooldown in ms so callers can log it. `bodyText` (a 429 body or error
 * message) is scanned for a quota signal to pick the long window.
 */
export function markEndpointCooldown(url, status, bodyText) {
	const ms = cooldownMsFor(status, bodyText);
	_endpointCooldown.set(url, Date.now() + ms);
	return ms;
}

function dedupe(list) {
	const seen = new Set();
	return list.filter((u) => u && typeof u === 'string' && !seen.has(u) && seen.add(u));
}

// devnet is inferred from the caller's url so we never append a mainnet fallback
// to a devnet primary (or vice-versa) — crossing clusters would return wrong data.
function inferNetwork(url) {
	return /devnet/i.test(String(url || '')) ? 'devnet' : 'mainnet';
}

// Operator-supplied extra fallback URLs (comma-separated SOLANA_RPC_FALLBACK_URLS).
// This is the zero-deploy lever for "spread load across as many free tiers as
// possible": sign up for free-tier keys at several providers (Alchemy, dRPC,
// QuickNode, Chainstack, Triton…), drop their URLs here, and EVERY Solana
// connection rotates across them — so no single free quota becomes the bottleneck
// and a provider running dry transparently fails over to the next.
function extraFallbackUrls() {
	return (process.env.SOLANA_RPC_FALLBACK_URLS || '')
		.split(',')
		.map((s) => normalizeRpcUrl(s))
		.filter(Boolean);
}

/**
 * Priority-ordered endpoint list for a network. An explicit `url` (the value a
 * call site already resolved) is pinned first; keyed providers, then any
 * operator-supplied SOLANA_RPC_FALLBACK_URLS, then the keyless public endpoints
 * follow as fallbacks. The most-throttled public endpoint is always last.
 */
export function solanaRpcEndpoints(network = 'mainnet', url = null) {
	const key = process.env.HELIUS_API_KEY;
	const alch = process.env.ALCHEMY_API_KEY;
	const ankr = process.env.ANKR_API_KEY;
	// dRPC — free tier requires a key (keyless now returns "chain is not available
	// on freetier"). Added in its authenticated form only when DRPC_API_KEY is set.
	const drpc = process.env.DRPC_API_KEY;
	if (network === 'devnet') {
		// .filter(isHttpUrl) is the hard guarantee: only a value `new Connection`
		// accepts survives, so a malformed env entry can never reach the constructor.
		return dedupe([
			normalizeRpcUrl(url),
			normalizeRpcUrl(process.env.SOLANA_RPC_URL_DEVNET),
			key && `https://devnet.helius-rpc.com/?api-key=${key}`,
			alch && `https://solana-devnet.g.alchemy.com/v2/${alch}`,
			drpc && `https://lb.drpc.org/ogrpc?network=solana-devnet&dkey=${drpc}`,
			PUBLIC_DEVNET,
		]).filter(isHttpUrl);
	}
	return dedupe([
		normalizeRpcUrl(url),
		normalizeRpcUrl(process.env.SOLANA_RPC_URL),
		key && `https://mainnet.helius-rpc.com/?api-key=${key}`,
		alch && `https://solana-mainnet.g.alchemy.com/v2/${alch}`,
		drpc && `https://lb.drpc.org/ogrpc?network=solana&dkey=${drpc}`,
		// Ankr sunset keyless access — every keyless rpc.ankr.com/<chain> now 403s
		// ("authenticate with an API key"), so include it only in its authenticated
		// form when ANKR_API_KEY is set. Mirrors idxRpcUrls() in api/cron/[name].js;
		// a keyless entry here was a guaranteed 403 + cooldown log every cron tick.
		ankr && `https://rpc.ankr.com/solana/${ankr}`,
		// Operator's own free-tier fallbacks (mainnet only — devnet URLs would cross
		// clusters and return wrong data). Tried before the public nodes so the
		// configured providers absorb load first.
		...extraFallbackUrls(),
		// PublicNode — a keyless, un-throttled fallback (the same node mcp-server
		// uses) so failover lands on a working endpoint instead of depending on the
		// aggressively rate-limited public mainnet-beta endpoint alone.
		'https://solana-rpc.publicnode.com',
		// Leo RPC keyless FREE tier — a second un-throttled keyless lane so the
		// chain still has depth when every paid key is exhausted (e.g. a Helius plan
		// lapsing mid-billing-cycle). Verified serving getAccountInfo on mainnet.
		'https://solana.leorpc.com/?api_key=FREE',
		// Tatum + therpc — two more keyless public lanes. PublicNode, Leo RPC and
		// Tatum were each verified serving getAccountInfo (the method whose malformed
		// response 500'd checkout); therpc was verified on getLatestBlockhash but is
		// flaky on getAccountInfo (intermittently returns an empty body), so it sits
		// last before mainnet-beta and leans on the classifyRpcBody guard to fail over
		// when it returns garbage — it adds redundancy for the methods it serves
		// without ever handing web3.js something it can't parse. With mainnet-beta this
		// is five keyless fallbacks: a request only errors if all five are down at
		// once. The free public-RPC pool has thinned (most providers now 401/403/429
		// keyless), so this set is curated to ones that actually respond — re-verify
		// any that start cooling persistently in the failover logs.
		'https://api.tatum.io/v3/blockchain/node/solana-mainnet',
		// MagicBlock + Tatum's gateway host — two more keyless lanes verified live
		// (getLatestBlockhash + sendTransaction enabled) on 2026-07-04 when the free
		// pool was re-probed after a Helius plan lapsed mid-cycle. They deepen the
		// keyless chain precisely for the "every paid key is exhausted" case; the
		// classifyRpcBody guard still fails them over if either returns garbage.
		'https://rpc.magicblock.app/mainnet',
		'https://solana-mainnet.gateway.tatum.io',
		'https://solana.therpc.io',
		PUBLIC_MAINNET,
		// .filter(isHttpUrl) is the hard guarantee: only a value `new Connection`
		// accepts survives, so a malformed env entry can never reach the constructor.
	]).filter(isHttpUrl);
}

function maskUrl(url) {
	try {
		const u = new URL(url);
		return `${u.protocol}//${u.host}`;
	} catch {
		return String(url).slice(0, 24);
	}
}

// JSON-RPC error codes that mean "this provider can't serve you right now" — a
// capacity/quota/auth/staleness problem the NEXT provider may not share, so we
// fail over instead of surfacing it. Crucially this is how an exhausted paid plan
// answers: HTTP 200 with `{"error":{"code":-32429,"message":"max usage reached"}}`
// — no rotate-worthy HTTP status, so without this it leaks straight to the caller.
// Method/data errors (-32600 invalid request, -32601 method not found, -32602
// invalid params, -32002 tx simulation failed) are deterministic across providers
// and are intentionally excluded — rotating on those would just retry a guaranteed
// failure on every lane.
const PROVIDER_CAPACITY_CODES = new Set([
	-32429, // Helius / common: max usage / quota reached
	-32029, // OnFinality / common: too many requests
	-32052, // Ankr: key not allowed / forbidden
	-32005, // node is behind by N slots — a fresher node may answer
	-32004, // block/slot not available yet — another node may have it
]);

// A provider that gates a method behind its paid/registered tier answers with a
// method-shaped JSON-RPC error (Tatum returns -32601-class codes for
// `getBalance` / `getSignaturesForAddress` on the keyless lane). The code alone
// is indistinguishable from a genuinely absent method — which is deterministic
// and must NOT rotate — so this matches the plan-gate phrasing instead. Unlike a
// missing method, a tier gate is provider-specific: the next lane serves the call
// normally, so failing over is the correct disposition. Left unclassified these
// surfaced straight to the caller and blinded every getSignaturesForAddress
// consumer (the ring leak scanner) and every getBalance consumer the moment the
// rotation cascaded past the keyed lanes onto Tatum.
function isProviderTierError(rpcError) {
	return /not available for anonymous access|available for paid plans only|upgrade your subscription|please register at/i.test(
		String(rpcError?.message || ''),
	);
}

function isProviderCapacityError(rpcError) {
	if (!rpcError || typeof rpcError !== 'object') return false;
	if (PROVIDER_CAPACITY_CODES.has(rpcError.code)) return true;
	if (isProviderTierError(rpcError)) return true;
	return /too many requests|rate.?limit|quota|usage limit|credits?\s*exhausted|forbidden|api key|unauthor|max usage/i.test(
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
// of those shapes here — plus provider-capacity JSON-RPC errors — and route past
// the bad node instead of handing the caller something it cannot parse.
export function classifyRpcBody(body) {
	const trimmed = (body || '').trim();
	if (trimmed === '') return { status: 502, reason: 'empty body', log: '200 but empty body', bodyText: '' };
	if (trimmed[0] === '<') return { status: 502, reason: 'HTML body', log: '200 but HTML body', bodyText: '' };
	let parsed;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return { status: 502, reason: 'unparseable body', log: '200 but unparseable JSON', bodyText: '' };
	}
	// Single response or a JSON-RPC batch array — every element must be a valid envelope.
	const items = Array.isArray(parsed) ? parsed : [parsed];
	if (items.length === 0) {
		return { status: 502, reason: 'empty batch', log: '200 but empty JSON-RPC batch', bodyText: '' };
	}
	for (const item of items) {
		if (!item || typeof item !== 'object') {
			return { status: 502, reason: 'malformed envelope', log: '200 but malformed JSON-RPC envelope', bodyText: '' };
		}
		const hasResult = 'result' in item;
		const hasError = 'error' in item;
		if (!hasResult && !hasError) {
			// Neither field present — the exact shape that produces the empty-`received:`
			// StructError. `result: null` is fine (the key is present); this catches a
			// genuinely truncated/garbage envelope.
			return { status: 502, reason: 'missing result/error', log: '200 but JSON-RPC envelope missing result/error', bodyText: '' };
		}
		if (hasError && isProviderCapacityError(item.error)) {
			const code = item.error?.code ?? '';
			const msg = String(item.error?.message || '');
			// status 429 → cooldownMsFor scans the message for a quota signal and parks
			// a truly-exhausted plan for hours rather than re-hitting it every call.
			return { status: 429, reason: `provider error ${code}`.trim(), log: `200 + provider error ${code} ${msg.slice(0, 48)}`.trim(), bodyText: msg };
		}
	}
	return null;
}

// Rotate this endpoint out of service on a 401/403 (bad/expired key on this
// provider only), 404/408/410 (the endpoint URL itself is dead, misrouted, or
// timing out — a live JSON-RPC node answers a POST with method-not-found as a
// 200 + JSON-RPC error body, never an HTTP 404, so a 404 means the configured
// URL is wrong, not the request), 429 (rate-limited), or 5xx (provider down) —
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

// Rotating fetch backing a Connection. It NEVER surfaces a rotate-worthy status
// (401/403/429/5xx) to @solana/web3.js — it either returns a healthy response or
// throws — so web3.js's internal 429 backoff loop ("Server responded with 429 …
// Retrying after Nms") never fires. Cooldowns live in the process-wide map, so a
// quota-dead provider is skipped on the very next call (and next cron tick), not
// re-probed every time.
//
// Log severity tracks actionability, not event count. A single provider getting
// parked while the call transparently lands on the next one is the failover doing
// its job — the request still succeeds (HTTP 200), so it logs at INFO. Emitting it
// at WARN flooded Vercel's `level:warning` view with non-actionable failover
// chatter (the source of the recurring "[solana-rpc] … 429 — cooling" warnings).
// The genuinely actionable condition — every provider in the chain failing within
// one request, so the caller gets nothing back — is the only WARN.
export function makeRotatingFetch(endpoints) {
	return async function rotatingFetch(_info, init) {
		// One fully-validated attempt against a single endpoint. Returns
		// `{ response }` with a usable JSON-RPC body, or `{ error }` after parking
		// the endpoint in cooldown so the caller rotates on. It NEVER returns an
		// unvalidated body: a 200 carrying an empty/HTML/truncated payload, a
		// `{jsonrpc,id}` envelope missing `result`, or a 200 + JSON-RPC capacity
		// error is treated as a failure — web3.js would otherwise choke on it with a
		// `StructError`, and the /api/solana-rpc proxy would forward the garbage (an
		// empty `[]`) straight to the browser.
		const tryEndpoint = async (url) => {
			try {
				const resp = await fetch(url, init);
				if (shouldRotate(resp.status)) {
					// Read the body only on the failure path (we never return it) so a
					// quota signal can pick the long cooldown.
					const bodyText = resp.status === 429 ? await resp.clone().text().catch(() => '') : '';
					// Check BEFORE marking: if parallel rotatingFetch calls race onto
					// the same endpoint simultaneously, only the first to resolve logs —
					// all subsequent callers see alreadyCooling=true and skip the line.
					const alreadyCooling = isEndpointCooling(url);
					const ms = markEndpointCooldown(url, resp.status, bodyText);
					if (!alreadyCooling) {
						// INFO, not WARN: the request continues to the next provider and
						// still succeeds. This is the redundancy working, not a fault.
						console.log(
							`[solana-rpc] ${maskUrl(url)} ${resp.status} — cooling ${Math.round(ms / 60_000)}m, failing over`,
						);
					}
					return { error: new Error(`solana rpc ${resp.status} @ ${maskUrl(url)}`) };
				}
				const okBody = await resp.text();
				const bad = classifyRpcBody(okBody);
				if (bad) {
					const alreadyCooling = isEndpointCooling(url);
					const ms = markEndpointCooldown(url, bad.status, bad.bodyText || '');
					if (!alreadyCooling) {
						console.log(
							`[solana-rpc] ${maskUrl(url)} ${bad.log} — cooling ${Math.round(ms / 60_000)}m, failing over`,
						);
					}
					return { error: new Error(`solana rpc ${bad.reason} @ ${maskUrl(url)}`) };
				}
				// Body already consumed above; hand the caller a fresh Response carrying
				// the same payload. Only content-type is preserved; copying
				// content-encoding/content-length would mislead the consumer since the
				// transport already decoded the body into `okBody`.
				return {
					response: new Response(okBody, {
						status: resp.status,
						statusText: resp.statusText,
						headers: { 'content-type': resp.headers.get('content-type') || 'application/json' },
					}),
				};
			} catch (err) {
				// A thrown fetch is a transient network/DNS blip, not a quota signal —
				// cool only briefly so a healthy provider isn't parked for long.
				_endpointCooldown.set(url, Date.now() + NETWORK_COOLDOWN_MS);
				return { error: err };
			}
		};

		let lastErr = null;
		// Pass 1 skips endpoints currently in cooldown. Pass 2 runs ONLY when pass 1
		// tried nothing (every endpoint was already cooling) — it ignores cooldowns so
		// a just-recovered node still gets exercised. Crucially both passes route
		// through tryEndpoint(), so the all-cooling case validates like any other and
		// can never fall back to a raw, unvalidated passthrough — the bug that leaked
		// an empty `[]` body straight to the browser and broke web3.js reads.
		for (const ignoreCooldown of [false, true]) {
			let attempted = false;
			for (const url of endpoints) {
				if (!ignoreCooldown && isEndpointCooling(url)) continue;
				attempted = true;
				const out = await tryEndpoint(url);
				if (out.response) return out.response;
				lastErr = out.error;
			}
			// Pass 1 actually exercised at least one live endpoint and they all failed
			// this request — the chain is genuinely down right now, so don't force a
			// second cooldown-ignoring sweep that would just re-hammer dead lanes.
			if (!ignoreCooldown && attempted) break;
		}
		// Reached the end with every provider failing in this one request — the caller
		// gets a thrown error (→ a clean 502 from the proxy), never garbage. THIS is
		// worth a warning: the whole failover chain is down, not just one lane.
		console.warn(
			`[solana-rpc] all ${endpoints.length} endpoints failed this request — ${lastErr?.message || 'unknown error'}`,
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
		wsEndpoint: deriveWsUrl(primary),
		// Never let web3.js run its own 429 backoff loop: with >1 endpoint the
		// rotating fetch already hides 429s, and with a single endpoint we want to
		// fail fast to the caller rather than spend seconds retrying a dead lane.
		disableRetryOnRateLimit: true,
		...(endpoints.length > 1 ? { fetch: makeRotatingFetch(endpoints) } : {}),
	});
}
