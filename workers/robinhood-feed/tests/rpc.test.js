// The retry classifier that keeps the public RPC's load shedding from aborting
// a cold-start backfill. The -32602 case is the one measured live: the public
// RPC answers a valid eth_getLogs with "Missing or invalid parameters" under
// load, and the identical request succeeds on the next attempt.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isTransientRpcError, withRpcRetry } from '../src/rpc.js';

test('isTransientRpcError: the public RPC load-shed and throttle responses retry', () => {
	assert.equal(isTransientRpcError({ code: -32602, message: 'Missing or invalid parameters.' }), true);
	assert.equal(isTransientRpcError({ code: -32603, message: 'Internal error' }), true);
	assert.equal(isTransientRpcError({ code: 429, message: 'Too Many Requests' }), true);
	assert.equal(isTransientRpcError({ status: 503, message: 'Service Unavailable' }), true);
	assert.equal(isTransientRpcError(new TypeError('fetch failed')), true);
	assert.equal(isTransientRpcError({ code: 'ECONNRESET', message: 'socket hang up' }), true);
});

test('isTransientRpcError: a caller mistake is not retried', () => {
	assert.equal(isTransientRpcError(new Error('Encoded error signature not found on ABI')), false);
	assert.equal(isTransientRpcError({ code: 3, message: 'execution reverted' }), false);
	assert.equal(isTransientRpcError(null), false);
	const aborted = new Error('aborted');
	aborted.name = 'AbortError';
	assert.equal(isTransientRpcError(aborted), false);
});

test('isTransientRpcError: unwraps a nested cause (viem wraps the transport error)', () => {
	const wrapped = new Error('RPC Request failed.');
	wrapped.cause = { code: -32602, message: 'Missing or invalid parameters.' };
	assert.equal(isTransientRpcError(wrapped), true);
});

test('withRpcRetry: retries a transient failure and returns the eventual result', async () => {
	let calls = 0;
	const result = await withRpcRetry(async () => {
		calls++;
		if (calls < 3) throw { code: -32602, message: 'Missing or invalid parameters.' };
		return ['log'];
	}, { baseDelayMs: 1 });

	assert.deepEqual(result, ['log']);
	assert.equal(calls, 3);
});

test('withRpcRetry: reports each retry with an increasing attempt number', async () => {
	const seen = [];
	await withRpcRetry(async () => {
		if (seen.length < 2) throw { code: 429, message: 'Too Many Requests' };
		return 'ok';
	}, { baseDelayMs: 1, onRetry: (info) => seen.push(info.attempt) });

	assert.deepEqual(seen, [1, 2]);
});

test('withRpcRetry: gives up after the attempt cap and rethrows the last error', async () => {
	let calls = 0;
	await assert.rejects(
		() => withRpcRetry(async () => { calls++; throw { code: -32602, message: 'shed' }; }, { attempts: 3, baseDelayMs: 1 }),
		(err) => err.message === 'shed',
	);
	assert.equal(calls, 3);
});

test('withRpcRetry: a non-transient error throws immediately, no retries', async () => {
	let calls = 0;
	await assert.rejects(
		() => withRpcRetry(async () => { calls++; throw new Error('bad ABI'); }, { baseDelayMs: 1 }),
		/bad ABI/,
	);
	assert.equal(calls, 1);
});
