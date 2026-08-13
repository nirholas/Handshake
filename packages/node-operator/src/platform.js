/**
 * Platform wire client: registration, job poll, result submit.
 *
 * The wire contract (documented for operators in this package's README.md, and
 * served by api/nodes/register.js and api/nodes/jobs.js) is:
 *
 *   POST {platformUrl}/api/nodes/register
 *     body: { publicKey, label?, capabilities: [{capability, model}],
 *             registeredAt, signature }
 *     where signature = ed25519 over `threews-node-register:{publicKey}:{registeredAt}`
 *     -> 200 { ok: true, node: { id, publicKey } }
 *
 *   GET {platformUrl}/api/nodes/jobs?node=<publicKey>&capability=<cap>&sig=<sig>&ts=<ms>
 *     where sig = ed25519 over `threews-node-poll:{publicKey}:{ts}`
 *     -> 200 { job: null }                          (queue empty, keep polling)
 *     -> 200 { job: { id, capability, model, input, deadlineAt } }
 *
 *   POST {platformUrl}/api/nodes/jobs/{jobId}/result
 *     body: { node: publicKey, output, startedAt, finishedAt, receipt }
 *     -> 200 { ok: true, verified: true }
 *
 * Every authenticated call signs a short, domain-separated string so a
 * signature harvested from one call can never be replayed against another.
 */

export function createPlatformClient({ platformUrl, identity, fetchImpl = globalThis.fetch }) {
	if (!platformUrl) throw new Error('platformUrl is required');
	if (!identity) throw new Error('identity is required');

	async function call(method, path, body) {
		const res = await fetchImpl(`${platformUrl}${path}`, {
			method,
			headers: { 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(30_000),
		});
		const text = await res.text();
		let data = null;
		try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
		if (!res.ok) {
			const msg = data?.error_description || data?.error || `HTTP ${res.status}`;
			const err = new Error(`${method} ${path} failed: ${msg}`);
			err.status = res.status;
			err.payload = data;
			throw err;
		}
		return data;
	}

	return {
		/** Register (or re-register: the call is idempotent on publicKey). */
		async register({ label, capabilities }) {
			const registeredAt = Date.now();
			const signature = identity.signText(`threews-node-register:${identity.publicKey}:${registeredAt}`);
			return call('POST', '/api/nodes/register', {
				publicKey: identity.publicKey,
				label: label || null,
				capabilities,
				registeredAt,
				signature,
			});
		},

		/**
		 * Poll for the next job this node can execute. Returns the job object
		 * or null when the queue is empty.
		 */
		 async pollJob({ capability }) {
			const ts = Date.now();
			const sig = identity.signText(`threews-node-poll:${identity.publicKey}:${ts}`);
			const q = new URLSearchParams({ node: identity.publicKey, capability, ts: String(ts), sig });
			const data = await call('GET', `/api/nodes/jobs?${q}`);
			return data?.job ?? null;
		},

		/** Submit a finished result plus its signed receipt. */
		async submitResult(jobId, { output, startedAt, finishedAt, receipt }) {
			return call('POST', `/api/nodes/jobs/${encodeURIComponent(jobId)}/result`, {
				node: identity.publicKey,
				output,
				startedAt,
				finishedAt,
				receipt,
			});
		},

		/** Report a job as failed so the platform can requeue or refund it. */
		async reportFailure(jobId, { error, startedAt, finishedAt }) {
			const ts = Date.now();
			const signature = identity.signText(`threews-node-fail:${identity.publicKey}:${jobId}:${ts}`);
			return call('POST', `/api/nodes/jobs/${encodeURIComponent(jobId)}/result`, {
				node: identity.publicKey,
				failed: true,
				error: String(error).slice(0, 500),
				startedAt,
				finishedAt,
				ts,
				signature,
			});
		},
	};
}
