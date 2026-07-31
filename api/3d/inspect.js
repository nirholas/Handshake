// GET/POST /api/3d/inspect — FREE, keyless glTF/GLB inspection + validation.
//
// The agent use-case: an autonomous agent has a 3D asset (from any source — a
// marketplace, a generation API, a user upload) and, before it commits to using
// it, needs to answer three questions cheaply: is this a spec-valid glTF/GLB,
// how heavy is it (vertices / triangles / materials / textures / animations /
// extensions), and what's the shortest path to making it smaller and faster for
// web/mobile delivery? This endpoint answers all three in one call. It is free
// on purpose — a validation utility drives trust and funnels callers to the paid
// pipelines (Forge Pro quality tiers, Rigged Avatars, mesh optimization).
//
// Input:
//   GET  /api/3d/inspect?url=<https url of a .glb/.gltf>
//   POST /api/3d/inspect            body { "url": "<https url>" }   (application/json)
//   POST /api/3d/inspect            raw .glb/.gltf bytes as the request body
//
// Output:
//   { url, valid, stats:{ vertices, triangles, materials, textures, animations,
//     extensions[], … }, sizeBytes, recommendations:[{ severity, issue, fix }],
//     validation:{ valid, numErrors, numWarnings, …,
//       issues:[{ code, message, severity, pointer? }] }, ts }
//
// `validation.issues` carries the actual glTF-Validator findings (capped at 10;
// the counts beside it are the true totals). Without them a caller that gates on
// `valid` knows only that an asset failed, never why.
//
// Reuses the same inspection core the paid /api/x402/model-check route uses
// (api/_lib/model-inspect.js → src/gltf-inspect.js) plus the official Khronos
// glTF-Validator (gltf-validator npm) for the spec-compliance verdict, and the
// SSRF-hardened, size-capped fetcher (api/_lib/fetch-model.js). Never returns a
// 500 on a well-formed request: every failure maps to a specific 4xx/502.

import { cors, wrap, error, json, rateLimited, readJson, readBody } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { fetchModel, FetchModelError } from '../_lib/fetch-model.js';
import { inspectModel, suggestOptimizations } from '../_lib/model-inspect.js';
import { validateBytes } from 'gltf-validator';

// Free-tier size cap. A generous ceiling for real avatars/props while bounding
// the memory + compute a single anonymous call can spend. GLBs above this are
// almost always un-optimized source assets that the recommendations below would
// tell you to shrink anyway.
const MAX_BYTES = 32 * 1024 * 1024;

// Rank for ordering the recommendations list: most severe first. `suggestOptimizations`
// emits severities but does not order them, so we sort here.
const SEVERITY_RANK = { critical: 0, warn: 1, info: 2 };

// Map each optimization-suggestion id (from suggestOptimizations) to a concise,
// actionable fix. The suggestion's own `message` becomes the `issue` (what's
// wrong); this is the `fix` (what to do about it). Reusing the detector keeps the
// "which suggestions fire" logic in one place (shared with the paid route + the
// MCP tools) — this layer only reshapes it into the { severity, issue, fix }
// contract this endpoint advertises.
const RECOMMENDATION_FIX = {
	tri_budget:
		'Decimate the mesh (gltf-transform simplify) or author LODs before shipping to the web.',
	draco: 'Apply KHR_draco_mesh_compression to the geometry buffers.',
	meshopt: 'Apply EXT_meshopt_compression to the vertex + index buffers (faster decode than Draco).',
	texture_oversized: 'Resize the flagged textures to ≤2048px unless hero-level detail is required.',
	texture_basisu:
		'Transcode PNG/JPEG textures to KTX2 / Basis Universal (KHR_texture_basisu) for GPU-direct upload.',
	non_indexed: 'Re-index the primitives (gltf-transform weld) to remove duplicate vertices.',
	too_many_materials: 'Merge identical materials to cut draw calls.',
	texture_weight: 'Compress textures to KTX2 and resize them for web delivery.',
	file_size: 'Compress geometry (Draco/meshopt) and textures (KTX2); target under 10 MB.',
	anim_without_skin:
		'Confirm the node-level animations are intentional; strip any orphan animation data.',
	ok: 'No action needed — the model is already well-suited for web delivery.',
};

// Reshape the raw inspectModel output into the advertised `stats` block. Keeps the
// prompt-13 core fields (vertices/triangles/materials/textures/animations/extensions)
// and adds a few more the agent almost always wants next (meshes, nodes, skins,
// bone/joint count, required extensions, container, generator).
export function buildStats(info) {
	const c = info.counts;
	return {
		vertices: c.totalVertices,
		triangles: c.totalTriangles,
		materials: c.materials,
		textures: c.textures,
		animations: c.animations,
		extensions: info.extensionsUsed,
		// Extra context — cheap to include, saves the caller a second call.
		meshes: c.meshes,
		nodes: c.nodes,
		scenes: c.scenes,
		skins: c.skins,
		joints: c.totalJoints,
		indexedPrimitives: c.indexedPrimitives,
		nonIndexedPrimitives: c.nonIndexedPrimitives,
		extensionsRequired: info.extensionsRequired,
		container: info.container,
		generator: info.generator,
	};
}

// Build the prioritized { severity, issue, fix } recommendation list, ordered most
// severe first. Reuses suggestOptimizations for detection.
export function buildRecommendations(info) {
	const suggestions = suggestOptimizations(info);
	return suggestions
		.map((s) => ({
			severity: s.severity,
			issue: s.estimate ? `${s.message} (${s.estimate})` : s.message,
			fix: RECOMMENDATION_FIX[s.id] || s.message,
		}))
		.sort((a, b) => (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3));
}

// The validator reports severity as an integer; callers want a word they can
// branch on without memorizing the enum.
const VALIDATOR_SEVERITY = ['error', 'warning', 'info', 'hint'];

// How many individual issues ride along in the response. The validator itself is
// capped at 100 below; a caller needs the first handful to act, not a wall of
// repeats of the same code, and the counts above already carry the true totals.
const MAX_REPORTED_ISSUES = 10;

// Reshape the validator's raw message list into the wire contract: what is wrong,
// where, and how severe. Exported so the shape is pinned in tests without running
// the validator over real bytes.
export function shapeIssues(messages) {
	if (!Array.isArray(messages)) return [];
	return messages.slice(0, MAX_REPORTED_ISSUES).map((m) => ({
		code: typeof m?.code === 'string' ? m.code : 'UNKNOWN',
		message: typeof m?.message === 'string' ? m.message : '',
		severity: VALIDATOR_SEVERITY[m?.severity] || 'error',
		// The JSON pointer into the asset (e.g. /images/0/bufferView). Absent on
		// whole-file issues, so it is omitted rather than sent as an empty string.
		...(typeof m?.pointer === 'string' && m.pointer ? { pointer: m.pointer } : {}),
	}));
}

// Run the Khronos glTF-Validator for the authoritative spec-compliance verdict.
// External resources (a .gltf's side-car .bin/textures) are NOT fetched — GLBs
// are self-contained, and fetching arbitrary side files would reopen the SSRF
// surface fetch-model.js closes. A validator failure never fails the whole call:
// inspectModel already proved the bytes parse, so we degrade to valid:true with a
// note rather than 500. Returns { valid, ...counts, issues[] } or null when
// unavailable.
//
// The `issues` array is the difference between a usable verdict and an unusable
// one. Counts alone tell a caller that the asset failed and nothing about why:
// a CI gate keyed on `valid` can only print "1 error" and stop. Carrying the
// codes and pointers means the same gate can say IMAGE_MIME_TYPE_INVALID at
// /images/0/bufferView, which is a fix, not a mystery.
async function runValidator(bytes, filename) {
	try {
		const report = await validateBytes(bytes, {
			maxIssues: 100,
			uri: filename || 'model.glb',
			externalResourceFunction: (uri) =>
				Promise.reject(new Error(`external resource not fetched: ${uri}`)),
		});
		const issues = report?.issues || {};
		return {
			valid: (issues.numErrors ?? 0) === 0,
			validatorVersion: report?.validatorVersion || null,
			numErrors: issues.numErrors ?? 0,
			numWarnings: issues.numWarnings ?? 0,
			numInfos: issues.numInfos ?? 0,
			numHints: issues.numHints ?? 0,
			issues: shapeIssues(issues.messages),
			truncated: Boolean(issues.truncated),
		};
	} catch {
		return null;
	}
}

// Fetch a model by URL through the SSRF-hardened, size-capped fetcher and translate
// its typed errors into this endpoint's HTTP contract. Blocked/private/invalid URLs
// are the caller's fault → 400; upstream problems → 502 with a retry hint; oversize
// → 413.
async function fetchByUrl(url) {
	try {
		const { bytes, url: finalUrl } = await fetchModel(url, {
			maxBytes: MAX_BYTES,
			timeoutMs: 20_000,
		});
		return { bytes, url: finalUrl };
	} catch (err) {
		if (err instanceof FetchModelError) {
			if (err.code === 'file_too_large') {
				throw httpError(413, 'too_large', `model exceeds the ${MAX_BYTES}-byte free-tier cap`);
			}
			if (['invalid_url', 'scheme_not_allowed', 'private_address', 'host_pin_mismatch'].includes(err.code)) {
				throw httpError(400, 'invalid_url', err.message);
			}
			// upstream_error, too_many_redirects, dns_failed, dns_timeout, no_body, fetch_failed
			throw httpError(502, 'fetch_failed', `could not fetch model: ${err.message}`, {
				retry: 'the source URL did not return the model — check it is public and try again',
			});
		}
		throw httpError(502, 'fetch_failed', `could not fetch model: ${err?.message || err}`);
	}
}

function httpError(status, code, message, extra = {}) {
	const e = new Error(message);
	e.status = status;
	e.code = code;
	e.extra = extra;
	return e;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', origins: '*' })) return;
	if (req.method !== 'GET' && req.method !== 'POST') {
		res.setHeader('allow', 'GET, POST');
		return error(res, 405, 'method_not_allowed', 'use GET (?url=) or POST ({ url } or a raw model body)');
	}

	// Generous per-IP budget — this is a free, keyless utility. Reuses the generic
	// api:ip limiter with an explicit 60/min override, which getLimiter keys into
	// its own isolated bucket (no dedicated limiter needed, no shared-file edit).
	const ip = clientIp(req);
	const rl = await limits.apiIp(ip, { limit: 60, window: '1 m' });
	if (!rl.success) return rateLimited(res, rl, 'too many inspect requests');

	// Resolve the model bytes from one of the three accepted inputs.
	let bytes;
	let sourceUrl = null;
	let filename = 'model.glb';

	try {
		if (req.method === 'GET') {
			const url = String(req.query?.url || '').trim();
			if (!url) {
				return error(res, 400, 'missing_url', 'query param "url" is required (or POST a model body)');
			}
			const fetched = await fetchByUrl(url);
			bytes = fetched.bytes;
			sourceUrl = fetched.url;
			filename = urlFilename(sourceUrl);
		} else {
			const ct = String(req.headers['content-type'] || '').toLowerCase();
			if (ct.includes('application/json')) {
				let body;
				try {
					body = await readJson(req);
				} catch (e) {
					return error(res, e.status === 415 ? 415 : 400, 'invalid_json', e.message || 'invalid JSON body');
				}
				const url = String(body?.url || '').trim();
				if (!url) {
					return error(res, 400, 'missing_url', 'POST JSON must include "url", or upload raw model bytes');
				}
				const fetched = await fetchByUrl(url);
				bytes = fetched.bytes;
				sourceUrl = fetched.url;
				filename = urlFilename(sourceUrl);
			} else {
				// Raw upload: the request body IS the model.
				let raw;
				try {
					raw = await readBody(req, MAX_BYTES);
				} catch (e) {
					if (e.status === 413) {
						return error(res, 413, 'too_large', `upload exceeds the ${MAX_BYTES}-byte free-tier cap`);
					}
					return error(res, 400, 'bad_body', e.message || 'could not read request body');
				}
				if (!raw || raw.byteLength === 0) {
					return error(res, 400, 'empty_body', 'no model bytes uploaded — send a .glb/.gltf body or a "url"');
				}
				// Copy into a tight, zero-offset buffer — `raw` is a Buffer backed by a
				// shared pool, and downstream parsers (glTF-Transform readBinary, the
				// validator) are happiest with a standalone Uint8Array.
				bytes = Uint8Array.from(raw);
			}
		}
	} catch (e) {
		// Typed errors from fetchByUrl (400/413/502) — never a 500.
		return error(res, e.status || 502, e.code || 'fetch_failed', e.message, e.extra || {});
	}

	// Parse structure. A parse failure here means the bytes are not a real glTF/GLB.
	let info;
	try {
		info = await inspectModel(bytes, { fileSize: bytes.byteLength });
	} catch (e) {
		return error(res, 400, 'invalid_model', `not a valid glTF/GLB: ${e.message || 'could not parse model'}`);
	}

	const validation = await runValidator(bytes, filename);
	const stats = buildStats(info);
	const recommendations = buildRecommendations(info);

	const payload = {
		url: sourceUrl,
		// `valid` reflects the Khronos validator's error count when it ran; when the
		// validator is unavailable the bytes still parsed, so it's structurally usable.
		valid: validation ? validation.valid : true,
		stats,
		sizeBytes: bytes.byteLength,
		recommendations,
		validation: validation || { valid: true, note: 'validator unavailable — structural parse succeeded' },
		ts: new Date().toISOString(),
	};

	// URL-sourced GETs are deterministic — let the CDN cache them briefly. Raw
	// uploads and POSTs are never cached.
	if (req.method === 'GET' && sourceUrl) {
		res.setHeader('cache-control', 'public, max-age=60, s-maxage=300');
	} else {
		res.setHeader('cache-control', 'no-store');
	}
	return json(res, 200, payload);
});

function urlFilename(u) {
	try {
		return new URL(u).pathname.split('/').pop() || 'model.glb';
	} catch {
		return 'model.glb';
	}
}
