/**
 * Portal: any website, as a walkable 3D world.
 * ---------------------------------------------
 *   GET /api/portal?url=<address>              → { outline, world, cached }
 *   GET /api/portal?url=<address>&format=glb   → the world as a binary glTF
 *   GET /api/portal?url=<address>&include=world|outline|both
 *
 * The world is a JSON document (specs/portal-world.md) that the page renderer,
 * the published SDK (@three-ws/portal) and the GLB exporter all read. Building
 * one costs exactly one request to the target site plus a cached robots.txt
 * read, and the result is cached fleet-wide for an hour, so a link shared to a
 * thousand people is still one visit to the origin.
 *
 * Open CORS on purpose: the SDK runs in other people's pages, and this endpoint
 * returns nothing that is not already public on the site it read.
 */

import { cors, json, method, wrap, error, rateLimited } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { cacheWrapLastGood } from './_lib/cache.js';
import { normalizeTarget, outlineForUrl, PortalFetchError, WORLD_TTL_SECONDS, USER_AGENT } from './_lib/portal/fetch-site.js';
import { buildWorld } from '../src/portal/layout.js';

export const maxDuration = 30;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const url = new URL(req.url, 'http://x');
	const raw = url.searchParams.get('url') || '';
	const format = (url.searchParams.get('format') || 'json').toLowerCase();
	const include = (url.searchParams.get('include') || 'both').toLowerCase();

	let target;
	try {
		target = normalizeTarget(raw);
	} catch (err) {
		return error(res, 400, err.code || 'invalid_url', err.message);
	}

	const ip = clientIp(req);
	const cacheKey = `portal:world:${target.toString()}`;

	// A cached world is free to serve and costs the origin site nothing, so the
	// rate limiter only guards a real build. Checking the cache first is what
	// makes a viral share link cheap for everyone involved.
	let cached = true;
	let built;
	try {
		const { value, stale } = await cacheWrapLastGood(
			cacheKey,
			WORLD_TTL_SECONDS,
			async () => {
				cached = false;
				const gate = await gateBuild(ip);
				if (gate) throw gate;
				const outline = await outlineForUrl(target);
				return { outline, world: buildWorld(outline), builtAt: new Date().toISOString() };
			},
			{ withMeta: true },
		);
		built = { ...value, stale: !!stale };
	} catch (err) {
		if (err instanceof RateLimited) return rateLimited(res, err.result, err.message);
		if (err instanceof PortalFetchError) return error(res, err.status, err.code, err.message);
		console.error('[portal] build failed', target.host, err?.message || err);
		return error(res, 502, 'build_failed', `Could not build a world from ${target.host}.`);
	}

	if (format === 'glb') {
		const exportGate = await limits.portalExportIp(ip);
		if (!exportGate.success) {
			return rateLimited(res, exportGate, 'Too many world exports from this address. Try again shortly.');
		}
		const { worldToGlb } = await import('./_lib/portal/world-glb.js');
		const glb = await worldToGlb(built.world);
		res.statusCode = 200;
		res.setHeader('content-type', 'model/gltf-binary');
		res.setHeader('content-length', String(glb.byteLength));
		res.setHeader('content-disposition', `attachment; filename="portal-${safeName(built.world.meta.host)}.glb"`);
		res.setHeader('cache-control', 'public, max-age=3600');
		return res.end(Buffer.from(glb));
	}

	const body = { ok: true, cached, stale: built.stale, built_at: built.builtAt, user_agent: USER_AGENT };
	if (include === 'outline' || include === 'both') body.outline = built.outline;
	if (include === 'world' || include === 'both') body.world = built.world;
	return json(res, 200, body, {
		'cache-control': 'public, max-age=300, stale-while-revalidate=3600',
	});
});

/**
 * Rate-limit rejection carried out of the cache loader without losing the
 * limiter result, which is what carries the real reset time and the reason a
 * degraded limiter reports (see rateLimited in api/_lib/http.js).
 */
class RateLimited extends Error {
	constructor(message, result) {
		super(message);
		this.name = 'RateLimited';
		this.result = result;
	}
}

async function gateBuild(ip) {
	const [perIp, fleet] = await Promise.all([limits.portalBuildIp(ip), limits.portalBuildGlobal()]);
	if (!perIp.success) {
		return new RateLimited('Too many new worlds from this address. Open a world someone already built, or try again shortly.', perIp);
	}
	if (!fleet.success) {
		return new RateLimited('Portal is building at capacity right now. Try again in a few minutes.', fleet);
	}
	return null;
}

function safeName(host) {
	return String(host || 'world').replace(/[^a-z0-9.-]+/gi, '-').slice(0, 48);
}
