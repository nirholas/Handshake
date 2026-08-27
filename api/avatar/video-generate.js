// POST /api/avatar/video-generate
//
// Submits a talking-avatar video generation job to the LongCat-Video-Avatar-1.5
// Cloud Run worker. Returns immediately with a job_id for polling.
//
// Free-plan users get 1 lifetime generation. Paid users are unlimited.
//
// Request body (JSON):
//   image_url  string  — publicly accessible reference image (PNG/JPG)
//   audio_url  string  — publicly accessible audio file (WAV/MP3)
//   prompt     string? — optional text description
//   avatar_id  string?  three.ws avatar id, resolved to a reference image
//                       when image_url is not supplied
//
// Response 202:
//   { job_id, status: "queued" }
//
// GET returns an availability document instead of a job:
//   { endpoint, available, reason, free_generations }
// so a client can tell a visitor the renderer is offline BEFORE it walks them
// through uploading audio. Without it the only signal was a 503 raised after
// the upload had already happened.
//
// Errors:
//   400 invalid_request   - missing required fields
//   402 free_trial_used   - free user has already used their 1 free generation
//   502 worker_error      - Cloud Run worker returned an error
//   503 worker_unconfigured - LongCat worker is not configured on this deployment

import { cors, error, json, wrap, rateLimited } from '../_lib/http.js';
import { limits } from '../_lib/rate-limit.js';
import { sql } from '../_lib/db.js';
import { publicUrl, thumbnailUrl } from '../_lib/r2.js';
import { getSessionUser } from '../_lib/auth.js';
import { env } from '../_lib/env.js';
import { fetchUpstream } from '../_lib/upstream-fetch.js';

// A submit starts a GPU job, so it is never retried; the deadline only bounds
// the wait for the worker to accept it. Shared breaker with video-status.
const WORKER_BREAKER = 'longcat-worker';
const GENERATE_TIMEOUT_MS = 60_000;
import { resolveRenderParams, renderAvatarImage } from '../_lib/avatar-render.js';

// Rendering a fresh reference image runs headless chromium, so this handler can
// legitimately outrun the 10 s default on a first-time avatar.
export const maxDuration = 60;

// Mirror of trustedOrigin() in api/avatar/optimize.js: image_url/audio_url are
// forwarded to the LongCat worker, which fetches them server-side. Restrict them
// to https on a three.ws-controlled host (APP_ORIGIN / R2 public domain) so a
// caller can't drive the worker into an SSRF against internal/metadata hosts.
function trustedMediaUrl(url) {
	let u;
	try {
		u = new URL(url);
	} catch {
		return false;
	}
	if (u.protocol !== 'https:') return false;
	const allowed = new Set();
	try {
		if (env.APP_ORIGIN) allowed.add(new URL(env.APP_ORIGIN).host);
	} catch {
		/* ignore malformed env */
	}
	try {
		if (env.S3_PUBLIC_DOMAIN) allowed.add(new URL(env.S3_PUBLIC_DOMAIN).host);
	} catch {
		/* ignore malformed env */
	}
	return allowed.has(u.host);
}

// Resolve the worker's address and credential together, returning null when
// either is unset. Both used to throw from inside the `fetch` try-block, so an
// unconfigured deployment answered `502 worker_unreachable` with the literal
// env-var name in the body: the wrong status (nothing was unreachable, the
// endpoint was never configured) and an operator detail the caller has no
// business seeing. Resolving up front turns that into the documented 503 and
// keeps the var name in the server log where it belongs.
function workerConfig() {
	const url = process.env.LONGCAT_WORKER_URL;
	const key = process.env.LONGCAT_WORKER_KEY;
	if (!url || !key) return null;
	return { url: url.replace(/\/$/, ''), key };
}

// The worker writes whatever this resolves to straight into `ref_image.png` and
// hands it to inference as `cond_image`, so it has to be an actual raster image.
// Returning the avatar's GLB (which is what this did) produced a job that always
// failed deep inside the worker, minutes after the caller was told "queued".
// Order: the stored thumbnail if one exists, otherwise a portrait render through
// the same cached pipeline /api/avatar/render uses, so the second video from an
// avatar costs a HEAD instead of a chromium launch.
const REFERENCE_RENDER = resolveRenderParams({
	scene: 'portrait',
	size: '768',
	bg: '#101010',
	format: 'png',
}).params;

async function resolveImageUrl(avatarId, requesterId) {
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(avatarId || ''))) {
		throw Object.assign(new Error('avatar not found'), { code: 'avatar_not_found', status: 404 });
	}
	// Enforce ownership/visibility: the caller may only generate video from an
	// avatar they own or one that is public/unlisted — never another user's
	// private avatar. (Previously resolved by id alone — an IDOR.)
	const rows = await sql`
		select id, storage_key, thumbnail_key, updated_at from avatars
		where id = ${avatarId} and deleted_at is null
		  and (owner_id = ${requesterId} or visibility in ('public', 'unlisted'))
		limit 1
	`;
	if (!rows[0])
		throw Object.assign(new Error('avatar not found'), {
			code: 'avatar_not_found',
			status: 404,
		});

	const stored = thumbnailUrl(rows[0].thumbnail_key);
	if (stored) return stored;

	try {
		const out = await renderAvatarImage({
			avatar: { id: rows[0].id, updated_at: rows[0].updated_at },
			glbUrl: publicUrl(rows[0].storage_key),
			params: REFERENCE_RENDER,
			awaitUpload: true,
		});
		return out.imageUrl;
	} catch (err) {
		console.error('[video-generate] reference render failed:', err?.message || err);
		throw Object.assign(
			new Error('Could not render a reference image for this avatar. Give it a thumbnail and try again.'),
			{ code: 'reference_image_failed', status: 502 },
		);
	}
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;

	if (req.method === 'GET') {
		const configured = workerConfig() !== null;
		return json(
			res,
			200,
			{
				endpoint: 'POST /api/avatar/video-generate',
				description:
					'Render a talking-head video from a three.ws avatar and a spoken audio clip.',
				available: configured,
				reason: configured ? 'ready' : 'worker_unconfigured',
				free_generations: 1,
				accepts: {
					avatar_id: 'three.ws avatar UUID; resolved server-side to a reference image',
					image_url: 'https URL on a three.ws host, used instead of avatar_id',
					audio_url: 'https URL on a three.ws host (WAV/MP3/M4A)',
					prompt: 'optional scene description',
				},
			},
			{ 'cache-control': 'no-store' },
		);
	}

	if (req.method !== 'POST')
		return error(res, 405, 'method_not_allowed', `method ${req.method} not allowed`);

	let session;
	try {
		session = await getSessionUser(req);
		if (!session) throw new Error('no session');
	} catch {
		return error(res, 401, 'unauthorized', 'valid session required');
	}

	const userId = session.id ?? session.userId;

	const [rl, rlg] = await Promise.all([
		limits.videoGenerateUser(userId),
		limits.videoGenerateGlobal(),
	]);
	if (!rl.success) return rateLimited(res, rl);
	if (!rlg.success) return rateLimited(res, rlg);

	// Check plan + usage. Free plan users get exactly 1 lifetime generation.
	const [userRow] = await sql`
		select plan from users where id = ${userId} and deleted_at is null limit 1
	`;
	const isFree = userRow?.plan === 'free';

	// Fast-path rejection. The authoritative, race-safe gate is the reservation
	// insert below — this early read just spares already-spent users the
	// validation work.
	if (isFree) {
		const [usageRow] = await sql`
			select count(*) as n from usage_events
			where user_id = ${userId} and kind = 'video_generate'
		`;
		if (Number(usageRow?.n) >= 1) {
			return error(
				res,
				402,
				'free_trial_used',
				'You have used your 1 free video. Upgrade to generate more.',
			);
		}
	}

	const body = req.body || {};
	let { image_url: imageUrl, audio_url: audioUrl, avatar_id: avatarId, prompt } = body;

	if (!audioUrl) return error(res, 400, 'invalid_request', 'audio_url is required');

	if (!imageUrl && avatarId) {
		try {
			imageUrl = await resolveImageUrl(avatarId, userId);
		} catch (err) {
			return error(res, err.status || 400, err.code || 'invalid_request', err.message);
		}
	}

	if (!imageUrl) return error(res, 400, 'invalid_request', 'image_url or avatar_id is required');

	// The worker fetches these URLs server-side, so they must be https on a
	// three.ws-controlled host. A server-resolved avatar render (publicUrl →
	// R2 domain) already satisfies this; an arbitrary caller-supplied URL must
	// pass the same allowlist or we'd hand the worker an SSRF primitive.
	if (!trustedMediaUrl(imageUrl)) {
		return error(res, 400, 'invalid_request', 'image_url must be an https three.ws-hosted URL');
	}
	if (!trustedMediaUrl(audioUrl)) {
		return error(res, 400, 'invalid_request', 'audio_url must be an https three.ws-hosted URL');
	}

	// Validation first (a malformed request deserves an actionable 400, not a
	// misleading "service unavailable"), then the worker-config gate, and only
	// then the reservation. The free-trial reservation below is a real DB write,
	// so a deployment that can never reach the worker must not insert and then
	// delete a usage row on every attempt.
	const worker = workerConfig();
	if (!worker) {
		console.error('[video-generate] LONGCAT_WORKER_URL / LONGCAT_WORKER_KEY not set on this deployment');
		return error(
			res,
			503,
			'worker_unconfigured',
			'Talking-avatar video generation is not available on this deployment.',
		);
	}

	// Atomically reserve the free-trial slot BEFORE submitting the worker job.
	// The old check-then-insert straddled the worker call, so two concurrent
	// requests could both pass the count check and both generate. Reserving
	// first closes that window: usage_events.id is a bigserial, so after our
	// reservation lands, any earlier (lower-id) video_generate row for this user
	// means another request already holds or spent the single free slot — we
	// release ours and reject. The row is deleted if worker submission fails,
	// so a worker outage never burns the trial.
	let reservationId = null;
	if (isFree) {
		const [reserved] = await sql`
			insert into usage_events (user_id, kind, meta)
			values (${userId}, 'video_generate', '{}'::jsonb)
			returning id
		`;
		reservationId = reserved.id;
		const [prior] = await sql`
			select count(*) as n from usage_events
			where user_id = ${userId} and kind = 'video_generate' and id < ${reservationId}
		`;
		if (Number(prior?.n) >= 1) {
			await releaseReservation(reservationId);
			return error(
				res,
				402,
				'free_trial_used',
				'You have used your 1 free video. Upgrade to generate more.',
			);
		}
	}

	let result;
	try {
		let workerRes;
		try {
			workerRes = await fetchUpstream(`${worker.url}/generate`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${worker.key}`,
				},
				body: JSON.stringify({
					image_url: imageUrl,
					audio_url: audioUrl,
					prompt: prompt || 'A person talking naturally.',
				}),
			}, { name: WORKER_BREAKER, timeoutMs: GENERATE_TIMEOUT_MS, attempts: 1, okWhen: () => true });
		} catch (err) {
			await releaseReservation(reservationId);
			return error(res, 502, 'worker_unreachable', err?.message || 'worker request failed');
		}

		if (!workerRes.ok) {
			const text = await workerRes.text().catch(() => '');
			await releaseReservation(reservationId);
			return error(
				res,
				502,
				'worker_error',
				`worker returned ${workerRes.status}: ${text.slice(0, 200)}`,
			);
		}

		result = await workerRes.json();
	} catch (err) {
		await releaseReservation(reservationId);
		return error(
			res,
			502,
			'worker_error',
			err?.message || 'worker returned an unreadable response',
		);
	}

	const jobId = result.job_id;

	// Record usage so we can verify job ownership. The free-trial quota row
	// already exists (the reservation) — attach the job id to it. Paid users
	// get a best-effort audit row; a logging failure must not block them.
	try {
		if (reservationId != null) {
			await sql`
				update usage_events set meta = ${JSON.stringify({ job_id: jobId })}::jsonb
				where id = ${reservationId}
			`;
		} else {
			await sql`
				insert into usage_events (user_id, kind, meta)
				values (${userId}, 'video_generate', ${JSON.stringify({ job_id: jobId })}::jsonb)
			`;
		}
	} catch (err) {
		console.error('[video-generate] failed to record job id on usage event:', err);
	}

	return json(res, 202, { job_id: jobId, status: result.status });
});

// Best-effort delete of a free-trial reservation row after a failed worker
// submission. A delete failure leaves the slot consumed (fail-closed) rather
// than risking unlimited free generations.
async function releaseReservation(reservationId) {
	if (reservationId == null) return;
	try {
		await sql`delete from usage_events where id = ${reservationId}`;
	} catch (err) {
		console.error('[video-generate] failed to release free-trial reservation:', err);
	}
}
