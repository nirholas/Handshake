// three.ws Forge — generative 3D sculptures with real AR + social-card sharing.
// Zero dependencies. Behind a Lambda Function URL.
//
// Routes:
//   GET /?seed=…              → per-seed share page (AR Quick Look / Scene Viewer,
//                               Open Graph + Twitter Card meta, share buttons)
//   GET /api/forge?seed=&res= → the sculpture as a binary GLB (downloadable)
//   GET /api/og?seed=         → 1200×630 PNG preview (the unfurl image)
//   GET /api/forge.json?seed= → traits + stats
//   GET /healthz              → liveness
//
// Pure & deterministic: a given seed always yields identical bytes, so every
// response is safely cacheable at the edge.

import { forgeGlb, forgeTraits } from './forge.mjs';
import { renderCardPng } from './render.mjs';
import { buildPage } from './page.mjs';

const CORS = {
	'access-control-allow-origin': '*',
	'access-control-allow-methods': 'GET, OPTIONS',
	'access-control-allow-headers': 'content-type',
};
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', ...CORS, 'cache-control': 'public, max-age=600' };
const IMMUTABLE = 'public, max-age=31536000, immutable';
const DEFAULT_SEED = 'three.ws';

function json(statusCode, body) { return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) }; }

function readSeed(event, { fallback = null } = {}) {
	const raw = event?.queryStringParameters?.seed;
	if (raw == null || raw === '') return fallback;
	return String(raw).slice(0, 256);
}
function safeName(seed) {
	return seed.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'sculpture';
}
function originOf(event) {
	const host = event?.requestContext?.domainName || event?.headers?.host || 'localhost';
	return `https://${host}`;
}

export const handler = async (event) => {
	const method = event?.requestContext?.http?.method || 'GET';
	const path = (event?.rawPath || '/').replace(/\/+$/, '') || '/';

	if (method === 'OPTIONS') return { statusCode: 204, headers: JSON_HEADERS, body: '' };

	if (path === '/healthz') return json(200, { ok: true, service: 'forge' });

	if (path === '/api/forge.json') {
		const seed = readSeed(event);
		if (!seed) return json(400, { error: 'missing_seed', message: 'Provide ?seed=<any text>' });
		return json(200, forgeTraits(seed));
	}

	if (path === '/api/forge') {
		const seed = readSeed(event);
		if (!seed) return json(400, { error: 'missing_seed', message: 'Provide ?seed=<any text>' });
		const res = Number(event?.queryStringParameters?.res) || 120;
		try {
			const out = forgeGlb(seed, res);
			return {
				statusCode: 200,
				isBase64Encoded: true,
				headers: {
					'content-type': 'model/gltf-binary',
					'content-disposition': `inline; filename="${safeName(seed)}.glb"`,
					'cache-control': IMMUTABLE,
					'x-forge-triangles': String(out.stats.triangles),
					'x-forge-tier': out.traits.tier,
					...CORS,
				},
				body: out.glb.toString('base64'),
			};
		} catch (err) {
			return json(500, { error: 'forge_failed', message: err?.message || 'Could not forge this seed.' });
		}
	}

	if (path === '/api/og') {
		const seed = readSeed(event, { fallback: DEFAULT_SEED });
		try {
			const { png } = renderCardPng(seed, { width: 1200, height: 630, res: 90 });
			return {
				statusCode: 200,
				isBase64Encoded: true,
				headers: { 'content-type': 'image/png', 'cache-control': IMMUTABLE, ...CORS },
				body: png.toString('base64'),
			};
		} catch (err) {
			return json(500, { error: 'render_failed', message: err?.message || 'Could not render preview.' });
		}
	}

	if (path === '/') {
		const seed = readSeed(event, { fallback: DEFAULT_SEED });
		const traits = forgeTraits(seed);
		return {
			statusCode: 200,
			headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' },
			body: buildPage({ seed, traits, origin: originOf(event) }),
		};
	}

	return json(404, { error: 'not_found', path });
};
