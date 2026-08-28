// GET/POST /api/3d/diff: FREE, keyless structural diff of two glTF/GLB models.
//
// The question this answers is not "are these two files different" (a re-export
// always is, down to the byte) but "what changed, and will it break anything
// that depends on this model". Byte comparison, checksums, and file size all
// fail at that: they cannot tell a lossless recompression from a rig that
// quietly lost three finger joints, and the second one is what takes an avatar
// off the screen in production.
//
// Input:
//   GET  /api/3d/diff?a=<url>&b=<url>[&format=json|markdown|text]
//   POST /api/3d/diff   body { "a": "<url>", "b": "<url>", "format": "json" }
//
// Output (format=json, the default): the change set from @three-ws/glb-diff:
//   { version, identical, severity, summary, totals, sections, extensions,
//     asset, highlights, ts }
// `severity` is the field to gate on: none < cosmetic < minor < major < breaking.
// `format=markdown` returns a pull-request-ready report as text/markdown, and
// `format=text` returns the plain terminal report, so a CI job can post the
// result without carrying a renderer of its own.
//
// The engine is the published package (packages/glb-diff), the same code the
// /diff page runs in the browser and the `glb-diff` CLI runs in a terminal. One
// implementation, three surfaces: a verdict from this endpoint can never
// disagree with what the page shows.

import { cors, wrap, error, json, text, rateLimited, readJson } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { fetchModel, FetchModelError } from '../_lib/fetch-model.js';
import { describeModel, diffDescriptions, formatMarkdown, formatText } from '@three-ws/glb-diff';

// Same free-tier ceiling as /api/3d/inspect, applied per side. Two models at
// 32 MiB each is the honest upper bound on what one anonymous call may cost.
const MAX_BYTES = 32 * 1024 * 1024;

const FORMATS = new Set(['json', 'markdown', 'text']);

function httpError(status, code, message, extra = {}) {
	const e = new Error(message);
	e.status = status;
	e.code = code;
	e.extra = extra;
	return e;
}

// Fetch one side through the SSRF-hardened, size-capped fetcher and translate
// its typed errors into this endpoint's HTTP contract. `side` names which input
// failed, because "could not fetch model" with two URLs in play is a support
// ticket rather than an error message.
async function fetchSide(side, url) {
	if (!url) throw httpError(400, 'missing_url', `query param "${side}" is required (a public https URL of a .glb/.gltf)`);
	try {
		const { bytes, url: finalUrl } = await fetchModel(url, { maxBytes: MAX_BYTES, timeoutMs: 20_000 });
		return { bytes, url: finalUrl };
	} catch (err) {
		if (err instanceof FetchModelError) {
			if (err.code === 'file_too_large') {
				throw httpError(413, 'too_large', `model "${side}" exceeds the ${MAX_BYTES}-byte free-tier cap`);
			}
			if (['invalid_url', 'scheme_not_allowed', 'private_address', 'host_pin_mismatch'].includes(err.code)) {
				throw httpError(400, 'invalid_url', `model "${side}": ${err.message}`);
			}
			throw httpError(502, 'fetch_failed', `could not fetch model "${side}": ${err.message}`, {
				retry: 'check the URL is public and returns the model bytes',
			});
		}
		throw httpError(502, 'fetch_failed', `could not fetch model "${side}": ${err?.message || err}`);
	}
}

function filenameOf(url, fallback) {
	try {
		return new URL(url).pathname.split('/').filter(Boolean).pop() || fallback;
	} catch {
		return fallback;
	}
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', origins: '*' })) return;
	if (req.method !== 'GET' && req.method !== 'POST') {
		res.setHeader('allow', 'GET, POST');
		return error(res, 405, 'method_not_allowed', 'use GET (?a=&b=) or POST ({ a, b })');
	}

	// Two fetches plus two full parses is heavier than /inspect, so the per-IP
	// budget is tighter. Still free and keyless: the limit exists to bound abuse,
	// not to push anyone toward an account.
	const ip = clientIp(req);
	const rl = await limits.apiIp(ip, { limit: 30, window: '1 m' });
	if (!rl.success) return rateLimited(res, rl, 'too many diff requests');

	let input = {};
	if (req.method === 'GET') {
		input = { a: req.query?.a, b: req.query?.b, format: req.query?.format };
	} else {
		try {
			input = (await readJson(req)) || {};
		} catch (e) {
			return error(res, e.status === 415 ? 415 : 400, 'invalid_json', e.message || 'invalid JSON body');
		}
	}

	const format = String(input.format || 'json').toLowerCase();
	if (!FORMATS.has(format)) {
		return error(res, 400, 'invalid_format', `format must be one of: ${[...FORMATS].join(', ')}`);
	}

	const urlA = String(input.a || '').trim();
	const urlB = String(input.b || '').trim();

	let sideA;
	let sideB;
	try {
		// Sequential rather than concurrent: a caller who passed one bad URL gets
		// that specific error without the endpoint having spent a second full
		// download on the other side first.
		sideA = await fetchSide('a', urlA);
		sideB = await fetchSide('b', urlB);
	} catch (e) {
		return error(res, e.status || 502, e.code || 'fetch_failed', e.message, e.extra || {});
	}

	let changeset;
	try {
		const [a, b] = await Promise.all([
			describeModel(sideA.bytes, { name: filenameOf(sideA.url, 'a.glb') }),
			describeModel(sideB.bytes, { name: filenameOf(sideB.url, 'b.glb') }),
		]);
		changeset = diffDescriptions(a, b);
	} catch (e) {
		return error(res, 400, 'invalid_model', `not a valid glTF/GLB: ${e.message || 'could not parse model'}`);
	}

	// URL-sourced requests are deterministic for a given pair, so the edge may
	// hold them briefly. The identical-inputs case is the common one in CI.
	const cache = req.method === 'GET' ? 'public, max-age=60, s-maxage=300' : 'no-store';

	if (format === 'markdown') {
		return text(res, 200, formatMarkdown(changeset), {
			'content-type': 'text/markdown; charset=utf-8',
			'cache-control': cache,
		});
	}
	if (format === 'text') {
		return text(res, 200, formatText(changeset, { color: false }), { 'cache-control': cache });
	}

	res.setHeader('cache-control', cache);
	return json(res, 200, {
		...changeset,
		a: { ...changeset.a, url: sideA.url },
		b: { ...changeset.b, url: sideB.url },
		ts: new Date().toISOString(),
	});
});
