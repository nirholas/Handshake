// POST /api/nodes/jobs/[id]/result: an inference node submits a finished job.
//
// Success body: { node, output, startedAt, finishedAt, receipt }
// Failure body: { node, failed: true, error, startedAt, finishedAt, ts, signature }
//
// On the success path the server RECOMPUTES the canonical receipt payload
// from the submitted fields and verifies the ed25519 signature against the
// claiming node's registered key. `verified: true` in the response means the
// result is cryptographically bound to that node, which is what phase 4
// settlement will check before paying out. A valid job closed by the wrong
// key returns verified:false and the result is discarded.
//
// 200: { ok: true, verified: true }        result accepted and verified
// 200: { ok: true, verified: false }       failure report accepted (unsigned)
// 400: malformed  ·  401: bad receipt  ·  403: not the claiming node
// 404: unknown job  ·  409: job already closed

import { cors, error, json, method, readJson, wrap, rateLimited } from '../../_lib/http.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { completeJob, failJob, verifyResultReceipt, verifyNodeSignature } from '../../_lib/inference-nodes.js';

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export default wrap(async (req, res) => {
	cors(req, res);
	if (!method(req, res, ['POST'])) return;
	if (await rateLimited(res, limits.lenient(clientIp(req)))) return;

	const url = new URL(req.url, 'http://localhost');
	const jobId = url.searchParams.get('id') || url.pathname.match(/\/api\/nodes\/jobs\/([^/]+)\/result/)?.[1];
	if (!jobId) return error(res, 400, 'missing_job_id', 'job id is required in the path');

	let body;
	try {
		body = await readJson(req, 2_000_000);
	} catch {
		return error(res, 400, 'invalid_json', 'request body must be JSON');
	}
	const { node, failed, error: errMsg, output, startedAt, finishedAt, receipt, ts, signature } = body || {};
	if (typeof node !== 'string' || node.length < 32) {
		return error(res, 400, 'invalid_node', 'node public key is required');
	}

	if (failed) {
		// Failure reports carry a signed timestamp instead of a result receipt.
		if (!ts || Math.abs(Date.now() - ts) > MAX_CLOCK_SKEW_MS ||
			!verifyNodeSignature(node, `threews-node-fail:${node}:${jobId}:${ts}`, signature)) {
			return error(res, 401, 'bad_signature', 'failure report signature does not verify');
		}
		const r = await failJob(jobId, { publicKey: node, error: errMsg });
		if (!r.ok) return error(res, r.status, r.error, r.error);
		return json(res, 200, { ok: true, verified: false });
	}

	if (output === undefined || typeof startedAt !== 'number' || typeof finishedAt !== 'number' || !receipt) {
		return error(res, 400, 'missing_fields', 'output, startedAt, finishedAt and receipt are required');
	}

	// Recompute the receipt from the submitted fields and verify it. The job's
	// claimed prompt/model come from the server's own record, so a node cannot
	// sign a receipt over a different prompt than it was assigned.
	const { getJob } = await import('../../_lib/inference-nodes.js');
	const job = await getJob(jobId);
	if (!job) return error(res, 404, 'job_not_found', 'no such job');
	if (job.claimedBy !== node) return error(res, 403, 'not_job_owner', 'this node did not claim this job');

	const prompt = typeof job.input === 'string' ? job.input : job.input?.text ?? '';
	const model = output?.model || job.model;
	const verified = await verifyResultReceipt(
		{ jobId, model, prompt, output, startedAt, finishedAt },
		receipt,
	);
	if (!verified) {
		return error(res, 401, 'bad_receipt', 'result receipt does not verify against the claiming node');
	}

	const r = await completeJob(jobId, { publicKey: node, output, receipt, startedAt, finishedAt });
	if (!r.ok) return error(res, r.status, r.error, r.error);
	return json(res, 200, { ok: true, verified: true });
});
