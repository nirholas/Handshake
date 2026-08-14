// POST /api/x402/avatar-optimize-batch
//
// Avatar Optimization Pipeline — nightly batch analysis endpoint.
// $0.001 USDC per call. Fetches the top N most-viewed public avatars,
// runs glTF-Transform optimization analysis on each, and stores the
// prioritized suggestion lists to avatar_optimization_results.
//
// Downstream consumers:
//   - avatar_optimization_results table: optimization hints per avatar_id
//   - The /api/avatars/:id endpoint can surface these hints to owners
//   - Autonomous loop health check: confirms optimize_model capability is live
//
// Body: { limit?: 1-50 }  (default 50)
// Response 200: { analyzed, critical_count, warn_count, total_size_bytes, avatars[] }

import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { readBody } from '../_lib/http.js';
import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { installAccessControl } from '../_lib/x402/access-control.js';
import { priceFor } from '../_lib/x402-prices.js';
import { sql } from '../_lib/db.js';
import { publicUrl } from '../_lib/r2.js';
import { inspectModel, suggestOptimizations } from '../_lib/model-inspect.js';

const ROUTE = '/api/x402/avatar-optimize-batch';
const MAX_BATCH = 50;
const FETCH_TIMEOUT_MS = 25_000;
const MAX_MODEL_BYTES = 32 * 1024 * 1024; // 32 MiB

const DESCRIPTION =
	'three.ws Avatar Optimization Pipeline — pay $0.001 USDC to trigger a batch ' +
	'glTF/GLB analysis of the top most-viewed public avatars. Returns a ranked ' +
	'list of optimization suggestions (Draco/Meshopt compression, oversized ' +
	'textures, non-indexed primitives) and stores results per-avatar so owners ' +
	'can be notified of actionable improvements.';

const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	properties: {
		limit: {
			type: 'integer',
			minimum: 1,
			maximum: MAX_BATCH,
			default: MAX_BATCH,
			description: `Number of top avatars to analyze (1–${MAX_BATCH}).`,
		},
	},
};

const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['analyzed', 'critical_count', 'warn_count', 'total_size_bytes', 'avatars'],
	properties: {
		analyzed:          { type: 'integer' },
		critical_count:    { type: 'integer' },
		warn_count:        { type: 'integer' },
		info_count:        { type: 'integer' },
		total_size_bytes:  { type: 'integer' },
		avatars: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					id:             { type: 'string' },
					name:           { type: 'string' },
					size_bytes:     { type: 'integer' },
					critical_count: { type: 'integer' },
					warn_count:     { type: 'integer' },
					info_count:     { type: 'integer' },
					top_suggestion: { type: ['string', 'null'] },
				},
			},
		},
	},
};

const BAZAAR = {
	discoverable: true,
	info: {
		input: { type: 'http', method: 'POST', bodyParams: { limit: 50 } },
		output: {
			type: 'json',
			example: {
				analyzed: 50,
				critical_count: 12,
				warn_count: 38,
				info_count: 91,
				total_size_bytes: 82_000_000,
				avatars: [{ id: 'uuid', name: 'My Avatar', size_bytes: 2_100_000, critical_count: 1, warn_count: 3, info_count: 5, top_suggestion: 'Apply Draco compression to reduce geometry size by ~60%' }],
			},
		},
	},
	schema: buildBazaarSchema({
		method: 'POST',
		bodySchema: INPUT_SCHEMA,
		outputSchema: OUTPUT_SCHEMA,
	}),
};

// Ensure the results table exists. Called once per execution; cheap via IF NOT EXISTS.
async function ensureTable() {
	try {
		await sql`
			CREATE TABLE IF NOT EXISTS avatar_optimization_results (
				id              bigserial PRIMARY KEY,
				avatar_id       uuid NOT NULL,
				avatar_name     text,
				glb_url         text NOT NULL,
				size_bytes      bigint,
				suggestions     jsonb,
				critical_count  int NOT NULL DEFAULT 0,
				warn_count      int NOT NULL DEFAULT 0,
				info_count      int NOT NULL DEFAULT 0,
				analyzed_at     timestamptz DEFAULT now(),
				CONSTRAINT avatar_optimization_results_avatar_id_unique UNIQUE (avatar_id)
			)
		`;
	} catch { /* already exists or migration handled it */ }
}

// Fetch model bytes from a public URL. Returns null on any failure.
async function fetchModelBytes(url) {
	try {
		const res = await fetch(url, {
			redirect: 'follow',
			headers: { accept: 'model/gltf-binary,application/octet-stream' },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!res.ok) return null;
		const buf = new Uint8Array(await res.arrayBuffer());
		if (buf.byteLength > MAX_MODEL_BYTES) return null;
		return buf;
	} catch {
		return null;
	}
}

export default paidEndpoint({
	route: ROUTE,
	method: 'POST',
	// $0.001 USDC. Goes through priceFor so the documented
	// X402_PRICE_AVATAR_OPTIMIZE_BATCH override actually applies; the literal it
	// replaces made this the one endpoint in the directory ops could not reprice.
	priceAtomics: priceFor('avatar-optimize-batch', '1000'),
	networks: ['solana', 'base'],
	description: DESCRIPTION,
	bazaar: BAZAAR,
	service: withService({
		serviceName: 'three.ws Avatar Optimization Pipeline',
		tags: ['3d', 'avatar', 'optimization', 'gltf', 'glb', 'batch'],
	}),
	requiredScope: 'x402:bypass',
	accessControl: installAccessControl({ requiredScope: 'x402:bypass' }),

	async handler({ req }) {
		// Parse optional body params.
		let limit = MAX_BATCH;
		try {
			const chunks = [await readBody(req, 1_000_000)];
			const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
			if (body.limit && typeof body.limit === 'number') {
				limit = Math.max(1, Math.min(MAX_BATCH, Math.floor(body.limit)));
			}
		} catch { /* default limit */ }

		await ensureTable();

		// Fetch top N most-viewed public avatars with their storage keys.
		const avatarRows = await sql`
			SELECT id, name, storage_key, baked_storage_key, size_bytes, visibility
			FROM avatars
			WHERE deleted_at IS NULL
			  AND visibility IN ('public', 'unlisted')
			  AND storage_key IS NOT NULL
			ORDER BY view_count DESC NULLS LAST, created_at DESC
			LIMIT ${limit}
		`;

		if (!avatarRows.length) {
			return { analyzed: 0, critical_count: 0, warn_count: 0, info_count: 0, total_size_bytes: 0, avatars: [] };
		}

		let totalCritical = 0;
		let totalWarn = 0;
		let totalInfo = 0;
		let totalBytes = 0;
		const results = [];

		for (const row of avatarRows) {
			// Use baked key when available (same logic as resolveAvatarUrl's _servedStorageKey).
			const storageKey = row.baked_storage_key || row.storage_key;
			const glbUrl = publicUrl(storageKey);

			let suggestions = [];
			let sizeBytes = Number(row.size_bytes || 0);
			let criticalCount = 0;
			let warnCount = 0;
			let infoCount = 0;

			const bytes = await fetchModelBytes(glbUrl);
			if (bytes) {
				try {
					sizeBytes = bytes.byteLength;
					const info = await inspectModel(bytes, { fileSize: bytes.byteLength });
					suggestions = suggestOptimizations(info);
					for (const s of suggestions) {
						if (s.severity === 'critical') criticalCount++;
						else if (s.severity === 'warn') warnCount++;
						else infoCount++;
					}
				} catch { /* malformed model — skip optimization, record zero suggestions */ }
			}

			totalCritical += criticalCount;
			totalWarn += warnCount;
			totalInfo += infoCount;
			totalBytes += sizeBytes;

			// Upsert results — latest analysis wins.
			try {
				await sql`
					INSERT INTO avatar_optimization_results
						(avatar_id, avatar_name, glb_url, size_bytes, suggestions,
						 critical_count, warn_count, info_count, analyzed_at)
					VALUES
						(${row.id}, ${row.name}, ${glbUrl}, ${sizeBytes},
						 ${JSON.stringify(suggestions)}::jsonb,
						 ${criticalCount}, ${warnCount}, ${infoCount}, now())
					ON CONFLICT (avatar_id) DO UPDATE SET
						avatar_name    = EXCLUDED.avatar_name,
						glb_url        = EXCLUDED.glb_url,
						size_bytes     = EXCLUDED.size_bytes,
						suggestions    = EXCLUDED.suggestions,
						critical_count = EXCLUDED.critical_count,
						warn_count     = EXCLUDED.warn_count,
						info_count     = EXCLUDED.info_count,
						analyzed_at    = now()
				`;
			} catch { /* DB write failure is non-fatal — analysis still succeeds */ }

			results.push({
				id: row.id,
				name: row.name,
				size_bytes: sizeBytes,
				critical_count: criticalCount,
				warn_count: warnCount,
				info_count: infoCount,
				top_suggestion: suggestions.find((s) => s.severity === 'critical')?.message
					|| suggestions.find((s) => s.severity === 'warn')?.message
					|| null,
			});
		}

		return {
			analyzed: results.length,
			critical_count: totalCritical,
			warn_count: totalWarn,
			info_count: totalInfo,
			total_size_bytes: totalBytes,
			avatars: results,
		};
	},
});
