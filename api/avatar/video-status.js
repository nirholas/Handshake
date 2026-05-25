// GET /api/avatar/video-status?job_id=<id>
//
// Polls the LongCat Cloud Run worker for the status of a video generation job.
//
// Query params:
//   job_id  string  — job id returned by POST /api/avatar/video-generate
//
// Response 200:
//   {
//     job_id,
//     status:    "queued" | "running" | "done" | "failed",
//     video_url: string | null,   // present when status === "done"
//     error:     string | null,   // present when status === "failed"
//     updated_at: string,         // ISO 8601
//   }
//
// Errors:
//   400 invalid_request  — missing job_id
//   404 not_found        — job not found
//   502 worker_error     — Cloud Run worker returned an error

import { cors, error, json, wrap } from '../_lib/http.js';
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

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (req.method !== 'GET') return error(res, 405, 'method_not_allowed', `method ${req.method} not allowed`);

	try {
		await requireSession(req);
	} catch {
		return error(res, 401, 'unauthorized', 'valid session required');
	}

	const url = new URL(req.url, 'http://x');
	const jobId = url.searchParams.get('job_id');
	if (!jobId) return error(res, 400, 'invalid_request', 'job_id is required');

	let workerRes;
	try {
		workerRes = await fetch(`${workerUrl()}/jobs/${encodeURIComponent(jobId)}`, {
			headers: { authorization: `Bearer ${workerKey()}` },
		});
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
		video_url:  job.video_url  ?? null,
		error:      job.error      ?? null,
		updated_at: job.updated_at ?? null,
	});
});
