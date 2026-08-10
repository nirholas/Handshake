// GET /api/agent-3d/versions: serves dist/agent-3d/versions.json (the CDN release
// manifest written by `npm run publish:lib`) with CORS, cache, and ETag headers.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { cors, json, error, method, wrap } from '../_lib/http.js';

const VERSIONS_PATH = new URL('../../dist/agent-3d/versions.json', import.meta.url);

const CACHE_HEADERS = {
	'cache-control': 'public, max-age=60, s-maxage=60, stale-while-revalidate=300',
};

// Read per request rather than memoized: the manifest is ~400 bytes, the CDN holds
// it for 60s so the origin barely sees this route, and every cheap invalidation key
// available here is unsound. mtime granularity on an overlay filesystem is coarse
// enough that two publishes inside the same tick are indistinguishable, which would
// pin a container to a superseded release manifest. Correctness wins over a syscall.
function loadManifest() {
	const raw = readFileSync(VERSIONS_PATH, 'utf8');
	return {
		data: JSON.parse(raw),
		// Content-derived, so it changes exactly when the published manifest does.
		etag: `"${createHash('sha256').update(raw).digest('base64url').slice(0, 27)}"`,
	};
}

// RFC 9110 §13.1.2: If-None-Match is a comma-separated list, entries may carry the
// weak `W/` prefix, and `*` matches any existing representation.
function ifNoneMatch(header, etag) {
	if (!header) return false;
	const tags = String(header).split(',').map((t) => t.trim());
	if (tags.includes('*')) return true;
	return tags.some((t) => t.replace(/^W\//, '') === etag);
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,HEAD,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET', 'HEAD'])) return;

	let manifest;
	try {
		manifest = loadManifest();
	} catch (err) {
		// Both branches are deployment faults rather than caller faults, so both are
		// 503, but they need different fixes: a missing file means publish:lib never
		// ran, a parse failure means it produced garbage. Saying "not found" for both
		// sends the operator looking for the wrong thing.
		const missing = err?.code === 'ENOENT';
		return error(
			res,
			503,
			'versions_unavailable',
			missing
				? 'dist/agent-3d/versions.json is missing; run `npm run publish:lib`'
				: 'dist/agent-3d/versions.json is unreadable or not valid JSON; rebuild it with `npm run publish:lib`',
		);
	}

	if (ifNoneMatch(req.headers['if-none-match'], manifest.etag)) {
		res.statusCode = 304;
		for (const [k, v] of Object.entries(CACHE_HEADERS)) res.setHeader(k, v);
		res.setHeader('etag', manifest.etag);
		res.end();
		return;
	}

	return json(res, 200, manifest.data, { ...CACHE_HEADERS, etag: manifest.etag });
});
