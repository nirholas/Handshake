// Tests for the shared vision helper (api/_lib/vision.js) and its three
// consumers: forge image validation, fact-checker image evidence, and avatar
// alt text. Transport is mocked (no live NIM calls); the focus is the free-first
// provider chain, normalized errors, spend tracking, and — critically — each
// consumer's DEGRADED path (vision unavailable / error must never hard-fail).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { clearProviderCooldown } from '../../api/_lib/provider-health.js';

// Capture recordEvent so we can assert spend tracking without a DB.
const usageState = { events: [] };
vi.mock('../../api/_lib/usage.js', () => ({
	recordEvent: (evt) => usageState.events.push(evt),
}));

// Control the SSRF-safe image fetch used by describeImage's inline path without
// touching the module's other (real) exports. Default impl (set in beforeEach)
// rejects, so any imageUrl test that doesn't opt in falls back to URL pass-through.
const imageFetch = vi.hoisted(() => ({ impl: null }));
vi.mock('../../api/_lib/ssrf-guard.js', async (importOriginal) => {
	const actual = await importOriginal();
	return { ...actual, fetchSafePublicUrl: (...args) => imageFetch.impl(...args) };
});

import {
	describeImage,
	describeImageJson,
	visionConfigured,
	parseJsonLoose,
	VisionUnavailableError,
} from '../../api/_lib/vision.js';
import { validateForgeImage } from '../../api/_lib/forge-image-validate.js';
import { imageEvidence } from '../../agents/fact-checker/src/image-evidence.js';
import { generateAltText, cleanAltText } from '../../api/_lib/avatar-alt-text.js';

const ORIGINAL_FETCH = globalThis.fetch;
// GOOGLE_CLOUD_PROJECT gates the Vertex Gemini credits anchor in visionChain;
// isolate it too so these tests are deterministic on GCP-configured machines.
const ENV_KEYS = ['NVIDIA_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_CLOUD_PROJECT'];
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

// Route a mocked fetch by URL substring so one test can exercise the full
// chain (NIM nemotron → NIM llama → OpenAI) and assert which lanes were hit.
function stubFetch(routes) {
	const calls = [];
	globalThis.fetch = vi.fn(async (url, opts = {}) => {
		const u = String(url);
		calls.push({ url: u, body: opts.body ? JSON.parse(opts.body) : null });
		for (const [match, responder] of routes) {
			if (u.includes(match)) return responder(calls[calls.length - 1]);
		}
		throw new Error(`unexpected fetch in test: ${u}`);
	});
	return calls;
}

function chatOk(content, usage = { prompt_tokens: 100, completion_tokens: 5 }) {
	return new Response(JSON.stringify({ model: 'm', choices: [{ message: { content } }], usage }), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	});
}
function httpErr(status, body = 'err') {
	return new Response(body, { status });
}

// Every lane key describeImage can cool, so a test never inherits another's bench.
const VISION_LANE_KEYS = [
	'vision:nvidia:nvidia/nemotron-nano-12b-v2-vl',
	'vision:nvidia:meta/llama-3.2-11b-vision-instruct',
	'vision:vertex-gemini:gemini-2.5-flash',
	'vision:openai:gpt-5.4-nano',
];
async function clearVisionCooldowns() {
	await Promise.all(VISION_LANE_KEYS.map((k) => clearProviderCooldown(k)));
}

beforeEach(async () => {
	usageState.events = [];
	// Lane cooldowns are process-wide and outlive a single test, exactly as they
	// do across requests in production. Clear them so each case asserts the
	// chain's ORDER from a clean slate rather than inheriting the bench a
	// previous case's failing lane earned.
	await clearVisionCooldowns();
	process.env.NVIDIA_API_KEY = 'nvapi-test';
	delete process.env.OPENAI_API_KEY;
	delete process.env.GOOGLE_CLOUD_PROJECT;
	// Default: our own image fetch fails, so describeImage falls back to handing
	// the raw URL to the provider (the pre-inline behavior). Tests that exercise
	// the inline path override this.
	imageFetch.impl = async () => {
		throw new Error('image host unreachable');
	};
});
afterEach(() => {
	globalThis.fetch = ORIGINAL_FETCH;
	for (const k of ENV_KEYS) {
		if (ORIGINAL_ENV[k] === undefined) delete process.env[k];
		else process.env[k] = ORIGINAL_ENV[k];
	}
	vi.restoreAllMocks();
});

// ── helper: chain + config ─────────────────────────────────────────────────────

describe('vision helper — provider chain', () => {
	it('visionConfigured reflects available keys', () => {
		expect(visionConfigured()).toBe(true);
		delete process.env.NVIDIA_API_KEY;
		expect(visionConfigured()).toBe(false);
		process.env.OPENAI_API_KEY = 'sk-x';
		expect(visionConfigured()).toBe(true);
	});

	it('serves from the free NIM nemotron lane first and records a free (zero-cost) vision event', async () => {
		const calls = stubFetch([['integrate.api.nvidia.com', () => chatOk('Gray')]]);
		const r = await describeImage({ prompt: 'color?', imageUrl: 'https://cdn/x.jpg' });
		expect(r.text).toBe('Gray');
		expect(r.provider).toBe('nvidia');
		expect(r.model).toBe('nvidia/nemotron-nano-12b-v2-vl');
		// One call, to the OpenAI-compatible chat host, multimodal user content.
		expect(calls).toHaveLength(1);
		const userMsg = calls[0].body.messages.at(-1);
		expect(userMsg.content[0]).toEqual({ type: 'text', text: 'color?' });
		expect(userMsg.content[1]).toEqual({ type: 'image_url', image_url: { url: 'https://cdn/x.jpg' } });
		// Spend tracked, free provider → cost 0.
		expect(usageState.events).toHaveLength(1);
		expect(usageState.events[0]).toMatchObject({ kind: 'vision', provider: 'nvidia', costMicroUsd: 0 });
	});

	it('inlines a fetchable image URL as base64 so the free lane serves it without the provider fetching the host', async () => {
		// A 1x1 PNG we can fetch ourselves; the provider must receive a data: URI,
		// not the original URL — this is what keeps the free NIM lane working when
		// the provider's own server-side fetch is blocked (hotlink/UA protection).
		imageFetch.impl = async () =>
			new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
				status: 200,
				headers: { 'content-type': 'image/png' },
			});
		const calls = stubFetch([['integrate.api.nvidia.com', () => chatOk('A red teapot')]]);
		const r = await describeImage({ prompt: 'p', imageUrl: 'https://cdn.example/x.png' });
		expect(r.provider).toBe('nvidia');
		const part = calls[0].body.messages.at(-1).content.find((c) => c.type === 'image_url');
		expect(part.image_url.url.startsWith('data:image/png;base64,')).toBe(true);
		expect(part.image_url.url).not.toContain('cdn.example');
	});

	it('falls back to URL pass-through when we cannot fetch the image ourselves', async () => {
		// Default beforeEach impl already rejects; assert the provider still gets the
		// raw URL so a host the provider CAN reach is never regressed.
		const calls = stubFetch([['integrate.api.nvidia.com', () => chatOk('ok')]]);
		const r = await describeImage({ prompt: 'p', imageUrl: 'https://cdn.example/x.png' });
		expect(r.provider).toBe('nvidia');
		const part = calls[0].body.messages.at(-1).content.find((c) => c.type === 'image_url');
		expect(part.image_url.url).toBe('https://cdn.example/x.png');
	});

	it('falls over from the first NIM lane to the second on a 5xx', async () => {
		let n = 0;
		const calls = stubFetch([
			['integrate.api.nvidia.com', () => (++n === 1 ? httpErr(500, 'boom') : chatOk('ok'))],
		]);
		const r = await describeImage({ prompt: 'p', imageUrl: 'https://cdn/x.jpg' });
		expect(calls).toHaveLength(2);
		expect(calls[0].body.model).toBe('nvidia/nemotron-nano-12b-v2-vl');
		expect(calls[1].body.model).toBe('meta/llama-3.2-11b-vision-instruct');
		expect(r.text).toBe('ok');
	});

	it('appends the paid OpenAI backstop last, after both free lanes fail', async () => {
		process.env.OPENAI_API_KEY = 'sk-x';
		const calls = stubFetch([
			['integrate.api.nvidia.com', () => httpErr(500)],
			['api.openai.com', () => chatOk('backstopped', { prompt_tokens: 1000, completion_tokens: 10 })],
		]);
		const r = await describeImage({ prompt: 'p', imageBase64: 'AAAA', mimeType: 'image/png' });
		expect(r.provider).toBe('openai');
		// Two NIM lanes tried, then OpenAI.
		expect(calls.map((c) => c.url.includes('openai.com'))).toEqual([false, false, true]);
		// base64 inlined as a data URI.
		expect(calls[0].body.messages.at(-1).content[1].image_url.url).toBe('data:image/png;base64,AAAA');
		// Paid model priced > 0.
		expect(usageState.events.at(-1).costMicroUsd).toBeGreaterThan(0);
	});

	it('maps 403 to invalid_key and throws the last error (502) when all lanes fail', async () => {
		const calls = stubFetch([['integrate.api.nvidia.com', () => httpErr(403, 'Authorization failed')]]);
		await expect(describeImage({ prompt: 'p', imageUrl: 'https://cdn/x.jpg' })).rejects.toMatchObject({
			status: 502,
			code: 'invalid_key',
		});
		expect(calls).toHaveLength(2); // both NIM lanes attempted
		expect(usageState.events).toHaveLength(0); // nothing succeeded → no spend
	});

	it('treats a fetch throw (timeout) as a lane failure and moves on', async () => {
		let n = 0;
		stubFetch([
			['integrate.api.nvidia.com', () => {
				if (++n === 1) throw new Error('aborted');
				return chatOk('recovered');
			}],
		]);
		const r = await describeImage({ prompt: 'p', imageUrl: 'https://cdn/x.jpg' });
		expect(r.text).toBe('recovered');
	});

	it('throws VisionUnavailableError when no provider is configured', async () => {
		delete process.env.NVIDIA_API_KEY;
		await expect(describeImage({ prompt: 'p', imageUrl: 'https://cdn/x.jpg' })).rejects.toBeInstanceOf(
			VisionUnavailableError,
		);
	});

	it('requires an image input', async () => {
		await expect(describeImage({ prompt: 'p' })).rejects.toMatchObject({ code: 'no_image' });
	});
});

describe('vision helper — JSON parsing', () => {
	it('parseJsonLoose strips a ```json fence and trailing prose', () => {
		expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 });
		expect(parseJsonLoose('{"a":1}\n')).toEqual({ a: 1 });
		expect(parseJsonLoose('here: {"a":1} done')).toEqual({ a: 1 });
	});
	it('parseJsonLoose throws a normalized error on garbage', () => {
		expect(() => parseJsonLoose('not json at all')).toThrow();
	});
	it('describeImageJson returns the parsed object', async () => {
		stubFetch([['integrate.api.nvidia.com', () => chatOk('{"usable":true}')]]);
		const r = await describeImageJson({ prompt: 'p', imageUrl: 'https://cdn/x.jpg' });
		expect(r.json).toEqual({ usable: true });
	});
});

// ── Consumer 1: forge image validation ─────────────────────────────────────────

describe('Consumer 1 — validateForgeImage', () => {
	it('passes a usable single-subject photo', async () => {
		stubFetch([['integrate.api.nvidia.com', () => chatOk('{"usable":true,"subject":"a red teapot","issue":"none"}')]]);
		const r = await validateForgeImage('https://cdn/teapot.jpg');
		expect(r).toMatchObject({ ok: true, subject: 'a red teapot' });
	});

	it('rejects a text screenshot with a designed, actionable message', async () => {
		stubFetch([['integrate.api.nvidia.com', () => chatOk('{"usable":false,"subject":"","issue":"text_screenshot"}')]]);
		const r = await validateForgeImage('https://cdn/screenshot.png');
		expect(r.ok).toBe(false);
		expect(r.issue).toBe('text_screenshot');
		expect(r.message).toMatch(/screenshot of text/i);
	});

	it('maps an unknown issue code to a safe default reason', async () => {
		stubFetch([['integrate.api.nvidia.com', () => chatOk('{"usable":false,"issue":"weird_new_code"}')]]);
		const r = await validateForgeImage('https://cdn/x.png');
		expect(r.ok).toBe(false);
		expect(r.issue).toBe('no_clear_subject');
		expect(r.message).toBeTruthy();
	});

	it('FAIL-OPEN: skips validation when vision is unconfigured', async () => {
		delete process.env.NVIDIA_API_KEY;
		const r = await validateForgeImage('https://cdn/x.jpg');
		expect(r).toEqual({ ok: true, skipped: 'unconfigured' });
	});

	it('FAIL-OPEN: proceeds on a vision outage (all lanes error)', async () => {
		stubFetch([['integrate.api.nvidia.com', () => httpErr(500)]]);
		const r = await validateForgeImage('https://cdn/x.jpg');
		expect(r).toEqual({ ok: true, skipped: 'error' });
	});

	it('FAIL-OPEN: proceeds on an unparseable / wrong-shape reply', async () => {
		stubFetch([['integrate.api.nvidia.com', () => chatOk('{"not_usable_field":1}')]]);
		const r = await validateForgeImage('https://cdn/x.jpg');
		expect(r).toEqual({ ok: true, skipped: 'bad_reply' });
	});
});

// ── Consumer 2: fact-checker image evidence ────────────────────────────────────

describe('Consumer 2 — imageEvidence', () => {
	const fixedNow = () => new Date('2026-06-11T00:00:00.000Z');

	it('returns a weighted, verdict-compatible source on a supporting image', async () => {
		stubFetch([
			['integrate.api.nvidia.com', () =>
				chatOk('{"description":"A tower at night","visible_text":"330 m","stance":"supports","reason":"shows the height"}'),
			],
		]);
		const s = await imageEvidence('The tower is 330 m tall.', 'https://cdn/tower.jpg', { now: fixedNow });
		expect(s).toMatchObject({
			url: 'https://cdn/tower.jpg',
			stance: 'supports',
			weight: 0.6,
			kind: 'image',
		});
		expect(s.excerpt).toMatch(/Text in image: "330 m"/);
		expect(s.retrievedAt).toBe('2026-06-11T00:00:00.000Z');
	});

	it('coerces an invalid stance to neutral', async () => {
		stubFetch([['integrate.api.nvidia.com', () => chatOk('{"description":"x","stance":"maybe"}')]]);
		const s = await imageEvidence('claim', 'https://cdn/x.jpg');
		expect(s.stance).toBe('neutral');
	});

	it('returns null when no image is attached (no upstream call)', async () => {
		const calls = stubFetch([['x', () => chatOk('{}')]]);
		expect(await imageEvidence('claim', null)).toBeNull();
		expect(calls).toHaveLength(0);
	});

	it('FAIL-OPEN: returns null when vision is unconfigured', async () => {
		delete process.env.NVIDIA_API_KEY;
		expect(await imageEvidence('claim', 'https://cdn/x.jpg')).toBeNull();
	});

	it('FAIL-OPEN: returns null on a vision outage', async () => {
		stubFetch([['integrate.api.nvidia.com', () => httpErr(500)]]);
		expect(await imageEvidence('claim', 'https://cdn/x.jpg')).toBeNull();
	});
});

// ── Consumer 3: avatar alt text ────────────────────────────────────────────────

describe('Consumer 3 — generateAltText / cleanAltText', () => {
	it('generates clean alt text from a thumbnail', async () => {
		stubFetch([['integrate.api.nvidia.com', () => chatOk('A robot knight with a glowing blue visor')]]);
		const alt = await generateAltText({ imageUrl: 'https://cdn/a.png', name: 'Knight' });
		expect(alt).toBe('A robot knight with a glowing blue visor');
	});

	it('FAIL-OPEN: returns null when vision is unconfigured', async () => {
		delete process.env.NVIDIA_API_KEY;
		expect(await generateAltText({ imageUrl: 'https://cdn/a.png' })).toBeNull();
	});

	it('FAIL-OPEN: returns null on a vision outage', async () => {
		stubFetch([['integrate.api.nvidia.com', () => httpErr(500)]]);
		expect(await generateAltText({ imageUrl: 'https://cdn/a.png' })).toBeNull();
	});

	it('returns null when no image is supplied', async () => {
		expect(await generateAltText({ name: 'x' })).toBeNull();
	});

	it('cleanAltText strips quotes, leading "image of", and over-long text', () => {
		expect(cleanAltText('"A blue cat"')).toBe('A blue cat');
		expect(cleanAltText('Image of a red car')).toBe('A red car');
		expect(cleanAltText('a picture showing a dog')).toBe('A dog');
		expect(cleanAltText('   ')).toBeNull();
		const long = cleanAltText('word '.repeat(60));
		expect(long.length).toBeLessThanOrEqual(161);
		expect(long.endsWith('…')).toBe(true);
	});
});
