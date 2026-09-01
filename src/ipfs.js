/**
 * IPFS / Arweave URI resolver.
 *
 * Translates decentralised storage URIs into HTTPS gateway URLs
 * so the Three.js loader can fetch them normally.
 *
 *   ipfs://QmXyz...        → https://dweb.link/ipfs/QmXyz...
 *   ipfs://bafkreiXyz...   → https://dweb.link/ipfs/bafkreiXyz...
 *   ar://txId               → https://arweave.net/txId
 */

// Cloudflare retired both cf-ipfs.com and cloudflare-ipfs.com (Aug 2024);
// requests to either now fail DNS (ERR_NAME_NOT_RESOLVED). pump.fun metadata
// still hands out cf-ipfs.com image URLs, so we keep this list dead-host-free
// and rewrite any lingering dead-gateway URL via normalizeGatewayURL().
export const IPFS_GATEWAYS = [
	'https://dweb.link/ipfs/',
	'https://ipfs.io/ipfs/',
	'https://flk-ipfs.xyz/ipfs/',
	'https://w3s.link/ipfs/',
	'https://nftstorage.link/ipfs/',
];

const AR_GATEWAY = 'https://arweave.net/';

// Per-gateway budget. Public gateways routinely accept a connection and then
// never answer; without a deadline the first such host holds the whole chain.
const GATEWAY_TIMEOUT_MS = 8_000;

// Hosts that no longer resolve. Any HTTPS gateway URL using one of these is
// rewritten onto the primary working gateway (preserving the /ipfs/<cid>/path).
const DEAD_GATEWAY_HOST_RE = /^https?:\/\/(?:cf-ipfs\.com|cloudflare-ipfs\.com)\/ipfs\/(.+)$/i;

/**
 * Returns true when the URL uses a decentralised storage scheme.
 * @param {string} url
 * @returns {boolean}
 */
export function isDecentralizedURI(url) {
	return /^(ipfs|ar):\/\//i.test(url);
}

/**
 * Repair full HTTPS gateway URLs that point at a retired gateway host.
 * Leaves every other URL (including live gateways) untouched.
 *
 * @param {string} url
 * @param {number} [gatewayIndex=0]  Which working gateway to route to.
 * @returns {string}
 */
export function normalizeGatewayURL(url, gatewayIndex = 0) {
	if (!url) return url;
	const dead = url.match(DEAD_GATEWAY_HOST_RE);
	if (dead) {
		const gw = IPFS_GATEWAYS[gatewayIndex % IPFS_GATEWAYS.length];
		return gw + dead[1];
	}
	return url;
}

/**
 * Resolve an ipfs:// or ar:// URI to an HTTPS gateway URL.
 * For regular URLs the input is returned unchanged, except that URLs pointing
 * at a retired gateway host are rewritten onto a working gateway.
 *
 * @param {string} uri
 * @param {number} [gatewayIndex=0]  Which IPFS gateway to use (for fallback).
 * @returns {string}
 */
export function resolveURI(uri, gatewayIndex = 0) {
	if (!uri) return uri;

	// ipfs://CID  or  ipfs://CID/path
	const ipfsMatch = uri.match(/^ipfs:\/\/(.+)$/i);
	if (ipfsMatch) {
		const gw = IPFS_GATEWAYS[gatewayIndex % IPFS_GATEWAYS.length];
		return gw + ipfsMatch[1];
	}

	// ar://txId
	const arMatch = uri.match(/^ar:\/\/(.+)$/i);
	if (arMatch) {
		return AR_GATEWAY + arMatch[1];
	}

	return normalizeGatewayURL(uri, gatewayIndex);
}

// Schemes an <img src> or a Three.js TextureLoader can actually render. Every
// image URL this module hands out is attacker-reachable: it arrives from a
// `?image=` deep link, a third-party token feed, or a peer's join options. A
// scheme outside this set is never art. It is either an attempt at a script
// sink (javascript:, vbscript:), a local-resource probe (file:, about:), or an
// HTML document dressed as an image (data:text/html), so the only correct
// answer is to drop it, not to pass it through to whoever asked.
const SAFE_IMAGE_SCHEMES = new Set(['http', 'https', 'ipfs', 'ar', 'blob']);
// Longest source URL worth proxying. Real IPFS/Arweave/CDN art sits well under
// 300 characters; a multi-kilobyte value is either junk or an attempt to make
// us issue an oversized upstream request, and the proxy would reject it anyway.
const MAX_SOURCE_URL = 2048;

// Characters that never appear unencoded in a real image path, and that are
// exactly the ones a crafted value uses to break out of the syntax it lands in:
// quotes and parentheses close a CSS url(), a semicolon starts a new declaration,
// angle brackets open a tag, whitespace and backslash split the token. A
// scheme-less value carrying any of them is not art someone forgot to encode, it
// is a payload, and handing it to an image sink costs a doomed request and a
// console error even when the escaping downstream holds.
const CSS_HTML_UNSAFE = /["'()<>;\\\s]/;

/**
 * True when a URL is safe to hand to an <img>/TextureLoader as an image source.
 * Relative and site-absolute paths qualify as long as they still look like paths;
 * `data:` only when it declares an image media type.
 *
 * @param {string} url
 * @returns {boolean}
 */
export function isSafeImageURL(url) {
	if (typeof url !== 'string') return false;
	const s = url.trim();
	if (!s) return false;
	// Control characters exist here only to smuggle a scheme past a parser
	// ("java\tscript:alert(1)" is a live URL in some engines). Refuse outright.
	if (/[\u0000-\u001f\u007f]/.test(s)) return false;
	const scheme = s.match(/^([a-z][a-z0-9+.\-]*):/i)?.[1]?.toLowerCase();
	if (!scheme) return !CSS_HTML_UNSAFE.test(s); // relative or site-absolute path
	if (scheme === 'data') return /^data:image\/[a-z0-9.+\-]+[,;]/i.test(s);
	if (!SAFE_IMAGE_SCHEMES.has(scheme)) return false;
	// blob: is an opaque single token; the rest are real URLs whose path is subject
	// to the same no-breakout-characters rule as a relative path.
	return scheme === 'blob' || !CSS_HTML_UNSAFE.test(s);
}

/**
 * Route an external image URL through the same-origin /api/img proxy.
 *
 * Third-party token-art hosts (per-launch CDNs, IPFS/Arweave gateways) fail in
 * browsers for reasons we can't fix client-side: missing CORS headers, ORB
 * blocking, retired hosts, and TLS interception on filtered networks. The
 * proxy fetches server-side with multi-gateway IPFS retry and always answers
 * with a valid image (deterministic placeholder on total failure), so the
 * loader never errors. Same-origin, relative, data:image and blob: URLs pass
 * through untouched; the proxy only earns its keep cross-origin.
 *
 * Anything that is not a renderable image source (javascript:, data:text/html,
 * file:, an over-long URL) resolves to '' so callers fall through to their own
 * "no art" branch instead of pushing a hostile value into an image sink.
 *
 * `width` asks the proxy for a copy no wider than that many pixels, re-encoded
 * as WebP (it snaps up to a fixed ladder, so a caller cannot mint unbounded
 * edge variants). Token art is stored at whatever size its creator uploaded:
 * four coins in the /play world pulled 2.7 MB of full-size PNGs for textures
 * that are a few hundred pixels on screen. Pass the size the art is actually
 * used at; leave it off to get the original bytes.
 *
 * @param {string} url          Image URL (https://, ipfs:// or ar:// accepted).
 * @param {string} [seed]       Stable placeholder seed (e.g. the token mint).
 * @param {{ width?: number }} [opts]  Max delivered width in pixels.
 * @returns {string}
 */
export function proxiedImageURL(url, seed = '', { width = 0 } = {}) {
	if (typeof url !== 'string' || !url) return '';
	// Protocol-relative art still deserves the proxy's CORS and gateway retry,
	// so give it the scheme the page is already on before anything else looks
	// at it. Site-absolute ('/x.png') is untouched; only '//host/x.png' matches.
	const raw = /^\/\/[^/]/.test(url.trim()) ? 'https:' + url.trim() : url.trim();
	if (!isSafeImageURL(raw)) return '';
	if (!/^(https?|ipfs|ar):/i.test(raw)) return raw;
	if (typeof location !== 'undefined' && raw.startsWith(location.origin + '/')) return raw;
	if (raw.length > MAX_SOURCE_URL) return '';
	const q = new URLSearchParams({ url: resolveURI(raw) });
	if (seed) q.set('seed', seed);
	if (width > 0) q.set('w', String(Math.round(width)));
	return `/api/img?${q.toString()}`;
}

// Pull the CID (plus any path) back out of a URL that already names a gateway,
// so content whose gateway was baked in upstream can still be rotated. Matches
// the /ipfs/<cid>[/path] form every gateway in the list serves.
const GATEWAY_URL_RE = /^https?:\/\/[^/]+\/ipfs\/(.+)$/i;

/**
 * Every HTTPS URL that can serve one piece of decentralised content, in
 * preference order. An `ipfs://` URI expands to one URL per gateway; so does a
 * URL that already points at a gateway (its CID is re-extracted), which is what
 * makes content whose gateway was chosen upstream recoverable. Anything else
 * (a plain CDN URL, `ar://`) yields the single normalised URL, so callers can
 * loop over the result unconditionally.
 *
 * @param {string} uri
 * @returns {string[]}
 */
export function uriCandidates(uri) {
	if (!uri) return [];
	const ipfsMatch = String(uri).match(/^ipfs:\/\/(.+)$/i);
	const cid = ipfsMatch ? ipfsMatch[1] : (String(uri).match(GATEWAY_URL_RE) || [])[1];
	if (cid) {
		const first = resolveURI(uri, 0);
		const all = IPFS_GATEWAYS.map((gw) => gw + cid);
		// Keep whatever the caller (or an upstream resolver) already chose at the
		// head of the list: it is the one most likely to be warm in a CDN.
		return [first, ...all.filter((u) => u !== first)];
	}
	const single = resolveURI(uri, 0);
	return single ? [single] : [];
}

/**
 * Try to fetch from the primary gateway; on failure, cycle through fallbacks.
 *
 * @param {string} ipfsURI  An ipfs:// URI, or any URL uriCandidates understands.
 * @returns {Promise<Response>}
 */
export async function fetchWithFallback(ipfsURI) {
	let lastError;
	for (const url of uriCandidates(ipfsURI)) {
		try {
			// Bounded per gateway: a black-holing gateway used to block the whole
			// chain behind it, which made the fallback list decorative.
			const res = await fetch(url, { signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS) });
			if (res.ok) return res;
			lastError = new Error(`${url} responded ${res.status}`);
		} catch (err) {
			lastError = err;
		}
	}
	throw lastError || new Error('All IPFS gateways failed for ' + ipfsURI);
}
