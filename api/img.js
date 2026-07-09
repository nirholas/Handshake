// Same-origin image proxy with IPFS multi-gateway fallback.
//
// Token art on /pump-visualizer (and any 3D surface that textures remote
// images) is loaded by Three.js with `crossOrigin = 'anonymous'`. The public
// IPFS gateways and metadata hosts these images live on (ipfs.io, arweave,
// per-launch CDNs) frequently answer browser requests with no
// `Access-Control-Allow-Origin` header, or get blocked by the browser's Opaque
// Response Blocking (ORB) — so the texture fails and the console fills with CORS
// / ERR_BLOCKED_BY_ORB errors, one per token.
//
// Routing the image through this same-origin endpoint removes the cross-origin
// problem entirely: the browser only ever talks to three.ws. Server-side we:
//   1. Fetch the upstream image through the SSRF-hardened fetcher (scheme
//      allowlist, our-side DNS + private-IP blocklist, connection pinning,
//      per-redirect re-validation, byte cap, timeout) — see api/_lib/ssrf.js.
//   2. If the source is an IPFS URL that fails, retry across alternate public
//      gateways so one slow gateway never blanks the art.
//   3. On total failure, serve a deterministic, on-brand SVG placeholder inline
//      (200, permissive CORS) so the loader ALWAYS receives a valid image and
//      never logs an error. The placeholder is generated here — same-origin, no
//      external dependency that could itself be down — and is unique per seed:
//      an abstract gradient "gem" that reads as token art rather than a generic
//      "broken image" tile.
//
// Responses are immutable and CDN-cached: a given upstream URL yields the same
// bytes forever, so we cache hard at the edge and the proxy is hit once per art.

import { wrap, cors, method, error, rateLimited } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { fetchModel } from './_lib/fetch-model.js';
import { safeFetchJson } from './_lib/ssrf.js';

const MAX_BYTES = 8 * 1024 * 1024; // 8 MB — generous for token art, bounded for abuse
// Per-gateway attempt cap. Each candidate fetch (DNS + connect + body) is bounded
// by this via the SSRF fetcher's own AbortController. Because the candidates are
// raced CONCURRENTLY (below), the whole resolution finishes in roughly one
// attempt's time — not the sum — so one stalled gateway never stacks toward the
// function's 30s kill, which is what produced the mass-504 storm.
const TIMEOUT_MS = 9_000;
// Token launch metadata (pump.fun et al.) is a small JSON doc whose `image`
// field is the real art. Resolving it server-side lets the browser load token
// images same-origin without the per-host CORS failures that a client-side
// `fetch(metadataUri)` hits. Kept short — the JSON is tiny.
const META_TIMEOUT_MS = 5_000;
// Overall budget for ALL upstream work combined — metadata resolution AND every
// gateway attempt. The function's Vercel maxDuration is 30s; trying 4 IPFS
// gateways at 10s each can reach 40s, and a slow metadata fetch (5s) layered on
// top of a 24s gateway budget reaches 29s + teardown and gets the invocation
// killed BEFORE the placeholder redirect below ever runs — defeating the
// "always hand back a valid 200" contract. A single deadline anchored at handler
// start, capped well under 30s, keeps meta + gateways + the placeholder response
// inside the hard kill no matter how the time is split between the two phases.
const TOTAL_BUDGET_MS = 25_000;
// Headroom reserved below the deadline so there is always time to compose and
// flush the placeholder SVG (or the real image) after the last upstream attempt.
const RESPONSE_HEADROOM_MS = 1_000;

// Public IPFS gateways. ipfs.io is the canonical resolver the rest of the platform
// pins to (api/_lib/onchain.js) but is also the one most likely to ORB-block or
// stall, so we fan out across healthy mirrors and race them — the first to return a
// valid image wins. cloudflare-ipfs.com is intentionally absent: Cloudflare sunset
// its public IPFS gateway, so every request to it is a guaranteed failure that only
// wastes a connection.
const IPFS_GATEWAYS = [
	'https://ipfs.io/ipfs/',
	'https://dweb.link/ipfs/',
	'https://gateway.pinata.cloud/ipfs/',
	'https://w3s.link/ipfs/',
	'https://4everland.io/ipfs/',
];

// Pull the `<cid>/<path?>` portion out of any recognised IPFS URL form so we can
// re-point it at a different gateway. Returns null for non-IPFS URLs.
function ipfsPath(rawUrl) {
	if (rawUrl.startsWith('ipfs://')) return rawUrl.slice('ipfs://'.length).replace(/^ipfs\//, '');
	const m = rawUrl.match(/\/ipfs\/(.+)$/);
	return m ? m[1] : null;
}

// Build the ordered list of candidate URLs to try for one logical image.
function candidates(rawUrl) {
	const path = ipfsPath(rawUrl);
	if (path) return IPFS_GATEWAYS.map((g) => g + path);
	// Non-IPFS: a single source (already an https CDN / arweave / data: link).
	return [rawUrl.startsWith('ipfs://') ? IPFS_GATEWAYS[0] + rawUrl.slice(7) : rawUrl];
}

// Race every candidate gateway concurrently and resolve with the FIRST one that
// returns a usable payload. Resolves to null when all candidates fail, OR when the
// shared `budgetMs` elapses — whichever comes first — so a stalled gateway can
// never pin the invocation toward the 30s wall. The losing fetches are each
// independently time-boxed by `perAttemptMs` (the SSRF fetcher aborts them), so
// they cannot outlive the request in any meaningful way. This concurrency is the
// fix for the sequential ipfs.io stall storm: total wall time is now ~one attempt,
// not the sum of all four.
//
// A "usable payload" is an image, OR — when `acceptJson` is set — a JSON document.
// Roughly half the token art on pump.fun surfaces is addressed by its *metadata*
// URI rather than its image URI: the CID resolves to a small JSON doc whose
// `image` field holds the real art. Callers hand us that URI in `?url=` because
// upstream feeds store both kinds in one `image_uri` column and the two are
// indistinguishable without fetching. Detecting the JSON here — instead of
// discarding it as "valid response but not an image" — lets one `?url=` call
// resolve either form. Returns { kind: 'image' | 'json', ... }.
function raceCandidates(urls, perAttemptMs, budgetMs, acceptJson) {
	if (!urls.length || budgetMs < 250) return Promise.resolve(null);
	return new Promise((resolve) => {
		let settled = false;
		let pending = urls.length;
		const finish = (payload) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(payload);
		};
		const timer = setTimeout(() => finish(null), budgetMs);
		for (const url of urls) {
			fetchModel(url, { maxBytes: MAX_BYTES, timeoutMs: Math.min(perAttemptMs, budgetMs) })
				.then((result) => {
					const ct = result?.contentType || '';
					if (ct.startsWith('image/')) return finish({ kind: 'image', ...result });
					if (acceptJson && ct.includes('json')) {
						// Metadata doc. Parse here — we already hold the bytes, so following
						// it costs no extra gateway round-trip for the document itself.
						try {
							const data = JSON.parse(new TextDecoder().decode(result.bytes));
							return finish({ kind: 'json', data });
						} catch {
							/* malformed — fall through and let the other candidates settle */
						}
					}
					if (--pending === 0) finish(null); // valid response, but nothing we can use
				})
				.catch(() => {
					// SSRF refusal, timeout, gateway 5xx — this candidate is out. Only
					// give up once every candidate has settled.
					if (--pending === 0) finish(null);
				});
		}
	});
}

// Deterministic, dependency-free placeholder art. The same seed always renders
// the same image, so a given token's fallback is stable across loads and the
// edge cache stays warm. Derives a two-tone palette + accent from a hash of the
// seed and composes a soft gradient backdrop, a faceted "gem" glyph, and a
// monogram — on-brand for three.ws and clearly intentional, not a 404 tile.
function hashSeed(str) {
	let h = 2166136261 >>> 0; // FNV-1a
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

function monogram(seed) {
	const m = String(seed).match(/[A-Za-z0-9]/);
	return (m ? m[0] : '◆').toUpperCase();
}

function placeholderSvg(seed) {
	const s = String(seed || 'token');
	const h = hashSeed(s);
	const hue = h % 360; // primary hue
	const hue2 = (hue + 38 + ((h >> 9) % 50)) % 360; // analogous accent
	const rot = (h >> 3) % 360; // gem rotation for per-seed variety
	const ch = monogram(s);
	// Two deep, saturated stops keep contrast high enough for a white monogram.
	const c1 = `hsl(${hue} 64% 16%)`;
	const c2 = `hsl(${hue2} 58% 9%)`;
	const glow = `hsl(${hue} 80% 60%)`;
	const accent = `hsl(${hue2} 85% 66%)`;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400" role="img" aria-label="placeholder artwork">
	<defs>
		<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
			<stop offset="0" stop-color="${c1}"/>
			<stop offset="1" stop-color="${c2}"/>
		</linearGradient>
		<radialGradient id="glow" cx="0.5" cy="0.42" r="0.65">
			<stop offset="0" stop-color="${glow}" stop-opacity="0.45"/>
			<stop offset="1" stop-color="${glow}" stop-opacity="0"/>
		</radialGradient>
		<linearGradient id="facet" x1="0" y1="0" x2="1" y2="1">
			<stop offset="0" stop-color="${accent}" stop-opacity="0.95"/>
			<stop offset="1" stop-color="${glow}" stop-opacity="0.55"/>
		</linearGradient>
	</defs>
	<rect width="400" height="400" fill="url(#bg)"/>
	<rect width="400" height="400" fill="url(#glow)"/>
	<g transform="rotate(${rot} 200 188)" opacity="0.9">
		<polygon points="200,96 268,150 242,236 158,236 132,150" fill="url(#facet)"/>
		<polygon points="200,96 268,150 200,188" fill="#ffffff" fill-opacity="0.16"/>
		<polygon points="200,96 132,150 200,188" fill="#000000" fill-opacity="0.12"/>
		<polygon points="200,188 242,236 158,236" fill="#000000" fill-opacity="0.18"/>
		<polyline points="132,150 200,188 268,150" fill="none" stroke="#ffffff" stroke-opacity="0.25" stroke-width="1.5"/>
	</g>
	<text x="200" y="188" text-anchor="middle" dominant-baseline="central"
		font-family="'Inter','Segoe UI',system-ui,sans-serif" font-size="84" font-weight="700"
		fill="#ffffff" fill-opacity="0.92" style="paint-order:stroke">${ch}</text>
	<text x="200" y="312" text-anchor="middle"
		font-family="'Inter','Segoe UI',system-ui,sans-serif" font-size="15" font-weight="600"
		letter-spacing="3" fill="#ffffff" fill-opacity="0.42">THREE.WS</text>
</svg>`;
}

// Resolve a token's artwork URL from its metadata JSON document. The metadata
// is creator-controlled, so we (a) fetch through the SSRF-hardened JSON client,
// (b) accept only an http(s) image URL — data: images are rejected so we never
// serve attacker-supplied inline content from our own origin, and (c) return
// null on any failure so the caller falls through to the on-brand placeholder.
async function resolveImageFromMeta(metaUri, timeoutMs = META_TIMEOUT_MS) {
	try {
		const { ok, data } = await safeFetchJson(metaUri, { timeoutMs });
		if (!ok || !data || typeof data !== 'object') return null;
		const candidate = data.image || data.image_url || data.imageUrl || data.imageUri || null;
		if (typeof candidate !== 'string') return null;
		const trimmed = candidate.trim();
		if (!trimmed || /^data:/i.test(trimmed)) return null;
		return trimmed;
	} catch {
		return null;
	}
}

export default wrap(async function handler(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: false })) return;
	if (!method(req, res, ['GET'])) return;

	const ip = clientIp(req);
	const rl = await limits.imgProxyIp(ip);
	if (!rl.success) return rateLimited(res, rl, 'too many image requests');

	const url = new URL(req.url, 'http://x');
	const directUrl = url.searchParams.get('url');
	const metaUri = url.searchParams.get('meta');
	const seed = url.searchParams.get('seed') || directUrl || metaUri || '';

	// Accept one of: ?url=<image>, ?meta=<metadata-json>, or ?seed=<x> (placeholder
	// only). Callers streaming launch feeds pass `meta` so the real artwork is
	// resolved server-side; a missing image still yields the branded placeholder.
	if (!directUrl && !metaUri && !seed) {
		return error(res, 400, 'missing_url', 'one of url, meta, or seed is required');
	}

	// data: URIs are not proxyable targets — redirecting to attacker-supplied
	// data: content is an open-redirect/content-injection vector. Reject.
	if (directUrl && /^data:/i.test(directUrl.trim())) {
		return error(
			res,
			400,
			'invalid_url',
			'data: URIs cannot be proxied — pass an http(s) or ipfs URL',
		);
	}

	// One hard deadline for ALL upstream work — metadata resolution and every
	// gateway attempt draw from the same budget so their combined spend can never
	// exceed it and trip the function's 30s kill before we serve the placeholder.
	const deadline = Date.now() + TOTAL_BUDGET_MS - RESPONSE_HEADROOM_MS;

	// Resolve the artwork URL: an explicit ?url wins; otherwise read it from the
	// token metadata document server-side. A null result simply falls through to
	// the placeholder below — the loader always receives a valid image. The meta
	// fetch is capped at whatever is left of the shared budget (never more than
	// META_TIMEOUT_MS) so a hung metadata host can't consume the gateway budget.
	let target = directUrl;
	if (!target && metaUri) {
		const metaBudget = Math.min(META_TIMEOUT_MS, deadline - Date.now());
		if (metaBudget > 250) target = await resolveImageFromMeta(metaUri, metaBudget);
	}

	// Race all candidate gateways concurrently inside whatever is left of the shared
	// budget. The first valid image wins; if every gateway fails (or the budget
	// runs out) we fall through to the placeholder below — always within the 30s wall.
	const image = await raceImageCandidates(
		target ? candidates(target) : [],
		TIMEOUT_MS,
		deadline - Date.now(),
	);

	if (!image) {
		// Every source failed. Hand back a valid, CORS-clean placeholder inline so
		// the texture/image loader resolves with a 200 instead of logging an error.
		// Served same-origin (no external dependency to fail) and cached, but for a
		// shorter window than real art so a transiently-down source can recover.
		res.statusCode = 200;
		res.setHeader('content-type', 'image/svg+xml; charset=utf-8');
		res.setHeader('access-control-allow-origin', '*');
		res.setHeader('cache-control', 'public, max-age=300, s-maxage=3600');
		res.end(placeholderSvg(seed));
		return;
	}

	res.statusCode = 200;
	res.setHeader('content-type', image.contentType);
	res.setHeader('access-control-allow-origin', '*');
	// Immutable: a given upstream URL is content-addressed (IPFS) or a fixed CDN
	// asset, so the bytes never change. Cache hard at the browser and the edge.
	res.setHeader('cache-control', 'public, max-age=86400, s-maxage=604800, immutable');
	res.end(Buffer.from(image.bytes));
});
