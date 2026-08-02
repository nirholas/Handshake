// GET /api/glb?src=<url> — same-origin GLB proxy with open CORS.
//
// Why: generated models live on the public R2 host, whose CORS policy is an
// origin allowlist. Anything loading a GLB from the browser on an origin
// outside that list gets no Access-Control-Allow-Origin header and the fetch
// dies: <model-viewer> embeds on partner sites, the OpenAI Cookbook notebook
// running in Jupyter/Colab (localhost origins), Codespaces previews. Same
// failure mode api/img.js solves for token art, applied to models.
//
// Routing the bytes through this endpoint makes the read work from ANY
// origin: the response carries `access-control-allow-origin: *`, which is
// safe because the upstream objects are already public and keyless. Uploads
// are unaffected (presigned PUTs stay origin-locked at the bucket).
//
// The upstream fetch goes through the SSRF-hardened fetcher (scheme
// allowlist, DNS pinning, private-IP blocklist, redirect re-validation, byte
// cap, timeout), so this cannot be used to read internal surfaces. Responses
// are immutable and CDN-cached, so repeat views of a model cost one upstream
// read, not one per viewer.

import { wrap, cors, method, error, rateLimited } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { fetchModel } from './_lib/fetch-model.js';

// Draft-tier GLBs run 2-8 MB; the paid lanes top out well under this.
const MAX_BYTES = 30 * 1024 * 1024;
const TIMEOUT_MS = 20_000;

export default wrap(async function handler(req, res) {
	if (cors(req, res, { origins: '*', methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const ip = clientIp(req);
	const rl = await limits.imgProxyIp(ip);
	if (!rl.success) return rateLimited(res, rl, 'too many model requests');

	const url = new URL(req.url, 'http://x');
	const src = (url.searchParams.get('src') || url.searchParams.get('url') || '').trim();
	if (!src || !/^https?:\/\//i.test(src)) {
		return error(res, 400, 'bad_request', 'Pass ?src=<http(s) URL of a .glb>');
	}

	let bytes;
	try {
		({ bytes } = await fetchModel(src, { maxBytes: MAX_BYTES, timeoutMs: TIMEOUT_MS }));
	} catch (err) {
		const code = err?.code || 'fetch_failed';
		const callerFault = new Set([
			'invalid_url',
			'scheme_not_allowed',
			'private_address',
			'host_pin_mismatch',
		]);
		const status = code === 'file_too_large' ? 413 : callerFault.has(code) ? 400 : 502;
		return error(res, status, code, err?.message || 'could not fetch the model');
	}

	res.statusCode = 200;
	res.setHeader('content-type', 'model/gltf-binary');
	// The bytes come from an arbitrary remote URL but leave on the three.ws
	// origin. Pin them as data: an opaque-origin sandbox, plus the declared model
	// type and the nosniff set by the wrapper, so nothing here can ever be
	// interpreted as a document with three.ws's cookies.
	res.setHeader('content-security-policy', "default-src 'none'; sandbox");
	res.setHeader('cross-origin-resource-policy', 'cross-origin');
	res.setHeader('content-length', String(bytes.length));
	// Generated GLBs are content-addressed by their unique object key, so a
	// given src never changes bytes: cache hard at every layer.
	res.setHeader('cache-control', 'public, max-age=86400, s-maxage=604800, immutable');
	res.end(Buffer.from(bytes));
});
