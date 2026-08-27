// GET /api/avatar/video-status?job_id=<id>
//
// Polls the LongCat Cloud Run worker for the status of a video generation job.
// Only the user who submitted the job can poll it.
//
// Query params:
//   job_id  string  — job id returned by POST /api/avatar/video-generate
//
// Response 200:
//   {
//     job_id,
//     status:    "queued" | "running" | "done" | "failed",
//     progress:  number | null,   // 0 to 1, monotonic, present once running
//     segments:  number | null,   // clips the worker is rendering for this audio
//     audio_seconds: number | null, // measured duration of the driving audio
//     video_url: string | null,   // present when status === "done"
//     error:     string | null,   // present when status === "failed"
//     updated_at: string,         // ISO 8601
//   }
//
// The worker renders a fixed 3.72 s clip per segment and sizes the segment count
// from the audio duration, so `segments` is what turns `progress` into a real
// expectation ("3 clips") instead of an opaque percentage.
//
// Errors:
//   400 invalid_request  - missing job_id
//   403 forbidden        - job belongs to a different user
//   404 not_found        - job not found
//   502 worker_error     - Cloud Run worker returned an error
//   503 worker_unconfigured - LongCat worker is not configured on this deployment

import { cors, error, json, wrap } from '../_lib/http.js';
import { sql } from '../_lib/db.js';
import { getSessionUser } from '../_lib/auth.js';
import { fetchUpstream } from '../_lib/upstream-fetch.js';

// Job reads are idempotent: short deadline, retried, same breaker as the submit.
const WORKER_BREAKER = 'longcat-worker';
const STATUS_TIMEOUT_MS = 10_000;

// Mirror of workerConfig() in api/avatar/video-generate.js: resolve address and
// credential together and return null when either is unset. Throwing from inside
// the `fetch` try-block made an unconfigured deployment answer
// `502 worker_unreachable` with the literal env-var name in the body: the wrong
// status, and an operator detail the caller should never see.
function workerConfig() {
	const url = process.env.LONGCAT_WORKER_URL;
	const key = process.env.LONGCAT_WORKER_KEY;
	if (!url || !key) return null;
	return { url: url.replace(/\/$/, ''), key };
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (req.method !== 'GET') return error(res, 405, 'method_not_allowed', `method ${req.method} not allowed`);

	let session;
	try {
		session = await getSessionUser(req);
		if (!session) throw new Error('no session');
	} catch {
		return error(res, 401, 'unauthorized', 'valid session required');
	}

	const userId = session.id ?? session.userId;

	const url = new URL(req.url, 'http://x');
	const jobId = url.searchParams.get('job_id');
	if (!jobId) return error(res, 400, 'invalid_request', 'job_id is required');

	// Verify job ownership via usage_events — the job record written at submit time.
	const [ownership] = await sql`
		select user_id from usage_events
		where kind = 'video_generate' and meta->>'job_id' = ${jobId}
		limit 1
	`;
	if (!ownership) return error(res, 404, 'not_found', 'job not found');
	if (String(ownership.user_id) !== String(userId)) return error(res, 403, 'forbidden', 'access denied');

	const worker = workerConfig();
	if (!worker) {
		console.error('[video-status] LONGCAT_WORKER_URL / LONGCAT_WORKER_KEY not set on this deployment');
		return error(res, 503, 'worker_unconfigured', 'Talking-avatar video generation is not available on this deployment.');
	}

	let workerRes;
	try {
		workerRes = await fetchUpstream(`${worker.url}/jobs/${encodeURIComponent(jobId)}`, {
			headers: { authorization: `Bearer ${worker.key}` },
		}, { name: WORKER_BREAKER, timeoutMs: STATUS_TIMEOUT_MS, attempts: 3, okWhen: () => true });
	} catch (err) {
		return error(res, 502, 'worker_unreachable', err?.message || 'worker request failed');
	}

	if (workerRes.status === 404) return error(res, 404, 'not_found', 'job not found');
	if (!workerRes.ok) {
		const text = await workerRes.text().catch(() => '');
		return error(res, 502, 'worker_error', `worker returned ${workerRes.status}: ${text.slice(0, 200)}`);
	}

	const job = await workerRes.json();
	return json(res, 200, {
		job_id:     job.job_id,
		status:     job.status,
		progress:   job.progress   ?? null,
		segments:   job.segments   ?? null,
		audio_seconds: job.audio_seconds ?? null,
		video_url:  job.video_url  ?? null,
		error:      job.error      ?? null,
		updated_at: job.updated_at ?? null,
	});
});
