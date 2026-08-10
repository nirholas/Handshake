// @ts-check
// GET /api/cron/auto-rig-sweep — completion backstop for auto-rig jobs.
//
// When a static avatar is created (upload, URL import, chat/MCP forge save) the
// platform fires a background 'rerig' job tagged auto_rig and materializes the
// rigged GLB as a sibling avatar once it lands. Completion is normally driven by the Replicate
// webhook (instant) or, for browser flows, the regenerate-status poll. Headless
// creations (MCP) never poll, so a single dropped webhook would otherwise leave
// the avatar stuck static forever with its job pinned at 'running'.
//
// This sweep is the safety net: every few minutes it finds auto_rig jobs that
// have gone quiet, asks the provider for their real status, and finalizes (or
// fails) them. It deliberately ignores jobs touched in the last few minutes so
// it never races the webhook for a job that's completing normally.
//
// Every job here is a rerig job, so resolve the first platform provider that
// actually supports rerig (Replicate with a rerig model, or the self-hosted GCP
// UniRig pipeline) — deterministic precedence means it matches the provider the
// submit path chose. No per-job BYOK key juggling.

import { json, method, wrapCron } from '../_lib/http.js';
import { sql } from '../_lib/db.js';
import { getRegenProviderForMode } from '../_lib/regen-provider.js';
import { finalizeAutoRigStage } from '../_lib/auto-rig.js';
import { isAllowedProviderResultUrl } from '../_lib/provider-result-url.js';
import { requireCron } from '../_lib/cron-auth.js';

// Leave the webhook a clear runway before we touch a job: most rigs finish in
// 60–90s, so a 3-minute quiet window means we only ever sweep genuinely stalled
// work, never a job that's about to complete on its own.
const QUIET_WINDOW = "3 minutes";
// Don't chase jobs forever — anything older than this that still isn't done is
// treated as dead and failed out so the queue can't accrete zombies.
const MAX_AGE = "6 hours";
// Throughput must outrun plausible headless-creation inflow so no job starves.
// 100 jobs/tick × 12 ticks/hour (the */5 schedule in vercel.json) = 1,200
// finalizations/hour from the cron alone — and the cron only ever handles the
// dropped-webhook tail (the webhook finalizes the overwhelming majority inline,
// instantly), so 1,200/hr clears even a large MCP creation burst within a tick or
// two. Candidates are ordered updated_at asc (oldest-quiet-first) so the backlog
// drains FIFO and the oldest job can never be perpetually overtaken.
const BATCH = 100;

// Best-effort hostname for a log line — never throws on a malformed URL.
function hostOf(raw) {
	try { return new URL(raw).hostname; } catch { return 'unparseable'; }
}

async function failJob(jobId, userId, reason) {
	await sql`
		update avatar_regen_jobs
		set status = 'failed', error = ${reason}, updated_at = now()
		where job_id = ${jobId} and user_id = ${userId}
	`;
}

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET', 'POST'])) return;
	if (!requireCron(req, res)) return;

	// Candidate jobs: our auto_rig rerig jobs that are still open, have gone quiet
	// (webhook missed or never arrived), and aren't yet materialized. Three states
	// qualify:
	//   • 'queued'/'running' — the normal stalled-job tail (dropped webhook, or a
	//     headless MCP creation that never polls).
	//   • 'done' + result_avatar_id IS NULL + error IS NULL — the permanent-orphan
	//     case. Under Strategy A a thrown finalize releases the row to 'running', so
	//     this lane mainly heals LEGACY orphans created before that fix shipped;
	//     it's kept as belt-and-suspenders for any path that could still strand a
	//     job at done+null. The `error IS NULL` guard is deliberate: finalize closes
	//     a job to done+null WITH an error note when it gives up on purpose (e.g.
	//     plan-quota exhaustion), and those terminal closes must NOT be re-attempted.
	// Either way result_avatar_id IS NULL means "not yet materialized", and the
	// QUIET_WINDOW guarantees we never race a webhook/poll finalize in progress.
	// We carry result_glb_url so a job that already has the provider's GLB URL
	// (the webhook stored it) is finalized from that URL WITHOUT a second provider
	// status() round-trip.
	const rows = await sql`
		select job_id, user_id, source_avatar_id, ext_job_id, status, result_glb_url, created_at
		from avatar_regen_jobs
		where mode = 'rerig'
		  and (params->>'auto_rig') = 'true'
		  and (
		    status in ('queued', 'running')
		    or (status = 'done' and error is null)
		  )
		  and result_avatar_id is null
		  and updated_at < now() - ${QUIET_WINDOW}::interval
		  and created_at > now() - ${MAX_AGE}::interval
		order by updated_at asc
		limit ${BATCH}
	`;

	const summary = { scanned: rows.length, finalized: 0, failed: 0, pending: 0, errored: 0, reaped: 0 };

	// Reap the truly-dead tail on EVERY tick, regardless of candidate count. This
	// used to be nested inside `if (!rows.length)`, so a sustained backlog of ≥BATCH
	// quiet candidates meant rows.length was never zero and zombies older than
	// MAX_AGE accreted forever. Run it unconditionally; its created_at <= now()-MAX_AGE
	// filter is disjoint from the candidate query's created_at > now()-MAX_AGE, so the
	// two never touch the same row.
	const reaped = await sql`
		update avatar_regen_jobs
		set status = 'failed', error = 'auto-rig job exceeded max age without completing', updated_at = now()
		where mode = 'rerig'
		  and (params->>'auto_rig') = 'true'
		  and status in ('queued', 'running')
		  and result_avatar_id is null
		  and created_at <= now() - ${MAX_AGE}::interval
		returning job_id
	`;
	summary.reaped = reaped.length;

	if (!rows.length) {
		return json(res, 200, { ok: true, ...summary });
	}

	// Resolve the provider lazily — a candidate that already carries result_glb_url
	// is finalized straight from that stored URL and never needs the provider at
	// all, so a batch of fully-delivered orphans completes even if the provider is
	// momentarily unavailable.
	let provider = null;
	let providerResolved = false;
	async function ensureProvider() {
		if (!providerResolved) {
			providerResolved = true;
			try {
				provider = await getRegenProviderForMode('rerig');
			} catch (err) {
				console.warn('[auto-rig-sweep] provider resolve failed', { error: err?.message });
				provider = null;
			}
		}
		return provider?.instance ? provider : null;
	}

	for (const job of rows) {
		try {
			// Fast path: the webhook already stored the provider's GLB URL on the
			// row. Finalize straight from it — no second status() call (wasted
			// latency + an extra failure surface for a URL we already hold). The
			// finalize claim makes this safe even if a webhook retry races us.
			if (job.result_glb_url) {
				// SSRF gate: the webhook persists the extracted URL WITHOUT the host
				// allowlist, so a poisoned URL could be sitting in this column. Pin it to
				// an allowed provider host before fetching server-side; fail the job
				// cleanly on a miss instead of finalizing from it.
				if (!isAllowedProviderResultUrl(job.result_glb_url)) {
					console.warn('[auto-rig-sweep] blocked result url', { jobId: job.job_id, host: hostOf(job.result_glb_url) });
					await failJob(job.job_id, job.user_id, 'provider returned a disallowed result url');
					summary.failed++;
					continue;
				}
				await finalizeAutoRigStage({
					userId: job.user_id,
					jobId: job.job_id,
					job,
					glbUrl: job.result_glb_url,
				});
				summary.finalized++;
				continue;
			}

			if (!job.ext_job_id) {
				// No stored URL and no external id — unpollable, so it can never
				// complete. Fail it out.
				await failJob(job.job_id, job.user_id, 'auto-rig job has no provider id to poll');
				summary.failed++;
				continue;
			}

			const prov = await ensureProvider();
			if (!prov) {
				// Provider down right now — leave the job untouched so a later tick
				// retries it; don't fail a recoverable job.
				summary.errored++;
				continue;
			}

			const update = await prov.instance.status(job.ext_job_id);

			if (update.status === 'done' && update.resultGlbUrl) {
				// SSRF gate (same as the fast path): pin the fresh provider URL to an
				// allowed host before the guarded fetch ever runs; fail on a miss.
				if (!isAllowedProviderResultUrl(update.resultGlbUrl)) {
					console.warn('[auto-rig-sweep] blocked result url', { jobId: job.job_id, host: hostOf(update.resultGlbUrl) });
					await failJob(job.job_id, job.user_id, 'provider returned a disallowed result url');
					summary.failed++;
				} else {
					await finalizeAutoRigStage({
						userId: job.user_id,
						jobId: job.job_id,
						job,
						glbUrl: update.resultGlbUrl,
					});
					summary.finalized++;
				}
			} else if (update.status === 'failed') {
				await failJob(job.job_id, job.user_id, update.error || 'provider reported rig failure');
				summary.failed++;
			} else {
				// Still genuinely running — bump the row so it isn't re-swept next
				// tick and record the live provider status.
				await sql`
					update avatar_regen_jobs
					set status = ${update.status || 'running'}, updated_at = now()
					where job_id = ${job.job_id} and user_id = ${job.user_id}
				`;
				summary.pending++;
			}
		} catch (err) {
			console.warn('[auto-rig-sweep] job error', { jobId: job.job_id, error: err?.message });
			summary.errored++;
		}
	}

	return json(res, 200, { ok: true, ...summary });
});
