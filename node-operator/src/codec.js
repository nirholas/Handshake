// Wire contract between a node and the three.ws coordinator.
//
// Derived from the platform's existing worker job format (no phase 4 spec had
// landed in specs/ when this client was built):
//   - bearer auth with a shared worker secret, as in workers/agent-screen-pool
//     (SCREEN_WORKER_SECRET on both sides, timing-safe compared by the API)
//   - claim -> execute -> submit loops, as in workers/agent-screen-pool and
//     workers/garment-forge (claim at execution time, submit signed result)
//   - Ed25519 signatures over a canonical UTF-8 string, verified by
//     api/_lib/siws.js-style logic (verifyPayload in src/identity.js)
//
// Job envelope (claim response item):
//   { jobId, type: 'llm.completion', model, input: { prompt }, maxTokens,
//     issuedAt }
//
// Canonical result payload (what the node actually signs):
//   threews-inference-v1\n<jobId>\n<nodeAddress>\n<model>\n
//   <sha256-hex of UTF-8 input.prompt>\n<sha256-hex of UTF-8 output text>\n
//   <latencyMs>\n<completedAt ISO>
//
// Submit body:
//   { jobId, node, model, result: { text, tokens, latencyMs },
//     inputHash, outputHash, completedAt, signature }
//
// Anyone can recompute the canonical string from a job + result and check it
// against `signature` with only the node's public address.

import { createHash } from 'node:crypto';

export const PROTOCOL = 'threews-inference-v1';
export const JOB_TYPE = 'llm.completion';

export function sha256Hex(text) {
	return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

// Validate and normalize a claimed job. Returns null for anything that is not
// an executable llm.completion job, so a malformed queue entry never reaches
// the engine.
export function normalizeJob(raw) {
	if (!raw || typeof raw !== 'object') return null;
	const jobId = String(raw.jobId || raw.job_id || '');
	if (!jobId) return null;
	if (raw.type && raw.type !== JOB_TYPE) return null;
	const input = raw.input && typeof raw.input === 'object' ? raw.input : {};
	const prompt = typeof input.prompt === 'string' ? input.prompt : null;
	if (!prompt) return null;
	const maxTokensRaw = Number(raw.maxTokens ?? raw.max_tokens ?? 64);
	const maxTokens = Number.isFinite(maxTokensRaw) ? Math.min(Math.max(Math.round(maxTokensRaw), 1), 512) : 64;
	return {
		jobId,
		type: JOB_TYPE,
		model: String(raw.model || ''),
		input: { prompt },
		maxTokens,
		issuedAt: raw.issuedAt || raw.issued_at || null,
	};
}

// Build the exact string the node signs. Field order is load-bearing; verifiers
// reproduce it byte for byte.
export function canonicalResult({ jobId, node, model, inputHash, outputHash, latencyMs, completedAt }) {
	return [
		PROTOCOL,
		jobId,
		node,
		model,
		inputHash,
		outputHash,
		String(Math.round(Number(latencyMs) || 0)),
		completedAt,
	].join('\n');
}

// Assemble the unsigned result record for a finished job.
export function buildResultRecord({ job, node, model, text, tokens, latencyMs, completedAt }) {
	const inputHash = sha256Hex(job.input.prompt);
	const outputHash = sha256Hex(text);
	return {
		jobId: job.jobId,
		node,
		model,
		result: { text, tokens: Math.max(0, Math.round(Number(tokens) || 0)), latencyMs: Math.round(latencyMs) },
		inputHash,
		outputHash,
		completedAt,
	};
}

// Verify a submitted result against the job and the node's public address.
// `verify` is the identity.verifyPayload function (injected so this module
// stays free of crypto imports and trivially testable).
export function verifyResult({ job, record, signature, verify }) {
	if (!job || !record || !signature || typeof verify !== 'function') return false;
	if (record.jobId !== job.jobId) return false;
	if (record.inputHash !== sha256Hex(job.input.prompt)) return false;
	if (record.outputHash !== sha256Hex(record.result?.text ?? '')) return false;
	const payload = canonicalResult({
		jobId: record.jobId,
		node: record.node,
		model: record.model,
		inputHash: record.inputHash,
		outputHash: record.outputHash,
		latencyMs: record.result.latencyMs,
		completedAt: record.completedAt,
	});
	return verify(record.node, payload, signature);
}
