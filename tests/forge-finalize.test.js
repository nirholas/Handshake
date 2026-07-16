// Unit tests for the finalizer's job-id discriminator: the base64url JSON
// envelope the GCP worker lanes store in forge_creations.replicate_job_id
// (see api/_providers/gcp.js) vs. opaque third-party ids the cron cannot poll.
// Importing the cron module is safe: db/neon clients are created lazily.

import { describe, it, expect } from 'vitest';
import { decodeWorkerEnvelope } from '../api/cron/forge-finalize.js';

function pack(obj) {
	return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

describe('decodeWorkerEnvelope', () => {
	it('decodes a real GCP worker envelope', () => {
		const envelope = pack({
			mode: 'trellis',
			taskId: '8e033fff-6ba2-4324-a388-e093a30ed083',
			baseUrl: 'https://model-trellis.example.test',
			resultKey: 'result_gcs_url',
		});
		const decoded = decodeWorkerEnvelope(envelope);
		expect(decoded).not.toBeNull();
		expect(decoded.taskId).toBe('8e033fff-6ba2-4324-a388-e093a30ed083');
		expect(decoded.baseUrl).toBe('https://model-trellis.example.test');
	});

	it('rejects an envelope missing taskId or baseUrl', () => {
		expect(decodeWorkerEnvelope(pack({ taskId: 'only-task' }))).toBeNull();
		expect(decodeWorkerEnvelope(pack({ baseUrl: 'https://x.test' }))).toBeNull();
		expect(decodeWorkerEnvelope(pack({}))).toBeNull();
	});

	it('rejects opaque third-party ids (Replicate predictions, HF jobs)', () => {
		expect(decodeWorkerEnvelope('rr2p7dbwd5rmyk4b3xyz')).toBeNull();
		expect(decodeWorkerEnvelope('hf-space-job-42')).toBeNull();
		expect(decodeWorkerEnvelope('')).toBeNull();
		expect(decodeWorkerEnvelope(null)).toBeNull();
	});

	it('rejects base64url payloads that are not JSON objects', () => {
		expect(decodeWorkerEnvelope(Buffer.from('"a string"').toString('base64url'))).toBeNull();
		expect(decodeWorkerEnvelope(Buffer.from('42').toString('base64url'))).toBeNull();
	});
});
