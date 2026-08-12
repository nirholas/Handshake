/**
 * The job loop: register once, then poll -> execute -> sign -> submit
 * forever, with bounded concurrency and graceful shutdown.
 *
 * Failure policy (matching the platform's agent-screen worker): a job that
 * throws is reported as failed with its error string (the platform requeues
 * or refunds it), and the loop continues. The loop itself only exits on
 * SIGINT/SIGTERM or a fatal registration error; transient poll failures back
 * off exponentially and retry, since a node that gives up on the first
 * network blip earns nothing.
 */

import { runJob } from './inference.js';
import { signResult } from './signing.js';

export function createJobLoop({
	client,
	identity,
	capability,
	pollIntervalMs = 5000,
	maxConcurrency = 1,
	cacheDir,
	jobTimeoutMs = 120_000,
	log = console,
	runJobImpl = runJob,
}) {
	let running = false;
	let inFlight = 0;
	let wakeTimer = null;
	let resolveWake = null;
	const jobsDone = { completed: 0, failed: 0 };

	function sleep(ms) {
		return new Promise((resolve) => {
			wakeTimer = setTimeout(() => {
				wakeTimer = null;
				resolveWake = null;
				resolve();
			}, ms);
			resolveWake = resolve;
		});
	}

	/** Interrupt the current sleep so shutdown is immediate. */
	function wake() {
		if (wakeTimer) clearTimeout(wakeTimer);
		wakeTimer = null;
		resolveWake?.();
	}

	async function executeJob(job) {
		const startedAt = Date.now();
		try {
			const { output, startedAt: t0, finishedAt: t1 } = await withTimeout(
				runJobImpl(job, { cacheDir }),
				jobTimeoutMs,
				`job ${job.id} exceeded ${jobTimeoutMs}ms`,
			);
			const receipt = await signResult(identity, {
				jobId: job.id,
				model: output.model || job.model,
				prompt: typeof job.input === 'string' ? job.input : job.input?.text ?? '',
				output,
				startedAt: t0,
				finishedAt: t1,
			});
			const res = await client.submitResult(job.id, { output, startedAt: t0, finishedAt: t1, receipt });
			jobsDone.completed++;
			log.log(`[node] job ${job.id} complete (${t1 - t0}ms inference, verified=${res?.verified ?? 'unknown'})`);
		} catch (err) {
			jobsDone.failed++;
			log.warn(`[node] job ${job.id} failed: ${err.message}`);
			try {
				await client.reportFailure(job.id, { error: err.message, startedAt, finishedAt: Date.now() });
			} catch (reportErr) {
				log.warn(`[node] could not report failure for ${job.id}: ${reportErr.message}`);
			}
		} finally {
			inFlight--;
		}
	}

	return {
		stats: jobsDone,

		/** Run until stop() is called. Resolves on clean shutdown. */
		async run() {
			running = true;
			let backoff = pollIntervalMs;
			while (running) {
				let job = null;
				try {
					job = await client.pollJob({ capability });
					backoff = pollIntervalMs; // a healthy poll resets the backoff
				} catch (err) {
					log.warn(`[node] poll failed (${err.message}); retrying in ${Math.round(backoff / 1000)}s`);
					await sleep(backoff);
					backoff = Math.min(backoff * 2, 60_000);
					continue;
				}
				if (job && inFlight < maxConcurrency) {
					inFlight++;
					// Deliberately not awaited: maxConcurrency > 1 overlaps jobs,
					// and a slow job must not stall the poll loop.
					void executeJob(job);
				} else if (!job) {
					await sleep(pollIntervalMs);
				}
			}
			// Drain in-flight jobs so a shutdown never abandons half-computed work.
			while (inFlight > 0) await sleep(250);
		},

		stop() {
			running = false;
			wake();
		},
	};
}

function withTimeout(promise, ms, message) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(message)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
