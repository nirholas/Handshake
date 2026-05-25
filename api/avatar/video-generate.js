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
//   avatar_id  string? — three.ws avatar id; resolved to a render URL
//                        when image_url is not supplied
//
// Response 202:
//   { job_id, status: "queued" }
//
// Errors:
//   400 invalid_request   — missing required fields
//   402 free_trial_used   — free user has already used their 1 free generation
//   502 worker_error      — Cloud Run worker returned an error

import { cors, error, json, wrap } from '../_lib/http.js';
import { sql } from '../_lib/db.js';
import { publicUrl } from '../_lib/r2.js';
import { requireSession } from '../_lib/zauth.js';

function workerUrl() {
	const u = process.env.LONGCAT_WORKER_URL;
	if (!u) throw Object.assign(new Error('LONGCAT_WORKER_URL not configured'), { code: 'worker_unconfigured', status: 503 });
	return u.replace(/\/$/, '');
}

function workerKey() {
	const k = process.env.LONGCAT_WORKER_KEY;
	if (!k) throw Object.assign(new Error('LONGCAT_WORKER_KEY not configured'), { code: 'worker_unconfigured', status: 503 });
	return k;
}

async function resolveImageUrl(avatarId) {
	const rows = await sql`
		select storage_key from avatars
		where id = ${avatarId} and deleted_at is null
		limit 1
	`;
	if (!rows[0]) throw Object.assign(new Error('avatar not found'), { code: 'avatar_not_found', status: 404 });
	return publicUrl(rows[0].storage_key);
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (req.method !== 'POST') return error(res, 405, 'method_not_allowed', `method ${req.method} not allowed`);

	let session;
	try {
		session = await requireSession(req);
	} catch {
		return error(res, 401, 'unauthorized', 'valid session required');
	}

	const userId = session.id ?? session.userId;

	// Check plan + usage. Free plan users get exactly 1 lifetime generation.
	const [userRow] = await sql`
		select plan from users where id = ${userId} and deleted_at is null limit 1
	`;
	if (userRow?.plan === 'free') {
		const [usageRow] = await sql`
			select count(*) as n from usage_events
			where user_id = ${userId} and kind = 'video_generate'
		`;
		if (Number(usageRow?.n) >= 1) {
			return error(res, 402, 'free_trial_used', 'You have used your 1 free video. Upgrade to generate more.');
		}
	}

	const body = req.body || {};
	let { image_url: imageUrl, audio_url: audioUrl, avatar_id: avatarId, prompt } = body;

	if (!audioUrl) return error(res, 400, 'invalid_request', 'audio_url is required');

	if (!imageUrl && avatarId) {
		try {
			imageUrl = await resolveImageUrl(avatarId);
		} catch (err) {
			return error(res, err.status || 400, err.code || 'invalid_request', err.message);
		}
	}

	if (!imageUrl) return error(res, 400, 'invalid_request', 'image_url or avatar_id is required');

	let workerRes;
	try {
		workerRes = await fetch(`${workerUrl()}/generate`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${workerKey()}`,
			},
			body: JSON.stringify({
				image_url: imageUrl,
				audio_url: audioUrl,
				prompt: prompt || 'A person talking naturally.',
			}),
		});
	} catch (err) {
		return error(res, 502, 'worker_unreachable', err?.message || 'worker request failed');
	}

	if (!workerRes.ok) {
		const text = await workerRes.text().catch(() => '');
		return error(res, 502, 'worker_error', `worker returned ${workerRes.status}: ${text.slice(0, 200)}`);
	}

	const result = await workerRes.json();

	// Record usage so we can enforce the free trial limit.
	await sql`
		insert into usage_events (user_id, kind, meta)
		values (${userId}, 'video_generate', ${JSON.stringify({ job_id: result.job_id })}::jsonb)
	`.catch(() => {});

	return json(res, 202, { job_id: result.job_id, status: result.status });
});
