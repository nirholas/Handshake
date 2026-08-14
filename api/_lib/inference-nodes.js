/**
 * Inference node network: shared data layer for the phase 4 open inference
 * endpoints. Owns the node registry, the job queue, and signature
 * verification, so the three route handlers (register / poll / result) stay
 * thin and the contract has exactly one home.
 *
 * Wire contract (the authoritative write-up is specs/inference-nodes.md):
 *
 *   register : POST /api/nodes/register
 *              { publicKey, label?, capabilities, registeredAt, signature }
 *              signature = ed25519(`threews-node-register:{publicKey}:{registeredAt}`)
 *
 *   poll     : GET /api/nodes/jobs?node=<pk>&capability=<c>&ts=<ms>&sig=<s>
 *              sig = ed25519(`threews-node-poll:{pk}:{ts}`)
 *
 *   result   : POST /api/nodes/jobs/{jobId}/result
 *              success: { node, output, startedAt, finishedAt, receipt }
 *              failure: { node, failed: true, error, startedAt, finishedAt, ts, signature }
 *              receipt.payload = sha256(jobId).sha256(model).sha256(prompt).sha256(output).start.end
 *
 * Storage: Redis when UPSTASH is configured (production), with a lazy
 * Postgres table as the durable record of registered nodes so a Redis flush
 * never strands a node identity. The job queue itself is Redis-only by
 * design: jobs are ephemeral (claim TTL, one-shot), which matches the
 * agent-screen task queue's model.
 */

import { createRequire } from 'node:module';
import { getRedis } from './redis.js';
import { sql } from './db.js';

const require = createRequire(import.meta.url);
const nacl = require('tweetnacl');

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const NODE_PREFIX = 'inode:';           // registry hash per node pubkey
const JOB_PREFIX = 'ijob:';             // job hash per job id
const QUEUE_PREFIX = 'iqueue:';         // list of pending job ids per capability
const NODE_TTL_S = 30 * 24 * 3600;      // registry entry refreshes on each register
const JOB_TTL_S = 3600;                 // unclaimed jobs die after an hour

/** Decode a base58 Solana public key to 32 bytes; throws on malformed input. */
export function nodePubkeyToBytes(pubkey) {
	if (typeof pubkey !== 'string' || pubkey.length < 32 || pubkey.length > 44) {
		throw new Error('invalid node public key');
	}
	const bytes = [0];
	for (const ch of pubkey) {
		const idx = B58.indexOf(ch);
		if (idx < 0) throw new Error('invalid node public key');
		let carry = idx;
		for (let i = 0; i < bytes.length; i++) {
			carry += bytes[i] * 58;
			bytes[i] = carry & 0xff;
			carry >>= 8;
		}
		while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
	}
	for (const ch of pubkey) { if (ch === '1') bytes.push(0); else break; }
	const out = Uint8Array.from(bytes.reverse());
	if (out.length !== 32) throw new Error('invalid node public key');
	return out;
}

/** Verify an ed25519 signature over a UTF-8 message against a base58 pubkey. */
export function verifyNodeSignature(pubkey, message, signatureB64) {
	try {
		return nacl.sign.detached.verify(
			new TextEncoder().encode(message),
			Uint8Array.from(Buffer.from(String(signatureB64 || ''), 'base64')),
			nodePubkeyToBytes(pubkey),
		);
	} catch {
		return false;
	}
}

/** Hex SHA-256 (WebCrypto, so the browser verifier reproduces it exactly). */
async function sha256Hex(input) {
	const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
	return Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
}

/** Recompute the canonical receipt payload and verify its signature. */
export async function verifyResultReceipt({ jobId, model, prompt, output, startedAt, finishedAt }, receipt) {
	if (!receipt || receipt.algorithm !== 'ed25519' || !receipt.publicKey || !receipt.signature) return false;
	const payload = [
		await sha256Hex(String(jobId)),
		await sha256Hex(String(model)),
		await sha256Hex(String(prompt)),
		await sha256Hex(typeof output === 'string' ? output : JSON.stringify(output)),
		String(startedAt),
		String(finishedAt),
	].join('.');
	if (payload !== receipt.payload) return false;
	return verifyNodeSignature(receipt.publicKey, payload, receipt.signature);
}

/**
 * Read a JSON record back out of Redis.
 *
 * The Upstash REST client deserializes on the way out: a value stored as a
 * JSON string comes back already parsed as an object. Calling JSON.parse on
 * that object stringifies it to "[object Object]" first and throws, which
 * took out getNode's Redis fallback, claimJob and getJob (every read path in
 * the queue). Accept either shape so the record survives whichever form the
 * client hands back.
 */
function parseRecord(raw) {
	if (raw === null || raw === undefined) return null;
	if (typeof raw === 'object') return raw;
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

// ── Durable node registry (Postgres) ─────────────────────────────────────────

let _ensured = null;
async function ensureNodeTable() {
	if (_ensured) return _ensured;
	_ensured = (async () => {
		await sql`
			create table if not exists inference_nodes (
				public_key text primary key,
				label text,
				capabilities jsonb not null default '[]',
				registered_at timestamptz not null default now(),
				last_seen_at timestamptz not null default now(),
				jobs_completed integer not null default 0,
				jobs_failed integer not null default 0
			)`;
	})();
	return _ensured;
}

/**
 * Register (idempotent upsert on public key) a node. Returns the stored row.
 * Falls back to Redis-only when the database is not reachable so a dev node
 * can still register against a bare local stack.
 */
export async function registerNode({ publicKey, label, capabilities }) {
	nodePubkeyToBytes(publicKey); // throws early on a malformed key
	const caps = Array.isArray(capabilities) ? capabilities.slice(0, 16) : [];
	try {
		await ensureNodeTable();
		const rows = await sql`
			insert into inference_nodes (public_key, label, capabilities)
			values (${publicKey}, ${label || null}, ${JSON.stringify(caps)})
			on conflict (public_key) do update
				set label = coalesce(excluded.label, inference_nodes.label),
					capabilities = excluded.capabilities,
					last_seen_at = now()
			returning public_key, label, capabilities, registered_at`;
		return rows[0];
	} catch (err) {
		// DB down: keep the node in Redis so local dev without Postgres works.
		const r = getRedis();
		if (!r) throw err;
		const node = { public_key: publicKey, label: label || null, capabilities: caps, registered_at: new Date().toISOString() };
		await r.set(`${NODE_PREFIX}${publicKey}`, JSON.stringify(node), { ex: NODE_TTL_S });
		return node;
	}
}

/** Look up a registered node, or null. */
export async function getNode(publicKey) {
	try {
		await ensureNodeTable();
		const rows = await sql`select public_key, label, capabilities, registered_at from inference_nodes where public_key = ${publicKey}`;
		if (rows[0]) return rows[0];
	} catch { /* fall through to Redis */ }
	const r = getRedis();
	if (!r) return null;
	return parseRecord(await r.get(`${NODE_PREFIX}${publicKey}`));
}

// ── Job queue ────────────────────────────────────────────────────────────────

/**
 * Enqueue an inference job for a capability. Called by the platform's agent
 * runtime (and by the local harness) when work needs a node. Returns the job.
 */
export async function enqueueJob({ capability, model, input, jobId }) {
	const r = getRedis();
	if (!r) throw new Error('job queue unavailable: Redis not configured');
	const id = jobId || `job_${crypto.randomUUID()}`;
	const job = {
		id,
		capability,
		model,
		input,
		status: 'queued',
		enqueuedAt: Date.now(),
		deadlineAt: Date.now() + JOB_TTL_S * 1000,
	};
	await r.set(`${JOB_PREFIX}${id}`, JSON.stringify(job), { ex: JOB_TTL_S });
	await r.rpush(`${QUEUE_PREFIX}${capability}`, id);
	return job;
}

/**
 * Claim the next queued job for a capability that this node can run.
 * Returns the claimed job (status flipped to 'running', node stamped), or
 * null when the queue is empty. Claim is a single atomic rpop + set so two
 * nodes never take the same job.
 */
export async function claimJob({ capability, publicKey }) {
	const r = getRedis();
	if (!r) return null;
	const id = await r.rpop(`${QUEUE_PREFIX}${capability}`);
	if (!id) return null;
	const job = parseRecord(await r.get(`${JOB_PREFIX}${id}`));
	if (!job) return null; // expired between push and pop
	if (job.status !== 'queued') return null;
	job.status = 'running';
	job.claimedBy = publicKey;
	job.claimedAt = Date.now();
	await r.set(`${JOB_PREFIX}${id}`, JSON.stringify(job), { ex: JOB_TTL_S });
	return job;
}

/** Read a job's current record. */
export async function getJob(jobId) {
	const r = getRedis();
	if (!r) return null;
	return parseRecord(await r.get(`${JOB_PREFIX}${jobId}`));
}

/**
 * Record a verified result on a job. Only the node that claimed the job can
 * close it, and only from the 'running' state, so a late or replayed submit
 * can never overwrite a result.
 */
export async function completeJob(jobId, { publicKey, output, receipt, startedAt, finishedAt }) {
	const r = getRedis();
	if (!r) throw new Error('job queue unavailable');
	const job = await getJob(jobId);
	if (!job) return { ok: false, status: 404, error: 'job_not_found' };
	if (job.claimedBy !== publicKey) return { ok: false, status: 403, error: 'not_job_owner' };
	if (job.status !== 'running') return { ok: false, status: 409, error: 'job_not_running' };
	job.status = 'done';
	job.output = output;
	job.receipt = receipt;
	job.startedAt = startedAt;
	job.finishedAt = finishedAt;
	job.completedAt = Date.now();
	await r.set(`${JOB_PREFIX}${jobId}`, JSON.stringify(job), { ex: JOB_TTL_S });
	bumpNodeCounter(publicKey, 'jobs_completed');
	return { ok: true, job };
}

/** Record a node-reported failure so the platform can requeue or refund. */
export async function failJob(jobId, { publicKey, error: errMsg }) {
	const r = getRedis();
	if (!r) throw new Error('job queue unavailable');
	const job = await getJob(jobId);
	if (!job) return { ok: false, status: 404, error: 'job_not_found' };
	if (job.claimedBy !== publicKey) return { ok: false, status: 403, error: 'not_job_owner' };
	job.status = 'failed';
	job.error = String(errMsg || '').slice(0, 500);
	job.completedAt = Date.now();
	await r.set(`${JOB_PREFIX}${jobId}`, JSON.stringify(job), { ex: JOB_TTL_S });
	bumpNodeCounter(publicKey, 'jobs_failed');
	return { ok: true, job };
}

function bumpNodeCounter(publicKey, column) {
	// Best-effort: the Redis result is authoritative; the counter is a rollup.
	// The single `.catch()` this used to carry did not make it best-effort. The
	// column name was interpolated with `sql(column)`, and each of those
	// fragment calls produces its OWN promise, which rejects on a host with no
	// DATABASE_URL and was attached to nothing. Two unhandled rejections
	// escaped per completed job. Naming both columns statically removes the
	// fragment promises entirely (and the dynamic identifier with them), so the
	// one remaining promise is the one the catch covers.
	try {
		const query = column === 'jobs_failed'
			? sql`update inference_nodes set jobs_failed = jobs_failed + 1, last_seen_at = now() where public_key = ${publicKey}`
			: sql`update inference_nodes set jobs_completed = jobs_completed + 1, last_seen_at = now() where public_key = ${publicKey}`;
		Promise.resolve(query).catch(() => {});
	} catch { /* no database configured: the rollup is optional, the result is not */ }
}
