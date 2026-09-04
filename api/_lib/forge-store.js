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
import { putObject, publicUrl, deleteObject, keyFromPublicUrl, objectStorageConfigured } from './r2.js';
import { recordDailyActivity, maybeAwardFirstCreation } from './streaks.js';
import { recordGenerationEvent } from './forge-events.js';
import { scoreGlbQuality } from './glb-quality.js';
import { compressGlb } from './glb-compress.js';
import { classifyModelCategory } from './forge-classify.js';
import { cleanupGlb } from './glb-cleanup.js';
import { derivePbrChannels } from './glb-pbr-derive.js';
import { fetchUpstream } from './upstream-fetch.js';
import { gradeSimReadiness } from './sim-readiness.js';
import { putGrade } from './sim-readiness-store.js';

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
	return Boolean(databaseConfigured() && objectStorageConfigured());
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

// Resolve the reference-view URLs a generation consumes down to the bucket keys
// of the user's own uploads (forge/uploads/..., written by api/forge-upload.js).
// Provider-hosted URLs (FLUX previews on a delivery CDN, pasted external links)
// resolve to null and are dropped: they are not ours to delete. Returns a
// deduplicated array, or null when nothing bucket-hosted is present, so the
// column stays null for the text-to-3D majority.
function sourceImageKeysFrom(urls) {
	const keys = new Set();
	for (const url of Array.isArray(urls) ? urls : []) {
		const key = keyFromPublicUrl(url);
		if (key && key.startsWith('forge/')) keys.add(key);
	}
	return keys.size ? [...keys].slice(0, 12) : null;
}

// Record a generation the moment it starts, so the prompt + reference image are
// retained even if the mesh step later fails. Returns the new creation id (used
// as the durable object key and the client-facing handle) or null when the
// store is unavailable.
export const MODEL_CATEGORIES = ['avatar', 'accessory', 'item', 'scene', 'creature', 'vehicle', 'other'];

export function validModelCategory(v) {
	return typeof v === 'string' && MODEL_CATEGORIES.includes(v) ? v : null;
}

// x402 payment provenance, shaped for read-path spreads. Only rows created by
// the paid /api/x402/forge lane carry these; every other lane spreads nothing,
// so existing consumers see no new keys on non-x402 items.
function x402Provenance(r) {
	if (!r?.x402_tx_sig && !r?.x402_payer) return {};
	return {
		x402: {
			payer: r.x402_payer ?? null,
			tx_sig: r.x402_tx_sig ?? null,
			price_usdc: r.x402_price_atomic != null ? Number(r.x402_price_atomic) / 1e6 : null,
		},
	};
}

// Stamp the on-chain receipt onto a creation the paid x402 lane just recorded:
// who paid, the settle signature, and the price. Keyed the same way as every
// other store writer (replicate_job_id + client_key) so it can only touch the
// row its caller created. Best-effort: a miss is logged, never thrown.
export async function attachX402Provenance({ replicateJobId, clientKey, payer, txSig, priceAtomic }) {
	if (!forgeStoreEnabled() || !replicateJobId || !clientKey) return false;
	try {
		const rows = await sql`
			update forge_creations
			set x402_payer = ${payer ?? null},
				x402_tx_sig = ${txSig ?? null},
				x402_price_atomic = ${Number.isFinite(Number(priceAtomic)) ? Number(priceAtomic) : null},
				updated_at = now()
			where replicate_job_id = ${replicateJobId} and client_key = ${clientKey}
			returning id
		`;
		return rows.length > 0;
	} catch (err) {
		if (isDbUnavailableError(err)) console.warn('[forge-store] attachX402Provenance skipped (db unavailable):', err?.message);
		else console.error('[forge-store] attachX402Provenance failed:', err?.message);
		return false;
	}
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
	// Every reference-view URL the generation consumes (multiview lanes pass the
	// full list). Bucket-hosted ones (the user's own uploaded photos) are
	// resolved to their object keys and remembered on the row so deleteCreation
	// can erase the photos too. Defaults to the preview URL, which is the single
	// reference view on every non-multiview lane, so callers that pass nothing
	// still get their upload tracked.
	sourceImageUrls = null,
}) {
	if (!forgeStoreEnabled()) return null;
	const id = randomUUID();
	// An explicit category (from the studio picker) always wins; otherwise infer
	// it from the prompt so the model gets a real category at birth instead of
	// defaulting to 'other' and leaving the category dimension dead.
	const category = validModelCategory(modelCategory) ?? classifyModelCategory(prompt);
	const sourceKeys = sourceImageKeysFrom(
		Array.isArray(sourceImageUrls) && sourceImageUrls.length ? sourceImageUrls : [previewImageUrl],
	);
	try {
		await sql`
			insert into forge_creations
				(id, client_key, ip_hash, prompt, aspect, preview_image_url,
				 replicate_job_id, text_to_image_model, views_requested, views_used,
				 multiview, backend, tier, path, status, outcome, model_category, user_id,
				 source_image_keys)
			values
				(${id}, ${clientKey}, ${ipHash ?? null}, ${prompt}, ${aspect ?? null},
				 ${previewImageUrl ?? null}, ${replicateJobId ?? null},
				 ${textToImageModel ?? null}, ${viewsRequested ?? null}, ${viewsUsed ?? null},
				 ${typeof multiview === 'boolean' ? multiview : null}, ${backend ?? null},
				 ${tier ?? null}, ${path ?? null}, 'generating', 'generated', ${category}, ${userId ?? null},
				 ${sourceKeys ? JSON.stringify(sourceKeys) : null})
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

// Register a finished selfie/prompt reconstruction (api/_lib/reconstruct-
// finalize.js) as a first-class creation, so the Forge surfaces — showcase,
// recent feed, share/embed pages, leaderboards — see reconstructions the same
// way they see /forge generations. The row lands already 'done': the GLB is
// durably stored by the avatar pipeline before this is called, so there is no
// generating phase to track here.
//
// Privacy contract: `visibility` mirrors the avatar's setting. Public feeds
// only serve null/'public' rows (see the visibility predicates on the list
// readers below); 'unlisted' additionally resolves on the direct share read
// (getPublicCreation); 'private' rows exist for provenance and the owner's own
// stores only. The client_key is derived from the owner's user id — it never
// matches a browser's anonymous key, which keeps these rows out of every
// anonymous client gallery.
//
// Idempotent per job: keyed on replicate_job_id (the regen job id), so the
// poll/cron race that can double-drive finalize registers one row, not two.
export async function registerReconstructionCreation({
	userId,
	avatarId,
	jobId,
	provider,
	prompt,
	glbKey,
	glbUrl,
	sizeBytes,
	visibility,
	previewImageUrl = null,
}) {
	if (!forgeStoreEnabled() || !userId || !avatarId || !jobId || !glbUrl) return null;
	const vis = ['public', 'unlisted', 'private'].includes(visibility) ? visibility : 'private';
	const promptLine = String(prompt || 'Selfie avatar').slice(0, 500);
	try {
		const existing = await sql`
			select id from forge_creations where replicate_job_id = ${jobId} limit 1
		`;
		if (existing[0]) return existing[0].id;
		const id = randomUUID();
		await sql`
			insert into forge_creations
				(id, client_key, prompt, preview_image_url, replicate_job_id,
				 glb_key, glb_url, size_bytes, backend, path, status, outcome,
				 model_category, user_id, visibility, avatar_id)
			values
				(${id}, ${hashClient(`user:${userId}`)}, ${promptLine}, ${previewImageUrl},
				 ${jobId}, ${glbKey ?? null}, ${glbUrl}, ${Number.isFinite(sizeBytes) ? sizeBytes : null},
				 ${provider ?? null}, 'reconstruct', 'done', 'generated', 'avatar',
				 ${userId}, ${vis}, ${avatarId})
		`;
		await recordGenerationEvent({ phase: 'done', backend: provider ?? 'unknown', path: 'reconstruct', source: 'reconstruct' });
		return id;
	} catch (err) {
		if (isDbUnavailableError(err)) console.warn('[forge-store] registerReconstructionCreation skipped (db unavailable):', err?.message);
		else console.error('[forge-store] registerReconstructionCreation failed:', err?.message);
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
				user_id, created_at
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
// A provider delivery blob can be tens of MB; the deadline covers the whole
// body read, so it is sized for the 64 MB ceiling on a slow origin.
const COPY_TIMEOUT_MS = 120_000;

// Score, clean, derive PBR channels for, and (optionally) compress a freshly
// downloaded GLB before it lands in the bucket. Every step is pure, local, and
// best-effort: a failure never blocks delivery — it just means the response
// carries no quality signal, or ships the un-cleaned / uncompressed bytes.
// `compress` is one of COMPRESSION_MODES ('draco' | 'meshopt') or falsy to
// skip. `cleanup` runs the codec-independent geometry cleanup (glb-cleanup.js)
// that tames the workers' raw marching-cubes triangle soup; on by default for
// forge meshes. `derivePbr` runs the material completion pass
// (glb-pbr-derive.js) that turns an albedo-only lane output into a full PBR set
// (normal + packed occlusion/roughness/metallic + the class's measured
// extension layer); on by default, pass false to deliver the lane's own
// materials untouched.
async function scoreAndCompress(buf, { computeQuality, compress, cleanup = false, derivePbr = false, prompt = '', tier = '', materialClass = '' }) {
	let quality = null;
	let compression = null;
	let cleaned = null;
	let pbr = null;
	let outBuf = buf;
	// Cleanup FIRST: a welded, de-duplicated, decimated mesh both renders better
	// and compresses better than the raw soup, so the codec below operates on the
	// cleaned geometry. Skips itself if it would grow the file (tiny meshes).
	if (cleanup) {
		try {
			const r = await cleanupGlb(outBuf);
			if (!r.grew) {
				outBuf = r.buffer;
				cleaned = {
					tris_before: r.trisBefore,
					tris_after: r.trisAfter,
					verts_before: r.vertsBefore,
					verts_after: r.vertsAfter,
					input_bytes: r.inputBytes,
					output_bytes: r.outputBytes,
					simplified: r.simplified,
				};
			}
		} catch (err) {
			console.warn('[forge-store] geometry cleanup failed, delivering as-is:', err?.message);
		}
	}
	// Material completion SECOND: it reads the albedo the lane baked and writes
	// derived maps onto the geometry cleanup just settled, so it has to run after
	// cleanup and before the codec pass (a Draco/meshopt-encoded buffer would
	// have to be decoded again to touch its materials) and before quality
	// scoring, so `no_materials` reflects what users actually receive.
	if (derivePbr) {
		try {
			const r = await derivePbrChannels(outBuf, { prompt, tier, materialClass });
			if (r.changed) {
				outBuf = r.buffer;
				pbr = {
					input_bytes: r.inputBytes,
					output_bytes: r.outputBytes,
					materials_created: r.materialsCreated,
					normals_filled: r.normalsFilled,
					mime_types_fixed: r.mimeTypesFixed,
					materials: r.materials,
				};
			}
		} catch (err) {
			console.warn('[forge-store] PBR derivation failed, delivering lane materials as-is:', err?.message);
		}
	}
	if (computeQuality) {
		try {
			quality = scoreGlbQuality(outBuf);
		} catch (err) {
			console.warn('[forge-store] quality scoring failed:', err?.message);
		}
	}
	if (compress) {
		try {
			const result = await compressGlb(outBuf, { mode: compress });
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
	return { buf: outBuf, quality, compression, cleaned, pbr };
}

// An upstream Content-Type ends up as the object's stored type, which the CDN
// then serves from the three.ws origin. Only ever store a media type: a
// provider (or a redirect chain that ends somewhere unexpected) answering with
// `text/html` or `image/svg+xml` must not get to decide that.
const STORABLE_TYPE_RE = /^(?:image\/(?:png|jpeg|webp|gif|avif)|model\/[\w.+-]+|video\/(?:mp4|webm)|audio\/[\w.+-]+|application\/(?:json|octet-stream))$/;

function mediaTypeOr(header, fallback) {
	const type = String(header || '').split(';')[0].trim().toLowerCase();
	return STORABLE_TYPE_RE.test(type) ? type : fallback;
}

async function copyToBucket({ sourceUrl, key, fallbackContentType, maxBytes, computeQuality = false, compress = null, cleanup = false, derivePbr = false, prompt = '', tier = '', materialClass = '', forceContentType = null }) {
	// fetchUpstream retries network errors and 408/425/429/5xx with jittered
	// backoff and gives up immediately on 404/410 (the ephemeral asset has
	// already expired; no retry can recover it), rejecting with an error that
	// carries `status` so callers keep classifying it the same way.
	const resp = await fetchUpstream(sourceUrl, {}, { timeoutMs: COPY_TIMEOUT_MS, attempts: COPY_MAX_ATTEMPTS, label: 'forge asset copy' });
	let buf = Buffer.from(await resp.arrayBuffer());
	if (buf.length > maxBytes) throw new Error(`asset too large: ${buf.length} bytes`);
	// forceContentType wins over the upstream header: providers (Replicate
	// et al.) often serve ephemeral output blobs as `application/octet-stream`
	// or another generic type regardless of the actual bytes. Trusting that
	// verbatim into R2's stored Content-Type is what made every homepage
	// forge thumbnail fail Chrome's Opaque Response Blocking: the browser
	// won't render a cross-origin <img> whose declared type isn't an image
	// type. Callers that know the asset kind (e.g. the preview image, whose
	// extension is already decided by imageExtFor) should force it.
	const contentType = forceContentType || mediaTypeOr(resp.headers.get('content-type'), fallbackContentType);
	let quality = null;
	let compression = null;
	let cleaned = null;
	if (computeQuality || compress || cleanup) {
		const scored = await scoreAndCompress(buf, { computeQuality, compress, cleanup });
		buf = scored.buf;
		quality = scored.quality;
		compression = scored.compression;
		cleaned = scored.cleaned;
	}
	await putObject({ key, body: buf, contentType, metadata: { source: 'forge' } });
	// `buffer` is the bytes actually stored, post-cleanup and post-compression, so
	// a caller that hashes or grades them is describing the asset users receive
	// rather than the provider's original, and does it without a second fetch.
	return { bytes: buf.length, publicUrl: publicUrl(key), quality, compression, cleaned, buffer: buf };
}

function imageExtFor(url) {
	const m = /\.(png|jpe?g|webp)(\?|$)/i.exec(url || '');
	return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'webp';
}

const IMAGE_CONTENT_TYPE_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
function imageContentTypeFor(ext) {
	return IMAGE_CONTENT_TYPE_BY_EXT[ext] || 'image/webp';
}

// Grade the delivered mesh for simulation readiness and cache the report by its
// content hash (api/_lib/sim-readiness-store.js). Every finished generation
// becomes a graded asset, which is what turns the free grade endpoint from an
// on-demand tool into a growing corpus: by the time anyone asks about one of our
// meshes, the answer is already a hash lookup.
//
// Deliberately fire-and-forget and fully wrapped. Grading is ~1.5 s of pure CPU
// against a generation that already took tens of seconds, but a user waiting on
// their model must never lose it to a grader bug or a database blip: any failure
// here leaves the creation ungraded and delivered, never failed.
function gradeDeliveredMesh({ buffer, creationId, sourceUrl }) {
	if (!buffer?.length) return;
	const started = Date.now();
	Promise.resolve()
		.then(() => gradeSimReadiness(buffer))
		.then((report) =>
			putGrade({
				glbSha256: createHash('sha256').update(buffer).digest('hex'),
				report,
				sourceUrl,
				creationId,
				sizeBytes: buffer.length,
				gradeMs: Date.now() - started,
			}),
		)
		.catch((err) => console.warn('[forge-store] simulation-readiness grading failed:', err?.message));
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
//   cleanup  — run the codec-independent geometry cleanup (glb-cleanup.js:
//              dedup/join/weld/simplify) on the delivered mesh. On by default:
//              every forge mesh is raw marching-cubes output that benefits, and
//              it's best-effort (any failure ships the original bytes). Pass
//              false to deliver the provider geometry untouched.
export async function materializeCreation({ replicateJobId, clientKey, glbUrl, quality = false, compress = null, cleanup = true }) {
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
			cleaned: null,
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
			cleanup,
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
		// Every delivered mesh gets a physics grade, cached by content hash.
		gradeDeliveredMesh({ buffer: glb.buffer, creationId: existing.id, sourceUrl: glb.publicUrl });
		// A finished, signed-in creation is a qualifying streak action + the
		// trigger for the "first creation" badge. Fire-and-forget — never blocks
		// delivery of the model itself.
		if (existing.user_id) {
			recordDailyActivity(existing.user_id).catch(() => {});
			maybeAwardFirstCreation(existing.user_id).catch(() => {});
		}
		return {
			id: existing.id,
			glbUrl: glb.publicUrl,
			previewImageUrl: preview.url,
			quality: glb.quality ?? null,
			compression: glb.compression ?? null,
			cleaned: glb.cleaned ?? null,
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

/**
 * Link a failed attempt to the successor row that re-ran it on another lane.
 *
 * Both failover paths already resubmit the original inputs and create a
 * successor creation row; without this link the ledger shows only the failure,
 * so the health sensor and the error report count a recovered attempt as a
 * user-visible loss (see the migration 20260814200000_forge_failover_supersede
 * for the production numbers that motivated it).
 *
 * Best-effort by design: the failover itself has already succeeded by the time
 * this runs, and losing the annotation must never turn a recovered generation
 * into a failed one.
 *
 * @param {{ replicateJobId: string, clientKey: string, successorId: string }} input
 * @returns {Promise<boolean>} true when a row was annotated.
 */
export async function markSupersededBy({ replicateJobId, clientKey, successorId }) {
	if (!forgeStoreEnabled() || !replicateJobId || !successorId) return false;
	try {
		const rows = await sql`
			update forge_creations
			set superseded_by = ${successorId}, updated_at = now()
			where replicate_job_id = ${replicateJobId}
			  and client_key = ${clientKey}
			  and status = 'failed'
			  and superseded_by is null
			returning id
		`;
		return rows.length > 0;
	} catch (err) {
		console.error('[forge-store] markSupersededBy failed:', err?.message);
		return false;
	}
}

// Permanently delete a creation: the stored mesh, the stored preview, every
// recorded source upload (the user's reference photos), and the row itself.
// Scoped to the owning client_key so one browser can never erase another's
// work. Bucket objects go first: if storage refuses, the row survives and the
// user can simply retry; deleting the row first would strand unreferenced
// bytes with no handle left to retry from. The row delete then cascades
// forge_votes and forge_comments; lineage children and forge_board_winners
// null their reference (see the migrations that created those FKs).
// Returns 'deleted' | 'not_found' | 'error' | 'unavailable'.
export async function deleteCreation({ id, clientKey }) {
	if (!forgeStoreEnabled() || !id || !clientKey) return 'unavailable';
	try {
		const rows = await sql`
			select id, glb_key, glb_url, preview_key, preview_image_url, source_image_keys
			from forge_creations
			where id = ${id} and client_key = ${clientKey}
			limit 1
		`;
		const row = rows[0];
		if (!row) return 'not_found';

		// Every bucket object the row points at. URL-derived keys cover legacy
		// rows written before the *_key columns existed, and a preview that still
		// points at the raw upload because the durable copy failed. The forge/
		// prefix guard keeps a corrupted row from ever deleting outside the
		// forge namespace.
		const keys = new Set();
		for (const k of [row.glb_key, row.preview_key]) {
			if (typeof k === 'string' && k.startsWith('forge/')) keys.add(k);
		}
		for (const u of [row.glb_url, row.preview_image_url]) {
			const k = keyFromPublicUrl(u);
			if (k && k.startsWith('forge/')) keys.add(k);
		}
		for (const k of Array.isArray(row.source_image_keys) ? row.source_image_keys : []) {
			if (typeof k === 'string' && k.startsWith('forge/')) keys.add(k);
		}
		await Promise.all([...keys].map((key) => deleteObject(key)));

		await sql`delete from forge_creations where id = ${id} and client_key = ${clientKey}`;
		return 'deleted';
	} catch (err) {
		if (isDbUnavailableError(err)) {
			console.warn('[forge-store] deleteCreation skipped (db unavailable):', err?.message);
			return 'unavailable';
		}
		console.error('[forge-store] deleteCreation failed:', err?.message);
		return 'error';
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
export async function getPublicCreation({ id, voterKey = null }) {
	if (!forgeStoreEnabled() || !id) return null;
	try {
		const rows = await sql`
			select fc.id, fc.prompt, fc.aspect, fc.glb_url, fc.preview_image_url, fc.outcome,
				fc.views_used, fc.multiview, fc.backend, fc.tier, fc.path, fc.model_category, fc.created_at,
				fc.x402_payer, fc.x402_tx_sig, fc.x402_price_atomic,
				fc.vote_count, fc.size_bytes, fc.remixable, fc.remix_royalty_bps,
				fc.parent_creation_id, fc.refine_instruction,
				coalesce(fc.view_count, 0) as view_count,
				(select count(*)::int from forge_creations c where c.parent_creation_id = fc.id) as remix_count,
				exists(select 1 from forge_votes v
					where v.creation_id = fc.id and v.voter_key = ${voterKey ?? ''}) as voted,
				u.username as creator_username,
				u.display_name as creator_display_name,
				u.avatar_url as creator_avatar_url,
				g.report as sim_readiness,
				g.graded_at as sim_readiness_graded_at
			from forge_creations fc
			left join users u on u.id = fc.user_id and u.deleted_at is null
			-- The physics grade for this creation's own bytes, written when the
			-- generation was materialized. Joined here so the model page renders
			-- the verdict without a second round trip and, more importantly,
			-- without re-fetching the GLB just to recompute a hash it already has
			-- a row for. Null is the honest answer for an older creation nobody
			-- has graded yet, and the page has a state for that.
			left join sim_readiness_grades g on g.creation_id = fc.id
			where fc.id = ${id} and fc.status = 'done' and fc.glb_url is not null
				and (fc.visibility is null or fc.visibility in ('public', 'unlisted'))
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
			vote_count: r.vote_count ?? 0,
			voted: r.voted === true,
			view_count: r.view_count ?? 0,
			remix_count: r.remix_count ?? 0,
			size_bytes: r.size_bytes ?? null,
			remixable: r.remixable === true,
			remix_royalty_bps: r.remix_royalty_bps ?? null,
			parent_creation_id: r.parent_creation_id ?? null,
			refine_instruction: r.refine_instruction ?? null,
			// Real, opt-in attribution only — set when the model was forged while
			// signed in. Never invented for anonymous generations.
			creatorUsername: r.creator_username || null,
			creatorDisplayName: r.creator_display_name || r.creator_username || null,
			creatorAvatarUrl: r.creator_avatar_url || null,
			simReadiness: r.sim_readiness ?? null,
			simReadinessGradedAt: r.sim_readiness_graded_at ? new Date(r.sim_readiness_graded_at).toISOString() : null,
			...x402Provenance(r),
		};
	} catch (err) {
		console.error('[forge-store] getPublicCreation failed:', err?.message);
		return null;
	}
}

// Count a model-page impression. Fail-soft and fire-and-forget: the page read
// never blocks (or breaks) on the counter, and a miss is just an uncounted
// view. Distinct from views_requested/views_used (multiview camera counts).
export async function recordCreationView({ id }) {
	if (!forgeStoreEnabled() || !id) return;
	try {
		await sql`
			update forge_creations set view_count = coalesce(view_count, 0) + 1
			where id = ${id} and status = 'done'
		`;
	} catch (err) {
		console.error('[forge-store] recordCreationView failed:', err?.message);
	}
}

// Suggested models for the detail page's sidebar: newest finished community
// models in the same category first, backfilled with fresh models from any
// category when the category is thin, never including the model itself.
// Card-shaped like listShowcase items (minus vote state, which is per-browser).
export async function listRelated({ id, category, limit = 6 }) {
	if (!forgeStoreEnabled() || !id) return [];
	const capped = Math.min(Math.max(Number(limit) || 6, 1), 12);
	const cat = validModelCategory(category);
	try {
		const rows = await sql`
			select id, prompt, glb_url, preview_image_url, model_category, backend,
				vote_count, coalesce(view_count, 0) as view_count, created_at,
				(model_category = ${cat ?? ''}) as same_category
			from forge_creations
			where status = 'done' and glb_url is not null and id != ${id}
				and (visibility is null or visibility = 'public')
			order by (model_category = ${cat ?? ''}) desc, created_at desc
			limit ${capped}
		`;
		return rows.map((r) => ({
			id: r.id,
			prompt: r.prompt,
			glb_url: r.glb_url,
			preview_image_url: r.preview_image_url,
			model_category: r.model_category ?? 'other',
			backend: r.backend ?? null,
			vote_count: r.vote_count ?? 0,
			view_count: r.view_count ?? 0,
			created_at: r.created_at,
		}));
	} catch (err) {
		console.error('[forge-store] listRelated failed:', err?.message);
		return [];
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
					and (visibility is null or visibility = 'public')
					and created_at < ${before}
				order by created_at desc
				limit ${capped}
			`
			: await sql`
				select id, prompt, glb_url, preview_image_url, model_category,
					parent_creation_id, remixable, created_at
				from forge_creations
				where user_id = ${userId} and status = 'done' and glb_url is not null
					and (visibility is null or visibility = 'public')
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
				and (visibility is null or visibility = 'public')
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
//
// Two orderings, both over the same public-artifact set:
//   • sort='fresh' (default) — visual-first, newest: the shop window. Rows with
//     a preview image lead (geometry-first lanes paint none), recency breaks
//     ties. This is the historical "Fresh from the Forge" strip.
//   • sort='top' — the Forge-Off board: most community votes first, recency
//     breaks ties, over the current Forge-Off week when window='week'. Served by
//     idx_forge_creations_board.
// Every row now carries vote_count and, when a voterKey is supplied, a per-row
// `voted` flag so the UI can render the caller's own upvotes without a second
// round-trip. voterKey is the hashed browser id (hashClient); pass null for an
// anonymous read (voted is then false for every row).
export async function listShowcase({ limit = 12, voterKey = null, sort = 'fresh', window = 'all' } = {}) {
	if (!forgeStoreEnabled()) return [];
	const capped = Math.min(Math.max(Number(limit) || 12, 1), 24);
	// Empty string never matches a real voter_key (hashClient collapses missing
	// ids to 'anon', a non-empty hash), so an anonymous read yields voted=false.
	const vk = typeof voterKey === 'string' && voterKey ? voterKey : '';
	const top = sort === 'top';
	const weekStart = top && window === 'week' ? forgeOffWeekStart().toISOString() : null;
	try {
		const rows = top
			? await sql`
				select fc.id, fc.prompt, fc.glb_url, fc.preview_image_url,
					fc.views_used, fc.multiview, fc.backend, fc.tier, fc.path,
					fc.model_category, fc.created_at, fc.vote_count,
					fc.x402_payer, fc.x402_tx_sig, fc.x402_price_atomic,
					(v.voter_key is not null) as voted
				from forge_creations fc
				left join forge_votes v on v.creation_id = fc.id and v.voter_key = ${vk}
				where fc.status = 'done' and fc.glb_url is not null
					and (fc.outcome is null or fc.outcome != 'rejected')
					and (fc.visibility is null or fc.visibility = 'public')
					and (${weekStart}::timestamptz is null or fc.created_at >= ${weekStart}::timestamptz)
				order by fc.vote_count desc, fc.created_at desc
				limit ${capped}
			`
			: await sql`
				select fc.id, fc.prompt, fc.glb_url, fc.preview_image_url,
					fc.views_used, fc.multiview, fc.backend, fc.tier, fc.path,
					fc.model_category, fc.created_at, fc.vote_count,
					fc.x402_payer, fc.x402_tx_sig, fc.x402_price_atomic,
					(v.voter_key is not null) as voted
				from forge_creations fc
				left join forge_votes v on v.creation_id = fc.id and v.voter_key = ${vk}
				where fc.status = 'done' and fc.glb_url is not null
					and (fc.outcome is null or fc.outcome != 'rejected')
					and (fc.visibility is null or fc.visibility = 'public')
				order by (fc.preview_image_url is not null) desc, fc.created_at desc
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
			vote_count: Number(r.vote_count) || 0,
			voted: Boolean(r.voted),
			...x402Provenance(r),
		}));
	} catch (err) {
		if (isDbUnavailableError(err)) console.warn('[forge-store] listShowcase skipped (db unavailable):', err?.message);
		else console.error('[forge-store] listShowcase failed:', err?.message);
		return [];
	}
}

// Total finished community models with a stored GLB — the same public-artifact
// bar the showcase feed uses (rejected rows excluded). Powers the live "N models
// forged" social-proof count. Cheap COUNT(*), CDN-cached by its callers.
export async function countShowcase() {
	if (!forgeStoreEnabled()) return 0;
	try {
		const [row] = await sql`
			select count(*)::int as n
			from forge_creations
			where status = 'done' and glb_url is not null
				and (outcome is null or outcome != 'rejected')
				and (visibility is null or visibility = 'public')
		`;
		return row?.n ?? 0;
	} catch (err) {
		if (isDbUnavailableError(err)) console.warn('[forge-store] countShowcase skipped (db unavailable):', err?.message);
		else console.error('[forge-store] countShowcase failed:', err?.message);
		return 0;
	}
}

// Monday 00:00:00 UTC of the Forge-Off week containing `ref` (default: now).
// The weekly ritual runs Monday→Monday UTC; the crowning cron writes one
// forge_board_winners row per completed week keyed by this Monday. Same idiom
// used for weekly windows elsewhere (api/permissions/[action].js).
export function forgeOffWeekStart(ref = new Date()) {
	const d = new Date(ref);
	const day = d.getUTCDay(); // 0=Sun
	const diff = day === 0 ? -6 : 1 - day; // back to this week's Monday
	d.setUTCDate(d.getUTCDate() + diff);
	d.setUTCHours(0, 0, 0, 0);
	return d;
}

// Cast an upvote for a creation from an anonymous browser. Idempotent: a second
// vote from the same voter_key is a no-op (the PRIMARY KEY makes it a conflict),
// so the button can be optimistic without creating duplicates. vote_count is
// recomputed from the authoritative forge_votes tally via a correlated
// subquery so the denormalized column can never drift (the Sketchfab showcase
// cron reads it). Returns { creationId, voteCount, voted:true } or null when the
// creation isn't a board-eligible public artifact / the store is unconfigured.
export async function castVote({ creationId, voterKey, ipHash = null }) {
	if (!forgeStoreEnabled() || !creationId || !voterKey) return null;
	try {
		// Only public, finished, non-rejected creations are votable — the same
		// bar the board and showcase render. Blocks votes on nonexistent or
		// private/failed ids before any write.
		const eligible = await sql`
			select id from forge_creations
			where id = ${creationId} and status = 'done' and glb_url is not null
				and (outcome is null or outcome != 'rejected')
			limit 1
		`;
		if (eligible.length === 0) return null;
		await sql`
			insert into forge_votes (creation_id, voter_key, ip_hash)
			values (${creationId}, ${voterKey}, ${ipHash})
			on conflict (creation_id, voter_key) do nothing
		`;
		const rows = await sql`
			update forge_creations
			set vote_count = (select count(*) from forge_votes where creation_id = ${creationId})
			where id = ${creationId}
			returning vote_count
		`;
		return { creationId, voteCount: Number(rows[0]?.vote_count) || 0, voted: true };
	} catch (err) {
		if (isDbUnavailableError(err)) console.warn('[forge-store] castVote skipped (db unavailable):', err?.message);
		else console.error('[forge-store] castVote failed:', err?.message);
		return null;
	}
}

// Remove the caller's upvote (toggle off). No-op when they hadn't voted.
// Recomputes vote_count from the tally, same as castVote, and returns the fresh
// count with voted:false. Returns null only on an unconfigured store / db fault.
export async function removeVote({ creationId, voterKey }) {
	if (!forgeStoreEnabled() || !creationId || !voterKey) return null;
	try {
		await sql`
			delete from forge_votes
			where creation_id = ${creationId} and voter_key = ${voterKey}
		`;
		const rows = await sql`
			update forge_creations
			set vote_count = (select count(*) from forge_votes where creation_id = ${creationId})
			where id = ${creationId}
			returning vote_count
		`;
		// No returned row → creation was pruned; report a zeroed, un-voted state.
		return { creationId, voteCount: Number(rows[0]?.vote_count) || 0, voted: false };
	} catch (err) {
		if (isDbUnavailableError(err)) console.warn('[forge-store] removeVote skipped (db unavailable):', err?.message);
		else console.error('[forge-store] removeVote failed:', err?.message);
		return null;
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
					fc.x402_payer, fc.x402_tx_sig, fc.x402_price_atomic,
					u.username, u.display_name, u.avatar_url
				from forge_creations fc
				left join users u on u.id = fc.user_id and u.deleted_at is null and u.username is not null
				where fc.status = 'done' and fc.glb_url is not null
					and (fc.outcome is null or fc.outcome != 'rejected')
					and (fc.visibility is null or fc.visibility = 'public')
					and fc.created_at < ${before}
				order by fc.created_at desc
				limit ${capped}`
			: await sql`
				select fc.id, fc.prompt, fc.glb_url, fc.preview_image_url, fc.model_category,
					fc.parent_creation_id, fc.created_at,
					fc.x402_payer, fc.x402_tx_sig, fc.x402_price_atomic,
					u.username, u.display_name, u.avatar_url
				from forge_creations fc
				left join users u on u.id = fc.user_id and u.deleted_at is null and u.username is not null
				where fc.status = 'done' and fc.glb_url is not null
					and (fc.outcome is null or fc.outcome != 'rejected')
					and (fc.visibility is null or fc.visibility = 'public')
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
			...x402Provenance(r),
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
				coalesce(rc.remix_count, 0) as remix_count,
				u.username as owner_username, u.display_name as owner_display_name, u.avatar_url as owner_avatar_url
			 from forge_creations p
			 left join (
				select parent_creation_id, count(*) as remix_count
				from forge_creations
				where parent_creation_id is not null and status = 'done'
				group by parent_creation_id
			 ) rc on rc.parent_creation_id = p.id
			 left join users u on u.id = p.user_id and u.deleted_at is null
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
			// Opt-in creator attribution — only when the model was made while
			// signed in (same contract as listRecentCreations / creator-portfolio).
			ownerUsername: r.owner_username || null,
			ownerDisplayName: r.owner_display_name || null,
			ownerAvatarUrl: r.owner_avatar_url || null,
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
