// Private module: avatar action endpoints dispatched from [id].js.
// presign, public, regenerate, regenerate-status

import { getSessionUser, authenticateBearer, extractBearer, hasScope } from '../_lib/auth.js';
import { presignUpload, headObject, r2, publicUrl, putObject } from '../_lib/r2.js';
import { storageKeyFor, enforceQuotas, searchPublicAvatars, stripOwnerFor } from '../_lib/avatars.js';
import { listAvatars, createAvatar } from '../_lib/avatars.js';
import { env } from '../_lib/env.js';
import { sql } from '../_lib/db.js';
import { cors, json, method, readJson, wrap, error } from '../_lib/http.js';
import { parse, presignUploadBody, slug as slugSchema, createAvatarBody } from '../_lib/validate.js';
import { recordEvent } from '../_lib/usage.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { requireCsrf } from '../_lib/csrf.js';
import { dispatchWebhooks } from '../_lib/webhook-dispatch.js';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { isValidGlbHeader, inspectGlb } from '../_lib/glb-inspect.js';

// ── regen provider loader ─────────────────────────────────────────────────────
// Dynamically import a provider module by name so we don't pay the cost of
// loading e.g. the Replicate SDK on every request when regeneration is unused.
// Cached per-process after first load.
//
// Provider name precedence:
//   1. Explicit env: AVATAR_REGEN_PROVIDER=replicate|huggingface|gcp
//   2. Inferred from credentials: if REPLICATE_API_TOKEN is set with no
//      explicit provider, default to 'replicate'. Same for GCP_RECONSTRUCTION_URL.
//      This keeps the deploy path 1-step: drop the token in env, ship.
let _regenProviderCache = null;
let _regenProviderName = null;
function resolveProviderName() {
	const explicit = (process.env.AVATAR_REGEN_PROVIDER || '').trim().toLowerCase();
	if (explicit) return explicit;
	// Auto-detect order is paid → free: prefer Replicate's pinned-version
	// reliability, then our own GCP Cloud Run service, then the HF Spaces
	// queue (free GPU but variable wait + cold starts).
	if (process.env.REPLICATE_API_TOKEN) return 'replicate';
	if (process.env.GCP_RECONSTRUCTION_URL) return 'gcp';
	if (process.env.HF_TOKEN) return 'huggingface';
	return 'none';
}
async function getRegenProvider() {
	const name = resolveProviderName();
	if (name === 'none' || !name) return { name, instance: null };
	if (_regenProviderCache && _regenProviderName === name) {
		return { name, instance: _regenProviderCache };
	}
	if (name === 'replicate') {
		const mod = await import('../_providers/replicate.js');
		_regenProviderCache = mod.createRegenProvider();
		_regenProviderName = name;
		return { name, instance: _regenProviderCache };
	}
	if (name === 'huggingface' || name === 'hf') {
		const mod = await import('../_providers/huggingface.js');
		_regenProviderCache = mod.createRegenProvider();
		_regenProviderName = name;
		return { name, instance: _regenProviderCache };
	}
	if (name === 'gcp') {
		const mod = await import('../_providers/gcp.js');
		_regenProviderCache = mod.createRegenProvider();
		_regenProviderName = name;
		return { name, instance: _regenProviderCache };
	}
	throw Object.assign(new Error(`unknown AVATAR_REGEN_PROVIDER: ${name}`), {
		code: 'regen_provider_unknown',
		status: 501,
	});
}

// ── presign ───────────────────────────────────────────────────────────────────

async function resolvePresignUser(req, requiredScope) {
	const session = await getSessionUser(req);
	if (session) return session.id;
	const bearer = await authenticateBearer(extractBearer(req), { audience: undefined });
	if (!bearer || !hasScope(bearer.scope, requiredScope)) return null;
	return bearer.userId;
}

const handlePresign = wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;
	const userId = await resolvePresignUser(req, 'avatars:write');
	if (!userId) return error(res, 401, 'unauthorized', 'sign in or provide a valid bearer token');
	const rl = await limits.upload(userId);
	if (!rl.success) return error(res, 429, 'rate_limited', 'upload rate exceeded');
	const body = parse(presignUploadBody, await readJson(req));
	try { await enforceQuotas(userId, body.size_bytes); }
	catch (err) { return error(res, err.status || 402, err.code || 'plan_limit', err.message); }
	const bodyAny = body;
	const slug = bodyAny.slug ? slugSchema.parse(bodyAny.slug) : `draft-${Math.random().toString(36).slice(2, 8)}`;
	const key = storageKeyFor({ userId, slug });
	const url = await presignUpload({ key, contentType: body.content_type });
	return json(res, 200, { storage_key: key, upload_url: url, method: 'PUT', headers: { 'content-type': body.content_type }, expires_in: 300 });
});

// ── upload proxy ──────────────────────────────────────────────────────────────
// Server-side upload fallback for environments where direct browser→R2 PUT is
// blocked (Codespaces previews, ephemeral domains not in the bucket CORS
// allowlist, restrictive corporate networks). The client streams the GLB to
// this endpoint and we PUT it to R2 server-side using already-authenticated
// S3 credentials. Same quotas, same key naming as presign — only the wire path
// differs. Used by account.js after a CORS-blocked presigned PUT.
//
// Body: raw octet stream (the GLB bytes). Metadata passed as query params so
// the body can be a single contiguous buffer:
//   ?slug=optional-slug&content_type=model/gltf-binary&sha256=hex-or-empty
//
// Vercel Pro caps Node function request bodies at 50 MB. Realistic avatars
// are 5–15 MB; the presign+direct path remains for anything larger.
const MAX_PROXY_UPLOAD_BYTES = 50 * 1024 * 1024;
const PROXY_CONTENT_TYPES = new Set([
	'model/gltf-binary',
	'application/octet-stream',
	'application/gltf-binary',
]);

const handleUpload = wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;
	const userId = await resolvePresignUser(req, 'avatars:write');
	if (!userId) return error(res, 401, 'unauthorized', 'sign in or provide a valid bearer token');
	if (!(await requireCsrf(req, res, userId))) return;
	const rl = await limits.upload(userId);
	if (!rl.success) return error(res, 429, 'rate_limited', 'upload rate exceeded');

	const url = new URL(req.url, 'http://x');
	const rawContentType = url.searchParams.get('content_type') || req.headers['content-type'] || 'model/gltf-binary';
	const contentType = rawContentType.split(';')[0].trim().toLowerCase();
	if (!PROXY_CONTENT_TYPES.has(contentType)) {
		return error(res, 415, 'unsupported_media_type', `content_type must be one of: ${[...PROXY_CONTENT_TYPES].join(', ')}`);
	}

	const declaredLength = Number(req.headers['content-length']);
	if (Number.isFinite(declaredLength) && declaredLength > MAX_PROXY_UPLOAD_BYTES) {
		return error(res, 413, 'payload_too_large', `body exceeds ${MAX_PROXY_UPLOAD_BYTES} bytes — use presigned upload for larger GLBs`);
	}

	let buffer;
	try {
		buffer = await readRawBody(req, MAX_PROXY_UPLOAD_BYTES);
	} catch (err) {
		return error(res, err.status || 400, err.code || 'invalid_body', err.message || 'failed to read body');
	}
	if (!buffer.length) return error(res, 400, 'empty_body', 'no bytes received');

	// GLB header (binary glTF 2.0 spec): 12 bytes of
	//   magic    uint32  0x46546C67  // 'glTF' little-endian
	//   version  uint32  must be 2
	//   length   uint32  total file length in bytes (must equal buffer length)
	// Catches mis-named uploads (JPEGs, HTML error pages, truncated files) and
	// sets the catalog up to only ever serve well-formed binary glTF.
	if (!isValidGlbHeader(buffer)) {
		return error(res, 415, 'invalid_glb', 'body is not a valid binary glTF 2.0 (GLB) — magic/version/length check failed');
	}

	try {
		await enforceQuotas(userId, buffer.length);
	} catch (err) {
		return error(res, err.status || 402, err.code || 'plan_limit', err.message);
	}

	const rawSlug = url.searchParams.get('slug');
	const slug = rawSlug ? slugSchema.parse(rawSlug) : `draft-${Math.random().toString(36).slice(2, 8)}`;
	const key = storageKeyFor({ userId, slug });

	const checksum = await sha256Hex(buffer);
	const claimedChecksum = (url.searchParams.get('sha256') || '').toLowerCase();
	if (claimedChecksum && claimedChecksum !== checksum) {
		return error(res, 400, 'checksum_mismatch', 'sha256 query param does not match received bytes');
	}

	await putObject({ key, body: buffer, contentType });

	return json(res, 200, {
		storage_key: key,
		size_bytes: buffer.length,
		content_type: contentType,
		checksum_sha256: checksum,
	});
});

function readRawBody(req, limit) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let total = 0;
		req.on('data', (chunk) => {
			total += chunk.length;
			if (total > limit) {
				const err = new Error(`body exceeds ${limit} bytes`);
				err.status = 413;
				err.code = 'payload_too_large';
				reject(err);
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => resolve(Buffer.concat(chunks)));
		req.on('error', reject);
	});
}

async function sha256Hex(buf) {
	const { createHash } = await import('crypto');
	return createHash('sha256').update(buf).digest('hex');
}

// ── public ────────────────────────────────────────────────────────────────────

// Public discovery surface — must always return 200 with a stable JSON shape so
// agent crawlers, OpenAPI probes, and the Bazaar validator see a clean response
// even when the DB is unreachable or the query parameters are malformed. Any
// internal failure degrades to an empty result set rather than a 5xx.
const handlePublic = wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;
	const url = new URL(req.url, 'http://x');
	const parsedLimit = Number(url.searchParams.get('limit'));
	const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 24;
	let result;
	try {
		result = await searchPublicAvatars({
			q: url.searchParams.get('q') || undefined,
			tag: url.searchParams.get('tag') || undefined,
			limit,
			cursor: url.searchParams.get('cursor') || undefined,
			withTotals: url.searchParams.get('totals') === '1',
		});
	} catch {
		result = { avatars: [], next_cursor: null };
	}
	const avatars = Array.isArray(result?.avatars) ? result.avatars : [];
	const payload = {
		avatars: avatars.map((a) => stripOwnerFor(a, null)),
		next_cursor: result?.next_cursor ?? null,
	};
	if (Object.prototype.hasOwnProperty.call(result || {}, 'total')) {
		payload.total = result.total;
		payload.total_views = result.total_views;
	}
	res.setHeader('cache-control', 'public, max-age=60, s-maxage=60');
	return json(res, 200, payload);
});

// ── regenerate ────────────────────────────────────────────────────────────────

const regenerateSchema = z.object({
	sourceAvatarId: z.string().trim().min(1).max(100),
	mode: z.enum(['remesh', 'retex', 'rerig', 'restyle', 'reconstruct']),
	params: z.record(z.unknown()).optional(),
});

async function resolveRegenUser(req) {
	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	if (!session && !bearer) return null;
	if (bearer && !hasScope(bearer.scope, 'avatars:write')) return null;
	return session?.id ?? bearer?.userId;
}

const handleRegenerate = wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;
	const userId = await resolveRegenUser(req);
	if (!userId) return error(res, 401, 'unauthorized', 'sign in or provide a valid bearer token');
	const rl = await limits.upload(userId);
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');
	const body = parse(regenerateSchema, await readJson(req));
	const rows = await sql`select id, name, storage_key from avatars where id = ${body.sourceAvatarId} and owner_id = ${userId} and deleted_at is null limit 1`;
	if (!rows[0]) return error(res, 404, 'not_found', 'source avatar not found or not owned');

	let provider;
	try {
		provider = await getRegenProvider();
	} catch (err) {
		return error(res, err.status || 501, err.code || 'regen_provider_error', err.message);
	}

	if (provider.name === 'none') {
		return error(
			res,
			501,
			'regen_unconfigured',
			'Avatar regeneration requires a configured backend. Set AVATAR_REGEN_PROVIDER and the matching API token (REPLICATE_API_TOKEN, HF_TOKEN, or GCP_RECONSTRUCTION_URL).',
		);
	}

	// Real provider — submit the job, persist the external id.
	const sourceUrl = publicUrl(rows[0].storage_key);
	let submission;
	try {
		submission = await provider.instance.submit({
			userId,
			sourceAvatarId: body.sourceAvatarId,
			mode: body.mode,
			params: body.params ?? {},
			sourceUrl,
			sourceStorageKey: rows[0].storage_key,
		});
	} catch (err) {
		return error(
			res,
			err.status || 502,
			err.code || 'regen_provider_error',
			err.message || 'provider rejected submission',
		);
	}

	const jobId = `${provider.name}-${randomUUID()}`;
	await sql`
		insert into avatar_regen_jobs
			(job_id, user_id, source_avatar_id, mode, params, status, provider, ext_job_id, created_at, updated_at)
		values
			(${jobId}, ${userId}, ${body.sourceAvatarId}, ${body.mode}, ${JSON.stringify(body.params ?? {})}, 'queued', ${provider.name}, ${submission.extJobId ?? null}, now(), now())
	`;
	return json(res, 202, {
		ok: true,
		jobId,
		status: 'queued',
		eta: submission.eta ?? null,
		provider: provider.name,
	});
});

// ── regenerate-status ─────────────────────────────────────────────────────────

const handleRegenerateStatus = wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;
	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	if (!session && !bearer) return error(res, 401, 'unauthorized', 'sign in or provide a valid bearer token');
	if (bearer && !hasScope(bearer.scope, 'avatars:read')) return error(res, 403, 'insufficient_scope', 'avatars:read scope required');
	const userId = session?.id ?? bearer?.userId;
	const url = new URL(req.url, 'http://x');
	const jobId = url.searchParams.get('jobId');
	if (!jobId) return error(res, 400, 'invalid_request', 'jobId required');
	const rows = await sql`
		select job_id, status, result_avatar_id, result_glb_url, error, provider, ext_job_id, created_at,
		       mode, params, source_avatar_id
		from avatar_regen_jobs
		where job_id = ${jobId} and user_id = ${userId}
		limit 1
	`;
	if (!rows[0]) return error(res, 404, 'not_found', 'job not found');
	let job = rows[0];

	// Pull a fresh status from the provider when the job is still in flight
	// and we have an external id to query. The status endpoint serves as our
	// poll trigger — no separate cron needed for short-lived jobs.
	if ((job.status === 'queued' || job.status === 'running') && job.provider && job.ext_job_id) {
		try {
			const provider = await getRegenProvider();
			if (provider.instance) {
				const update = await provider.instance.status(job.ext_job_id);
				const nextStatus = update.status;
				const nextResultUrl = update.resultGlbUrl ?? null;
				const nextError = update.error ?? null;
				if (
					nextStatus !== job.status ||
					nextResultUrl !== job.result_glb_url ||
					nextError !== job.error
				) {
					await sql`
						update avatar_regen_jobs
						set status = ${nextStatus},
							result_glb_url = ${nextResultUrl},
							error = ${nextError},
							updated_at = now()
						where job_id = ${jobId} and user_id = ${userId}
					`;
					job = {
						...job,
						status: nextStatus,
						result_glb_url: nextResultUrl,
						error: nextError,
					};
				}
			}
		} catch (err) {
			// Surface the polling error but don't fail the request — the job
			// row stays as-is and the client can retry later.
			job = { ...job, error: job.error || `provider poll failed: ${err?.message}` };
		}
	}

	// Materialize the avatar row when a reconstruct job finishes successfully
	// but hasn't yet been materialized. We copy the result GLB from the
	// provider's URL into our R2 bucket so the avatar is durable, then create
	// the avatars row with the user-supplied name/description.
	if (
		job.status === 'done' &&
		job.mode === 'reconstruct' &&
		!job.result_avatar_id &&
		!job.source_avatar_id &&
		job.result_glb_url
	) {
		try {
			const params = job.params || {};
			const name = (params.name || 'My selfie avatar').toString().slice(0, 120);
			const description = params.description ? String(params.description).slice(0, 500) : null;
			const visibility = ['private', 'unlisted', 'public'].includes(params.visibility) ? params.visibility : 'private';
			const glbResp = await fetch(job.result_glb_url);
			if (!glbResp.ok) throw new Error(`fetch result_glb_url: ${glbResp.status}`);
			const glbBuf = Buffer.from(await glbResp.arrayBuffer());

			// Probe the GLB to capture rigging state. Reconstruction families
			// differ on whether they emit a skeleton (Hunyuan3D yes, TRELLIS/
			// TripoSR no) — the UI uses source_meta.is_rigged to badge
			// "needs rigging" and to gate animation features.
			const info = inspectGlb(glbBuf);
			const glbMeta = info
				? {
					is_rigged: info.isRigged,
					skin_count: info.skinCount,
					skeleton_joint_count: info.skeletonJointCount,
					node_count: info.nodeCount,
					mesh_count: info.meshCount,
					animation_count: info.animationCount,
					glb_generator: info.generator,
				}
				: { is_rigged: null, glb_inspect_error: 'invalid_glb_header' };

			const slug = `selfie-${Math.random().toString(36).slice(2, 8)}`;
			const key = storageKeyFor({ userId, slug });
			await putObject({
				key,
				body: glbBuf,
				contentType: 'model/gltf-binary',
				metadata: { source: 'reconstruct', job_id: jobId },
			});
			const tags = ['selfie'];
			if (info && !info.isRigged) tags.push('unrigged');
			const avatar = await createAvatar({
				userId,
				storageKey: key,
				input: {
					slug,
					name,
					description,
					size_bytes: glbBuf.length,
					content_type: 'model/gltf-binary',
					source: 'reconstruct',
					source_meta: { jobId, provider: job.provider, replicateGlb: job.result_glb_url, ...glbMeta },
					visibility,
					tags,
					checksum_sha256: null,
					parent_avatar_id: null,
				},
			});
			await sql`
				update avatar_regen_jobs
				set result_avatar_id = ${avatar.id}, updated_at = now()
				where job_id = ${jobId} and user_id = ${userId}
			`;
			dispatchWebhooks({
				userId,
				eventType: 'avatar.created',
				data: { id: avatar.id, name: avatar.name, slug: avatar.slug, source: 'reconstruct' },
			}).catch(() => {});
			job = { ...job, result_avatar_id: avatar.id };
		} catch (err) {
			job = { ...job, error: job.error || `materialize failed: ${err?.message}` };
		}
	}

	const response = { ok: true, jobId: job.job_id, status: job.status };
	if (job.result_avatar_id) response.resultAvatarId = job.result_avatar_id;
	if (job.result_glb_url) response.resultGlbUrl = job.result_glb_url;
	if (job.error) response.error = job.error;
	if (job.provider) response.provider = job.provider;
	return json(res, 200, response);
});

// ── presign-thumbnail ─────────────────────────────────────────────────────────
// Called by the browser after rendering a GLB preview via <model-viewer>.
// The client captures toBlob() and uploads the PNG here, then PATCHes the
// avatar record with the resulting thumbnail_key.

const thumbnailPresignSchema = z.object({
	avatar_id: z.string().uuid(),
	size_bytes: z.number().int().min(1).max(2 * 1024 * 1024), // 2 MB max for a PNG thumb
});

const handlePresignThumbnail = wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;
	const userId = await resolvePresignUser(req, 'avatars:write');
	if (!userId) return error(res, 401, 'unauthorized', 'sign in or provide a valid bearer token');

	const body = parse(thumbnailPresignSchema, await readJson(req));

	// Verify caller owns the avatar they're thumbnailing.
	const rows = await (await import('../_lib/db.js')).sql`
		select id, storage_key from avatars
		where id = ${body.avatar_id} and owner_id = ${userId} and deleted_at is null
		limit 1
	`;
	if (!rows[0]) return error(res, 404, 'not_found', 'avatar not found or not yours');

	// Thumbnail key: same prefix as the GLB, different suffix.
	const thumbKey = rows[0].storage_key.replace(/\.glb$/i, '') + '_thumb.jpg';
	const uploadUrl = await presignUpload({ key: thumbKey, contentType: 'image/jpeg' });

	return json(res, 200, {
		thumb_key: thumbKey,
		upload_url: uploadUrl,
		method: 'PUT',
		headers: { 'content-type': 'image/jpeg' },
		expires_in: 300,
	});
});

// ── presign-usdz ──────────────────────────────────────────────────────────────
// Called by the browser after a GLB upload completes. The client converts the
// GLB → USDZ in-memory via three's USDZExporter and PUTs it to R2 here, then
// PATCHes the avatar row with the returned usdz_key. Enables iOS Quick Look
// for every avatar without an external USDZ source.

const usdzPresignSchema = z.object({
	avatar_id: z.string().uuid(),
	size_bytes: z.number().int().min(1).max(50 * 1024 * 1024), // 50 MB cap — USDZ is larger than GLB
});

const handlePresignUsdz = wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;
	const userId = await resolvePresignUser(req, 'avatars:write');
	if (!userId) return error(res, 401, 'unauthorized', 'sign in or provide a valid bearer token');

	const body = parse(usdzPresignSchema, await readJson(req));

	const rows = await sql`
		select id, storage_key from avatars
		where id = ${body.avatar_id} and owner_id = ${userId} and deleted_at is null
		limit 1
	`;
	if (!rows[0]) return error(res, 404, 'not_found', 'avatar not found or not yours');

	const usdzKey = rows[0].storage_key.replace(/\.glb$/i, '') + '.usdz';
	const uploadUrl = await presignUpload({ key: usdzKey, contentType: 'model/vnd.usdz+zip' });

	return json(res, 200, {
		usdz_key: usdzKey,
		upload_url: uploadUrl,
		method: 'PUT',
		headers: { 'content-type': 'model/vnd.usdz+zip' },
		expires_in: 300,
	});
});

// ── presign-halfbody ──────────────────────────────────────────────────────────
// Half-body (waist-up) GLB variant used in VR / first-person seats. Generated
// client-side by stripping the lower-body bone hierarchy + skinned mesh from
// the source avatar. Uploaded here, then PATCHed onto the avatar row.

const halfbodyPresignSchema = z.object({
	avatar_id: z.string().uuid(),
	size_bytes: z.number().int().min(1).max(25 * 1024 * 1024),
});

const handlePresignHalfbody = wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;
	const userId = await resolvePresignUser(req, 'avatars:write');
	if (!userId) return error(res, 401, 'unauthorized', 'sign in or provide a valid bearer token');

	const body = parse(halfbodyPresignSchema, await readJson(req));

	const rows = await sql`
		select id, storage_key from avatars
		where id = ${body.avatar_id} and owner_id = ${userId} and deleted_at is null
		limit 1
	`;
	if (!rows[0]) return error(res, 404, 'not_found', 'avatar not found or not yours');

	const halfKey = rows[0].storage_key.replace(/\.glb$/i, '') + '_halfbody.glb';
	const uploadUrl = await presignUpload({ key: halfKey, contentType: 'model/gltf-binary' });

	return json(res, 200, {
		halfbody_key: halfKey,
		upload_url: uploadUrl,
		method: 'PUT',
		headers: { 'content-type': 'model/gltf-binary' },
		expires_in: 300,
	});
});

// ── auto-tag ──────────────────────────────────────────────────────────────────
// Called after thumbnail upload; sends the poster to Claude vision for
// auto-generated tags and a one-line description. Non-blocking — a failure
// here must never fail the upload flow.

const autoTagSchema = z.object({
	avatar_id: z.string().uuid(),
	thumb_key: z.string().min(1).max(512),
});

const AVATAR_TAG_PROMPT = `You are a 3D avatar classification assistant.
Given a screenshot of a 3D avatar, respond with ONLY a JSON object:
{
  "tags": [3-6 tags from: humanoid, robot, animal, vehicle, stylized, realistic, anime, creature, character, abstract, military, fantasy, sci-fi, casual, formal],
  "description": "One sentence describing this 3D avatar (20-60 words)."
}
Respond with nothing else — no markdown, no explanation.`;

const handleAutoTag = wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;
	const userId = await resolvePresignUser(req, 'avatars:write');
	if (!userId) return error(res, 401, 'unauthorized', 'sign in or provide a valid bearer token');

	const body = parse(autoTagSchema, await readJson(req));

	// Verify ownership.
	const { sql } = await import('../_lib/db.js');
	const rows = await sql`
		select id, name, tags, description, thumbnail_key
		from avatars where id = ${body.avatar_id} and owner_id = ${userId} and deleted_at is null
		limit 1
	`;
	if (!rows[0]) return error(res, 404, 'not_found', 'avatar not found');

	// Fetch the thumbnail from R2 for vision.
	const { publicUrl } = await import('../_lib/r2.js');
	const { env } = await import('../_lib/env.js');
	const thumbUrl = publicUrl(body.thumb_key);

	// Call Claude Haiku — cheapest, sufficient for image classification.
	const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-api-key': env.ANTHROPIC_API_KEY,
			'anthropic-version': '2023-06-01',
		},
		body: JSON.stringify({
			model: 'claude-haiku-4-5-20251001',
			max_tokens: 256,
			messages: [
				{
					role: 'user',
					content: [
						{ type: 'image', source: { type: 'url', url: thumbUrl } },
						{ type: 'text', text: AVATAR_TAG_PROMPT },
					],
				},
			],
		}),
	});

	if (!anthropicRes.ok) {
		console.error('[auto-tag] anthropic error', await anthropicRes.text());
		return json(res, 200, { ok: false, reason: 'vision_api_error' });
	}

	const result = await anthropicRes.json();
	let parsed;
	try {
		const raw = result.content?.[0]?.text || '{}';
		parsed = JSON.parse(raw.trim());
	} catch {
		return json(res, 200, { ok: false, reason: 'parse_error' });
	}

	const newTags = Array.isArray(parsed.tags) ? parsed.tags.slice(0, 6) : [];
	const desc = typeof parsed.description === 'string' ? parsed.description.slice(0, 500) : '';

	// Only write if the avatar still has no tags/description (don't overwrite manual ones).
	const currentTags = rows[0].tags || [];
	const currentDesc = rows[0].description || '';

	const patch = {};
	if (!currentTags.length && newTags.length) patch.tags = newTags;
	if (!currentDesc && desc) patch.description = desc;
	// Always write thumbnail_key if not set yet.
	if (!rows[0].thumbnail_key) patch.thumbnail_key = body.thumb_key;

	if (Object.keys(patch).length) {
		await sql`
			update avatars set
				tags        = coalesce(${patch.tags ?? null}::text[], tags),
				description = coalesce(${patch.description ?? null}, description),
				thumbnail_key = coalesce(${patch.thumbnail_key ?? null}, thumbnail_key),
				updated_at  = now()
			where id = ${body.avatar_id} and owner_id = ${userId}
		`;
	}

	return json(res, 200, { ok: true, tags: newTags, description: desc });
});

// ── reconstruct (Phase 1 — Selfie → Avatar engine) ────────────────────────────
// Submits a Replicate reconstruct job from selfie photos. No source avatar
// exists yet; the avatar row is materialized when the status handler observes
// a successful result and copies the generated GLB into R2.

// Photos may be either:
//   • http(s):// URL — typically an R2 object URL the client uploaded first
//   • data:image/...;base64,... — inline base64 (Replicate accepts these natively)
const photoUrlOrDataUri = z
	.string()
	.max(8 * 1024 * 1024) // generous cap to allow inline JPEGs up to ~6 MB pre-base64
	.refine(
		(v) =>
			/^https?:\/\//i.test(v) ||
			/^data:image\/(png|jpe?g|webp|heic|heif);base64,/i.test(v),
		'must be an http(s) URL or a data:image/* base64 URI',
	);

const reconstructSchema = z.object({
	name: z.string().trim().min(1).max(120),
	description: z.string().trim().max(500).optional(),
	photos: z.array(photoUrlOrDataUri).min(1).max(6),
	visibility: z.enum(['private', 'unlisted', 'public']).optional(),
	params: z.record(z.unknown()).optional(),
});

const handleReconstruct = wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;
	const userId = await resolveRegenUser(req);
	if (!userId) return error(res, 401, 'unauthorized', 'sign in or provide a valid bearer token');
	const rl = await limits.upload(userId);
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');
	const body = parse(reconstructSchema, await readJson(req));

	let provider;
	try {
		provider = await getRegenProvider();
	} catch (err) {
		return error(res, err.status || 501, err.code || 'regen_provider_error', err.message);
	}
	if (provider.name === 'none') {
		return error(
			res,
			501,
			'regen_unconfigured',
			'Avatar reconstruction requires a configured backend. Set AVATAR_REGEN_PROVIDER and the matching API token (REPLICATE_API_TOKEN, HF_TOKEN, or GCP_RECONSTRUCTION_URL).',
		);
	}

	let submission;
	try {
		submission = await provider.instance.submit({
			userId,
			mode: 'reconstruct',
			params: { ...(body.params ?? {}), images: body.photos, name: body.name },
			sourceUrl: body.photos[0],
		});
	} catch (err) {
		return error(
			res,
			err.status || 502,
			err.code || 'regen_provider_error',
			err.message || 'provider rejected submission',
		);
	}

	const jobId = `${provider.name}-${randomUUID()}`;
	const params = {
		images: body.photos,
		name: body.name,
		description: body.description ?? null,
		visibility: body.visibility ?? 'private',
	};
	await sql`
		insert into avatar_regen_jobs
			(job_id, user_id, source_avatar_id, mode, params, status, provider, ext_job_id, created_at, updated_at)
		values
			(${jobId}, ${userId}, ${null}, ${'reconstruct'}, ${JSON.stringify(params)}, 'queued', ${provider.name}, ${submission.extJobId ?? null}, now(), now())
	`;
	return json(res, 202, {
		ok: true,
		jobId,
		status: 'queued',
		eta: submission.eta ?? null,
		provider: provider.name,
	});
});

// ── dispatcher ────────────────────────────────────────────────────────────────

const DISPATCH = {
	presign:             handlePresign,
	upload:              handleUpload,
	'presign-thumbnail': handlePresignThumbnail,
	'presign-usdz':      handlePresignUsdz,
	'presign-halfbody':  handlePresignHalfbody,
	'auto-tag':          handleAutoTag,
	public:              handlePublic,
	reconstruct:         handleReconstruct,
	regenerate:          handleRegenerate,
	'regenerate-status': handleRegenerateStatus,
};

export function dispatch(action, req, res) {
	const fn = DISPATCH[action];
	if (!fn) return error(res, 404, 'not_found', `unknown avatar action: ${action}`);
	return fn(req, res);
}
