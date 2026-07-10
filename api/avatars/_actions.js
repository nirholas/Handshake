// Private module: avatar action endpoints dispatched from [id].js.
// presign, public, regenerate, regenerate-status

import { getSessionUser, authenticateBearer, extractBearer, hasScope } from '../_lib/auth.js';
import { presignUpload, headObject, r2, publicUrl, putObject } from '../_lib/r2.js';
import { storageKeyFor, enforceQuotas, searchPublicAvatars, stripOwnerFor } from '../_lib/avatars.js';
import { listAvatars } from '../_lib/avatars.js';
import { env } from '../_lib/env.js';
import { sql } from '../_lib/db.js';
import { cors, json, method, readJson, wrap, error, rateLimited } from '../_lib/http.js';
import { parse, presignUploadBody, slug as slugSchema, createAvatarBody } from '../_lib/validate.js';
import { recordEvent } from '../_lib/usage.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { requireCsrf } from '../_lib/csrf.js';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { isValidGlbHeader } from '../_lib/glb-inspect.js';
import { getRegenProviderCandidates, getRegenProviderByName, getRegenProviderForJob, BYOK_REGEN_PROVIDERS } from '../_lib/regen-provider.js';
import { resolveProviderKey } from '../_lib/forge-provider-key.js';
import { finalizeReconstructStage, pollRiggingStage } from '../_lib/reconstruct-finalize.js';
import { finalizeAutoRigStage } from '../_lib/auto-rig.js';
import { isAllowedProviderResultUrl } from '../_lib/provider-result-url.js';
import { textToImage } from '../_mcp3d/text-to-image.js';

// ── provider error masking ──────────────────────────────────────────────────────
// The regen adapters (Replicate, GCP, and the BYOK Meshy/Tripo) attach a stable
// .code/.status to every thrown error, but err.message can name the vendor, its
// billing state ("Meshy account is out of credits."), or echo a raw upstream
// body. None of that may reach the browser. These two helpers translate by code
// into neutral, actionable copy and keep the raw detail in server logs only.

// Classify a provider submit/resolve failure into a vendor-free { status, code,
// message } envelope. The error CODE is preserved (the clients already branch on
// invalid_key / missing_key / insufficient_credits / rate_limited) — only the
// leaky MESSAGE is replaced, so the BYOK key-entry UX keeps working while no
// vendor name or billing state ever ships. Pure + exported for direct testing.
export function classifyProviderError(err) {
	const code = err?.code;
	const status = Number(err?.status) || 0;
	if (code === 'insufficient_credits' || status === 402) {
		return { status: 402, code: 'insufficient_credits', message: 'The 3D engine key is out of credits — top it up and try again.' };
	}
	if (code === 'invalid_key' || code === 'missing_key' || status === 401) {
		return { status: 401, code: code === 'missing_key' ? 'missing_key' : 'invalid_key', message: 'The 3D engine key was rejected — check it and try again.' };
	}
	if (code === 'rate_limited' || status === 429) {
		return { status: 429, code: 'rate_limited', message: 'The 3D engine is busy right now — wait a moment and try again.', retryAfter: 15 };
	}
	if (code === 'invalid_request' || status === 400) {
		return { status: 400, code: 'invalid_request', message: 'That request could not be processed — check your photo and try again.' };
	}
	if (code === 'mode_unconfigured' || code === 'regen_provider_unknown' || status === 501) {
		return { status: 501, code: 'regen_unconfigured', message: 'The 3D engine is not available for this request right now.' };
	}
	// provider_unreachable, provider_error, and anything else → generic retry.
	return { status: 502, code: 'regen_provider_error', message: 'The 3D engine could not start this job — please try again shortly.' };
}

// Send the masked classification to the client, logging the raw detail for ops.
function maskSubmitError(res, err) {
	const c = classifyProviderError(err);
	console.warn('[avatars] provider error:', err?.code || err?.status || 'unknown', '—', err?.message);
	if (c.retryAfter) res.setHeader('retry-after', String(c.retryAfter));
	return error(res, c.status, c.code, c.message, c.retryAfter ? { retry_after: c.retryAfter } : {});
}

// Collapse a raw job/provider error string into neutral copy before it leaves the
// API. The DB keeps the raw value for operators; only this masked form is
// returned to any client (browser or bearer-token API consumer). Shared with the
// forge text→3D poll (api/forge.js) so both pipelines mask identically; re-exported
// here because the avatar tests and handlers already import it from this module.
// A bare `export { x } from './mod'` re-export does NOT bind `x` in this module's
// scope, so the regenerate-status poll handler below (which calls sanitizeJobError)
// threw `ReferenceError: sanitizeJobError is not defined` at runtime. Import the
// local binding and re-export it so both this module and its consumers resolve it.
import { sanitizeJobError } from '../_lib/provider-job-error.js';
export { sanitizeJobError };

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
	if (!rl.success) return rateLimited(res, rl, 'upload rate exceeded');
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
	if (!rl.success) return rateLimited(res, rl, 'upload rate exceeded');

	const url = new URL(req.url, 'http://x');
	const rawContentType = url.searchParams.get('content_type') || req.headers['content-type'] || 'model/gltf-binary';
	const contentType = rawContentType.split(';')[0].trim().toLowerCase();
	if (!PROXY_CONTENT_TYPES.has(contentType)) {
		return error(res, 415, 'unsupported_media_type', `content_type must be one of: ${[...PROXY_CONTENT_TYPES].join(', ')}`);
	}

	// Two body modes:
	//   • source_url=<http(s) GLB URL> — we fetch the bytes server-side. This is
	//     the URL-import path: the browser can't fetch most avatar CDNs directly
	//     (CloudFront/Arweave/etc. send no CORS headers), so we pull it here where
	//     same-origin policy doesn't apply. SSRF-guarded against internal targets.
	//   • raw octet-stream body — the CORS-fallback path for client-held blobs.
	const sourceUrl = url.searchParams.get('source_url');
	let buffer;
	if (sourceUrl) {
		try {
			buffer = await fetchRemoteGlb(sourceUrl, MAX_PROXY_UPLOAD_BYTES);
		} catch (err) {
			return error(res, err.status || 502, err.code || 'fetch_failed', err.message || 'failed to fetch source URL');
		}
	} else {
		const declaredLength = Number(req.headers['content-length']);
		if (Number.isFinite(declaredLength) && declaredLength > MAX_PROXY_UPLOAD_BYTES) {
			return error(res, 413, 'payload_too_large', `body exceeds ${MAX_PROXY_UPLOAD_BYTES} bytes — use presigned upload for larger GLBs`);
		}
		try {
			buffer = await readRawBody(req, MAX_PROXY_UPLOAD_BYTES);
		} catch (err) {
			return error(res, err.status || 400, err.code || 'invalid_body', err.message || 'failed to read body');
		}
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

	// Canonicalize bone names + up-axis orientation at ingest so every stored
	// GLB shares the canonical convention. The client-body path sends already-
	// canonical bytes (account.js canonicalizes before upload), so this is a
	// no-op there; the source_url path fetches raw bytes that may still be
	// Mixamo/FBX-oriented. Non-fatal: if the buffer isn't a recognised humanoid
	// rig the canonicalizer returns it unchanged.
	try {
		const { canonicalizeGLBBones } = await import('../../src/glb-canonicalize.js');
		const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
		const canonical = canonicalizeGLBBones(ab);
		if (canonical.renamed > 0 || canonical.orientationCorrected) {
			buffer = Buffer.from(canonical.buffer);
		}
	} catch (err) {
		console.warn('[avatar-upload] canonicalize skipped:', err?.message);
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

// Fetch a remote GLB server-side for the URL-import flow. Guards against SSRF:
// the URL is attacker-controlled (any signed-in user can submit one), so we
// resolve every redirect hop's hostname to its IPs and reject anything that
// points at loopback, private, link-local, or cloud-metadata ranges before a
// single byte is read. Streamed with a hard byte cap and a wall-clock timeout.
const REMOTE_FETCH_TIMEOUT_MS = 20_000;
const MAX_REMOTE_REDIRECTS = 5;

async function fetchRemoteGlb(rawUrl, maxBytes) {
	let target;
	try {
		target = new URL(rawUrl);
	} catch {
		throw fetchError(400, 'invalid_url', 'source_url is not a valid URL');
	}
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), REMOTE_FETCH_TIMEOUT_MS);
	try {
		let resp;
		for (let hop = 0; hop <= MAX_REMOTE_REDIRECTS; hop++) {
			if (!['http:', 'https:'].includes(target.protocol)) {
				throw fetchError(400, 'unsupported_scheme', 'only http(s) URLs can be imported');
			}
			await assertPublicHost(target.hostname);
			resp = await fetch(target.href, {
				redirect: 'manual',
				signal: ac.signal,
				headers: { accept: 'model/gltf-binary,application/octet-stream,*/*' },
			});
			if (resp.status >= 300 && resp.status < 400 && resp.headers.get('location')) {
				if (hop === MAX_REMOTE_REDIRECTS) throw fetchError(502, 'too_many_redirects', 'source URL redirected too many times');
				target = new URL(resp.headers.get('location'), target);
				continue;
			}
			break;
		}
		if (!resp.ok) throw fetchError(502, 'fetch_failed', `source URL returned HTTP ${resp.status}`);

		const declared = Number(resp.headers.get('content-length'));
		if (Number.isFinite(declared) && declared > maxBytes) {
			throw fetchError(413, 'payload_too_large', `source file is ${declared} bytes — max ${maxBytes}`);
		}

		const reader = resp.body?.getReader();
		if (!reader) throw fetchError(502, 'empty_body', 'source URL returned no body');
		const chunks = [];
		let total = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.length;
			if (total > maxBytes) {
				await reader.cancel();
				throw fetchError(413, 'payload_too_large', `source file exceeds ${maxBytes} bytes`);
			}
			chunks.push(value);
		}
		return Buffer.concat(chunks.map((c) => Buffer.from(c)));
	} catch (err) {
		if (err.code && err.status) throw err;
		if (err.name === 'AbortError') throw fetchError(504, 'fetch_timeout', 'source URL timed out');
		console.warn('[avatar-upload] remote fetch failed:', err?.message);
		throw fetchError(502, 'fetch_failed', 'could not fetch the source URL');
	} finally {
		clearTimeout(timer);
	}
}

function fetchError(status, code, message) {
	const err = new Error(message);
	err.status = status;
	err.code = code;
	return err;
}

// Reject hostnames that resolve to non-public address space (SSRF defense).
async function assertPublicHost(hostname) {
	const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
	if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
		console.warn('[avatar-upload] ssrf blocked: reserved hostname', host);
		throw fetchError(400, 'blocked_host', 'source_url host is not allowed');
	}
	const { lookup } = await import('dns/promises');
	let records;
	try {
		records = await lookup(host, { all: true });
	} catch {
		throw fetchError(400, 'dns_failure', 'could not resolve source_url host');
	}
	for (const { address } of records) {
		if (isPrivateAddress(address)) {
			console.warn('[avatar-upload] ssrf blocked: private address', host, '->', address);
			throw fetchError(400, 'blocked_host', 'source_url resolves to a non-public address');
		}
	}
}

function isPrivateAddress(ip) {
	if (ip.includes(':')) {
		const v6 = ip.toLowerCase();
		if (v6 === '::1' || v6 === '::') return true;
		if (v6.startsWith('fe80') || v6.startsWith('fc') || v6.startsWith('fd')) return true;
		// IPv4-mapped IPv6 (::ffff:a.b.c.d) — unwrap and re-check.
		const mapped = v6.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
		if (mapped) return isPrivateAddress(mapped[1]);
		return false;
	}
	const p = ip.split('.').map(Number);
	if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
	const [a, b] = p;
	if (a === 0 || a === 10 || a === 127) return true;
	if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
	if (a >= 224) return true; // multicast / reserved
	return false;
}

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
	const limit = Math.min(Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 24, 100);
	let result;
	try {
		result = await searchPublicAvatars({
			q: url.searchParams.get('q') || undefined,
			tag: url.searchParams.get('tag') || undefined,
			category: url.searchParams.get('category') || undefined,
			rigged: url.searchParams.get('rigged') || undefined,
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
	if (!rl.success) return rateLimited(res, rl);
	const body = parse(regenerateSchema, await readJson(req));
	const rows = await sql`select id, name, storage_key from avatars where id = ${body.sourceAvatarId} and owner_id = ${userId} and deleted_at is null limit 1`;
	if (!rows[0]) return error(res, 404, 'not_found', 'source avatar not found or not owned');

	// Platform provider failover: try every configured provider (primary first),
	// retrying transient faults, so a single outage / throttle / cold start
	// doesn't dead-end the job. Mirrors the reconstruct submit path.
	let candidates;
	try {
		candidates = await getRegenProviderCandidates();
	} catch (err) {
		return maskSubmitError(res, err);
	}
	if (candidates.length === 0) {
		return error(
			res,
			501,
			'regen_unconfigured',
			'Avatar regeneration is not available on this deployment yet.',
		);
	}

	const sourceUrl = publicUrl(rows[0].storage_key);
	let submission = null;
	let usedProvider = null;
	let bestError = null;
	const attempts = [];
	for (const provider of candidates) {
		try {
			submission = await submitWithTransientRetry(provider.instance, {
				userId,
				sourceAvatarId: body.sourceAvatarId,
				mode: body.mode,
				params: body.params ?? {},
				sourceUrl,
				sourceStorageKey: rows[0].storage_key,
			});
			usedProvider = provider;
			break;
		} catch (err) {
			attempts.push(`${provider.name}:${err?.code || err?.status || classifyProviderError(err).code}`);
			console.warn(
				'[avatars] regenerate submit failed on',
				provider.name,
				'—',
				err?.code || err?.status || 'unknown',
				'-',
				err?.message,
			);
			// Keep the most actionable error to surface if every provider fails.
			if (!bestError || (isGenericProviderError(bestError) && !isGenericProviderError(err))) {
				bestError = err;
			}
		}
	}

	if (!submission || !usedProvider) {
		if (attempts.length > 1) {
			console.warn('[avatars] all regenerate providers failed:', attempts.join(', '));
		}
		return maskSubmitError(res, bestError || new Error('no regenerate provider available'));
	}

	const jobId = `${usedProvider.name}-${randomUUID()}`;
	await sql`
		insert into avatar_regen_jobs
			(job_id, user_id, source_avatar_id, mode, params, status, provider, ext_job_id, created_at, updated_at)
		values
			(${jobId}, ${userId}, ${body.sourceAvatarId}, ${body.mode}, ${JSON.stringify(body.params ?? {})}, 'queued', ${usedProvider.name}, ${submission.extJobId ?? null}, now(), now())
	`;
	return json(res, 202, {
		ok: true,
		jobId,
		status: 'queued',
		eta: submission.eta ?? null,
		provider: usedProvider.name,
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

	// Strategy A: an auto-rig job's terminal 'done' transition is owned solely by
	// finalizeAutoRigStage (its closeJob writes done + result_avatar_id together).
	// If this poll flipped the row to 'done' and finalize then threw, the job would
	// strand at 'done' + null — invisible to the cron's queued/running recovery
	// filter. So for auto-rig we persist a non-terminal status here and let finalize
	// own 'done'; `autoRigProviderDone` carries the provider's verdict to the
	// finalize branch below. Reconstruct and every other mode are unaffected.
	const isAutoRig = job.mode === 'rerig' && job.params?.auto_rig === true;
	let autoRigProviderDone = false;

	// Pull a fresh status from the provider when the job is still in flight
	// and we have an external id to query. The status endpoint serves as our
	// poll trigger — no separate cron needed for short-lived jobs.
	// Route by job.provider so BYOK jobs (meshy, tripo) load the right adapter
	// with the user's stored key, not the platform env credential.
	if ((job.status === 'queued' || job.status === 'running') && job.provider && job.ext_job_id) {
		try {
			const provider = await getRegenProviderForJob(job.provider, req);
			if (provider.instance) {
				const update = await provider.instance.status(job.ext_job_id);
				let nextStatus = update.status;
				let nextResultUrl = update.resultGlbUrl ?? null;
				let nextError = update.error ?? null;
				// SSRF gate (defense-in-depth): a provider-returned result URL is
				// attacker-influenceable if the provider account/payload is forged.
				// Pin it to an allowed provider host BEFORE it ever lands in
				// result_glb_url — which the cron/poll later fetch server-side. A
				// disallowed URL terminates the job cleanly instead of seeding a
				// poisoned fetch (the guarded fetch would reject it too, but failing
				// here keeps the bad URL out of the DB).
				if (nextResultUrl && !isAllowedProviderResultUrl(nextResultUrl)) {
					let blockedHost = 'unparseable';
					try { blockedHost = new URL(nextResultUrl).hostname; } catch { /* keep placeholder */ }
					console.warn('[regenerate-status] blocked result url', { jobId, host: blockedHost });
					nextStatus = 'failed';
					nextResultUrl = null;
					nextError = 'provider returned a disallowed result url';
				}

				if (isAutoRig && nextStatus === 'done') autoRigProviderDone = true;
				const persistStatus = isAutoRig && nextStatus === 'done' ? 'running' : nextStatus;
				if (
					persistStatus !== job.status ||
					nextResultUrl !== job.result_glb_url ||
					nextError !== job.error
				) {
					await sql`
						update avatar_regen_jobs
						set status = ${persistStatus},
							result_glb_url = ${nextResultUrl},
							error = ${nextError},
							updated_at = now()
						where job_id = ${jobId} and user_id = ${userId}
					`;
					job = {
						...job,
						status: persistStatus,
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

	// Stage 2 — the reconstructed mesh was bare and we kicked off an auto-rig
	// job. Poll that child job; the shared stage swaps in the rigged GLB when it
	// lands, or falls back to the bare mesh so the user is never left empty.
	if (job.status === 'rigging' && job.mode === 'reconstruct' && !job.result_avatar_id) {
		try {
			const result = await pollRiggingStage({ userId, jobId, job });
			job = { ...job, status: result.status, result_avatar_id: result.resultAvatarId ?? job.result_avatar_id };
		} catch (err) {
			job = { ...job, error: job.error || `rig stage failed: ${err?.message}` };
		}
	}

	// Stage 1 — the reconstruct job finished successfully but isn't materialized
	// yet. The shared stage copies the GLB into R2 and either creates the avatar
	// immediately or, when the mesh is unrigged and a rig model is configured,
	// chains a rigging job and moves us into 'rigging' (handled above next poll).
	if (
		job.status === 'done' &&
		job.mode === 'reconstruct' &&
		!job.result_avatar_id &&
		!job.source_avatar_id &&
		job.result_glb_url
	) {
		try {
			const result = await finalizeReconstructStage({ userId, jobId, job, glbUrl: job.result_glb_url });
			job = { ...job, status: result.status, result_avatar_id: result.resultAvatarId ?? job.result_avatar_id };
		} catch (err) {
			job = { ...job, error: job.error || `materialize failed: ${err?.message}` };
		}
	}

	// Auto-rig completion (browser-poll fallback to the webhook) — a static
	// upload/import/forge avatar finished its 'rerig' job. Materialize the rigged
	// result as a sibling and re-point the agent at it; resultAvatarId is the NEW
	// sibling id so the browser navigates to the animation-ready model. Gated on
	// auto_rig so the manual rig panel (which materializes a sibling client-side)
	// is untouched.
	// Fire when the provider just reported success (autoRigProviderDone — the row is
	// now persisted as the non-terminal 'running', not 'done') OR when the row was
	// already 'done' on entry (a legacy orphan from before Strategy A, or another
	// driver mid-flight). finalize's DB claim makes a concurrent fire a safe no-op.
	if (
		isAutoRig &&
		!job.result_avatar_id &&
		job.result_glb_url &&
		(autoRigProviderDone || job.status === 'done')
	) {
		try {
			const result = await finalizeAutoRigStage({ userId, jobId, job, glbUrl: job.result_glb_url });
			job = { ...job, status: result.status, result_avatar_id: result.resultAvatarId ?? job.result_avatar_id };
		} catch (err) {
			job = { ...job, error: job.error || `auto-rig finalize failed: ${err?.message}` };
		}
	}

	const response = { ok: true, jobId: job.job_id, status: job.status };
	if (job.result_avatar_id) response.resultAvatarId = job.result_avatar_id;
	if (job.result_glb_url) response.resultGlbUrl = job.result_glb_url;
	// Never return the raw provider/job error — it can carry a vendor name, task
	// id, or upstream status. The DB row keeps the raw value for operators; the
	// wire gets the masked form only (safe for both the web UI and API consumers).
	const maskedError = sanitizeJobError(job.error);
	if (maskedError) response.error = maskedError;
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

// Classify an avatar thumbnail with a vision-capable model. Platform LLM
// policy (api/_lib/llm.js): free providers lead — OpenRouter's free vision
// Llama, then the same model family on NVIDIA NIM — and paid Anthropic is the
// last-resort backstop. Every configured provider is TRIED in order (not
// pick-first-and-die): a 429 on the free tier degrades to the next lane
// instead of failing the auto-tag. Throws { code: 'not_configured' } when no
// vision provider is available so the caller can skip silently.
async function classifyAvatarImage({ thumbUrl, prompt, env }) {
	const openaiVision = (name, key, url, model, extraHeaders = {}) => async () => {
		const r = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...extraHeaders },
			body: JSON.stringify({
				model,
				max_tokens: 256,
				messages: [
					{
						role: 'user',
						content: [
							{ type: 'text', text: prompt },
							{ type: 'image_url', image_url: { url: thumbUrl } },
						],
					},
				],
			}),
		});
		if (!r.ok) throw Object.assign(new Error(`${name} vision ${r.status}`), { code: 'vision_api_error' });
		const d = await r.json();
		return d.choices?.[0]?.message?.content || '';
	};

	const attempts = [];
	if (env.OPENROUTER_API_KEY) {
		attempts.push(openaiVision(
			'openrouter',
			env.OPENROUTER_API_KEY,
			'https://openrouter.ai/api/v1/chat/completions',
			'meta-llama/llama-3.2-11b-vision-instruct',
			{ 'HTTP-Referer': 'https://three.ws', 'X-Title': 'three.ws avatar auto-tag' },
		));
	}
	if (env.NVIDIA_API_KEY) {
		attempts.push(openaiVision(
			'nvidia',
			env.NVIDIA_API_KEY,
			'https://integrate.api.nvidia.com/v1/chat/completions',
			'meta/llama-3.2-11b-vision-instruct',
		));
	}
	if (env.ANTHROPIC_API_KEY) {
		attempts.push(async () => {
			const r = await fetch('https://api.anthropic.com/v1/messages', {
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
								{ type: 'text', text: prompt },
							],
						},
					],
				}),
			});
			if (!r.ok) throw Object.assign(new Error(`anthropic vision ${r.status}`), { code: 'vision_api_error' });
			const d = await r.json();
			return d.content?.[0]?.text || '';
		});
	}
	if (!attempts.length) {
		throw Object.assign(new Error('no vision provider configured'), { code: 'not_configured' });
	}
	let lastErr;
	for (const attempt of attempts) {
		try {
			return await attempt();
		} catch (err) {
			lastErr = err;
		}
	}
	throw lastErr;
}

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

	// Never trust thumb_key blindly: it is used for a server-side vision fetch and
	// written into avatars.thumbnail_key (which decorate() exposes as a public
	// URL). Restrict it to keys the caller can legitimately own — either their own
	// u/<userId>/ namespace, or the canonical thumb/<avatarId>.png slot for THIS
	// avatar (the shape thumbnail.js writes). Anything else would let one user
	// point the fetch at, and publicly disclose, another user's private object.
	const thumbKey = body.thumb_key;
	const ownsKey =
		thumbKey.startsWith(`u/${userId}/`) || thumbKey === `thumb/${body.avatar_id}.png`;
	if (!ownsKey) {
		return error(res, 400, 'invalid_storage_key', 'thumb_key must live under your namespace');
	}

	// Fetch the thumbnail from R2 for vision.
	const { publicUrl, headObject } = await import('../_lib/r2.js');
	const { env } = await import('../_lib/env.js');

	// `thumb_key` is caller-supplied. Ownership was checked above, but nothing has
	// checked that an object actually lives there — the caller may never have
	// completed the upload. Confirm it before we (a) spend a vision call on a URL
	// that 404s and (b) write the key into avatars.thumbnail_key, from where
	// decorate() would publish it into an <img> that Chrome blocks as ORB.
	// The invariant: a thumbnail_key is persisted only after its object exists.
	if (!(await headObject(thumbKey))) {
		return error(res, 404, 'thumbnail_not_found', 'no object stored at thumb_key — upload the thumbnail first');
	}
	const thumbUrl = publicUrl(thumbKey);

	// Image classification needs a vision-capable model. Per platform policy
	// the free providers come first (OpenRouter hosts open vision models);
	// Anthropic is BYOK and only used when a server-side key is present. When
	// no vision provider is configured we skip auto-tagging rather than fail —
	// it is an enhancement, not a required step.
	let visionText;
	try {
		visionText = await classifyAvatarImage({ thumbUrl, prompt: AVATAR_TAG_PROMPT, env });
	} catch (err) {
		console.error('[auto-tag] vision error', err.message);
		return json(res, 200, { ok: false, reason: err.code || 'vision_api_error' });
	}

	let parsed;
	try {
		parsed = JSON.parse((visionText || '{}').trim());
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
	// Always write thumbnail_key if not set yet — using the validated key only.
	if (!rows[0].thumbnail_key) patch.thumbnail_key = thumbKey;

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
// Submits a reconstruct job from selfie photos. No source avatar exists yet;
// the avatar row is materialized when the status handler observes a successful
// result and copies the generated GLB into R2.
//
// Provider resolution order:
//   1. Platform env (REPLICATE_API_TOKEN / GCP_RECONSTRUCTION_URL / HF_TOKEN)
//   2. Inline BYOK key in request body (provider_name + provider_key)
//   3. User's stored BYOK key for a supported provider (meshy > tripo)
// When none is available, returns needs_key so the client can prompt for a key.

// Photos may be either:
//   • http(s):// URL — typically an R2 object URL the client uploaded first
//   • data:image/...;base64,... — inline base64 (Replicate / Meshy accept these)
const photoUrlOrDataUri = z
	.string()
	.max(8 * 1024 * 1024) // generous cap to allow inline JPEGs up to ~6 MB pre-base64
	.refine(
		(v) =>
			/^https?:\/\//i.test(v) ||
			/^data:image\/(png|jpe?g|webp|heic|heif);base64,/i.test(v),
		'must be an http(s) URL or a data:image/* base64 URI',
	);

const reconstructSchema = z
	.object({
		name: z.string().trim().min(1).max(120),
		description: z.string().trim().max(500).optional(),
		photos: z.array(photoUrlOrDataUri).min(1).max(6).optional(),
		// Text → avatar: a prompt is turned into a clean frontal reference image
		// (Flux), which then feeds the exact same reconstruct → auto-rig pipeline
		// as a selfie. One of `photos` or `prompt` is required.
		prompt: z.string().trim().min(3).max(600).optional(),
		visibility: z.enum(['private', 'unlisted', 'public']).optional(),
		params: z.record(z.unknown()).optional(),
		// BYOK: caller can supply their own provider key when the platform backend
		// is unconfigured. Never stored on the job row.
		provider_key: z.string().trim().max(512).optional(),
		provider_name: z.enum(['meshy', 'tripo']).optional(),
	})
	.refine((v) => (Array.isArray(v.photos) && v.photos.length > 0) || !!v.prompt, {
		message: 'provide either photos or a prompt',
		path: ['photos'],
	});

// Steer Flux toward a single, evenly-lit, full-figure humanoid on a plain
// background — that composition reconstructs and auto-rigs far more reliably
// than a busy scene — without overriding the user's own subject description.
const AVATAR_PROMPT_SUFFIX =
	', full body character, standing in a relaxed A-pose, facing forward, centered in frame, entire figure visible from head to feet, plain neutral studio background, soft even lighting, single subject, high detail, game-ready character render';

const handleReconstruct = wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;
	const userId = await resolveRegenUser(req);
	if (!userId) return error(res, 401, 'unauthorized', 'sign in or provide a valid bearer token');
	const rl = await limits.upload(userId);
	if (!rl.success) return rateLimited(res, rl);
	const body = parse(reconstructSchema, await readJson(req));

	// ── Provider resolution ──────────────────────────────────────────────────
	// Build the ordered list of providers to try. Every configured platform
	// provider leads (primary first), then the caller's BYOK keys (inline, then
	// stored) backstop them — so a single provider outage, throttle, or credit
	// exhaustion fails over to the next instead of dead-ending the job. Each
	// entry is { name, instance }; names are de-duplicated.
	const candidates = await resolveReconstructCandidates(req, body);

	// Nothing configured anywhere — tell the client which BYOK providers are
	// accepted (unchanged 402 contract the client branches on).
	if (candidates.length === 0) {
		return json(res, 402, {
			ok: false,
			code: 'regen_needs_byok',
			message:
				'Avatar reconstruction requires an API key. Add your Meshy or Tripo key in settings, or pass provider_key + provider_name in this request.',
			providers: BYOK_REGEN_PROVIDERS,
		});
	}

	// Text → avatar: turn the prompt into a frontal reference image, then treat
	// it exactly like a selfie. Done only once the reconstruct backend is known
	// to be live, so a configuration gap never burns a Flux generation.
	let photos = body.photos ?? null;
	let referenceImageUrl = null;
	if (!photos || !photos.length) {
		try {
			const generated = await textToImage(`${body.prompt}${AVATAR_PROMPT_SUFFIX}`, {
				aspectRatio: '2:3',
			});
			referenceImageUrl = generated.imageUrl;
			photos = [generated.imageUrl];
		} catch (err) {
			// Map the reference-image failure to the most accurate status so the
			// symptom is self-explanatory instead of a blank 502. textToImage tags
			// its errors: 'unconfigured' (no provider), 'rate_limited' (Replicate
			// throttle — common when account credit is low, carries retryAfter),
			// 'provider_unreachable' (network), or a raw providerStatus (e.g. 402
			// billing). Anything else is a genuine upstream 5xx.
			if (err?.code === 'unconfigured') {
				return error(res, 501, 'txt2img_unconfigured', 'The avatar generator is not available on this deployment yet.');
			}
			if (err?.code === 'rate_limited') {
				const retryAfter = Number(err.retryAfter) || 10;
				res.setHeader('retry-after', String(retryAfter));
				return error(
					res,
					429,
					'txt2img_rate_limited',
					err.message || 'the image provider is throttling requests — try again shortly',
					{ retry_after: retryAfter },
				);
			}
			if (err?.code === 'provider_unreachable') {
				return error(res, 503, 'txt2img_unreachable', 'Could not reach the image engine — please try again shortly.');
			}
			if (err?.code === 'billing' || err?.providerStatus === 402) {
				// Never relay the provider's raw "purchase credit at …/billing"
				// copy — even the error_description must be buyer-safe, since a
				// client may surface it verbatim. textToImage already logged the
				// raw detail (providerDetail) for operators.
				return error(
					res,
					402,
					'txt2img_billing',
					'the image engine is temporarily unavailable — please try again later',
				);
			}
			return error(
				res,
				502,
				'txt2img_error',
				'Could not generate a reference image from your prompt — try rewording it.',
			);
		}
	}

	// ── Submit with provider failover ─────────────────────────────────────────
	// Try each candidate in turn. A submit() only spends provider credits on
	// success (the prediction/task is created server-side after the call
	// returns), so advancing past a thrown error never double-charges. We keep
	// the most actionable classified error to surface if every provider fails.
	let submission = null;
	let usedProvider = null;
	let bestError = null;
	const attempts = [];
	for (const provider of candidates) {
		try {
			submission = await submitWithTransientRetry(provider.instance, {
				userId,
				mode: 'reconstruct',
				params: { ...(body.params ?? {}), images: photos, name: body.name },
				sourceUrl: photos[0],
			});
			usedProvider = provider;
			break;
		} catch (err) {
			const classified = classifyProviderError(err);
			attempts.push(`${provider.name}:${err?.code || err?.status || classified.code}`);
			console.warn(
				'[avatars] reconstruct submit failed on',
				provider.name,
				'—',
				err?.code || err?.status || 'unknown',
				'-',
				err?.message,
			);
			// Prefer the first error that points to a concrete, user-fixable cause
			// (bad key, no credits, bad request) over a generic retry — that is the
			// most useful thing to tell the user if nothing succeeds.
			if (!bestError || (isGenericProviderError(bestError) && !isGenericProviderError(err))) {
				bestError = err;
			}
		}
	}

	if (!submission || !usedProvider) {
		if (attempts.length > 1) {
			console.warn('[avatars] all reconstruct providers failed:', attempts.join(', '));
		}
		return maskSubmitError(res, bestError || new Error('no reconstruct provider available'));
	}

	const jobId = `${usedProvider.name}-${randomUUID()}`;
	const params = {
		images: photos,
		name: body.name,
		description: body.description ?? null,
		visibility: body.visibility ?? 'private',
		...(body.prompt
			? { source: 'prompt', prompt: body.prompt, referenceImageUrl }
			: {}),
	};
	await sql`
		insert into avatar_regen_jobs
			(job_id, user_id, source_avatar_id, mode, params, status, provider, ext_job_id, created_at, updated_at)
		values
			(${jobId}, ${userId}, ${null}, ${'reconstruct'}, ${JSON.stringify(params)}, 'queued', ${usedProvider.name}, ${submission.extJobId ?? null}, now(), now())
	`;
	return json(res, 202, {
		ok: true,
		jobId,
		status: 'queued',
		eta: submission.eta ?? null,
		provider: usedProvider.name,
	});
});

// Assemble the ordered provider candidate list for a reconstruct submit:
// configured platform providers (primary first) followed by the caller's BYOK
// keys (inline body key, then stored keys), de-duplicated by provider name.
async function resolveReconstructCandidates(req, body) {
	const candidates = [];
	const seen = new Set();
	const add = (resolved) => {
		if (resolved?.instance && !seen.has(resolved.name)) {
			seen.add(resolved.name);
			candidates.push(resolved);
		}
	};

	// 1. Every configured platform provider, in precedence order.
	try {
		for (const p of await getRegenProviderCandidates()) add(p);
	} catch (err) {
		console.warn('[avatars] platform provider enumeration failed:', err?.message);
	}

	// 2. Inline BYOK key supplied by the client (provider_name + provider_key).
	if (body.provider_key && body.provider_name) {
		try {
			add(getRegenProviderByName(body.provider_name, body.provider_key));
		} catch (err) {
			console.warn('[avatars] inline BYOK provider load failed:', err?.message);
		}
	}

	// 3. User's stored BYOK keys — iterate preferred providers in order.
	for (const pName of BYOK_REGEN_PROVIDERS) {
		if (seen.has(pName)) continue;
		try {
			const key = await resolveProviderKey(req, null, pName);
			if (key) add(getRegenProviderByName(pName, key));
		} catch {
			// resolveProviderKey can fail when there is no DB session — skip.
		}
	}

	return candidates;
}

// A "generic" provider error is the catch-all 502 (unreachable / unclassified
// provider_error) — i.e. one that doesn't name a concrete, user-fixable cause.
// Used to prefer the most actionable error when reporting an all-providers-failed
// outcome.
function isGenericProviderError(err) {
	return classifyProviderError(err).code === 'regen_provider_error';
}

// Infra faults worth one quick retry against the *same* provider before failing
// over or giving up: transport errors and upstream 5xx. These are the cold-start
// and transient-network failures behind most "engine rejected the job" 502s — a
// single bounded retry clears them without the user noticing, and on a
// single-provider deployment it's the only second chance there is. Deterministic
// faults (bad key, no credits, bad input, throttle, a provider 4xx) are never
// retried here: an identical second call won't change the outcome.
export function isTransientProviderError(err) {
	if (!err) return false;
	if (err.code === 'provider_unreachable' || err.code === 'provider_timeout') return true;
	const upstream = Number(err.providerStatus) || 0;
	if (err.code === 'provider_error') {
		// No upstream status (couldn't even parse a response) or a 5xx → transient.
		// A concrete provider 4xx (e.g. 422 bad image) is deterministic — don't retry.
		return upstream === 0 || upstream >= 500;
	}
	const status = Number(err.status) || 0;
	return status === 503 || status === 504;
}

const SUBMIT_RETRY_DELAY_MS = 1500;

// Submit one provider job, retrying once on a transient infra fault. The retry
// is safe against double-charging: a provider only spends credits / creates the
// upstream prediction on a successful return, so a thrown error means nothing
// was queued. Non-transient errors propagate immediately for the caller to
// classify (and, in the failover loop, fail over to the next provider).
export async function submitWithTransientRetry(instance, request) {
	try {
		return await instance.submit(request);
	} catch (err) {
		if (!isTransientProviderError(err)) throw err;
		await new Promise((resolve) => setTimeout(resolve, SUBMIT_RETRY_DELAY_MS));
		return instance.submit(request);
	}
}

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
