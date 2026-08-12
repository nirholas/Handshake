// The job loop: claim -> execute -> sign -> submit, forever.
//
// Poll cadence mirrors workers/agent-screen-pool (POLL_MS, default 3s). A
// failed job is submitted as a signed error record so the coordinator can
// penalize the node instead of retrying forever; a failed HTTP round backs
// off linearly and never kills the loop.

import { buildResultRecord, canonicalResult } from './codec.js';
import { signPayload } from './identity.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class NodeRunner {
	constructor({ client, engine, keypair, pollMs = 3000, maxJobs = Infinity, onEvent = () => {} }) {
		this.client = client;
		this.engine = engine;
		this.keypair = keypair;
		this.pollMs = pollMs;
		this.maxJobs = maxJobs;
		this.onEvent = onEvent;
		this.completed = 0;
		this.stopping = false;
	}

	stop() {
		this.stopping = true;
	}

	async executeAndSubmit(job) {
		const { engine, keypair, client } = this;
		let record;
		try {
			const out = await engine.generate(job.input.prompt, job.maxTokens);
			record = buildResultRecord({
				job,
				node: keypair.address,
				model: job.model || 'Xenova/distilgpt2',
				text: out.text,
				tokens: out.tokens,
				latencyMs: out.latencyMs,
				completedAt: new Date().toISOString(),
			});
		} catch (err) {
			// A failed execution still produces a signed record (empty output) so
			// the failure is attributable to this node rather than ambiguous.
			record = buildResultRecord({
				job,
				node: keypair.address,
				model: job.model || 'Xenova/distilgpt2',
				text: '',
				tokens: 0,
				latencyMs: 0,
				completedAt: new Date().toISOString(),
			});
			record.error = String(err?.message || err).slice(0, 300);
		}
		const payload = canonicalResult({
			jobId: record.jobId,
			node: record.node,
			model: record.model,
			inputHash: record.inputHash,
			outputHash: record.outputHash,
			latencyMs: record.result.latencyMs,
			completedAt: record.completedAt,
		});
		const signature = signPayload(keypair.secretKey, payload);
		await client.submitResult(record, signature);
		return { record, signature };
	}

	async run() {
		const { client, pollMs, onEvent } = this;
		let failures = 0;
		while (!this.stopping && this.completed < this.maxJobs) {
			let job = null;
			try {
				job = await client.claimJob();
				failures = 0;
			} catch (err) {
				failures++;
				const backoff = Math.min(pollMs * failures, 30_000);
				onEvent({ type: 'claim-error', error: String(err?.message || err), backoffMs: backoff });
				await sleep(backoff);
				continue;
			}
			if (!job) {
				await sleep(pollMs);
				continue;
			}
			onEvent({ type: 'claimed', jobId: job.jobId });
			try {
				const { record, signature } = await this.executeAndSubmit(job);
				this.completed++;
				onEvent({
					type: 'completed',
					jobId: job.jobId,
					tokens: record.result.tokens,
					latencyMs: record.result.latencyMs,
					error: record.error || null,
					signature,
				});
			} catch (err) {
				onEvent({ type: 'submit-error', jobId: job.jobId, error: String(err?.message || err) });
				await sleep(pollMs);
			}
		}
		return { completed: this.completed };
	}
}
