// POST /api/x402/model-validation-sweep
//
// Paid endpoint ($0.001 USDC) that validates the next public GLB avatar in the
// database awaiting inspection. Called by the autonomous spend loop on a
// scheduled tick — each call validates one avatar and upserts a quality-score
// row into `model_quality_scores`.
//
// The sweep cycles through public avatars ordered by last inspection time
// (NULLS FIRST), so every model is covered before any model is re-checked.
// After 24 hours each row goes stale and re-enters the queue.
//
// Downstream consumer: model_quality_scores is queried by the explore/discovery
// surface to surface quality badges and by future curation pipelines that flag
// models needing attention (missing rig, critical geometry errors, oversized
// textures, etc.). The quality score is also available to the MCP inspect_model
// tool to return pre-cached results.

import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { installAccessControl } from '../_lib/x402/access-control.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { priceFor } from '../_lib/x402-prices.js';
import { sql } from '../_lib/db.js';
import { inspectModel, suggestOptimizations } from '../_lib/model-inspect.js';
import { getObjectBuffer } from '../_lib/r2.js';

const ROUTE = '/api/x402/model-validation-sweep';
const MAX_BYTES = 16 * 1024 * 1024; // 16 MB cap, mirrors model-check.js

const DESCRIPTION =
	'three.ws model quality sweep — picks the next public GLB avatar in the ' +
	'database that has never been inspected (or whose inspection is older than ' +
	'24 hours), downloads the file, runs the glTF-Transform inspector, computes ' +
	'a 0-100 quality score, and records a time-series row. Use to proactively ' +
	'detect geometry errors, missing rigs, and unsupported features before users ' +
	'encounter them in the viewer.';

const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	properties: {},
	additionalProperties: false,
};

const OUTPUT_EXAMPLE = {
	ok: true,
	avatar_id: 'a3f3d6c2-1f1b-4f10-9b6c-1b1f5e0c9c34',
	avatar_name: 'Realistic Male',
	score: 82,
	has_errors: false,
	missing_bones: false,
	counts: {
		scenes: 1, nodes: 22, meshes: 4, materials: 3, textures: 5,
		animations: 12, skins: 1, totalVertices: 8432, totalTriangles: 14200,
		indexedPrimitives: 4, nonIndexedPrimitives: 0,
	},
	extensions_used: ['KHR_draco_mesh_compression'],
	file_size_bytes: 1572864,
	inspected_at: '2026-06-27T10:00:00.000Z',
};

const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['ok'],
	properties: {
		ok: { type: 'boolean' },
		skipped: { type: 'boolean' },
		reason: { type: 'string' },
		error: {
			type: 'string',
			description: 'Set with ok:false when the queued model could not be downloaded or parsed.',
		},
		avatar_id: { type: 'string', format: 'uuid' },
		avatar_name: { type: ['string', 'null'] },
		score: { type: 'integer', minimum: 0, maximum: 100 },
		has_errors: { type: 'boolean' },
		missing_bones: { type: 'boolean' },
		counts: { type: 'object' },
		extensions_used: { type: 'array', items: { type: 'string' } },
		file_size_bytes: { type: ['integer', 'null'] },
		inspected_at: { type: 'string', format: 'date-time' },
	},
};

const BAZAAR = {
	discoverable: true,
	info: {
		input: { type: 'http', method: 'POST', body: {} },
		output: { type: 'json', example: OUTPUT_EXAMPLE },
	},
	schema: buildBazaarSchema({
		method: 'POST',
		bodySchema: INPUT_SCHEMA,
		outputSchema: OUTPUT_SCHEMA,
	}),
};

async function ensureSchema() {
	try {
		await sql`
			CREATE TABLE IF NOT EXISTS model_quality_scores (
				id                  bigserial PRIMARY KEY,
				avatar_id           uuid NOT NULL,
				score               int NOT NULL DEFAULT 0,
				geometry_errors     int NOT NULL DEFAULT 0,
				missing_bones       boolean NOT NULL DEFAULT false,
				unsupported_features text[],
				file_size_bytes     bigint,
				vertices            int,
				triangles           int,
				materials           int,
				textures            int,
				animations          int,
				skins               int,
				extensions_used     text[],
				response_data       jsonb,
				inspected_at        timestamptz DEFAULT now(),
				UNIQUE (avatar_id)
			)
		`;
	} catch { /* already exists or migration system handles it */ }
}

function computeScore(info) {
	let score = 100;
	const c = info.counts;

	// No rig — model won't animate in the three.ws viewer
	if (!c.skins || c.skins === 0) score -= 20;
	// No animation clips packed in the file
	if (!c.animations || c.animations === 0) score -= 10;
	// Non-indexed primitives waste GPU bandwidth
	if ((c.nonIndexedPrimitives || 0) > 0) {
		const total = (c.indexedPrimitives || 0) + (c.nonIndexedPrimitives || 0);
		const ratio = total > 0 ? c.nonIndexedPrimitives / total : 0;
		score -= Math.round(ratio * 15);
	}
	// Oversized file
	if (info.fileSize > 20 * 1024 * 1024) score -= 15;
	else if (info.fileSize > 10 * 1024 * 1024) score -= 7;
	// Excessive triangle count
	if ((c.totalTriangles || 0) > 1_000_000) score -= 15;
	else if ((c.totalTriangles || 0) > 500_000) score -= 8;
	// Excessive material count raises draw-call overhead
	if ((c.materials || 0) > 20) score -= 5;
	// No geometry at all
	if (!c.meshes || c.meshes === 0) score -= 30;

	return Math.max(0, Math.min(100, score));
}

async function fetchAvatarBytes(storageKey) {
	// storage_key is either an R2 object key (u/{ownerId}/…) or an absolute URL
	// for first-party / externally-hosted models.
	if (/^https?:\/\//i.test(storageKey)) {
		const res = await fetch(storageKey, {
			headers: { accept: 'model/gltf-binary,application/octet-stream,*/*' },
			signal: AbortSignal.timeout(20_000),
		});
		if (!res.ok) {
			throw Object.assign(new Error(`upstream ${res.status} ${res.statusText}`), { code: 'fetch_failed' });
		}
		const arr = await res.arrayBuffer();
		if (arr.byteLength > MAX_BYTES) {
			throw Object.assign(new Error(`model is ${arr.byteLength} bytes; max is ${MAX_BYTES}`), { code: 'too_large' });
		}
		return new Uint8Array(arr);
	}

	// R2-backed key — direct bucket read, no presign needed server-side.
	const buf = await getObjectBuffer(storageKey);
	if (buf.byteLength > MAX_BYTES) {
		throw Object.assign(new Error(`model is ${buf.byteLength} bytes; max is ${MAX_BYTES}`), { code: 'too_large' });
	}
	return new Uint8Array(buf);
}

export default paidEndpoint({
	route: ROUTE,
	method: 'POST',
	priceAtomics: priceFor('model-validation-sweep', '1000'),
	networks: ['solana', 'base'],
	description: DESCRIPTION,
	bazaar: BAZAAR,
	service: withService({
		serviceName: 'three.ws Model Validation Sweep',
		tags: ['3d', 'gltf', 'glb', 'validation', 'quality', 'sweep'],
	}),
	// Same internal / subscription / OAuth bypass every other paid x402 route
	// carries, so an operator can run the sweep without a payment leg.
	accessControl: installAccessControl({ requiredScope: 'x402:bypass' }),

	async handler() {
		await ensureSchema();

		// Pick the public avatar that has been waiting longest for inspection.
		// NULLS FIRST ensures never-inspected avatars run before stale ones.
		const [avatar] = await sql`
			SELECT a.id, a.storage_key, a.name
			FROM avatars a
			LEFT JOIN model_quality_scores mqs ON mqs.avatar_id = a.id
			WHERE a.deleted_at IS NULL
			  AND a.visibility = 'public'
			  AND a.storage_key IS NOT NULL
			  AND (
			        mqs.inspected_at IS NULL
			     OR mqs.inspected_at < NOW() - INTERVAL '24 hours'
			     )
			ORDER BY mqs.inspected_at ASC NULLS FIRST, a.created_at ASC
			LIMIT 1
		`;

		if (!avatar) {
			return { ok: true, skipped: true, reason: 'all_models_fresh' };
		}

		const now = new Date().toISOString();
		let info;
		let fetchError = null;

		try {
			const bytes = await fetchAvatarBytes(avatar.storage_key);
			info = await inspectModel(bytes, { fileSize: bytes.byteLength });
		} catch (err) {
			fetchError = err?.message || String(err);
		}

		if (fetchError || !info) {
			// Still record the attempt so the avatar doesn't block the queue.
			await sql`
				INSERT INTO model_quality_scores
					(avatar_id, score, geometry_errors, missing_bones,
					 response_data, inspected_at)
				VALUES
					(${avatar.id}, 0, 0, true,
					 ${JSON.stringify({ error: fetchError })}::jsonb, ${now})
				ON CONFLICT (avatar_id) DO UPDATE SET
					score         = 0,
					response_data = ${JSON.stringify({ error: fetchError })}::jsonb,
					inspected_at  = ${now}
			`.catch((dbErr) =>
				console.error('[model-validation-sweep] error_log_failed', dbErr?.message),
			);

			return {
				ok: false,
				avatar_id: avatar.id,
				avatar_name: avatar.name || null,
				error: fetchError,
				inspected_at: now,
			};
		}

		const c = info.counts;
		const score = computeScore(info);
		const missingBones = !c.skins || c.skins === 0;
		const suggestions = suggestOptimizations(info);
		const hasErrors = suggestions.some((s) => s.severity === 'critical');
		const extUsed = Array.isArray(info.extensionsUsed) && info.extensionsUsed.length > 0
			? info.extensionsUsed
			: null;

		await sql`
			INSERT INTO model_quality_scores
				(avatar_id, score, geometry_errors, missing_bones, file_size_bytes,
				 vertices, triangles, materials, textures, animations, skins,
				 extensions_used, response_data, inspected_at)
			VALUES
				(${avatar.id}, ${score}, ${hasErrors ? 1 : 0}, ${missingBones},
				 ${info.fileSize ?? null},
				 ${c.totalVertices ?? null}, ${c.totalTriangles ?? null},
				 ${c.materials ?? null}, ${c.textures ?? null},
				 ${c.animations ?? null}, ${c.skins ?? null},
				 ${extUsed},
				 ${JSON.stringify({ info, suggestions })}::jsonb, ${now})
			ON CONFLICT (avatar_id) DO UPDATE SET
				score             = EXCLUDED.score,
				geometry_errors   = EXCLUDED.geometry_errors,
				missing_bones     = EXCLUDED.missing_bones,
				file_size_bytes   = EXCLUDED.file_size_bytes,
				vertices          = EXCLUDED.vertices,
				triangles         = EXCLUDED.triangles,
				materials         = EXCLUDED.materials,
				textures          = EXCLUDED.textures,
				animations        = EXCLUDED.animations,
				skins             = EXCLUDED.skins,
				extensions_used   = EXCLUDED.extensions_used,
				response_data     = EXCLUDED.response_data,
				inspected_at      = EXCLUDED.inspected_at
		`.catch((dbErr) => {
			// Log but don't fail — caller already paid and the result is valid.
			console.error('[model-validation-sweep] db_upsert_failed', dbErr?.message);
		});

		return {
			ok: true,
			avatar_id: avatar.id,
			avatar_name: avatar.name || null,
			score,
			has_errors: hasErrors,
			missing_bones: missingBones,
			counts: {
				scenes: c.scenes ?? 0,
				nodes: c.nodes ?? 0,
				meshes: c.meshes ?? 0,
				materials: c.materials ?? 0,
				textures: c.textures ?? 0,
				animations: c.animations ?? 0,
				skins: c.skins ?? 0,
				totalVertices: c.totalVertices ?? 0,
				totalTriangles: c.totalTriangles ?? 0,
				indexedPrimitives: c.indexedPrimitives ?? 0,
				nonIndexedPrimitives: c.nonIndexedPrimitives ?? 0,
			},
			extensions_used: info.extensionsUsed || [],
			file_size_bytes: info.fileSize ?? null,
			inspected_at: now,
		};
	},
});
