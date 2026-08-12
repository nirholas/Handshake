// Coordinator client: registration, job claim, and signed-result submit.
//
// Endpoint defaults follow the platform's existing worker conventions:
//   POST /api/inference/nodes/register   { node, capabilities, models, version }
//   POST /api/inference/jobs/claim       { node }            -> { job | null }
//   POST /api/inference/jobs/submit      signed result record
// Authorization: `Bearer $NODE_WORKER_SECRET` (the same shared-secret pattern
// as SCREEN_WORKER_SECRET for workers/agent-screen-pool). The base URL and all
// three paths are overridable so the client speaks to any deployment of the
// coordinator, including the local dev server used by the end-to-end proof.

import { normalizeJob } from './codec.js';

export const CLIENT_VERSION = '1.0.0';

export class CoordinatorClient {
	constructor({ baseUrl, secret, nodeAddress, fetchImpl = fetch, log = () => {} }) {
		if (!baseUrl) throw new Error('baseUrl is required');
		this.baseUrl = String(baseUrl).replace(/\/+$/, '');
		this.secret = secret || '';
		this.nodeAddress = nodeAddress;
		this.fetch = fetchImpl;
		this.log = log;
	}

	headers() {
		const h = { 'content-type': 'application/json', accept: 'application/json' };
		if (this.secret) h.authorization = `Bearer ${this.secret}`;
		return h;
	}

	async post(pathname, body) {
		const url = `${this.baseUrl}${pathname}`;
		const res = await this.fetch(url, {
			method: 'POST',
			headers: this.headers(),
			body: JSON.stringify(body),
		});
		const text = await res.text();
		let parsed = null;
		try {
			parsed = text ? JSON.parse(text) : null;
		} catch {
			parsed = null;
		}
		if (!res.ok) {
			const detail = parsed?.error || parsed?.message || text.slice(0, 200);
			throw new Error(`${pathname} failed: ${res.status} ${detail}`);
		}
		return parsed;
	}

	// Announce this node to the coordinator. Idempotent: re-registering the
	// same address refreshes capabilities and last-seen.
	async register({ capabilities, models, endpoint }) {
		return this.post('/api/inference/nodes/register', {
			node: this.nodeAddress,
			capabilities,
			models,
			endpoint: endpoint || null,
			version: CLIENT_VERSION,
			registeredAt: new Date().toISOString(),
		});
	}

	// Ask for the next job. Returns a normalized job, or null when the queue
	// is empty (the coordinator answers { job: null }).
	async claimJob() {
		const body = await this.post('/api/inference/jobs/claim', { node: this.nodeAddress });
		const raw = body?.job ?? body?.data?.job ?? null;
		if (!raw) return null;
		const job = normalizeJob(raw);
		if (!job) this.log('coordinator returned a job this client cannot execute; skipping', raw?.jobId || raw?.job_id || '');
		return job;
	}

	// Submit a signed result record (see src/codec.js for the shape).
	async submitResult(record, signature) {
		return this.post('/api/inference/jobs/submit', { ...record, signature });
	}
}
