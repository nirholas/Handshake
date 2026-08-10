// GET /api/assets: public asset library catalog.
//
// Returns a unified, filterable catalog of three.ws-hosted accessories,
// animations, and environments: the on-disk truth (public/accessories/,
// public/animations/, src/environments.js) exposed as a stable REST shape.
//
// Query params (an unrecognized value is a 400, never a silently empty page):
//   ?type=accessory|animation|environment   filter by top-level kind
//   ?kind=hat|glasses|earrings|outfit       filter accessories by subkind
//   ?loop=true|false                        filter animations by loopability
//   ?limit=<n>                              cap result count (default 200,
//                                           clamped to 500, non-integer is 400)
//
// Response:
//   { ok: true, total: <int>, items: [ { id, type, kind?, name, ...} ] }
//
// Cached at the edge for 1h; on-disk manifests are part of the deploy so the
// catalog is immutable per build.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { cors, error, method, wrap, serverError } from '../_lib/http.js';
import { environments } from '../../src/environments.js';

// In-process caches: the on-disk manifests don't change between requests
// on the same serverless instance.
let accessoriesCache = null;
let animationsCache = null;

async function loadAccessories() {
	if (accessoriesCache) return accessoriesCache;
	const raw = await readFile(
		path.resolve(process.cwd(), 'public/accessories/presets.json'),
		'utf-8',
	);
	const items = JSON.parse(raw);
	accessoriesCache = items.map((a) => ({
		id: a.id,
		type: 'accessory',
		kind: a.kind,
		name: a.name,
		thumbnail: a.thumbnail || null,
		glb_url: a.glbUrl || null,
		attach_bone: a.attachBone || null,
		morph_binding: a.morphBinding || null,
	}));
	return accessoriesCache;
}

async function loadAnimations() {
	if (animationsCache) return animationsCache;
	const raw = await readFile(
		path.resolve(process.cwd(), 'public/animations/manifest.json'),
		'utf-8',
	);
	const items = JSON.parse(raw);
	animationsCache = items.map((a) => ({
		id: a.name,
		type: 'animation',
		name: a.label || a.name,
		clip_url: a.url,
		icon: a.icon || null,
		loop: a.loop === true,
	}));
	return animationsCache;
}

// Environments come straight from the viewer's own list (src/environments.js is
// a pure data module: no three.js import, nothing browser-only), so a preset
// added or renamed there shows up here without a second edit. The one shape
// change: the viewer encodes "no environment" as an empty id, and every catalog
// item must carry a non-empty id, so it is published as `none`.
const ENVIRONMENTS = environments.map((e) => ({
	id: e.id || 'none',
	type: 'environment',
	name: e.name,
	path: e.path ?? null,
	...(e.format ? { format: e.format } : {}),
}));

const TYPES = ['accessory', 'animation', 'environment'];

export default wrap(async (req, res) => {
	// origins:'*' (not the default allowlist) so the allow-origin header rides on
	// the OPTIONS preflight and the 4xx/5xx paths too, not just the success body.
	// A public catalog that only answers CORS when it succeeds is unusable from a
	// browser the moment a client sends a bad filter.
	if (cors(req, res, { origins: '*', methods: 'GET,HEAD,OPTIONS', credentials: false })) return;
	if (!method(req, res, ['GET'])) return;

	const url = new URL(req.url, 'http://x');
	const type = (url.searchParams.get('type') || '').trim().toLowerCase();
	const kind = (url.searchParams.get('kind') || '').trim().toLowerCase();
	const loopRaw = url.searchParams.get('loop');
	const loopParam = loopRaw == null ? null : loopRaw.trim().toLowerCase();
	const limitRaw = url.searchParams.get('limit');

	if (type && !TYPES.includes(type)) {
		return error(res, 400, 'invalid_type', `\`type\` must be one of ${TYPES.join(', ')}`);
	}
	if (loopParam !== null && loopParam !== '' && loopParam !== 'true' && loopParam !== 'false') {
		return error(res, 400, 'invalid_loop', '`loop` must be `true` or `false`');
	}

	// A garbled limit must not quietly become the default page size: the caller
	// asked for something specific and would read the answer as if it applied.
	// An out-of-range integer still clamps, which is the documented cap.
	let limit = 200;
	if (limitRaw != null && limitRaw.trim() !== '') {
		const n = Number(limitRaw);
		if (!Number.isInteger(n) || n < 1) {
			return error(res, 400, 'invalid_limit', '`limit` must be an integer between 1 and 500 (default 200)');
		}
		limit = Math.min(500, n);
	}

	const buckets = [];
	if (!type || type === 'accessory') {
		try {
			buckets.push(await loadAccessories());
		} catch (err) {
			console.error('[assets] accessories manifest unreadable', err?.message);
			return serverError(res, 500, 'manifest_unreadable', err);
		}
	}
	if (!type || type === 'animation') {
		try {
			buckets.push(await loadAnimations());
		} catch (err) {
			console.error('[assets] animations manifest unreadable', err?.message);
			return serverError(res, 500, 'manifest_unreadable', err);
		}
	}
	if (!type || type === 'environment') {
		buckets.push(ENVIRONMENTS);
	}

	let items = buckets.flat();

	// `kind` is validated against the manifest itself rather than a hardcoded
	// list, so a new accessory subkind is filterable the day it lands and a typo
	// is still a 400 instead of an empty page cached for an hour.
	if (kind) {
		let known;
		try {
			known = new Set((await loadAccessories()).map((a) => a.kind).filter(Boolean));
		} catch (err) {
			console.error('[assets] accessories manifest unreadable', err?.message);
			return serverError(res, 500, 'manifest_unreadable', err);
		}
		if (!known.has(kind)) {
			return error(
				res,
				400,
				'invalid_kind',
				`\`kind\` must be one of ${[...known].sort().join(', ')}`,
			);
		}
		items = items.filter((i) => i.kind === kind);
	}
	if (loopParam === 'true') items = items.filter((i) => i.type === 'animation' && i.loop === true);
	if (loopParam === 'false') items = items.filter((i) => i.type === 'animation' && i.loop === false);

	const total = items.length;
	items = items.slice(0, limit);

	res.setHeader('content-type', 'application/json; charset=utf-8');
	res.setHeader('cache-control', 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400');
	res.statusCode = 200;
	res.end(JSON.stringify({ ok: true, total, items }));
});
