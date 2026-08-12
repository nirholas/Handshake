// @ts-check
// GET /api/crypto/openapi.json: the machine-readable spec for the free Crypto
// Data API bundle, generated live from the catalog (api/_lib/crypto-catalog).
//
// Served at `/api/crypto/openapi.json` via the rewrite in vercel.json; this file
// also answers `/api/crypto/openapi` directly. An agent points its OpenAPI
// toolchain (openapi-generator, LangChain's OpenAPIToolkit, Swagger UI) at this
// URL and gets typed clients / callable tools for every endpoint, with no key and no
// account. The doc is never hand-written: paths, params, and response schemas
// all derive from the catalog entries, so it can't drift from `/api/crypto`.

import { wrap, cors, method, json, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { env } from '../_lib/env.js';
import { loadCatalog } from '../_lib/crypto-catalog/index.js';
import { buildOpenApiDoc } from '../_lib/crypto-catalog/openapi.js';

const VERSION = '1.0.0';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const ip = clientIp(req);
	const rl = await limits.apiIp(ip, { limit: 240, window: '5 m' });
	if (!rl.success) return rateLimited(res, rl, 'too many requests to the crypto OpenAPI doc');

	const entries = await loadCatalog();
	const doc = buildOpenApiDoc(entries, { origin: env.APP_ORIGIN, version: VERSION });

	// Catalog changes only on deploy, so it is safe to CDN-cache briefly.
	return json(res, 200, doc, {
		'cache-control': 'public, s-maxage=300, stale-while-revalidate=600',
	});
});
