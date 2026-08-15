// A caller's bad input has to come back as the caller's error, before any money
// moves. Three places in the TTS surface used to break that:
//
//   1. GET /api/tts/catalog answered 200 with an empty catalog for a provider id
//      that does not exist, so a typo and a lane that is genuinely down looked
//      identical to the picker.
//   2. POST /api/tts/synthesize handed an unrecognized voiceId straight to the
//      router, which swaps in the lane default. The caller got a 200, somebody
//      else's voice, and (on a metered lane) a charge, with nothing in the
//      response saying a substitution had happened. A well-formed-but-nonexistent
//      id instead burned an upstream round trip and came back 502.
//   3. POST /api/tts/eleven-clone read out whether this server has an ElevenLabs
//      key before it checked who was asking, so a signed-out caller could probe
//      the deployment's configuration.
//
// Transport-layer stubs only (global fetch, the R2 and credit boundaries). No
// live synthesis, no live credit ledger.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';

const authState = vi.hoisted(() => ({ user: null }));
const creditState = vi.hoisted(() => ({ charges: [], refunds: [] }));

vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: async () => authState.user,
	authenticateBearer: async () => null,
	extractBearer: () => null,
}));

// R2 stands in for "no cached clip": a miss on both head and write keeps the
// handler on the path this file is about.
vi.mock('../../api/_lib/r2.js', () => ({
	headObject: async () => {
		throw new Error('no such key');
	},
	getObjectBuffer: async () => {
		throw new Error('no such key');
	},
	putObject: async () => ({}),
}));

// api/tts/eleven.js only touches the database on the agent-voice lane, which no
// test here exercises; the stub exists so importing the handler does not need a
// live connection.
vi.mock('../../api/_lib/db.js', () => ({
	sql: async () => [],
}));

vi.mock('../../api/_lib/credits.js', () => ({
	chargeCreditsForAction: async (args) => {
		creditState.charges.push(args);
		return { chargedUsd: 0.0001 };
	},
	refundCredits: async (args) => {
		creditState.refunds.push(args);
		return { refundedUsd: 0.0001 };
	},
}));

const ORIGINAL_FETCH = globalThis.fetch;
const ENV_KEYS = ['OPENAI_API_KEY', 'ELEVENLABS_API_KEY', 'NVIDIA_API_KEY'];
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

// Shaped exactly like Microsoft's published voice list, so the real
// normalizer in api/_lib/tts-edge.js runs over it.
const EDGE_LIST = [
	{
		Name: 'Microsoft Server Speech Text to Speech Voice (en-US, AriaNeural)',
		ShortName: 'en-US-AriaNeural',
		Gender: 'Female',
		Locale: 'en-US',
		FriendlyName: 'Microsoft Aria Online (Natural) - English (United States)',
		VoiceTag: { ContentCategories: ['News'], VoicePersonalities: ['Positive'] },
	},
	{
		Name: 'Microsoft Server Speech Text to Speech Voice (en-GB, RyanNeural)',
		ShortName: 'en-GB-RyanNeural',
		Gender: 'Male',
		Locale: 'en-GB',
		FriendlyName: 'Microsoft Ryan Online (Natural) - English (United Kingdom)',
		VoiceTag: { ContentCategories: ['General'], VoicePersonalities: ['Friendly'] },
	},
];

const OPENAI_MP3 = Buffer.from('openai-mp3-fixture');
const ELEVEN_MP3 = Buffer.from('eleven-mp3-fixture');

let edgeListCalls = 0;
let openaiCalls = [];

function stubFetch({ edgeList = EDGE_LIST, edgeStatus = 200, elevenStatus = 200 } = {}) {
	globalThis.fetch = vi.fn(async (url, opts = {}) => {
		const u = String(url);
		if (u.includes('voices/list')) {
			edgeListCalls += 1;
			if (edgeStatus !== 200) return new Response('nope', { status: edgeStatus });
			return new Response(JSON.stringify(edgeList), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		}
		if (u.includes('api.openai.com')) {
			openaiCalls.push(JSON.parse(opts.body));
			return new Response(OPENAI_MP3, {
				status: 200,
				headers: { 'content-type': 'audio/mpeg' },
			});
		}
		if (u.includes('api.elevenlabs.io')) {
			if (elevenStatus !== 200) {
				// The shape ElevenLabs actually returns for an id it does not have.
				return new Response(
					JSON.stringify({
						detail: {
							status: 'voice_not_found',
							message: "An invalid ID has been received: 'ghost-voice'.",
						},
					}),
					{ status: elevenStatus, headers: { 'content-type': 'application/json' } },
				);
			}
			return new Response(ELEVEN_MP3, {
				status: 200,
				headers: { 'content-type': 'audio/mpeg' },
			});
		}
		throw new Error(`unexpected fetch in test: ${u}`);
	});
}

let ipCounter = 0;
let userCounter = 0;

function makeReq({ method = 'POST', url = '/api/tts/synthesize', body = null, headers = {} } = {}) {
	const buf = body === null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
	const req = Readable.from([buf]);
	req.method = method;
	req.url = url;
	req.headers = {
		'content-type': 'application/json',
		'content-length': String(buf.length),
		// A fresh IP and a fresh user id per request so the in-memory limiters
		// never trip across this file.
		'x-forwarded-for': `10.1.0.${++ipCounter}, 35.191.0.1`,
		...headers,
	};
	return req;
}

function makeRes() {
	const chunks = [];
	return {
		statusCode: 200,
		_h: {},
		writableEnded: false,
		headersSent: false,
		setHeader(k, v) {
			this._h[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this._h[k.toLowerCase()];
		},
		write(c) {
			chunks.push(Buffer.from(c));
		},
		end(c) {
			if (c) chunks.push(Buffer.from(c));
			this.writableEnded = true;
		},
		body() {
			return Buffer.concat(chunks);
		},
		json() {
			return JSON.parse(this.body().toString('utf8'));
		},
	};
}

async function call(modulePath, reqOpts) {
	const handler = (await import(modulePath)).default;
	const res = makeRes();
	await handler(makeReq(reqOpts), res);
	return res;
}

function signIn() {
	authState.user = { id: `11111111-0000-4000-8000-00000000${String(++userCounter).padStart(4, '0')}` };
	return authState.user;
}

beforeEach(() => {
	authState.user = null;
	creditState.charges.length = 0;
	creditState.refunds.length = 0;
	openaiCalls = [];
	edgeListCalls = 0;
	for (const k of ENV_KEYS) delete process.env[k];
	stubFetch();
});

afterEach(() => {
	globalThis.fetch = ORIGINAL_FETCH;
	for (const k of ENV_KEYS) {
		if (ORIGINAL_ENV[k] === undefined) delete process.env[k];
		else process.env[k] = ORIGINAL_ENV[k];
	}
});

describe('isKnownVoice (api/_lib/voice-providers.js)', () => {
	it('accepts an id the lane actually publishes and rejects one it does not', async () => {
		const { isKnownVoice } = await import('../../api/_lib/voice-providers.js');
		expect(await isKnownVoice('edge', 'en-GB-RyanNeural')).toBe(true);
		expect(await isKnownVoice('edge', 'zz-ZZ-NopeNeural')).toBe(false);
		expect(await isKnownVoice('edge', 'not a voice at all')).toBe(false);
	});

	it('treats an omitted voiceId as "use the lane default"', async () => {
		const { isKnownVoice } = await import('../../api/_lib/voice-providers.js');
		for (const p of ['edge', 'gemini', 'nvidia', 'openai', 'elevenlabs']) {
			expect(await isKnownVoice(p, '')).toBe(true);
			expect(await isKnownVoice(p, undefined)).toBe(true);
		}
	});

	it('checks the closed-vocabulary lanes against their own catalog', async () => {
		const { isKnownVoice, listProviderVoices } = await import(
			'../../api/_lib/voice-providers.js'
		);
		for (const p of ['gemini', 'nvidia', 'openai']) {
			const [first] = await listProviderVoices(p);
			expect(await isKnownVoice(p, first.id)).toBe(true);
			expect(await isKnownVoice(p, 'totally-not-real')).toBe(false);
		}
	});

	it('leaves the per-account ElevenLabs catalog to upstream', async () => {
		const { isKnownVoice } = await import('../../api/_lib/voice-providers.js');
		// Voices are cloned and added to an account at runtime, so a local list
		// would reject ids that are genuinely valid a second later.
		expect(await isKnownVoice('elevenlabs', 'a-voice-only-this-account-has')).toBe(true);
	});

	it('fails open when the lane catalog cannot be fetched', async () => {
		// A Microsoft outage must not turn every Edge request into a 400.
		vi.resetModules();
		stubFetch({ edgeStatus: 503 });
		const { isKnownVoice } = await import('../../api/_lib/voice-providers.js');
		expect(await isKnownVoice('edge', 'en-US-AriaNeural')).toBe(true);
	});
});

describe('POST /api/tts/synthesize voiceId guard', () => {
	it('rejects a voice the lane does not have instead of silently substituting one', async () => {
		const res = await call('../../api/tts/synthesize.js', {
			body: { provider: 'edge', voiceId: 'zz-ZZ-NopeNeural', text: 'hello' },
		});
		expect(res.statusCode).toBe(400);
		const body = res.json();
		expect(body.error).toBe('validation_error');
		expect(body.error_description).toContain('zz-ZZ-NopeNeural');
		expect(body.error_description).toContain('/api/tts/catalog?provider=edge');
	});

	it('never charges for a rejected voice', async () => {
		process.env.OPENAI_API_KEY = 'sk-test-openai';
		signIn();
		const res = await call('../../api/tts/synthesize.js', {
			body: { provider: 'openai', voiceId: 'not-an-openai-voice', text: 'hello' },
		});
		expect(res.statusCode).toBe(400);
		expect(creditState.charges).toEqual([]);
		expect(openaiCalls).toEqual([]);
	});

	it('still renders, and still meters, a voice the lane does have', async () => {
		process.env.OPENAI_API_KEY = 'sk-test-openai';
		signIn();
		const res = await call('../../api/tts/synthesize.js', {
			body: { provider: 'openai', voiceId: 'nova', text: 'hello' },
		});
		expect(res.statusCode).toBe(200);
		expect(res.getHeader('x-tts-billing')).toBe('credits');
		expect(res.getHeader('x-tts-voice')).toBe('nova');
		expect(openaiCalls).toHaveLength(1);
		expect(openaiCalls[0].voice).toBe('nova');
		expect(creditState.charges).toHaveLength(1);
		expect(creditState.refunds).toEqual([]);
	});

	it('lets an omitted voiceId through to the lane default', async () => {
		process.env.OPENAI_API_KEY = 'sk-test-openai';
		signIn();
		const res = await call('../../api/tts/synthesize.js', {
			body: { provider: 'openai', text: 'hello' },
		});
		expect(res.statusCode).toBe(200);
		expect(openaiCalls).toHaveLength(1);
		expect(res.getHeader('x-tts-voice')).toBe(openaiCalls[0].voice);
	});

	it('rejects an unknown provider before it looks at the voice', async () => {
		const res = await call('../../api/tts/synthesize.js', {
			body: { provider: 'nope', voiceId: 'x', text: 'hello' },
		});
		expect(res.statusCode).toBe(400);
		expect(res.json().error_description).toContain('nope');
	});
});

describe('GET /api/tts/catalog provider guard', () => {
	it('rejects a provider id that does not exist', async () => {
		const res = await call('../../api/tts/catalog.js', {
			method: 'GET',
			url: '/api/tts/catalog?provider=bogus',
		});
		expect(res.statusCode).toBe(400);
		const body = res.json();
		expect(body.error).toBe('validation_error');
		expect(body.error_description).toContain('bogus');
		// The message names the lanes that do exist, so the caller can fix it.
		expect(body.error_description).toContain('edge');
	});

	it('serves the lane for a provider id that does exist', async () => {
		const res = await call('../../api/tts/catalog.js', {
			method: 'GET',
			url: '/api/tts/catalog?provider=edge',
		});
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.counts.edge).toBe(EDGE_LIST.length);
		expect(body.voices.map((v) => v.id)).toEqual(EDGE_LIST.map((v) => v.ShortName));
	});

	it('treats a blank provider param as "every lane"', async () => {
		const res = await call('../../api/tts/catalog.js', {
			method: 'GET',
			url: '/api/tts/catalog?provider=',
		});
		expect(res.statusCode).toBe(200);
		expect(res.json().total).toBe(EDGE_LIST.length);
	});
});

describe('an unknown ElevenLabs voice is the caller\'s error, not the platform\'s', () => {
	it('POST /api/tts/eleven answers 4xx and refunds, instead of blaming itself with a 502', async () => {
		vi.resetModules();
		stubFetch({ elevenStatus: 400 });
		process.env.ELEVENLABS_API_KEY = 'xi-platform-key';
		signIn();
		const res = await call('../../api/tts/eleven.js', {
			url: '/api/tts/eleven',
			body: { voiceId: 'ghost-voice', text: 'hello' },
		});
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toBe('validation_error');
		expect(res.json().error_description).toContain('ghost-voice');
		// Charged before the upstream call, so a failed clip has to be given back.
		expect(creditState.charges).toHaveLength(1);
		expect(creditState.refunds).toHaveLength(1);
	});

	it('POST /api/tts/eleven still reports a genuine upstream fault as 502', async () => {
		vi.resetModules();
		stubFetch({ elevenStatus: 500 });
		process.env.ELEVENLABS_API_KEY = 'xi-platform-key';
		signIn();
		const res = await call('../../api/tts/eleven.js', {
			url: '/api/tts/eleven',
			body: { voiceId: 'ghost-voice', text: 'hello' },
		});
		expect(res.statusCode).toBe(502);
		expect(res.json().error).toBe('upstream_error');
		expect(creditState.refunds).toHaveLength(1);
	});

	it('synthesizeVoice tags a 404 as invalid_argument so the router can answer 4xx', async () => {
		vi.resetModules();
		stubFetch({ elevenStatus: 404 });
		const { synthesizeVoice } = await import('../../api/_lib/voice-providers.js');
		await expect(
			synthesizeVoice({
				provider: 'elevenlabs',
				text: 'hello',
				voiceId: 'ghost-voice',
				elevenKey: 'xi-user-key',
			}),
		).rejects.toMatchObject({ code: 'invalid_argument' });
	});
});

describe('POST /api/tts/eleven-clone auth ordering', () => {
	it('answers 401 to a signed-out caller rather than reporting the key state', async () => {
		process.env.ELEVENLABS_API_KEY = 'xi-platform-key';
		const res = await call('../../api/tts/eleven-clone.js', {
			url: '/api/tts/eleven-clone',
			body: {},
			headers: { 'content-type': 'multipart/form-data; boundary=abc' },
		});
		expect(res.statusCode).toBe(401);
		expect(res.json().error).toBe('unauthorized');
	});

	it('answers 401 the same way when the server has no key at all', async () => {
		const res = await call('../../api/tts/eleven-clone.js', {
			url: '/api/tts/eleven-clone',
			body: {},
			headers: { 'content-type': 'multipart/form-data; boundary=abc' },
		});
		expect(res.statusCode).toBe(401);
	});
});
