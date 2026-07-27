// GET /api/cron/forge-finalize: server-side completion for forge generations.
//
// Historically a forge_creations row only flipped from 'generating' to
// 'done'/'failed' when the creator's browser polled GET /api/forge?job=… to
// completion (materializeCreation runs inside that poll). Close the tab and the
// generation is orphaned at 'generating' forever, even though the GPU worker
// finished and the GLB is sitting in GCS. This cron makes completion
// server-authoritative so users can leave the page mid-generation:
//
//   1. Sweep 'generating' rows older than GRACE (the browser poll path gets
//      first shot: most generations still finish attended).
//   2. Rows whose replicate_job_id is a GCP worker envelope (the async
//      self-host lanes: trellis_selfhost, hunyuan3d, sketch/triposg: exactly
//      the minutes-long lanes that get orphaned) are polled directly on the
//      worker. done → materializeCreation (same durable-copy writer the
//      browser poll uses, so gallery/showcase/streaks all light up
//      identically). failed → markFailed.
//   3. Anything still not terminal after HARD_TTL is marked failed as timed
//      out, so no row is ever stuck at 'generating' forever. Envelope rows are
//      still polled once first: recovering a finished model always beats
//      declaring it dead.
//   4. A creation finalized here completed UNATTENDED: the user wasn't
//      watching: so this is the one place completion notifications fire
//      (bell + push + email via api/_lib/forge-notify). The attended path
//      never notifies: the result is already on screen.
//
// Idempotent + swarm-safe: materializeCreation short-circuits on already-done
// rows, markFailed is guarded by status != 'done', and the batch is bounded so
// overlapping ticks just split the work.
//
// Auth: CRON_SECRET header, same pattern as every other cron in /api/cron/.

import { sql } from '../_lib/db.js';
import { cors, json, wrapCron } from '../_lib/http.js';
import { constantTimeEquals } from '../_lib/crypto.js';
import { materializeCreation, markFailed, forgeStoreEnabled, createCreation } from '../_lib/forge-store.js';
import { notifyForgeComplete, notifyForgeFailed } from '../_lib/forge-notify.js';
import { createRegenProvider as createGcpProvider } from '../_providers/gcp.js';
import { createNvidiaProvider } from '../_providers/nvidia.js';
import { decodeJobToken, encodeJobToken } from '../_lib/forge-job-token.js';
import {
	pickRedispatchLane,
	submitFailoverJob,
	bindJobSuccessor,
	MAX_FAILOVER_HOPS,
} from '../_lib/forge-failover.js';
import { markLaneUnhealthy } from '../_lib/forge-lane-health.js';
import { resolveTier } from '../_lib/forge-tiers.js';
import { acquireLock, cacheGet, cacheSet } from '../_lib/cache.js';
import { getRedis } from '../_lib/redis.js';

export const maxDuration = 60;

const BATCH_LIMIT = Number(process.env.FORGE_FINALIZE_BATCH) || 25;
// Leave fresh rows to the attended browser poll path.
const GRACE_MINUTES = 2;
// Past this age a non-terminal generation is declared dead. The slowest real
// lane (self-host TRELLIS high tier behind a full queue) finishes well inside
// 30 minutes; beyond it the worker task has been evicted or lost.
const HARD_TTL_MINUTES = 45;
// Browser clients poll attended for up to 12 minutes (src/forge.js MAX_POLL_MS)
// and run their own poll-time lane failover. The cron defers acting on a failed
// self-host poll until that window has passed, so it can never race a live
// browser into a duplicate redispatch of the same generation.
const ATTENDED_POLL_BUDGET_MINUTES = 13;
// Hop/attempted memory for cron-built failover chains, keyed by the successor's
// worker envelope. Same lifetime as the poll path's successor bindings.
const CRON_HOP_PREFIX = 'fr:cron-hop:';
const CRON_HOP_TTL_S = 2 * 3600;
// Mirrors the poll path's NVCF alias/resub keys (api/forge.js pollNvidiaStatus)
// so attended and unattended recovery share one once-per-job budget.
const NVCF_ALIAS_TTL_S = 3600;

export function requireCron(req, res) {
	const secret = process.env.CRON_SECRET;
	if (!secret) {
		// Fail closed, same as the rest of /api/cron: an unset CRON_SECRET must
		// never silently open the endpoint — a misconfigured deploy would
		// otherwise let anyone trigger the finalize sweep on demand.
		res.writeHead(503, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ error: 'not_configured', error_description: 'CRON_SECRET unset' }));
		return true; // handled
	}
	const provided = req.headers['x-cron-secret'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
	if (!provided || !constantTimeEquals(provided, secret)) {
		res.writeHead(401, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ error: 'unauthorized' }));
		return true; // handled
	}
	return false;
}

// The async GCP worker lanes wrap their upstream task in a base64url JSON
// envelope ({ mode, taskId, baseUrl, resultKey }): see api/_providers/gcp.js.
// That shape is the reliable discriminator between "a worker we can poll" and
// an opaque third-party id (Replicate prediction, HF job) we cannot.
export function decodeWorkerEnvelope(replicateJobId) {
	try {
		const obj = JSON.parse(Buffer.from(String(replicateJobId), 'base64url').toString('utf8'));
		return obj?.taskId && obj?.baseUrl ? obj : null;
	} catch {
		return null;
	}
}

async function readCronHop(replicateJobId) {
	const r = getRedis();
	if (!r) return null;
	try {
		const raw = await r.get(`${CRON_HOP_PREFIX}${replicateJobId}`);
		const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
		return value && Number.isFinite(value.hop) ? value : null;
	} catch {
		return null;
	}
}

async function writeCronHop(replicateJobId, value) {
	const r = getRedis();
	if (!r) return;
	try {
		await r.set(`${CRON_HOP_PREFIX}${replicateJobId}`, JSON.stringify(value), { ex: CRON_HOP_TTL_S });
	} catch {
		// Best-effort: a lost hop record loosens the chain cap by one, nothing more.
	}
}

// Unattended twin of the poll handler's automatic lane failover (api/forge.js
// pollJob). The 30-minute worker orphan class lands here by construction: the
// worker only declares an orphan long after every browser has stopped polling,
// so the cron is the ONLY consumer of that failure, and before this it
// dead-ended the job permanently. The original inputs are still on the row;
// resubmit to the next healthy lane instead. The successor gets its own
// creation row (same client/user), so this same cron sweeps it to completion
// and the completion notification still fires for a model, not a failure.
async function tryCronRedispatch(row) {
	if (!row.preview_image_url || row.path === 'sketch') return false;
	const prior = await readCronHop(row.replicate_job_id);
	const hop = prior ? prior.hop : 0;
	if (hop >= MAX_FAILOVER_HOPS) return false;
	const attempted = [...new Set([...(prior?.attempted || []), row.backend].filter(Boolean))];
	const nextLane = await pickRedispatchLane({ attempted });
	if (!nextLane) return false;
	try {
		const submitted = await submitFailoverJob({
			backend: nextLane,
			imageUrl: row.preview_image_url,
			prompt: row.prompt,
			tierId: row.tier,
			path: row.path,
		});
		// The redispatch reconstructs from the primary stored view, so a
		// multi-view original degrades visibly (views_used: 1), never silently:
		// the same provenance contract as the attended failover.
		await createCreation({
			clientKey: row.client_key,
			userId: row.user_id ?? null,
			prompt: row.prompt,
			previewImageUrl: row.preview_image_url,
			replicateJobId: submitted.extJobId,
			viewsRequested: 1,
			viewsUsed: 1,
			multiview: false,
			backend: nextLane,
			tier: row.tier,
			path: row.path,
		});
		await writeCronHop(submitted.extJobId, { hop: hop + 1, attempted });
		// A late attended poller still holds the original f1 handle. Job tokens
		// are deterministic (HMAC over the same payload), so re-encoding the
		// envelope reconstructs the exact string that client polls, so bind the
		// successor chain on it so resolveLiveJob chases to the live job.
		await bindJobSuccessor(
			encodeJobToken({ provider: 'gcp', kind: null, taskId: row.replicate_job_id }),
			{ handle: submitted.handle, backend: nextLane, hop: hop + 1, attempted },
		);
		console.warn(
			`[forge-finalize] job failed on ${row.backend}; unattended auto-failover #${hop + 1} → ${nextLane}`,
		);
		return true;
	} catch (err) {
		console.warn(`[forge-finalize] redispatch failed: ${err?.message || err}`);
		return false;
	}
}

export default wrapCron(async (req, res) => {
	cors(req, res, { methods: 'GET,POST,OPTIONS' });
	if (req.method?.toUpperCase() === 'OPTIONS') return;
	if (requireCron(req, res)) return;
	if (!forgeStoreEnabled()) {
		return json(res, 200, { enabled: false, swept: 0 });
	}

	const t0 = Date.now();

	const rows = await sql`
		select id, replicate_job_id, client_key, user_id, prompt, preview_image_url,
			backend, tier, path, created_at
		from forge_creations
		where status = 'generating'
			and replicate_job_id is not null
			and created_at < now() - (${GRACE_MINUTES} * interval '1 minute')
		order by created_at asc
		limit ${BATCH_LIMIT}
	`;

	let gcp = null;
	try {
		gcp = createGcpProvider();
	} catch {
		// No GCP_RECONSTRUCTION_KEY on this deployment: envelope rows can't be
		// polled here; the hard TTL below still reaps them.
	}
	let nvidia = null;
	try {
		nvidia = createNvidiaProvider();
	} catch {
		// NIM unconfigured: forge-token rows can't be polled here; hard TTL reaps.
	}

	const out = { done: 0, failed: 0, failed_over: 0, resubmitted: 0, timed_out: 0, still_running: 0, unpollable: 0 };

	for (const row of rows) {
		const ageMinutes = (Date.now() - Date.parse(row.created_at)) / 60_000;
		const envelope = decodeWorkerEnvelope(row.replicate_job_id);

		if (envelope && gcp) {
			const status = await gcp.status(row.replicate_job_id).catch(() => null);

			if (status?.status === 'done' && status.resultGlbUrl) {
				const durable = await materializeCreation({
					replicateJobId: row.replicate_job_id,
					clientKey: row.client_key,
					glbUrl: status.resultGlbUrl,
				});
				if (durable) {
					out.done++;
					if (row.user_id) {
						notifyForgeComplete({
							userId: row.user_id,
							creationId: durable.id,
							prompt: row.prompt,
							previewImageUrl: durable.previewImageUrl ?? row.preview_image_url ?? null,
						});
					}
					continue;
				}
				// Copy-to-durable failed (transient storage/network): leave the row
				// for the next tick rather than failing a finished model.
				out.still_running++;
				continue;
			}

			if (status?.status === 'failed') {
				// Inside the attended window a live browser may poll this failure
				// seconds from now and run its own failover; acting here would race
				// it into duplicate GPU work. Leave the row: an attended client
				// resolves it, and an abandoned one ages into the branch below.
				if (ageMinutes < ATTENDED_POLL_BUDGET_MINUTES) {
					out.still_running++;
					continue;
				}
				if (row.backend) await markLaneUnhealthy(row.backend).catch(() => {});
				if (await tryCronRedispatch(row)) {
					await markFailed({
						replicateJobId: row.replicate_job_id,
						clientKey: row.client_key,
						error: status.error || 'generation failed',
					});
					out.failed_over++;
					// No failure notification: the successor row carries the job on,
					// and its completion (or terminal failure) notifies instead.
					continue;
				}
				await markFailed({
					replicateJobId: row.replicate_job_id,
					clientKey: row.client_key,
					error: status.error || 'generation failed',
				});
				out.failed++;
				if (row.user_id) {
					notifyForgeFailed({ userId: row.user_id, prompt: row.prompt, error: status.error });
				}
				continue;
			}

			// queued / running / poll blip: fall through to the TTL check.
		} else if (!envelope) {
			// The paid x402 lane stores the FULL signed forge token (provider +
			// upstream task id) so unattended agent purchases can be completed
			// server-side here, so an agent that got its poll_url answer and moved on
			// still ends with a finished gallery row, not a TTL orphan.
			const forgeToken = decodeJobToken(row.replicate_job_id);
			if (forgeToken?.provider === 'nvidia' && forgeToken.taskId && nvidia) {
				const status = await nvidia
					.status({ kind: forgeToken.kind, taskId: forgeToken.taskId })
					.catch(() => null);
				if (status?.status === 'done' && status.resultGlbUrl) {
					const durable = await materializeCreation({
						replicateJobId: row.replicate_job_id,
						clientKey: row.client_key,
						glbUrl: status.resultGlbUrl,
					});
					if (durable) {
						out.done++;
						continue;
					}
					out.still_running++;
					continue;
				}
				if (status?.status === 'failed') {
					await markFailed({
						replicateJobId: row.replicate_job_id,
						clientKey: row.client_key,
						error: status.error || 'generation failed',
					});
					out.failed++;
					continue;
				}
				// queued / running / poll blip: fall through to the TTL check.
			} else if (row.backend === 'nvidia' && nvidia) {
				// Browser/free-lane NIM rows store the BARE NVCF request id (only the
				// x402 lane stores the signed token), so they used to be unpollable
				// here and died at the hard TTL as "generation timed out" even when
				// the GPU had finished. Poll the bare id directly, chasing the alias
				// an attended expiry recovery may have written first.
				const alias = await cacheGet(`nvcf:alias:${row.replicate_job_id}`).catch(() => null);
				const taskId = typeof alias === 'string' && alias ? alias : row.replicate_job_id;
				const status = await nvidia.status({ taskId }).catch(() => null);
				if (status?.status === 'done' && status.resultGlbUrl) {
					const durable = await materializeCreation({
						replicateJobId: row.replicate_job_id,
						clientKey: row.client_key,
						glbUrl: status.resultGlbUrl,
					});
					if (durable) {
						out.done++;
						if (row.user_id) {
							notifyForgeComplete({
								userId: row.user_id,
								creationId: durable.id,
								prompt: row.prompt,
								previewImageUrl: durable.previewImageUrl ?? row.preview_image_url ?? null,
							});
						}
						continue;
					}
					out.still_running++;
					continue;
				}
				if (status?.code === 'nvcf_expired' && row.prompt) {
					// The request id is dead but the inputs live on the row — the same
					// never-dead-end recovery the attended poll runs, sharing its
					// once-per-job resub lock so the two paths can't double-submit.
					// The alias keeps the row's handle stable; the next tick polls the
					// resubmitted task and materializes onto this same row.
					if (await acquireLock(`nvcf:resub:${row.replicate_job_id}`, NVCF_ALIAS_TTL_S)) {
						try {
							const resub = await nvidia.textTo3d({ prompt: row.prompt, tier: resolveTier(row.tier) });
							if (resub.taskId) {
								await cacheSet(`nvcf:alias:${row.replicate_job_id}`, resub.taskId, NVCF_ALIAS_TTL_S);
								console.warn(
									`[forge-finalize] NVCF request expired; resubmitted unattended job (creation ${row.id})`,
								);
								out.resubmitted++;
								continue;
							}
							if (resub.resultGlbUrl) {
								const durable = await materializeCreation({
									replicateJobId: row.replicate_job_id,
									clientKey: row.client_key,
									glbUrl: resub.resultGlbUrl,
								});
								if (durable) {
									out.done++;
									continue;
								}
							}
						} catch (err) {
							console.warn(`[forge-finalize] NVCF resubmit failed: ${err?.message || err}`);
						}
					}
					// Lock held by a prior recovery or the resubmit failed: fall through
					// to the TTL check so a second expiry fails honestly, not instantly.
				} else if (status?.status === 'failed') {
					await markFailed({
						replicateJobId: row.replicate_job_id,
						clientKey: row.client_key,
						error: status.error || 'generation failed',
					});
					out.failed++;
					if (row.user_id) {
						notifyForgeFailed({ userId: row.user_id, prompt: row.prompt, error: status.error });
					}
					continue;
				}
				// queued / running / poll blip: fall through to the TTL check.
			} else {
				out.unpollable++;
			}
		}

		if (ageMinutes > HARD_TTL_MINUTES) {
			await markFailed({
				replicateJobId: row.replicate_job_id,
				clientKey: row.client_key,
				error: `generation timed out after ${Math.round(ageMinutes)} minutes`,
			});
			out.timed_out++;
			if (row.user_id) {
				notifyForgeFailed({ userId: row.user_id, prompt: row.prompt, error: 'generation timed out' });
			}
		} else if (envelope) {
			out.still_running++;
		}
	}

	return json(res, 200, {
		enabled: true,
		swept: rows.length,
		...out,
		elapsed_ms: Date.now() - t0,
	});
});
