// Forge creation store — durable persistence + the text→3D data flywheel.
//
// /forge runs the real flux-schnell → TRELLIS pipeline (see api/forge.js) and
// hands back the Replicate delivery URL, which expires in ~1h. This module is
// the layer that makes a generator a *data engine*: it copies every generated
// mesh (and its reference image) into our own object storage so they're
// permanent, records the (prompt → image → mesh) pair, and captures the human
// verdict (kept / discarded / downloaded) — the labeled signal a future
// in-house model trains on.
//
// Every function is best-effort and fail-soft. /forge is auth-free and works on
// deployments without a database or object storage configured; when either is
// missing, these helpers no-op (return null/false/[]) and the endpoint falls
// back to returning the raw provider URL. Persistence is a bonus, never a gate.

import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { sql, isDbUnavailableError } from './db.js';
import { databaseConfigured } from './env.js';
import { putObject, publicUrl } from './r2.js';
import { recordGenerationEvent } from './forge-events.js';
import { scoreGlbQuality } from './glb-quality.js';
import { compressGlb } from './glb-compress.js';

// Stable, non-secret salt so a leaked DB row can't be trivially reversed to the
// raw browser-local id. The id is anonymous to begin with; this is hygiene, not
// a security boundary.
const CLIENT_SALT = 'forge:v1';

// Generations larger than this are almost certainly a runaway TRELLIS output;
// refuse to copy them into our bucket rather than ingest an unbounded blob.
const MAX_GLB_BYTES = 64 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

// Forge persistence needs both a database (the creation rows) and object
// storage (durable copies). Detect from the raw env so a partially-configured
// deployment degrades to the stateless path instead of throwing on first use.
export function forgeStoreEnabled() {
	return Boolean(
		databaseConfigured() &&
			process.env.S3_ENDPOINT &&
			process.env.S3_BUCKET &&
			process.env.S3_PUBLIC_DOMAIN &&
			process.env.S3_ACCESS_KEY_ID &&
			process.env.S3_SECRET_ACCESS_KEY,
	);
}

// Hash a caller-supplied anonymous client id. Empty / missing ids collapse to a
// shared 'anon' bucket so the column is never null and gallery scoping is total.
export function hashClient(raw) {
	const value = typeof raw === 'string' ? raw.trim() : '';
	if (!value) return 'anon';
	return createHash('sha256').update(`${CLIENT_SALT}:${value}`).digest('hex');
}

export function hashIp(ip) {
	if (!ip) return null;
	return createHash('sha256').update(`${CLIENT_SALT}:ip:${ip}`).digest('hex');
}

// Record a generation the moment it starts, so the prompt + reference image are
// retained even if the mesh step later fails. Returns the new creation id (used
// as the durable object key and the client-facing handle) or null when the
// store is unavailable.
export const MODEL_CATEGORIES = ['avatar', 'accessory', 'item', 'scene', 'creature', 'vehicle', 'other'];

export function validModelCategory(v) {
	return typeof v === 'string' && MODEL_CATEGORIES.includes(v) ? v : null;
}

export async function createCreation({
	clientKey,
	ipHash,
	prompt,
	aspect,
	previewImageUrl,
	replicateJobId,
	textToImageModel,
	viewsRequested,
	viewsUsed,
	multiview,
	backend,
	tier,
	path,
	modelCategory,
	userId,
}) {
	if (!forgeStoreEnabled()) return null;
	const id = randomUUID();
	const category = validModelCategory(modelCategory) ?? 'other';
	try {
		await sql`
			insert into forge_creations
				(id, client_key, ip_hash, prompt, aspect, preview_image_url,
				 replicate_job_id, text_to_image_model, views_requested, views_used,
				 multiview, backend, tier, path, status, outcome, model_category, user_id)
			values
				(${id}, ${clientKey}, ${ipHash ?? null}, ${prompt}, ${aspect ?? null},
				 ${previewImageUrl ?? null}, ${replicateJobId ?? null},
				 ${textToImageModel ?? null}, ${viewsRequested ?? null}, ${viewsUsed ?? null},
				 ${typeof multiview === 'boolean' ? multiview : null}, ${backend ?? null},
				 ${tier ?? null}, ${path ?? null}, 'generating', 'generated', ${category}, ${userId ?? null})
		`;
		// Funnel start — counts attempts so the health rollup can show how many
		// generations began vs. completed. Best-effort; never blocks the insert.
		await recordGenerationEvent({ phase: 'start', backend, tier, path, source: 'create' });
		return id;
	} catch (err) {
		if (isDbUnavailableError(err)) console.warn('[forge-store] createCreation skipped (db unavailable):', err?.message);
		else console.error('[forge-store] createCreation failed:', err?.message);
		return null;
	}
}

// Look up an in-flight creation by its TRELLIS prediction id, scoped to the
// requesting client so one browser can't poll another's job into existence.
export async function findByJob({ replicateJobId, clientKey }) {
	if (!forgeStoreEnabled() || !replicateJobId) return null;
	try {
		const rows = await sql`
			select id, status, glb_url, glb_key, prompt, preview_image_url,
				views_requested, views_used, multiview, backend, tier, path, model_category,
				created_at
			from forge_creations
			where replicate_job_id = ${replicateJobId} and client_key = ${clientKey}
			limit 1
		`;
		return rows[0] ?? null;
	} catch (err) {
		if (isDbUnavailableError(err)) console.warn('[forge-store] findByJob skipped (db unavailable):', err?.message);
		else console.error('[forge-store] findByJob failed:', err?.message);
		return null;
	}
}

// Provider asset URLs are frequently short-lived (HuggingFace Spaces serve the
// mesh from an ephemeral gradio /tmp path; CDNs hiccup). Pull the bytes with a
// few quick retries so a transient network error or 5xx/429 — the dominant cause
// of "materializeCreation failed: 404/5xx" in the logs — doesn't permanently lose
// a generation. A hard 404/410 means the file is already gone, so retrying is
// pointless: fail fast on those and let the caller fall back to the provider URL.
const COPY_MAX_ATTEMPTS = 3;
const COPY_RETRY_BASE_MS = 400;

// Score + (optionally) compress a freshly-downloaded GLB before it lands in the
// bucket. Both steps are pure, local, and best-effort: a scoring/compression
// failure never blocks delivery — it just means the response carries no
// quality signal, or ships the original uncompressed bytes. `compress` is one
// of COMPRESSION_MODES ('draco' | 'meshopt') or falsy to skip.
async function scoreAndCompress(buf, { computeQuality, compress }) {
	let quality = null;
	let compression = null;
	if (computeQuality) {
		try {
			quality = scoreGlbQuality(buf);
		} catch (err) {
			console.warn('[forge-store] quality scoring failed:', err?.message);
		}
	}
	let outBuf = buf;
	if (compress) {
		try {
			const result = await compressGlb(buf, { mode: compress });
			if (result.grew) {
				compression = { mode: result.mode, skipped: true, reason: 'no_size_benefit' };
			} else {
				outBuf = result.buffer;
				compression = {
					mode: result.mode,
					input_bytes: result.inputBytes,
					output_bytes: result.outputBytes,
					ratio: result.ratio,
				};
			}
		} catch (err) {
			console.warn(`[forge-store] compression (${compress}) failed, delivering uncompressed:`, err?.message);
			compression = { mode: compress, skipped: true, reason: 'compression_failed' };
		}
	}
	return { buf: outBuf, quality, compression };
}

async function copyToBucket({ sourceUrl, key, fallbackContentType, maxBytes, computeQuality = false, compress = null, forceContentType = null }) {
	let lastErr;
	for (let attempt = 1; attempt <= COPY_MAX_ATTEMPTS; attempt++) {
		try {
			const resp = await fetch(sourceUrl);
			if (!resp.ok) {
				const err = new Error(`fetch ${sourceUrl}: ${resp.status}`);
				err.status = resp.status;
				// 404/410 = the ephemeral asset has already expired; no retry can recover it.
				if (resp.status === 404 || resp.status === 410) throw err;
				// 408/425/429/5xx are transient — retry within the loop.
				if (attempt < COPY_MAX_ATTEMPTS) { lastErr = err; }
				else throw err;
			} else {
				let buf = Buffer.from(await resp.arrayBuffer());
				if (buf.length > maxBytes) throw new Error(`asset too large: ${buf.length} bytes`);
				// forceContentType wins over the upstream header: providers (Replicate
				// et al.) often serve ephemeral output blobs as `application/octet-stream`
				// or another generic type regardless of the actual bytes. Trusting that
				// verbatim into R2's stored Content-Type is what made every homepage
				// forge thumbnail fail Chrome's Opaque Response Blocking — the browser
				// won't render a cross-origin <img> whose declared type isn't an image
				// type. Callers that know the asset kind (e.g. the preview image, whose
				// extension is already decided by imageExtFor) should force it.
				const contentType = forceContentType || resp.headers.get('content-type') || fallbackContentType;
				let quality = null;
				let compression = null;
				if (computeQuality || compress) {
					const scored = await scoreAndCompress(buf, { computeQuality, compress });
					buf = scored.buf;
					quality = scored.quality;
					compression = scored.compression;
				}
				await putObject({ key, body: buf, contentType, metadata: { source: 'forge' } });
				return { bytes: buf.length, publicUrl: publicUrl(key), quality, compression };
			}
		} catch (err) {
			// Permanent (404/410) or too-large: surface immediately. Network errors
			// (fetch throw) are transient and retried until attempts are exhausted.
			if (err?.status === 404 || err?.status === 410 || /asset too large/.test(err?.message || '')) throw err;
			lastErr = err;
			if (attempt >= COPY_MAX_ATTEMPTS) throw err;
		}
		await new Promise((r) => setTimeout(r, COPY_RETRY_BASE_MS * attempt));
	}
	throw lastErr;
}

function imageExtFor(url) {
	const m = /\.(png|jpe?g|webp)(\?|$)/i.exec(url || '');
	return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'webp';
}

const IMAGE_CONTENT_TYPE_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
function imageContentTypeFor(ext) {
	return IMAGE_CONTENT_TYPE_BY_EXT[ext] || 'image/webp';
}

// Copy a finished generation into durable storage and flip the row to 'done'.
// Copies the mesh (required) and the reference image (best-effort). Returns the
// durable { id, glbUrl, previewImageUrl, quality, compression } or null on any
// failure so the caller can fall back to the provider URL.
//
// Two additive, opt-in params:
//   quality  — when true, scores the mesh (glb-quality.js) and returns the
//              signal in `quality`. Off by default so an existing caller's
//              response shape and latency are unaffected.
//   compress — 'draco' | 'meshopt' to deliver a geometry-compressed variant
//              (glb-compress.js) instead of the raw provider bytes. Falls back
//              to uncompressed on any compression failure — never blocks
//              delivery. Omitted/null preserves today's uncompressed behavior.
export async function materializeCreation({ replicateJobId, clientKey, glbUrl, quality = false, compress = null }) {
	if (!forgeStoreEnabled() || !replicateJobId || !glbUrl) return null;
	const existing = await findByJob({ replicateJobId, clientKey });
	if (!existing) return null;
	// Idempotent: a repeat poll after completion returns the durable copy.
	if (existing.status === 'done' && existing.glb_url) {
		return {
			id: existing.id,
			glbUrl: existing.glb_url,
			previewImageUrl: existing.preview_image_url ?? null,
			quality: null,
			compression: null,
		};
	}

	const keyPrefix = `forge/${clientKey.slice(0, 12)}/${existing.id}`;
	try {
		const glb = await copyToBucket({
			sourceUrl: glbUrl,
			key: `${keyPrefix}.glb`,
			fallbackContentType: 'model/gltf-binary',
			maxBytes: MAX_GLB_BYTES,
			computeQuality: quality,
			compress,
		});

		// Reference image is part of the training pair but never blocks the mesh.
		let preview = { key: null, url: existing.preview_image_url ?? null };
		if (existing.preview_image_url) {
			try {
				const ext = imageExtFor(existing.preview_image_url);
				const copied = await copyToBucket({
					sourceUrl: existing.preview_image_url,
					key: `${keyPrefix}.${ext}`,
					fallbackContentType: 'image/webp',
					forceContentType: imageContentTypeFor(ext),
					maxBytes: MAX_IMAGE_BYTES,
				});
				preview = { key: `${keyPrefix}.${ext}`, url: copied.publicUrl };
			} catch (imgErr) {
				console.error('[forge-store] preview copy failed:', imgErr?.message);
			}
		}

		await sql`
			update forge_creations
			set status = 'done',
				glb_key = ${`${keyPrefix}.glb`},
				glb_url = ${glb.publicUrl},
				preview_key = ${preview.key},
				preview_image_url = ${preview.url},
				size_bytes = ${glb.bytes},
				updated_at = now()
			where id = ${existing.id} and client_key = ${clientKey}
		`;
		// Terminal success — the one universal completion writer every lane (free
		// HF, async Replicate poll, BYOK) flows through, so it's where the rolling
		// success/latency counters are recorded. Latency is wall-clock from the row's
		// created_at; null if the timestamp is unreadable rather than a bogus number.
		const startedAt = existing.created_at ? Date.parse(existing.created_at) : NaN;
		const latencyMs = Number.isFinite(startedAt) ? Date.now() - startedAt : null;
		await recordGenerationEvent({
			phase: 'done',
			backend: existing.backend,
			tier: existing.tier,
			path: existing.path,
			latencyMs,
			source: 'materialize',
		});
		return {
			id: existing.id,
			glbUrl: glb.publicUrl,
			previewImageUrl: preview.url,
			quality: glb.quality ?? null,
			compression: glb.compression ?? null,
		};
	} catch (err) {
		// A 404/410 means the provider's ephemeral asset (e.g. a HuggingFace Space's
		// gradio /tmp mesh) expired before we could copy it — expected and fully
		// handled here by returning null so the caller falls back to the provider
		// URL. Log it at WARN so it doesn't flood the actionable-error view; genuine
		// failures (storage write, oversize, 5xx after retries) stay at ERROR.
		const recoverable = err?.status === 404 || err?.status === 410;
		const log = recoverable ? console.warn : console.error;
		log('[forge-store] materializeCreation failed:', err?.message);
		return null;
	}
}

// Attach a client-rendered poster to a creation that has no preview image.
// Geometry-first and sketch lanes never paint a flux reference image, so their
// gallery/showcase cards had nothing to show; the browser renders the actual
// mesh to a small webp and posts it here. Fill-only: a row that already has a
// preview (the flux reference image — part of the training pair) is never
// overwritten. Scoped to the owning client. Returns the durable URL or null.
export async function attachPoster({ id, clientKey, body, contentType, ext }) {
	if (!forgeStoreEnabled() || !id || !body) return null;
	try {
		const rows = await sql`
			select id, preview_image_url
			from forge_creations
			where id = ${id} and client_key = ${clientKey} and status = 'done'
			limit 1
		`;
		const existing = rows[0];
		if (!existing || existing.preview_image_url) return null;

		const key = `forge/${clientKey.slice(0, 12)}/${id}-poster.${ext}`;
		await putObject({ key, body, contentType, metadata: { source: 'forge-poster' } });
		const url = publicUrl(key);
		const updated = await sql`
			update forge_creations
			set preview_key = ${key}, preview_image_url = ${url}, updated_at = now()
			where id = ${id} and client_key = ${clientKey} and preview_image_url is null
			returning id
		`;
		return updated.length > 0 ? url : null;
	} catch (err) {
		console.error('[forge-store] attachPoster failed:', err?.message);
		return null;
	}
}

export async function markFailed({ replicateJobId, clientKey, error }) {
	if (!forgeStoreEnabled() || !replicateJobId) return;
	try {
		const rows = await sql`
			update forge_creations
			set status = 'failed', error = ${String(error || 'generation failed').slice(0, 500)}, updated_at = now()
			where replicate_job_id = ${replicateJobId} and client_key = ${clientKey} and status != 'done'
			returning backend, tier, path
		`;
		// Terminal failure — counted only when a row actually flipped to 'failed'
		// (returning is empty when the job already completed or never existed), so a
		// stray late poll can't inflate the failure rate.
		const row = rows[0];
		if (row) {
			await recordGenerationEvent({
				phase: 'failed',
				backend: row.backend,
				tier: row.tier,
				path: row.path,
				source: 'mark_failed',
			});
		}
	} catch (err) {
		console.error('[forge-store] markFailed failed:', err?.message);
	}
}

const VALID_OUTCOMES = new Set(['accepted', 'rejected', 'generated']);

// Capture the human verdict on a creation. Scoped to the owning client so a
// verdict can't be forged for someone else's row. Returns true on a real write.
export async function recordFeedback({ id, clientKey, outcome, downloaded, rating, note }) {
	if (!forgeStoreEnabled() || !id) return false;
	const nextOutcome = VALID_OUTCOMES.has(outcome) ? outcome : null;
	const nextRating =
		Number.isInteger(rating) && rating >= 1 && rating <= 5 ? rating : null;
	const nextNote = typeof note === 'string' && note.trim() ? note.trim().slice(0, 500) : null;
	const markDownloaded = downloaded === true;
	// Nothing meaningful to record → don't touch the row.
	if (!nextOutcome && nextRating === null && nextNote === null && !markDownloaded) return false;
	try {
		const rows = await sql`
			update forge_creations
			set outcome      = coalesce(${nextOutcome}, outcome),
				rating       = coalesce(${nextRating}, rating),
				note         = coalesce(${nextNote}, note),
				downloaded   = (downloaded or ${markDownloaded}),
				feedback_at  = now(),
				updated_at   = now()
			where id = ${id} and client_key = ${clientKey}
			returning id
		`;
		return rows.length > 0;
	} catch (err) {
		console.error('[forge-store] recordFeedback failed:', err?.message);
		return false;
	}
}

// Update the model_category on a forge creation. Scoped to the owning client.
export async function setForgeCategory({ id, clientKey, modelCategory }) {
	if (!forgeStoreEnabled() || !id) return false;
	const category = validModelCategory(modelCategory);
	if (!category) return false;
	try {
		const rows = await sql`
			update forge_creations
			set model_category = ${category}, updated_at = now()
			where id = ${id} and client_key = ${clientKey}
			returning id
		`;
		return rows.length > 0;
	} catch (err) {
		console.error('[forge-store] setForgeCategory failed:', err?.message);
		return false;
	}
}

// Fetch a single durable creation by id, NOT scoped to any client. Powers the
// share flow: a recipient who didn't forge the model still gets to view it.
// Only returns finished, durably-stored rows — an in-flight or failed creation
// has no public artifact to show. Returns null when missing or store-disabled.
export async function getPublicCreation({ id }) {
	if (!forgeStoreEnabled() || !id) return null;
	try {
		const rows = await sql`
			select fc.id, fc.prompt, fc.aspect, fc.glb_url, fc.preview_image_url, fc.outcome,
				fc.views_used, fc.multiview, fc.backend, fc.tier, fc.path, fc.model_category, fc.created_at,
				u.username as creator_username
			from forge_creations fc
			left join users u on u.id = fc.user_id and u.deleted_at is null
			where fc.id = ${id} and fc.status = 'done' and fc.glb_url is not null
			limit 1
		`;
		const r = rows[0];
		if (!r) return null;
		return {
			id: r.id,
			prompt: r.prompt,
			aspect: r.aspect,
			glb_url: r.glb_url,
			preview_image_url: r.preview_image_url,
			outcome: r.outcome,
			views_used: r.views_used ?? null,
			multiview: r.multiview ?? null,
			backend: r.backend ?? null,
			tier: r.tier ?? null,
			path: r.path ?? null,
			model_category: r.model_category ?? 'other',
			created_at: r.created_at,
			// Real, opt-in attribution only — set when the model was forged while
			// signed in. Never invented for anonymous generations.
			creatorUsername: r.creator_username || null,
		};
	} catch (err) {
		console.error('[forge-store] getPublicCreation failed:', err?.message);
		return null;
	}
}

// Link an already-created creation to the one it was derived from, marking it as
// a refinement/remix in the lineage. Called AFTER the derived model is generated
// (the base row exists from createCreation), so the durable parent → child edge
// is written without touching the many-laned /api/forge submit path. Sets
// parent_creation_id + refine_instruction + lineage_index. Idempotent per row.
// Returns true on success, false when the store is unavailable or the row is
// missing / not owned by clientKey.
export async function linkRefinement({
	creationId,
	clientKey,
	parentCreationId,
	refineInstruction,
	lineageIndex,
}) {
	if (!forgeStoreEnabled() || !creationId || !parentCreationId) return false;
	try {
		const rows = await sql`
			update forge_creations
			set parent_creation_id = ${parentCreationId},
				refine_instruction = ${refineInstruction ?? null},
				lineage_index = ${typeof lineageIndex === 'number' ? lineageIndex : 1},
				updated_at = now()
			where id = ${creationId}
				and (${clientKey}::text is null or client_key = ${clientKey})
				and parent_creation_id is null
			returning id
		`;
		return rows.length > 0;
	} catch (err) {
		console.error('[forge-store] linkRefinement failed:', err?.message);
		return false;
	}
}

// Return the full lineage thread rooted at rootCreationId: the root itself plus
// all descendants in lineage_index order. Fails soft (returns []) when the store
// is unavailable or the root doesn't exist. The caller reconstructs the tree
// structure using parent_creation_id + lineage_index.
export async function getLineage({ rootCreationId, clientKey }) {
	if (!forgeStoreEnabled() || !rootCreationId) return [];
	try {
		// Recursive CTE: walk descendants of the root creation. Up to 50 versions
		// per thread (a hard cap so a misbehaving recursive loop can't exhaust the
		// connection pool). Rows are returned newest-first within each lineage_index
		// so the latest refinement at each depth comes first.
		const rows = await sql`
			with recursive thread as (
				select id, parent_creation_id, prompt, refine_instruction, lineage_index,
					glb_url, preview_image_url, status, backend, created_at
				from forge_creations
				where id = ${rootCreationId}
					and (${clientKey}::text is null or client_key = ${clientKey})
				union all
				select fc.id, fc.parent_creation_id, fc.prompt, fc.refine_instruction,
					fc.lineage_index, fc.glb_url, fc.preview_image_url, fc.status,
					fc.backend, fc.created_at
				from forge_creations fc
				join thread t on fc.parent_creation_id = t.id
			)
			select * from thread
			order by lineage_index asc, created_at asc
			limit 50
		`;
		return rows.map((r) => ({
			id: r.id,
			parent_creation_id: r.parent_creation_id,
			prompt: r.prompt,
			refine_instruction: r.refine_instruction,
			lineage_index: r.lineage_index,
			glb_url: r.glb_url,
			preview_image_url: r.preview_image_url,
			status: r.status,
			backend: r.backend,
			created_at: r.created_at,
		}));
	} catch (err) {
		console.error('[forge-store] getLineage failed:', err?.message);
		return [];
	}
}

// Newest durable creations for one anonymous client — powers the gallery.
export async function listCreations({ clientKey, limit = 24 }) {
	if (!forgeStoreEnabled()) return [];
	const capped = Math.min(Math.max(Number(limit) || 24, 1), 48);
	try {
		const rows = await sql`
			select id, prompt, aspect, glb_url, preview_image_url, outcome, downloaded,
				views_used, multiview, backend, tier, path, model_category, created_at
			from forge_creations
			where client_key = ${clientKey} and status = 'done' and glb_url is not null
			order by created_at desc
			limit ${capped}
		`;
		return rows.map((r) => ({
			id: r.id,
			prompt: r.prompt,
			aspect: r.aspect,
			glb_url: r.glb_url,
			preview_image_url: r.preview_image_url,
			outcome: r.outcome,
			downloaded: r.downloaded,
			views_used: r.views_used ?? null,
			multiview: r.multiview ?? null,
			backend: r.backend ?? null,
			tier: r.tier ?? null,
			path: r.path ?? null,
			model_category: r.model_category ?? 'other',
			created_at: r.created_at,
		}));
	} catch (err) {
		if (isDbUnavailableError(err)) console.warn('[forge-store] listCreations skipped (db unavailable):', err?.message);
		else console.error('[forge-store] listCreations failed:', err?.message);
		return [];
	}
}

// A signed-in creator's finished, durably-stored models — powers the
// "Models" tab on their public portfolio (/u/:username). Scoped to user_id,
// not client_key, so it only ever surfaces creations made while logged in;
// anonymous forges (the majority) never attach to any profile. Cursor
// pagination by created_at mirrors listRemixable so the profile's "load
// more" can page through a prolific creator's full history.
export async function listCreationsByUser({ userId, limit = 24, before } = {}) {
	if (!forgeStoreEnabled() || !userId) return [];
	const capped = Math.min(Math.max(Number(limit) || 24, 1), 60);
	try {
		const rows = before
			? await sql`
				select id, prompt, glb_url, preview_image_url, model_category,
					parent_creation_id, remixable, created_at
				from forge_creations
				where user_id = ${userId} and status = 'done' and glb_url is not null
					and created_at < ${before}
				order by created_at desc
				limit ${capped}
			`
			: await sql`
				select id, prompt, glb_url, preview_image_url, model_category,
					parent_creation_id, remixable, created_at
				from forge_creations
				where user_id = ${userId} and status = 'done' and glb_url is not null
				order by created_at desc
				limit ${capped}
			`;
		return rows.map((r) => ({
			id: r.id,
			type: 'model',
			prompt: r.prompt,
			glbUrl: r.glb_url,
			previewImageUrl: r.preview_image_url,
			category: r.model_category ?? 'other',
			isRemix: Boolean(r.parent_creation_id),
			remixable: Boolean(r.remixable),
			createdAt: r.created_at,
		}));
	} catch (err) {
		if (isDbUnavailableError(err)) console.warn('[forge-store] listCreationsByUser skipped (db unavailable):', err?.message);
		else console.error('[forge-store] listCreationsByUser failed:', err?.message);
		return [];
	}
}

// Count of a signed-in creator's finished, stored models — cheap stat-strip
// number, separate from the paginated list above.
export async function countCreationsByUser({ userId } = {}) {
	if (!forgeStoreEnabled() || !userId) return 0;
	try {
		const [row] = await sql`
			select count(*)::int as n
			from forge_creations
			where user_id = ${userId} and status = 'done' and glb_url is not null
		`;
		return row?.n ?? 0;
	} catch (err) {
		if (isDbUnavailableError(err)) console.warn('[forge-store] countCreationsByUser skipped (db unavailable):', err?.message);
		else console.error('[forge-store] countCreationsByUser failed:', err?.message);
		return 0;
	}
}

// Newest durable creations across ALL clients — powers the public "Fresh from
// the Forge" showcase on /forge. Same public-artifact bar as the share flow
// (getPublicCreation): finished rows with a stored GLB only. Rows the creator
// explicitly discarded (outcome = 'rejected') are excluded — a model its own
// maker rated as bad is not showcase material. No client_key in the SELECT, so
// nothing identifying ever leaves the store.
export async function listShowcase({ limit = 12 } = {}) {
	if (!forgeStoreEnabled()) return [];
	const capped = Math.min(Math.max(Number(limit) || 12, 1), 24);
	try {
		// Visual-first: the showcase is a shop window, so rows that have a
		// preview image lead; recency breaks ties. Geometry-first lanes paint
		// no reference image — their cards still work (the GLB is the artifact)
		// but they shouldn't bury the visual rows.
		const rows = await sql`
			select id, prompt, glb_url, preview_image_url,
				views_used, multiview, backend, tier, path, model_category, created_at
			from forge_creations
			where status = 'done' and glb_url is not null
				and (outcome is null or outcome != 'rejected')
			order by (preview_image_url is not null) desc, created_at desc
			limit ${capped}
		`;
		return rows.map((r) => ({
			id: r.id,
			prompt: r.prompt,
			glb_url: r.glb_url,
			preview_image_url: r.preview_image_url,
			views_used: r.views_used ?? null,
			multiview: r.multiview ?? null,
			backend: r.backend ?? null,
			tier: r.tier ?? null,
			path: r.path ?? null,
			model_category: r.model_category ?? 'other',
			created_at: r.created_at,
		}));
	} catch (err) {
		if (isDbUnavailableError(err)) console.warn('[forge-store] listShowcase skipped (db unavailable):', err?.message);
		else console.error('[forge-store] listShowcase failed:', err?.message);
		return [];
	}
}

// Newest durable creations across ALL clients, WITH creator attribution when
// the creator was signed in — powers the platform-wide activity feed
// (api/users/me/feed.js, scope=all) and /community. Same public-artifact bar
// as listShowcase (finished rows with a stored GLB, nothing rejected by its
// own maker), but left-joins users so a signed-in creator's forge shows up
// with a real profile link while an anonymous one (the majority) still
// appears with no identity attached rather than being excluded.
export async function listRecentCreations({ limit = 24, before } = {}) {
	if (!forgeStoreEnabled()) return [];
	const capped = Math.min(Math.max(Number(limit) || 24, 1), 60);
	try {
		const rows = before
			? await sql`
				select fc.id, fc.prompt, fc.glb_url, fc.preview_image_url, fc.model_category,
					fc.parent_creation_id, fc.created_at,
					u.username, u.display_name, u.avatar_url
				from forge_creations fc
				left join users u on u.id = fc.user_id and u.deleted_at is null and u.username is not null
				where fc.status = 'done' and fc.glb_url is not null
					and (fc.outcome is null or fc.outcome != 'rejected')
					and fc.created_at < ${before}
				order by fc.created_at desc
				limit ${capped}`
			: await sql`
				select fc.id, fc.prompt, fc.glb_url, fc.preview_image_url, fc.model_category,
					fc.parent_creation_id, fc.created_at,
					u.username, u.display_name, u.avatar_url
				from forge_creations fc
				left join users u on u.id = fc.user_id and u.deleted_at is null and u.username is not null
				where fc.status = 'done' and fc.glb_url is not null
					and (fc.outcome is null or fc.outcome != 'rejected')
				order by fc.created_at desc
				limit ${capped}`;
		return rows.map((r) => ({
			id: r.id,
			type: 'model',
			prompt: r.prompt,
			glbUrl: r.glb_url,
			previewImageUrl: r.preview_image_url,
			category: r.model_category ?? 'other',
			isRemix: Boolean(r.parent_creation_id),
			createdAt: r.created_at,
			username: r.username || null,
			displayName: r.display_name || null,
			avatarUrl: r.avatar_url || null,
		}));
	} catch (err) {
		if (isDbUnavailableError(err)) console.warn('[forge-store] listRecentCreations skipped (db unavailable):', err?.message);
		else console.error('[forge-store] listRecentCreations failed:', err?.message);
		return [];
	}
}

// ── Remix economy ────────────────────────────────────────────────────────────
//
// A creator opts a finished creation into the remix bazaar (setRemixable) with a
// license, a royalty rate, and a Solana payout wallet. Other agents browse the
// opted-in assets (listRemixable), inspect one's provenance + terms before
// remixing (getRemixSource), and — after a paid remix settles — the royalty
// settlement is recorded back onto the source (recordRemixSettlement). All of
// this lives on the SAME forge_creations rows the generator already writes; no
// parallel asset store. USDC is the settlement asset only — no other coin.

const REMIX_LICENSES = new Set(['remix-cc', 'remix-nc', 'remix-royalty', 'all-rights']);

// Opt a creation into (or out of) the remix bazaar and set its terms. Scoped to
// the owning client_key so one browser can't publish another's model. Only a
// done row with a stored GLB can be made remixable. Royalty bps is clamped at
// the DB check constraint (0–2000); we pre-clamp for a clean error path.
export async function setRemixable({ creationId, clientKey, remixable, royaltyBps, creatorWallet, license }) {
	if (!forgeStoreEnabled() || !creationId || !clientKey) return null;
	const bps = Math.max(0, Math.min(2000, Math.round(Number(royaltyBps ?? 1000)) || 0));
	const lic = REMIX_LICENSES.has(license) ? license : null;
	try {
		const rows = await sql`
			update forge_creations
			set remixable = ${remixable !== false},
				remix_royalty_bps = ${bps},
				creator_wallet_solana = ${creatorWallet ?? null},
				model_category = coalesce(model_category, 'other'),
				updated_at = now()
			where id = ${creationId}
				and client_key = ${clientKey}
				and status = 'done'
				and glb_url is not null
			returning id, remixable, remix_royalty_bps, creator_wallet_solana
		`;
		if (!rows.length) return null;
		const r = rows[0];
		return {
			id: r.id,
			remixable: r.remixable,
			royaltyBps: r.remix_royalty_bps,
			creatorWallet: r.creator_wallet_solana,
			license: lic || 'remix-royalty',
		};
	} catch (err) {
		console.error('[forge-store] setRemixable failed:', err?.message);
		return null;
	}
}

// Newest remixable creations across all creators — powers the remix feed /
// creator marketplace gallery (prompt 09). Only done rows with a stored GLB
// and remixable = true are surfaced.
//
// Three sort modes, matched to what can be paginated safely:
//   - 'recent' (default): cursor by created_at (`before` = last item's ISO
//     timestamp) — true infinite scroll, monotonic key.
//   - 'royalty': highest creator royalty rate first. Non-monotonic across
//     pages, so `before` is ignored — this returns a fixed top-N list (a
//     leaderboard slice, same pattern trending/leaderboard surfaces use
//     everywhere on the platform — they don't infinite-scroll either).
//   - 'remixed': most-derived-from first (a live count of child creations),
//     same fixed top-N behavior as 'royalty'.
// `q` does a case-insensitive substring match on the prompt; `category` filters
// to one of MODEL_CATEGORIES. Both are additive, backward-compatible with the
// original (limit, before)-only call shape.
export async function listRemixable({ limit = 24, before, category, q, sort } = {}) {
	if (!forgeStoreEnabled()) return [];
	const capped = Math.min(Math.max(Number(limit) || 24, 1), 48);
	const sortMode = sort === 'royalty' || sort === 'remixed' ? sort : 'recent';
	const cat = validModelCategory(category);
	const search = typeof q === 'string' && q.trim() ? q.trim().slice(0, 120) : null;

	const params = [];
	const conds = [`p.remixable = true`, `p.status = 'done'`, `p.glb_url is not null`];
	if (cat) {
		params.push(cat);
		conds.push(`p.model_category = $${params.length}`);
	}
	if (search) {
		params.push(`%${search}%`);
		conds.push(`p.prompt ilike $${params.length}`);
	}
	// The cursor only makes sense for the monotonic 'recent' sort.
	if (sortMode === 'recent' && before) {
		params.push(before);
		conds.push(`p.created_at < $${params.length}`);
	}
	params.push(capped);
	const limitParam = `$${params.length}`;

	const orderBy =
		sortMode === 'royalty'
			? `p.remix_royalty_bps desc, p.created_at desc`
			: sortMode === 'remixed'
				? `remix_count desc, p.created_at desc`
				: `p.created_at desc`;

	try {
		const rows = await sql(
			`select p.id, p.prompt, p.glb_url, p.preview_image_url, p.remix_royalty_bps,
				p.creator_wallet_solana, p.parent_creation_id, p.lineage_index,
				p.backend, p.model_category, p.created_at,
				coalesce(rc.remix_count, 0) as remix_count
			 from forge_creations p
			 left join (
				select parent_creation_id, count(*) as remix_count
				from forge_creations
				where parent_creation_id is not null and status = 'done'
				group by parent_creation_id
			 ) rc on rc.parent_creation_id = p.id
			 where ${conds.join(' and ')}
			 order by ${orderBy}
			 limit ${limitParam}`,
			params,
		);
		return rows.map((r) => ({
			id: r.id,
			prompt: r.prompt,
			glb_url: r.glb_url,
			preview_image_url: r.preview_image_url,
			royaltyBps: r.remix_royalty_bps ?? 0,
			// Provenance + terms VISIBLE before remixing — but never leak the raw
			// payout wallet in the public feed; only whether royalties can route.
			royaltyPayable: Boolean(r.creator_wallet_solana),
			isDerived: Boolean(r.parent_creation_id),
			lineageIndex: r.lineage_index ?? 0,
			remixCount: Number(r.remix_count) || 0,
			backend: r.backend ?? null,
			model_category: r.model_category ?? 'other',
			created_at: r.created_at,
		}));
	} catch (err) {
		if (isDbUnavailableError(err)) console.warn('[forge-store] listRemixable skipped (db unavailable):', err?.message);
		else console.error('[forge-store] listRemixable failed:', err?.message);
		return [];
	}
}

// The most-remixed published assets, platform-wide — the "trending" half of
// the creator marketplace leaderboard (prompt 09). Counts REAL child rows
// (finished derivatives whose parent_creation_id points at this asset), not a
// synthetic popularity score. A source that is no longer published as
// remixable can still appear (its remix history is a fact even if it was later
// unpublished) — the caller renders that as "no longer remixable".
export async function listMostRemixed({ limit = 10 } = {}) {
	if (!forgeStoreEnabled()) return [];
	const capped = Math.min(Math.max(Number(limit) || 10, 1), 24);
	try {
		const rows = await sql`
			with remix_counts as (
				select parent_creation_id, count(*) as remix_count
				from forge_creations
				where parent_creation_id is not null and status = 'done'
				group by parent_creation_id
			)
			select p.id, p.prompt, p.glb_url, p.preview_image_url, p.remix_royalty_bps,
				p.creator_wallet_solana, p.remixable, p.model_category, p.created_at,
				rc.remix_count
			from remix_counts rc
			join forge_creations p on p.id = rc.parent_creation_id
			where p.status = 'done' and p.glb_url is not null
			order by rc.remix_count desc, p.created_at desc
			limit ${capped}
		`;
		return rows.map((r) => ({
			id: r.id,
			prompt: r.prompt,
			glb_url: r.glb_url,
			preview_image_url: r.preview_image_url,
			royaltyBps: r.remix_royalty_bps ?? 0,
			royaltyPayable: Boolean(r.creator_wallet_solana),
			remixable: Boolean(r.remixable),
			remixCount: Number(r.remix_count) || 0,
			model_category: r.model_category ?? 'other',
			created_at: r.created_at,
		}));
	} catch (err) {
		if (isDbUnavailableError(err)) console.warn('[forge-store] listMostRemixed skipped (db unavailable):', err?.message);
		else console.error('[forge-store] listMostRemixed failed:', err?.message);
		return [];
	}
}

// Fetch one remixable source with the fields settlement needs: its GLB, the
// reference image to anchor the remix, the royalty rate, and the payout wallet.
// Includes the wallet (unlike the public feed) because the caller is the
// settlement path, not a browser. Returns null when missing or not remixable.
export async function getRemixSource({ creationId }) {
	if (!forgeStoreEnabled() || !creationId) return null;
	try {
		const rows = await sql`
			select id, client_key, user_id, prompt, glb_url, preview_image_url,
				remixable, remix_royalty_bps, creator_wallet_solana,
				parent_creation_id, lineage_index, aspect, created_at
			from forge_creations
			where id = ${creationId} and status = 'done' and glb_url is not null
			limit 1
		`;
		if (!rows.length) return null;
		const r = rows[0];
		return {
			id: r.id,
			clientKey: r.client_key,
			userId: r.user_id ?? null,
			prompt: r.prompt,
			glbUrl: r.glb_url,
			previewImageUrl: r.preview_image_url,
			remixable: r.remixable === true,
			royaltyBps: r.remix_royalty_bps ?? 0,
			creatorWallet: r.creator_wallet_solana,
			parentCreationId: r.parent_creation_id,
			lineageIndex: r.lineage_index ?? 0,
			aspect: r.aspect,
			createdAt: r.created_at,
		};
	} catch (err) {
		console.error('[forge-store] getRemixSource failed:', err?.message);
		return null;
	}
}

// Record a completed royalty settlement on the SOURCE creation (the one that was
// remixed). Stored as JSONB carrying the on-chain tx, amount, and the remix that
// triggered it — the append-only provenance of income earned. Best-effort.
export async function recordRemixSettlement({ sourceCreationId, settlement }) {
	if (!forgeStoreEnabled() || !sourceCreationId || !settlement) return false;
	try {
		await sql`
			update forge_creations
			set remix_settlement_ref = ${JSON.stringify(settlement)}::jsonb,
				updated_at = now()
			where id = ${sourceCreationId}
		`;
		return true;
	} catch (err) {
		console.error('[forge-store] recordRemixSettlement failed:', err?.message);
		return false;
	}
}
