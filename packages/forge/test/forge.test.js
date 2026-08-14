import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createForge, ThreeWsError, PaymentRequiredError } from '../src/index.js';

// A scripted fetch double: each call shifts the next queued response and records
// the request. No network, no real endpoints — we assert on request shaping and
// response parsing, which is all the SDK is responsible for.
function stubFetch(responses) {
	const calls = [];
	const queue = [...responses];
	const fetch = async (url, init) => {
		calls.push({ url: new URL(url), init });
		const next = queue.shift();
		if (!next) throw new Error('stubFetch: no more queued responses');
		const { status = 200, body = {}, headers = {} } = next;
		return {
			ok: status >= 200 && status < 300,
			status,
			headers: { get: (k) => headers[k.toLowerCase()] ?? null },
			text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
		};
	};
	return { fetch, calls };
}

test('forge() posts the prompt and shapes a synchronous done job', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { job_id: null, creation_id: 'c1', status: 'done', glb_url: 'https://three.ws/cdn/a.glb', backend: 'nvidia', tier: 'standard', path: 'image', durable: true } },
	]);
	const client = createForge({ fetch, baseUrl: 'https://three.ws' });
	const res = await client.forge('a chrome robot');

	assert.equal(calls[0].url.pathname, '/api/forge');
	assert.equal(calls[0].init.method, 'POST');
	const sent = JSON.parse(calls[0].init.body);
	assert.equal(sent.prompt, 'a chrome robot');
	assert.ok(!('path' in sent), 'unset options are pruned from the body');
	assert.equal(res.status, 'done');
	assert.equal(res.glbUrl, 'https://three.ws/cdn/a.glb');
	assert.equal(res.viewerUrl, 'https://three.ws/forge?share=c1');
	assert.equal(res.backend, 'nvidia');
});

test('forge() polls a queued job until done', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { job_id: 'j1', creation_id: 'c2', status: 'queued' } },
		{ body: { job_id: 'j1', status: 'running' } },
		{ body: { job_id: 'j1', creation_id: 'c2', status: 'done', glb_url: 'https://three.ws/cdn/b.glb' } },
	]);
	const ticks = [];
	const client = createForge({ fetch });
	const res = await client.forge('a fox', { pollIntervalMs: 1, onProgress: (j) => ticks.push(j.status) });

	assert.equal(res.glbUrl, 'https://three.ws/cdn/b.glb');
	assert.equal(calls[1].url.searchParams.get('job'), 'j1');
	assert.ok(ticks.includes('queued'));
	assert.ok(ticks.includes('done'));
});

test('rig() targets action=rig with the glb_url', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { job_id: null, creation_id: 'c3', status: 'done', glb_url: 'https://three.ws/cdn/rigged.glb' } },
	]);
	const client = createForge({ fetch });
	const res = await client.rig('https://three.ws/cdn/raw.glb');
	assert.equal(calls[0].url.searchParams.get('action'), 'rig');
	assert.equal(JSON.parse(calls[0].init.body).glb_url, 'https://three.ws/cdn/raw.glb');
	assert.equal(res.glbUrl, 'https://three.ws/cdn/rigged.glb');
});

test('the geometry path attaches the BYOK provider key header', async () => {
	const { fetch, calls } = stubFetch([{ body: { status: 'done', glb_url: 'x' } }]);
	const client = createForge({ fetch, providerKey: 'meshy_test_key' });
	await client.forge('a sword', { path: 'geometry' });
	assert.equal(calls[0].init.headers['x-forge-provider-key'], 'meshy_test_key');
});

test('a per-call providerKey overrides the client key and rides every poll', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { job_id: 'j9', status: 'queued' } },
		{ body: { job_id: 'j9', status: 'done', glb_url: 'https://three.ws/cdn/c.glb' } },
	]);
	const client = createForge({ fetch, providerKey: 'client_key' });
	const res = await client.forge('a sword', { path: 'geometry', providerKey: 'call_key', pollIntervalMs: 1 });

	assert.equal(res.glbUrl, 'https://three.ws/cdn/c.glb');
	assert.equal(calls[0].init.headers['x-forge-provider-key'], 'call_key');
	// The API re-resolves the BYOK key on every poll and fails the job without it.
	assert.equal(calls[1].init.headers['x-forge-provider-key'], 'call_key');
});

test('getJob() reads one job and carries the BYOK key', async () => {
	const { fetch, calls } = stubFetch([{ body: { job_id: 'j5', status: 'running' } }]);
	const client = createForge({ fetch });
	const job = await client.getJob('j5', { providerKey: 'meshy_test_key' });
	assert.equal(calls[0].url.searchParams.get('job'), 'j5');
	assert.equal(calls[0].init.headers['x-forge-provider-key'], 'meshy_test_key');
	assert.equal(job.status, 'running');
	assert.equal(job.jobId, 'j5');
});

test('payWith:x402 posts to the paid twin and polls the free job endpoint', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { job_id: 'x402-token', status: 'queued', tier: 'draft', backend: 'nvidia' } },
		{ body: { job_id: 'x402-token', status: 'done', glb_url: 'https://three.ws/cdn/paid.glb' } },
	]);
	const client = createForge({ fetch });
	const res = await client.forge('a chrome robot', { payWith: 'x402', tier: 'draft', pollIntervalMs: 1 });

	assert.equal(calls[0].url.pathname, '/api/x402/forge');
	assert.equal(calls[0].init.method, 'POST');
	const sent = JSON.parse(calls[0].init.body);
	assert.deepEqual(sent, { prompt: 'a chrome robot', tier: 'draft' });
	assert.equal(calls[1].url.pathname, '/api/forge');
	assert.equal(calls[1].url.searchParams.get('job'), 'x402-token');
	assert.equal(res.glbUrl, 'https://three.ws/cdn/paid.glb');
});

test('the x402 lane rejects the knobs it cannot honor, before any network call', async () => {
	const { fetch, calls } = stubFetch([]);
	const client = createForge({ fetch });
	await assert.rejects(() => client.forge('x', { payWith: 'x402', backend: 'meshy' }), /does not accept: backend/);
	await assert.rejects(() => client.forge('x', { payWith: 'x402', path: 'geometry' }), /does not accept: path/);
	await assert.rejects(() => client.forge('x', { payWith: 'nope' }), /Invalid payWith/);
	assert.equal(calls.length, 0);
});

test('an unpaid x402 call surfaces the challenge as PaymentRequiredError', async () => {
	const accepts = [{ scheme: 'exact', network: 'solana:5eykt4Us…', maxAmountRequired: '50000' }];
	const { fetch, calls } = stubFetch([
		{ status: 402, body: { x402Version: 2, error: 'X-PAYMENT header is required', accepts } },
	]);
	const client = createForge({ fetch });
	await assert.rejects(() => client.forge('a fox', { payWith: 'x402' }), (e) => {
		assert.ok(e instanceof PaymentRequiredError);
		assert.deepEqual(e.accepts, accepts);
		return true;
	});
	assert.equal(calls[0].url.pathname, '/api/x402/forge');
});

test('needs_key (501) surfaces as a typed ThreeWsError', async () => {
	const { fetch } = stubFetch([{ status: 501, body: { error: 'needs_key', message: 'Add a Meshy key.' } }]);
	const client = createForge({ fetch });
	await assert.rejects(() => client.forge('x', { path: 'geometry' }), (e) => {
		assert.ok(e instanceof ThreeWsError);
		assert.equal(e.code, 'needs_key');
		assert.equal(e.status, 501);
		return true;
	});
});

test('402 surfaces as PaymentRequiredError carrying the x402 challenge', async () => {
	const accepts = [{ scheme: 'exact', asset: 'USDC', network: 'eip155:8453', maxAmountRequired: '150000' }];
	const { fetch } = stubFetch([{ status: 402, body: { error: 'payment_required', message: 'pay', accepts } }]);
	const client = createForge({ fetch });
	await assert.rejects(() => client.forge('x', { tier: 'high' }), (e) => {
		assert.ok(e instanceof PaymentRequiredError);
		assert.deepEqual(e.accepts, accepts);
		return true;
	});
});

test('invalid tier/path are rejected before any network call', async () => {
	const { fetch, calls } = stubFetch([]);
	const client = createForge({ fetch });
	await assert.rejects(() => client.forge('x', { tier: 'ultra' }), /Invalid tier/);
	await assert.rejects(() => client.forge('x', { path: 'voxel' }), /Invalid path/);
	await assert.rejects(() => client.forge({}), /needs a `prompt`/);
	assert.equal(calls.length, 0);
});

test('catalog() reads the matrix endpoint', async () => {
	const { fetch, calls } = stubFetch([{ body: { tiers: [{ id: 'draft' }], backends: [], paths: [] } }]);
	const client = createForge({ fetch });
	const cat = await client.catalog();
	assert.equal(calls[0].url.searchParams.get('catalog'), '1');
	assert.equal(cat.tiers[0].id, 'draft');
});
