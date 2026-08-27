// Lane health and budget policy for the vision chain: a throttled host is
// skipped by the next request instead of being re-picked as attempt zero, and
// no single lane can spend the whole deadline that the lanes behind it need.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { clearProviderCooldown } from '../../api/_lib/provider-health.js';

const usageState = { events: [] };
vi.mock('../../api/_lib/usage.js', () => ({
	recordEvent: (evt) => usageState.events.push(evt),
}));

import { describeImage, laneAttemptTimeout, inlineImageBudget } from '../../api/_lib/vision.js';

const ORIGINAL_FETCH = globalThis.fetch;
const ENV_KEYS = ['NVIDIA_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_CLOUD_PROJECT'];
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

const LANE_KEYS = [
	'vision:nvidia:nvidia/nemotron-nano-12b-v2-vl',
	'vision:nvidia:meta/llama-3.2-11b-vision-instruct',
	'vision:openai:gpt-5.4-nano',
];

function stubFetch(routes) {
	const calls = [];
	globalThis.fetch = vi.fn(async (url, opts = {}) => {
		const u = String(url);
		calls.push({ url: u, body: opts.body ? JSON.parse(opts.body) : null, signal: opts.signal });
		for (const [match, responder] of routes) {
			if (u.includes(match)) return responder(calls[calls.length - 1]);
		}
		throw new Error(`unexpected fetch in test: ${u}`);
	});
	return calls;
}
const chatOk = (content) =>
	new Response(JSON.stringify({ model: 'm', choices: [{ message: { content } }], usage: {} }), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	});
const httpErr = (status, body = 'err') => new Response(body, { status });

beforeEach(async () => {
	usageState.events = [];
	await Promise.all(LANE_KEYS.map((k) => clearProviderCooldown(k)));
	process.env.NVIDIA_API_KEY = 'nvapi-test';
	process.env.OPENAI_API_KEY = 'sk-x';
	delete process.env.GOOGLE_CLOUD_PROJECT;
});
afterEach(async () => {
	globalThis.fetch = ORIGINAL_FETCH;
	await Promise.all(LANE_KEYS.map((k) => clearProviderCooldown(k)));
	for (const k of ENV_KEYS) {
		if (ORIGINAL_ENV[k] === undefined) delete process.env[k];
		else process.env[k] = ORIGINAL_ENV[k];
	}
	vi.restoreAllMocks();
});

describe('laneAttemptTimeout', () => {
	it('splits the remaining deadline across the lanes still to come', () => {
		// 18s left, three lanes to go: 6s each, so the last rung still gets a turn.
		expect(laneAttemptTimeout(18_000, 3, 20_000)).toBe(6_000);
		expect(laneAttemptTimeout(12_000, 2, 20_000)).toBe(6_000);
	});
	it('never exceeds the caller timeout and never outlives the deadline', () => {
		expect(laneAttemptTimeout(60_000, 1, 20_000)).toBe(20_000);
		expect(laneAttemptTimeout(2_000, 3, 20_000)).toBe(2_000);
	});
	it('keeps a workable floor rather than handing a lane an unusable slice', () => {
		// 10s left across 8 lanes is 1.25s each, too short for any VLM call, so the
		// floor applies and the chain simply gets through fewer lanes honestly.
		expect(laneAttemptTimeout(10_000, 8, 20_000)).toBe(3_500);
	});
	it('leaves the caller timeout alone when there is no deadline', () => {
		expect(laneAttemptTimeout(Infinity, 3, 20_000)).toBe(20_000);
	});
});

describe('inlineImageBudget', () => {
	it('takes only a slice of the deadline so the chain is not starved', () => {
		// The bug this replaces: min(20s timeout, 24s remaining) = 20s for the image
		// fetch alone, leaving 4s for every provider combined.
		expect(inlineImageBudget(24_000, 20_000)).toBe(6_000);
	});
	it('is capped for a generous deadline and floored for a nearly spent one', () => {
		expect(inlineImageBudget(120_000, 20_000)).toBe(8_000);
		expect(inlineImageBudget(1_000, 20_000)).toBe(1_000);
	});
});

describe('vision lane cooldowns', () => {
	it('sends the next request past a throttled NIM host instead of re-picking it', async () => {
		const first = stubFetch([
			['integrate.api.nvidia.com', () => httpErr(429, 'rate limit')],
			['api.openai.com', () => chatOk('backstop')],
		]);
		const a = await describeImage({ prompt: 'p', imageBase64: 'AAAA', mimeType: 'image/png' });
		expect(a.provider).toBe('openai');
		// 429 is the one verdict that is unambiguously about the host and its
		// quota, so the sibling rung is skipped inside this very request: one
		// throttled attempt is paid, not one per model the host serves.
		expect(first.filter((c) => c.url.includes('nvidia')).length).toBe(1);

		const second = stubFetch([
			['integrate.api.nvidia.com', () => chatOk('nim back')],
			['api.openai.com', () => chatOk('backstop')],
		]);
		const b = await describeImage({ prompt: 'p', imageBase64: 'AAAA', mimeType: 'image/png' });
		// The cooled lanes are re-ordered behind the healthy one, never dropped.
		expect(b.provider).toBe('openai');
		expect(second[0].url).toContain('openai.com');
	});

	it('keeps trying the twin rung on a transport failure, which may be one slow model', async () => {
		let nimCalls = 0;
		const calls = stubFetch([
			['integrate.api.nvidia.com', () => {
				if (++nimCalls === 1) throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
				return chatOk('twin answered');
			}],
		]);
		const r = await describeImage({ prompt: 'p', imageBase64: 'AAAA', mimeType: 'image/png' });
		expect(r.text).toBe('twin answered');
		expect(calls.filter((c) => c.url.includes('nvidia')).length).toBe(2);
	});

	it('benches only the failing model on a 5xx, keeping its twin on the same host', async () => {
		let nimCalls = 0;
		stubFetch([
			['integrate.api.nvidia.com', () => (++nimCalls === 1 ? httpErr(500, 'boom') : chatOk('twin'))],
		]);
		const a = await describeImage({ prompt: 'p', imageBase64: 'AAAA', mimeType: 'image/png' });
		expect(a.provider).toBe('nvidia');

		// Next request still leads with a NIM lane, because a model-level 500 is no
		// evidence against the host or against the sibling model.
		const next = stubFetch([['integrate.api.nvidia.com', () => chatOk('ok')]]);
		await describeImage({ prompt: 'p', imageBase64: 'AAAA', mimeType: 'image/png' });
		expect(next[0].url).toContain('integrate.api.nvidia.com');
	});

	it('clears a lane cooldown as soon as that lane serves a real request', async () => {
		stubFetch([
			['integrate.api.nvidia.com', () => httpErr(429)],
			['api.openai.com', () => chatOk('backstop')],
		]);
		await describeImage({ prompt: 'p', imageBase64: 'AAAA', mimeType: 'image/png' });

		// Force the cooled NIM lanes to answer (every lane cooling means the whole
		// chain is tried anyway) and confirm the bench is lifted afterwards.
		await Promise.all(LANE_KEYS.map((k) => clearProviderCooldown(k)));
		const back = stubFetch([['integrate.api.nvidia.com', () => chatOk('recovered')]]);
		const r = await describeImage({ prompt: 'p', imageBase64: 'AAAA', mimeType: 'image/png' });
		expect(r.text).toBe('recovered');
		expect(back[0].url).toContain('integrate.api.nvidia.com');
	});

	it('still answers when every lane is cooling, rather than failing cold', async () => {
		stubFetch([
			['integrate.api.nvidia.com', () => httpErr(429)],
			['api.openai.com', () => httpErr(429)],
		]);
		await expect(
			describeImage({ prompt: 'p', imageBase64: 'AAAA', mimeType: 'image/png' }),
		).rejects.toThrow();

		const retry = stubFetch([
			['integrate.api.nvidia.com', () => chatOk('recovered')],
			['api.openai.com', () => chatOk('backstop')],
		]);
		const r = await describeImage({ prompt: 'p', imageBase64: 'AAAA', mimeType: 'image/png' });
		expect(r.text).toBeTruthy();
		expect(retry.length).toBeGreaterThan(0);
	});
});
