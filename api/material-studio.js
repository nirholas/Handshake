// POST /api/material-studio — Material Studio: AI PBR restyle + seeded
// colorway variants + durable checkpoint uploads for arbitrary GLBs.
//
// Free and hosted, like /api/mcp-studio: no wallet, no account, no x402 dance.
// Abuse is bounded by server-side rate limits (api/_lib/rate-limit.js
// materialStudioRestyle / materialStudioUpload) instead of payment — the same
// "hosted FREE lane, bounded by rate limits" doctrine forge_free and the free
// 3D Studio already use. The restyle_material MCP tool
// (mcp-server/src/tools/restyle-material.js) is a thin, PAID stdio client over
// this SAME endpoint, so the free web page and the paid agent tool can never
// drift — one implementation, two transports.
//
//   GET  /api/material-studio                    → discovery doc
//   POST /api/material-studio?action=upload       (body: raw GLB bytes)
//        → validate + persist a client-exported GLB; returns a durable URL.
//          Used to checkpoint a lineage version (Save) and to turn a local
//          file-drop into an https URL the other two actions can operate on.
//   POST /api/material-studio?action=restyle      { glb_url, instruction, material_index? }
//        → AI PBR restyle ("make it chrome" / "wooden" / "cyberpunk"): IBM
//          Granite proposes PBR factors, applied + re-exported server-side.
//   POST /api/material-studio?action=variants     { glb_url, preset?, seed?, count?, material_index? }
//        → N reproducible colorway variants of one preset (seeded PRNG).
//
// Every failure throws BEFORE any object is persisted — a bad request never
// leaves a half-written asset in storage.

import { cors, json, error, method, wrap, readBody, rateLimited } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { MATERIAL_PRESET_NAMES } from '@three-ws/viewer-presets';
import {
	MaterialStudioError,
	restyleMaterialFromInstruction,
	generateSeededVariants,
	validateAndPersistGlb,
} from './_lib/material-studio-store.js';
import { getSessionUser } from './_lib/auth.js';
import { recordMaterialRestyle } from './_lib/material-restyle-store.js';

const ROUTE = '/api/material-studio';
const MAX_GLB_UPLOAD_BYTES = 64 * 1024 * 1024;
const MAX_JSON_BODY_BYTES = 16_384;
const MAX_INSTRUCTION_LEN = 300;

function badRequest(code, message) {
	return Object.assign(new Error(message), { status: 400, code });
}

async function readJsonBody(req) {
	const buf = await readBody(req, MAX_JSON_BODY_BYTES);
	const raw = buf.toString('utf8').trim();
	if (!raw) return {};
	try {
		return JSON.parse(raw);
	} catch {
		throw badRequest('invalid_json', 'request body must be valid JSON');
	}
}

function parseMaterialIndex(v) {
	return Number.isInteger(v) && v >= 0 ? v : undefined;
}

function parseParentLineage(v) {
	return Array.isArray(v) ? v : undefined;
}

function parseParentIndex(v) {
	return Number.isInteger(v) && v >= 0 ? v : undefined;
}

const discovery = wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;
	return json(res, 200, {
		route: ROUTE,
		description:
			'Material Studio: free, rate-limited AI PBR restyle and seeded colorway ' +
			'variant generation for arbitrary GLB models. No wallet or account required.',
		actions: {
			upload: {
				method: 'POST',
				query: '?action=upload',
				body: 'raw GLB bytes (content-type: model/gltf-binary)',
				returns: '{ url, bytes }',
			},
			restyle: {
				method: 'POST',
				query: '?action=restyle',
				body: '{ glb_url, instruction, material_index?, parent_lineage?, parent_index? }',
				returns:
					'{ glbUrl, sourceGlbUrl, instruction, factors, materialsEdited, lineage, activeIndex }',
			},
			variants: {
				method: 'POST',
				query: '?action=variants',
				body: '{ glb_url, preset?, seed?, count?, material_index?, parent_lineage?, parent_index? }',
				presets: MATERIAL_PRESET_NAMES,
				returns: '{ variants: [{ glbUrl, label, seed, config, lineageIndex }], lineage, activeIndex }',
			},
		},
		lineage:
			'Every restyle/variants response includes an immutable parent → child version lineage ' +
			'(the same shape refine_model uses). Pass the returned `lineage` array back in as ' +
			'`parent_lineage` on the next call to extend one thread; add `parent_index` to branch off ' +
			'an earlier version instead of the latest.',
		web: 'https://three.ws/restyle',
	});
});

async function handleUpload(req, res, ip) {
	const rl = await limits.materialStudioUpload(ip);
	if (!rl.success) return rateLimited(res, rl, 'Upload limit reached. Try again shortly.');
	const bytes = await readBody(req, MAX_GLB_UPLOAD_BYTES);
	const result = await validateAndPersistGlb(bytes, { keyPrefix: 'material-studio/checkpoints' });
	return json(res, 200, { ok: true, url: result.url, bytes: result.bytes });
}

async function handleRestyle(req, res, ip) {
	const rl = await limits.materialStudioRestyle(ip);
	if (!rl.success) return rateLimited(res, rl, 'Restyle limit reached. Try again shortly.');
	const body = await readJsonBody(req);
	const glbUrl = typeof body.glb_url === 'string' ? body.glb_url.trim() : '';
	const instruction = typeof body.instruction === 'string' ? body.instruction.trim() : '';
	if (!glbUrl) throw badRequest('missing_glb_url', '"glb_url" is required');
	if (!instruction) throw badRequest('missing_instruction', '"instruction" is required');
	if (instruction.length > MAX_INSTRUCTION_LEN) {
		throw badRequest('instruction_too_long', `"instruction" must be at most ${MAX_INSTRUCTION_LEN} characters`);
	}
	const result = await restyleMaterialFromInstruction({
		glbUrl,
		instruction,
		materialIndex: parseMaterialIndex(body.material_index),
		parentLineage: parseParentLineage(body.parent_lineage),
		parentIndex: parseParentIndex(body.parent_index),
	});
	// Best-effort: attribute to the signed-in caller so it shows up on their
	// public portfolio's Creations tab. Never blocks or fails generation.
	const userId = await getSessionUser(req).then((u) => u?.id || null).catch(() => null);
	recordMaterialRestyle({
		userId,
		action: 'restyle',
		sourceUrl: result.sourceGlbUrl || glbUrl,
		resultUrl: result.glbUrl,
		instruction,
		materialIndex: parseMaterialIndex(body.material_index) ?? null,
	}).catch(() => {});
	return json(res, 200, { ok: true, ...result });
}

async function handleVariants(req, res, ip) {
	const rl = await limits.materialStudioRestyle(ip);
	if (!rl.success) return rateLimited(res, rl, 'Variant generation limit reached. Try again shortly.');
	const body = await readJsonBody(req);
	const glbUrl = typeof body.glb_url === 'string' ? body.glb_url.trim() : '';
	if (!glbUrl) throw badRequest('missing_glb_url', '"glb_url" is required');
	const result = await generateSeededVariants({
		glbUrl,
		preset: typeof body.preset === 'string' ? body.preset : undefined,
		seed: Number.isFinite(body.seed) ? body.seed : undefined,
		count: Number.isFinite(body.count) ? body.count : undefined,
		materialIndex: parseMaterialIndex(body.material_index),
		parentLineage: parseParentLineage(body.parent_lineage),
		parentIndex: parseParentIndex(body.parent_index),
	});
	// Best-effort: one row per generated variant so a prolific creator's whole
	// colorway fan-out shows up on their portfolio, not just a single card.
	const userId = await getSessionUser(req).then((u) => u?.id || null).catch(() => null);
	if (userId && Array.isArray(result.variants)) {
		Promise.all(
			result.variants.map((v) =>
				recordMaterialRestyle({
					userId,
					action: 'variants',
					label: v.label || null,
					sourceUrl: glbUrl,
					resultUrl: v.glbUrl,
					preset: typeof body.preset === 'string' ? body.preset : null,
					seed: Number.isFinite(v.seed) ? v.seed : null,
					materialIndex: parseMaterialIndex(body.material_index) ?? null,
				}),
			),
		).catch(() => {});
	}
	return json(res, 200, { ok: true, ...result });
}

const post = wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;
	const ip = clientIp(req);
	const url = new URL(req.url, 'http://localhost');
	const action = url.searchParams.get('action');
	try {
		if (action === 'upload') return await handleUpload(req, res, ip);
		if (action === 'restyle') return await handleRestyle(req, res, ip);
		if (action === 'variants') return await handleVariants(req, res, ip);
	} catch (err) {
		if (err instanceof MaterialStudioError) {
			return error(res, err.status, err.code, err.message);
		}
		throw err;
	}
	return error(res, 400, 'unknown_action', 'Unknown ?action — use upload, restyle, or variants.');
});

export default function handler(req, res) {
	if (req.method === 'GET') return discovery(req, res);
	return post(req, res);
}
