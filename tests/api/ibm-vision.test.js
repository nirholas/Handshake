// Unit tests for /api/ibm/vision — IBM Granite Vision multimodal endpoint.
//
// Covers every path without any real network calls:
//   GET  — subject list (DB rows, empty DB, DB error, method guard)
//   POST — watsonx unconfigured, input validation, SSRF allowlist, server-side
//          image fetch, all three subject types, hint wiring, structured result,
//          raw-prose fallback, Granite errors, and usage pass-through.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';

// ── Shared mutable state threaded through all mock factories ──────────────────
const state = {
	wxConfigured: false,
	dbRows: [],
	fetchOk: true,
	fetchStatus: 200,
	fetchContentType: 'image/jpeg',
	fetchBody: Buffer.alloc(200), // tiny valid image
	graniteText:
		'{"appearance":"A sleek cobalt android.","vibe":"calm, precise","persona":"A reliable guide.","suggested_name":"Cobalt","bio":"Your co-pilot.","tone_tags":["calm","precise"],"voice":"warm and measured"}',
	graniteThrows: false,
	graniteThrowMsg: 'watsonx 404: not found',
};

// ── Mocks ──────────────────────────────────────────────────────────────────────
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		publicIp: vi.fn(async () => ({ success: true })),
		watsonxEmbedGlobal: vi.fn(async () => ({ success: true })),
	},
	clientIp: vi.fn(() => '127.0.0.1'),
}));

vi.mock('../../api/_lib/db.js', () => ({
	sql: vi.fn(async () => state.dbRows),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

vi.mock('../../api/_lib/watsonx.js', () => ({
	watsonxConfig: vi.fn(() =>
		state.wxConfigured
			? {
					configured: true,
					url: 'https://wx',
					projectId: 'proj',
					apiVersion: '2024-05-31',
					chatModel: 'ibm/granite-3-8b-instruct',
					embedModel: 'ibm/granite-embedding-278m-multilingual',
				}
			: { configured: false },
	),
	watsonxChatComplete: vi.fn(async () => {
		if (state.graniteThrows) throw new Error(state.graniteThrowMsg);
		return {
			text: state.graniteText,
			model: 'ibm/granite-vision-3-2-2b',
			usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 },
		};
	}),
}));

vi.mock('../../api/_lib/r2.js', () => ({
	publicUrl: vi.fn((key) => `https://cdn.example.com/${key}`),
	// thumbnailUrl mirrors r2.js: null for a missing key or the legacy *_og.png form.
	thumbnailUrl: vi.fn((key) =>
		!key || /^https?:\/\/.*_og\.png$/i.test(key) ? null : `https://cdn.example.com/${key}`,
	),
}));

// Mock global fetch for server-side image fetching.
global.fetch = vi.fn(async () => {
	if (!state.fetchOk) {
		return {
			ok: false,
			status: state.fetchStatus,
			headers: { get: () => null },
			arrayBuffer: async () => new ArrayBuffer(0),
		};
	}
	const body = state.fetchBody;
	return {
		ok: true,
		status: 200,
		headers: {
			get(h) {
				if (h === 'content-type') return state.fetchContentType;
				if (h === 'content-length') return String(body.length);
				return null;
			},
		},
		arrayBuffer: async () =>
			body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
	};
});

// Import AFTER all mocks are set up.
const handler = (await import('../../api/ibm/vision.js')).default;
import { allowedImageHost, buildPrompt, parseVision, VISION_MODEL } from '../../api/ibm/vision.js';

// ── Test helpers ──────────────────────────────────────────────────────────────
const TINY_PNG =
	'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function makeReq({ method = 'GET', url = '/api/ibm/vision', body = null } = {}) {
	const base = body ? Readable.from([Buffer.from(JSON.stringify(body))]) : Readable.from([]);
	base.method = method;
	base.url = url;
	base.headers = {
		host: 'localhost',
		'content-type': 'application/json',
		origin: 'http://localhost:3000',
	};
	return base;
}
function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		writableEnded: false,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this.headers[k.toLowerCase()];
		},
		end(chunk) {
			if (chunk !== undefined) this.body += chunk;
			this.writableEnded = true;
		},
	};
}
async function invoke(reqOpts) {
	const res = makeRes();
	await handler(makeReq(reqOpts), res);
	return {
		status: res.statusCode,
		body: res.body ? JSON.parse(res.body) : null,
		headers: res.headers,
	};
}

beforeEach(() => {
	state.wxConfigured = false;
	state.dbRows = [];
	state.fetchOk = true;
	state.fetchStatus = 200;
	state.fetchContentType = 'image/jpeg';
	state.fetchBody = Buffer.alloc(200);
	state.graniteText =
		'{"appearance":"A sleek cobalt android.","vibe":"calm, precise","persona":"A reliable guide.","suggested_name":"Cobalt","bio":"Your co-pilot.","tone_tags":["calm","precise"],"voice":"warm and measured"}';
	state.graniteThrows = false;
	state.graniteThrowMsg = 'watsonx 502: upstream error';
});

// ── GET /api/ibm/vision ───────────────────────────────────────────────────────
describe('GET /api/ibm/vision — subjects', () => {
	it('returns 200 with empty subjects and visionModel when DB has no rows', async () => {
		const { status, body } = await invoke({ method: 'GET' });
		expect(status).toBe(200);
		expect(body.subjects).toEqual([]);
		expect(typeof body.visionModel).toBe('string');
		expect(body.visionModel).toContain('granite');
	});

	it('maps DB rows to subjects with cdn URLs', async () => {
		state.dbRows = [
			{
				id: 'id-1',
				slug: 'cobalt',
				name: 'Cobalt',
				storage_key: 'avatars/cobalt.glb',
				thumbnail_key: 'thumbs/cobalt.jpg',
				featured: true,
				view_count: 42,
			},
		];
		const { status, body } = await invoke({ method: 'GET' });
		expect(status).toBe(200);
		expect(body.subjects).toHaveLength(1);
		const s = body.subjects[0];
		expect(s.id).toBe('id-1');
		expect(s.name).toBe('Cobalt');
		expect(s.thumbnail).toContain('thumbs/cobalt.jpg');
		expect(s.model_url).toContain('avatars/cobalt.glb');
		expect(s.slug).toBe('cobalt');
	});

	it('returns empty subjects (not 500) when DB throws', async () => {
		const { sql } = await import('../../api/_lib/db.js');
		sql.mockRejectedValueOnce(new Error('DB unavailable'));
		const { status, body } = await invoke({ method: 'GET' });
		expect(status).toBe(200);
		expect(body.subjects).toEqual([]);
	});

	it('returns 405 for unsupported methods', async () => {
		const { status } = await invoke({ method: 'DELETE' });
		expect(status).toBe(405);
	});
});

// ── POST /api/ibm/vision — auth ────────────────────────────────────────────────
describe('POST /api/ibm/vision — watsonx gate', () => {
	it('returns 503 watsonx_unavailable when watsonx is not configured', async () => {
		state.wxConfigured = false;
		const { status, body } = await invoke({ method: 'POST', body: { image: TINY_PNG } });
		expect(status).toBe(503);
		expect(body.error).toBe('watsonx_unavailable');
		expect(body.error_description).toMatch(/WATSONX_API_KEY/i);
	});
});

// ── POST /api/ibm/vision — input validation ─────────────────────────────────────
describe('POST /api/ibm/vision — input validation', () => {
	beforeEach(() => {
		state.wxConfigured = true;
	});

	it('returns 400 bad_image when neither image nor imageUrl is provided', async () => {
		const { status, body } = await invoke({ method: 'POST', body: { hint: 'hello' } });
		expect(status).toBe(400);
		expect(body.error).toBe('bad_image');
	});

	it('returns 400 bad_image when image data URL has empty data portion', async () => {
		const { status, body } = await invoke({
			method: 'POST',
			body: { image: 'data:image/png;base64,' },
		});
		expect(status).toBe(400);
		expect(body.error).toBe('bad_image');
	});

	it('returns 413 image_too_large when data URL exceeds 6 MB', async () => {
		// 6MB / 0.75 ≈ 8MB of base64
		const big = 'data:image/png;base64,' + 'A'.repeat(8_500_000);
		const { status, body } = await invoke({ method: 'POST', body: { image: big } });
		expect(status).toBe(413);
		expect(body.error).toBe('image_too_large');
	});

	it('returns 400 bad_image when imageUrl uses http (not https)', async () => {
		const { status, body } = await invoke({
			method: 'POST',
			body: { imageUrl: 'http://pub-abc.r2.dev/img.jpg' },
		});
		expect(status).toBe(400);
		expect(body.error).toBe('bad_image');
	});

	it('returns 400 image_host_not_allowed for an arbitrary external host', async () => {
		const { status, body } = await invoke({
			method: 'POST',
			body: { imageUrl: 'https://evil.example.com/img.jpg' },
		});
		expect(status).toBe(400);
		expect(body.error).toBe('image_host_not_allowed');
	});

	it('returns 400 image_host_not_allowed for internal metadata endpoint (SSRF)', async () => {
		const { status, body } = await invoke({
			method: 'POST',
			body: { imageUrl: 'https://169.254.169.254/latest/meta-data/' },
		});
		expect(status).toBe(400);
		expect(body.error).toBe('image_host_not_allowed');
	});
});

// ── POST /api/ibm/vision — server-side image fetch ───────────────────────────────
describe('POST /api/ibm/vision — server-side image fetch', () => {
	beforeEach(() => {
		state.wxConfigured = true;
	});

	it('fetches an allowlisted imageUrl and sends it to Granite', async () => {
		const { status, body } = await invoke({
			method: 'POST',
			body: { imageUrl: 'https://pub-test.r2.dev/avatar.jpg', subject: 'avatar' },
		});
		expect(status).toBe(200);
		expect(global.fetch).toHaveBeenCalledWith(
			expect.stringContaining('pub-test.r2.dev'),
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(body.vision.suggested_name).toBe('Cobalt');
	});

	it('returns 502 image_fetch_failed when upstream fetch fails', async () => {
		state.fetchOk = false;
		state.fetchStatus = 503;
		const { status, body } = await invoke({
			method: 'POST',
			body: { imageUrl: 'https://pub-test.r2.dev/avatar.jpg' },
		});
		expect(status).toBe(502);
		expect(body.error).toBe('image_fetch_failed');
	});

	it('returns 415 not_an_image when fetched URL is not an image', async () => {
		state.fetchContentType = 'text/html';
		const { status, body } = await invoke({
			method: 'POST',
			body: { imageUrl: 'https://pub-test.r2.dev/page.html' },
		});
		expect(status).toBe(415);
		expect(body.error).toBe('not_an_image');
	});
});

// ── POST /api/ibm/vision — Granite Vision call ────────────────────────────────
describe('POST /api/ibm/vision — Granite Vision result', () => {
	beforeEach(() => {
		state.wxConfigured = true;
	});

	it('returns a structured identity when Granite returns valid JSON', async () => {
		const { status, body } = await invoke({ method: 'POST', body: { image: TINY_PNG } });
		expect(status).toBe(200);
		expect(body.vision.structured).toBe(true);
		expect(body.vision.suggested_name).toBe('Cobalt');
		expect(body.vision.bio).toBe('Your co-pilot.');
		expect(body.vision.tone_tags).toEqual(['calm', 'precise']);
		expect(body.vision.voice).toBe('warm and measured');
	});

	it('includes the model name in the response', async () => {
		const { body } = await invoke({ method: 'POST', body: { image: TINY_PNG } });
		expect(body.model).toBe('ibm/granite-vision-3-2-2b');
	});

	it('passes usage through to the response', async () => {
		const { body } = await invoke({ method: 'POST', body: { image: TINY_PNG } });
		expect(body.usage).toMatchObject({
			prompt_tokens: 120,
			completion_tokens: 80,
			total_tokens: 200,
		});
	});

	it('does not include "raw" when result is structured', async () => {
		const { body } = await invoke({ method: 'POST', body: { image: TINY_PNG } });
		expect(body.raw).toBeUndefined();
	});

	it('returns raw fallback (structured:false) when Granite returns prose', async () => {
		state.graniteText =
			'This avatar appears to be a futuristic character with a calm demeanor.';
		const { status, body } = await invoke({ method: 'POST', body: { image: TINY_PNG } });
		expect(status).toBe(200);
		expect(body.vision.structured).toBe(false);
		expect(body.raw).toMatch(/futuristic character/);
	});

	it('recovers JSON from a code-fenced response', async () => {
		state.graniteText =
			'```json\n{"appearance":"A bot.","vibe":"calm","persona":"Helpful.","suggested_name":"Bot","bio":"Here to help.","tone_tags":["calm"],"voice":"steady"}\n```';
		const { body } = await invoke({ method: 'POST', body: { image: TINY_PNG } });
		expect(body.vision.structured).toBe(true);
		expect(body.vision.suggested_name).toBe('Bot');
	});

	it('uses the avatar prompt by default (subject omitted)', async () => {
		const { watsonxChatComplete } = await import('../../api/_lib/watsonx.js');
		await invoke({ method: 'POST', body: { image: TINY_PNG } });
		const calls = watsonxChatComplete.mock.calls;
		const lastCall = calls[calls.length - 1];
		const messages = lastCall[1].messages;
		expect(messages[0].content).toMatch(/casting director/i);
	});

	it('uses the token prompt when subject is "token"', async () => {
		const { watsonxChatComplete } = await import('../../api/_lib/watsonx.js');
		await invoke({ method: 'POST', body: { image: TINY_PNG, subject: 'token' } });
		const calls = watsonxChatComplete.mock.calls;
		const lastCall = calls[calls.length - 1];
		const messages = lastCall[1].messages;
		expect(messages[0].content).toMatch(/brand analyst/i);
	});

	it('uses the generic image prompt when subject is "image"', async () => {
		const { watsonxChatComplete } = await import('../../api/_lib/watsonx.js');
		await invoke({ method: 'POST', body: { image: TINY_PNG, subject: 'image' } });
		const calls = watsonxChatComplete.mock.calls;
		const lastCall = calls[calls.length - 1];
		const messages = lastCall[1].messages;
		expect(messages[0].content).toMatch(/art director/i);
	});

	it('defaults unknown subject to avatar', async () => {
		const { status, body } = await invoke({
			method: 'POST',
			body: { image: TINY_PNG, subject: 'spacecraft' },
		});
		expect(status).toBe(200);
		expect(body.subject).toBe('avatar');
	});

	it('weaves the hint into the user message', async () => {
		const { watsonxChatComplete } = await import('../../api/_lib/watsonx.js');
		await invoke({ method: 'POST', body: { image: TINY_PNG, hint: 'a rogue detective' } });
		const calls = watsonxChatComplete.mock.calls;
		const lastCall = calls[calls.length - 1];
		const userContent = lastCall[1].messages[1].content;
		const textBlock = userContent.find((b) => b.type === 'text');
		expect(textBlock.text).toContain('a rogue detective');
	});

	it('embeds the image as a data URL in the image_url block', async () => {
		const { watsonxChatComplete } = await import('../../api/_lib/watsonx.js');
		await invoke({ method: 'POST', body: { image: TINY_PNG } });
		const calls = watsonxChatComplete.mock.calls;
		const lastCall = calls[calls.length - 1];
		const userContent = lastCall[1].messages[1].content;
		const imgBlock = userContent.find((b) => b.type === 'image_url');
		expect(imgBlock.image_url.url).toMatch(/^data:image\//);
	});

	it('returns 502 vision_failed when Granite throws', async () => {
		state.graniteThrows = true;
		state.graniteThrowMsg = 'watsonx 502: quota exceeded';
		const { status, body } = await invoke({ method: 'POST', body: { image: TINY_PNG } });
		expect(status).toBe(502);
		expect(body.error).toBe('vision_failed');
	});

	it('returns 502 model_unavailable when Granite reports model not found', async () => {
		state.graniteThrows = true;
		state.graniteThrowMsg = 'watsonx 404: model not found in this region';
		const { status, body } = await invoke({ method: 'POST', body: { image: TINY_PNG } });
		expect(status).toBe(502);
		expect(body.error).toBe('model_unavailable');
	});
});

// ── Unit: parseVision ─────────────────────────────────────────────────────────
describe('parseVision — identity parser', () => {
	it('parses a clean JSON blob', () => {
		const v = parseVision(
			'{"appearance":"Blue bot.","vibe":"calm","persona":"A guide.","suggested_name":"Bot","bio":"Here for you.","tone_tags":["calm","helpful"],"voice":"warm"}',
		);
		expect(v.structured).toBe(true);
		expect(v.suggested_name).toBe('Bot');
		expect(v.tone_tags).toEqual(['calm', 'helpful']);
	});

	it('strips leading and trailing prose around the JSON', () => {
		const v = parseVision(
			'Sure, here it is: {"suggested_name":"Echo","bio":"test","appearance":"","vibe":"","persona":"","tone_tags":[],"voice":""} Hope that helps!',
		);
		expect(v.structured).toBe(true);
		expect(v.suggested_name).toBe('Echo');
	});

	it('splits a comma-joined string into tone_tags array', () => {
		const v = parseVision(
			'{"appearance":"x","vibe":"x","persona":"x","suggested_name":"x","bio":"x","tone_tags":"calm, curious, witty","voice":"x"}',
		);
		expect(v.tone_tags).toEqual(['calm', 'curious', 'witty']);
	});

	it('clamps fields to their max lengths', () => {
		const v = parseVision(
			`{"appearance":"x","vibe":"x","persona":"x","suggested_name":"${'A'.repeat(100)}","bio":"${'B'.repeat(300)}","tone_tags":[],"voice":"${'C'.repeat(200)}"}`,
		);
		expect(v.suggested_name.length).toBeLessThanOrEqual(60);
		expect(v.bio.length).toBeLessThanOrEqual(200);
		expect(v.voice.length).toBeLessThanOrEqual(120);
	});

	it('returns structured:false for empty input', () => {
		expect(parseVision('').structured).toBe(false);
		expect(parseVision(null).structured).toBe(false);
		expect(parseVision('no json here').structured).toBe(false);
	});

	it('returns structured:false for invalid JSON', () => {
		expect(parseVision('{broken json}').structured).toBe(false);
	});
});

// ── Unit: allowedImageHost ─────────────────────────────────────────────────────
describe('allowedImageHost — SSRF allowlist', () => {
	const allow = [
		'pub-abc.r2.dev',
		'three.ws',
		'ipfs.io',
		'arweave.net',
		'pump.mypinata.cloud',
		'bafyb.ipfs.dweb.link',
		'user.githubusercontent.com',
	];
	const deny = [
		'localhost',
		'127.0.0.1',
		'169.254.169.254',
		'evil.com',
		'10.0.0.1',
		'metadata.google.internal',
	];

	for (const h of allow) it(`allows ${h}`, () => expect(allowedImageHost(h)).toBe(true));
	for (const h of deny) it(`rejects ${h}`, () => expect(allowedImageHost(h)).toBe(false));
});

// ── Unit: buildPrompt ─────────────────────────────────────────────────────────
describe('buildPrompt — prompt builder', () => {
	it('returns a casting-director system prompt for avatar subject', () => {
		const { system } = buildPrompt('avatar', '');
		expect(system).toMatch(/casting director/i);
	});

	it('returns a brand-analyst system prompt for token subject', () => {
		const { system } = buildPrompt('token', '');
		expect(system).toMatch(/brand analyst/i);
	});

	it('returns an art-director system prompt for image subject', () => {
		const { system } = buildPrompt('image', '');
		expect(system).toMatch(/art director/i);
	});

	it('injects the hint into the user message', () => {
		const { user } = buildPrompt('avatar', 'a grumpy wizard');
		expect(user).toContain('a grumpy wizard');
	});

	it('omits the hint line when hint is empty', () => {
		const { user } = buildPrompt('avatar', '');
		expect(user).not.toContain('adds:');
	});
});

// ── Unit: VISION_MODEL ────────────────────────────────────────────────────────
describe('VISION_MODEL', () => {
	it('defaults to the Granite Vision 3.2 model', () => {
		expect(VISION_MODEL).toMatch(/granite-vision/);
	});
});
