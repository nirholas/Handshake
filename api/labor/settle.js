// POST /api/labor/settle: verify a delivered job and release escrow on-chain.
// Idempotent (job settle_key): a retry never double-pays. Callable by either
// participant (poster or worker owner) so a stuck-but-delivered job can always be
// resolved; the neutral verifier, not the caller, decides whether funds release.

import { cors, error, json, method, readJson, wrap } from '../_lib/http.js';
import { sql } from '../_lib/db.js';
import { authWrite, requireUuid } from '../_lib/labor-auth.js';
import { getJob, getJobByBounty, getBounty } from '../_lib/agent-labor.js';
import { runSettlement } from '../_lib/labor-settle.js';

async function ownsEither(userId, posterAgentId, workerAgentId) {
	const rows = await sql`
		SELECT id FROM agent_identities
		WHERE id IN (${posterAgentId}, ${workerAgentId}) AND user_id = ${userId} AND deleted_at IS NULL`;
	return rows.length > 0;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const auth = await authWrite(req, res);
	if (!auth) return;
	const { userId } = auth;

	const body = (await readJson(req)) || {};
	const { jobId, bountyId } = body;
	// Say "you sent nothing" rather than "the job does not exist": a caller that
	// omitted both ids used to get a 404 and go hunting for a missing job.
	if (!jobId && !bountyId) return error(res, 400, 'validation_error', 'jobId or bountyId is required');
	if (jobId && !requireUuid(res, jobId, 'jobId')) return;
	if (!jobId && !requireUuid(res, bountyId, 'bountyId')) return;

	const job = jobId ? await getJob(jobId) : await getJobByBounty(bountyId);
	if (!job) return error(res, 404, 'not_found', 'job not found');

	if (!(await ownsEither(userId, job.poster_agent_id, job.worker_agent_id))) {
		return error(res, 403, 'forbidden', 'only the poster or worker owner can settle this job');
	}

	if (!['delivered', 'verifying'].includes(job.status)) {
		if (job.status === 'settled' || job.status === 'failed' || job.status === 'refunded') {
			return json(res, 200, { ok: true, idempotent: true, status: job.status, job_id: job.id });
		}
		return error(res, 409, 'not_deliverable', `job is ${job.status}; nothing to settle until it is delivered`);
	}

	const bounty = await getBounty(job.bounty_id);
	const result = await runSettlement({ job, bounty });
	return json(res, 200, { ok: true, job_id: job.id, settlement: result });
});
