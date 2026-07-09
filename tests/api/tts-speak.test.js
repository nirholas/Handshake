// Tests for the TTS free-first provider chain (task T2.1).
//
// Policy under test (api/_lib/llm.js doctrine applied to speech):
//   • NVIDIA NIM Magpie (free, gRPC) leads whenever NVIDIA_API_KEY is set —
//     and OpenAI is NEVER called when it serves.
//   • OpenAI is the paid backstop: attempted only after the NIM lane fails or
//     is unconfigured.
//   • 503 only when NO lane is configured; 502 (with both lanes' errors, in
//     attempt order) when every configured lane fails.
//   • x-tts-voice / x-tts-model / x-tts-format / content-type always describe
//     the bytes actually served (Magpie emits PCM → non-pcm requests become
//     WAV).
//
// Transport-layer mocks only: the gRPC client (@grpc/grpc-js) and global
// fetch. No live calls. Same chain is asserted on the MCP twin
// (packages/avatar-agent-mcp/src/tools/speak.js).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';

// Shared with the hoisted vi.mock factories below.
const grpcState = vi.hoisted(() => ({
	// (req, metadata, opts, cb) — set per test.
	synthesize: null,
	calls: [], // { request, metadata }
	clients: [], // constructor args, to prove the channel target
}));

vi.mock('@grpc/grpc-js', () => {
	class Metadata {
		constructor() {
			this.map = {};
		}
		set(k, v) {
			this.map[k] = v;
		}
		get(k) {
			return this.map[k];
		}
	}
	class RivaSpeechSynthesis {
		constructor(host, creds, opts) {
			grpcState.clients.push({ host, creds, opts });
		}
		synthesize(request, metadata, opts, cb) {
			grpcState.calls.push({ request, metadata });
			grpcState.synthesize(request, metadata, opts, cb);
		}
	}
	const grpc = {
		Metadata,
		credentials: { createSsl: () => ({ ssl: true }) },
		loadPackageDefinition: () => ({ nvidia: { riva: { tts: { RivaSpeechSynthesis } } } }),
	};
	return { default: grpc };
});

vi.mock('@grpc/proto-loader', () => ({
	default: { fromJSON: () => ({ mockPackageDefinition: true }) },
}));

const ORIGINAL_FETCH = globalThis.fetch;
const ENV_KEYS = ['NVIDIA_API_KEY', 'OPENAI_API_KEY'];
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

// Synthetic little-endian s16 PCM (clearly not RIFF) the mock lane returns.
const PCM_BYTES = Buffer.alloc(2000, 0x42);
const OPENAI_MP3_BYTES = Buffer.from('openai-mp3-bytes-fixture');

function grpcSuccess() {
	grpcState.synthesize = (_req, _md, _opts, cb) => cb(null, { audio: PCM_BYTES });
}

function grpcFailure(code = 16, details = 'auth denied') {
	grpcState.synthesize = (_req, _md, _opts, cb) => {
		const err = new Error(details);
		err.code = code;
		err.details = details;
		cb(err);
	};
}

function stubOpenAi(status = 200, body = OPENAI_MP3_BYTES) {
	const calls = [];
	globalThis.fetch = vi.fn(async (url, opts = {}) => {
		const u = String(url);
		calls.push({ url: u, body: opts.body ? JSON.parse(opts.body) : null });
		if (!u.includes('api.openai.com')) throw new Error(`unexpected fetch in test: ${u}`);
		if (status !== 200) {
			return new Response(JSON.stringify({ error: { message: 'insufficient_quota' } }), { status });
		}
		return new Response(body, { status: 200, headers: { 'content-type': 'audio/mpeg' } });
	});
	return calls;
}

let ipCounter = 0;
function makeReq(body, headers = {}) {
	const buf = Buffer.from(JSON.stringify(body));
	const req = Readable.from([buf]);
	req.method = 'POST';
	req.url = '/api/tts/speak';
	req.headers = {
		'content-type': 'application/json',
		'content-length': String(buf.length),
		// Unique IP per request so the in-memory per-IP limiter never trips.
		'x-forwarded-for': `10.0.0.${++ipCounter}, 35.191.0.1`,
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

async function callSpeak(body, headers) {
	const handler = (await import('../../api/tts/speak.js')).default;
	const res = makeRes();
	await handler(makeReq(body, headers), res);
	return res;
}

beforeEach(() => {
	grpcState.synthesize = () => {
		throw new Error('grpc synthesize called without a test stub');
	};
	grpcState.calls.length = 0;
	process.env.NVIDIA_API_KEY = 'nvapi-test-key';
	process.env.OPENAI_API_KEY = 'sk-test-openai';
	globalThis.fetch = vi.fn(async (url) => {
		throw new Error(`unexpected fetch in test: ${url}`);
	});
});

afterEach(() => {
	globalThis.fetch = ORIGINAL_FETCH;
	for (const k of ENV_KEYS) {
		if (ORIGINAL_ENV[k] === undefined) delete process.env[k];
		else process.env[k] = ORIGINAL_ENV[k];
	}
});

describe('POST /api/tts/speak — free-first chain', () => {
	it('NIM serves and OpenAI is never called; headers describe the actual audio', async () => {
		grpcSuccess();
		const res = await callSpeak({ text: 'Hello there', voice: 'nova', format: 'mp3' });

		expect(res.statusCode).toBe(200);
		// mp3 was requested, but the free lane emits PCM → served as WAV, truthfully.
		expect(res.getHeader('content-type')).toBe('audio/wav');
		expect(res.getHeader('x-tts-model')).toBe('magpie-tts-multilingual');
		expect(res.getHeader('x-tts-voice')).toBe('Magpie-Multilingual.EN-US.Aria');
		expect(res.getHeader('x-tts-format')).toBe('wav');
		const body = res.body();
		expect(body.subarray(0, 4).toString('ascii')).toBe('RIFF');
		expect(body.subarray(8, 12).toString('ascii')).toBe('WAVE');
		expect(body.length).toBe(44 + PCM_BYTES.length);
		// Paid backstop untouched.
		expect(globalThis.fetch).not.toHaveBeenCalled();
		// The gRPC request carried the probe-verified NVCF contract.
		expect(grpcState.calls).toHaveLength(1);
		const { request, metadata } = grpcState.calls[0];
		expect(request).toMatchObject({
			text: 'Hello there',
			language_code: 'en-US',
			encoding: 'LINEAR_PCM',
			sample_rate_hz: 44100,
			voice_name: 'Magpie-Multilingual.EN-US.Aria',
		});
		expect(metadata.map['function-id']).toBe('877104f7-e885-42b9-8de8-f6e4c6303969');
		expect(metadata.map['authorization']).toBe('Bearer nvapi-test-key');
		expect(grpcState.clients.at(-1).host).toBe('grpc.nvcf.nvidia.com:443');
	});

	it('fails over to OpenAI when the NIM lane errors, with truthful headers', async () => {
		grpcFailure(8, 'free tier exhausted');
		const calls = stubOpenAi();
		const res = await callSpeak({ text: 'Backstop please', voice: 'shimmer', format: 'mp3' });

		expect(res.statusCode).toBe(200);
		expect(grpcState.calls).toHaveLength(1); // NIM attempted first
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toContain('api.openai.com/v1/audio/speech');
		expect(calls[0].body).toMatchObject({ voice: 'shimmer', model: 'gpt-4o-mini-tts', response_format: 'mp3' });
		expect(res.getHeader('content-type')).toBe('audio/mpeg');
		expect(res.getHeader('x-tts-model')).toBe('gpt-4o-mini-tts');
		expect(res.getHeader('x-tts-voice')).toBe('shimmer');
		expect(res.getHeader('x-tts-format')).toBe('mp3');
		expect(res.body().equals(OPENAI_MP3_BYTES)).toBe(true);
	});

	it('goes straight to OpenAI when NVIDIA_API_KEY is absent', async () => {
		delete process.env.NVIDIA_API_KEY;
		const calls = stubOpenAi();
		const res = await callSpeak({ text: 'No free lane today' });

		expect(res.statusCode).toBe(200);
		expect(grpcState.calls).toHaveLength(0);
		expect(calls).toHaveLength(1);
		expect(res.getHeader('x-tts-model')).toBe('gpt-4o-mini-tts');
	});

	it('returns 503 not_configured only when NO lane is configured', async () => {
		delete process.env.NVIDIA_API_KEY;
		delete process.env.OPENAI_API_KEY;
		const res = await callSpeak({ text: 'anyone there?' });

		expect(res.statusCode).toBe(503);
		expect(res.json().error).toBe('not_configured');
		expect(grpcState.calls).toHaveLength(0);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it('returns a clean 502 with both lane errors, in attempt order, when everything fails', async () => {
		grpcFailure(16, 'bad key');
		stubOpenAi(429);
		const res = await callSpeak({ text: 'Total outage' });

		expect(res.statusCode).toBe(502);
		const detail = res.json().error_description;
		const iNvidia = detail.indexOf('nvidia:');
		const iOpenai = detail.indexOf('openai:');
		expect(iNvidia).toBeGreaterThanOrEqual(0);
		expect(iOpenai).toBeGreaterThan(iNvidia); // nvidia attempted first
		expect(detail).toContain('invalid_key');
		expect(detail).toContain('429');
	});

	it('serves pcm requests raw (no WAV header) with audio/pcm content-type', async () => {
		grpcSuccess();
		const res = await callSpeak({ text: 'raw please', format: 'pcm' });

		expect(res.statusCode).toBe(200);
		expect(res.getHeader('content-type')).toBe('audio/pcm');
		expect(res.getHeader('x-tts-format')).toBe('pcm');
		expect(res.body().equals(PCM_BYTES)).toBe(true);
	});

	it('serves opus requests as WAV on the NIM lane (NVCF emits containerless opus), truthfully labeled', async () => {
		grpcSuccess();
		const res = await callSpeak({ text: 'opus request', format: 'opus' });

		expect(res.statusCode).toBe(200);
		expect(grpcState.calls[0].request.encoding).toBe('LINEAR_PCM');
		expect(res.getHeader('content-type')).toBe('audio/wav');
		expect(res.getHeader('x-tts-format')).toBe('wav');
		expect(res.body().subarray(0, 4).toString('ascii')).toBe('RIFF');
	});

	it('keeps request validation: empty text is a 400 before any lane is tried', async () => {
		const res = await callSpeak({ text: '   ' });

		expect(res.statusCode).toBe(400);
		expect(grpcState.calls).toHaveLength(0);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});
});

describe('voice + language mapping (api/_lib/tts-nvidia.js)', () => {
	it('maps every platform voice name to a live-verified en-US Magpie persona', async () => {
		const { VOICE_TO_MAGPIE, resolveMagpieVoice } = await import('../../api/_lib/tts-nvidia.js');
		const platformVoices = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];
		// Personas confirmed against the live GetRivaSynthesisConfig subvoice list.
		const livePersonas = new Set(['Mia', 'Jason', 'Aria', 'Leo', 'Sofia', 'Ray']);
		for (const v of platformVoices) {
			expect(livePersonas.has(VOICE_TO_MAGPIE[v]), `${v} maps to a live persona`).toBe(true);
			expect(resolveMagpieVoice(v)).toBe(`Magpie-Multilingual.EN-US.${VOICE_TO_MAGPIE[v]}`);
		}
	});

	it('upper-cases the language tag in the subvoice id (server rejects lowercase)', async () => {
		const { resolveMagpieVoice } = await import('../../api/_lib/tts-nvidia.js');
		expect(resolveMagpieVoice('nova', 'ja-JP')).toBe('Magpie-Multilingual.JA-JP.Aria');
		expect(resolveMagpieVoice('nova', 'ja')).toBe('Magpie-Multilingual.JA-JP.Aria');
	});

	it('falls back to en-US for unknown languages and passes raw Magpie ids through', async () => {
		const { resolveMagpieVoice, resolveMagpieLanguage } = await import('../../api/_lib/tts-nvidia.js');
		expect(resolveMagpieLanguage('en-GB')).toBe('en-US');
		expect(resolveMagpieLanguage('xx-YY')).toBe('en-US');
		expect(resolveMagpieVoice('Magpie-Multilingual.ES-US.Diego.Happy')).toBe('Magpie-Multilingual.ES-US.Diego.Happy');
	});

	it('unknown voice names get the default persona instead of failing', async () => {
		const { resolveMagpieVoice } = await import('../../api/_lib/tts-nvidia.js');
		expect(resolveMagpieVoice('definitely-not-a-voice')).toBe('Magpie-Multilingual.EN-US.Sofia');
	});
});

describe('MCP twin (packages/avatar-agent-mcp speak tool) — same chain', () => {
	// config.js binds env at import time, so reset modules and re-import per test.
	async function freshTool() {
		vi.resetModules();
		return (await import('../../packages/avatar-agent-mcp/src/tools/speak.js')).def;
	}

	it('NIM serves: provider nvidia, wav data URL, OpenAI never called', async () => {
		grpcSuccess();
		const tool = await freshTool();
		const out = await tool.handler({ text: 'MCP says hi', voice: 'onyx' });

		expect(out.ok).toBe(true);
		expect(out.provider).toBe('nvidia');
		expect(out.model).toBe('magpie-tts-multilingual');
		expect(out.voice).toBe('Magpie-Multilingual.EN-US.Ray');
		expect(out.format).toBe('wav');
		expect(out.mime).toBe('audio/wav');
		expect(out.audio.startsWith('data:audio/wav;base64,')).toBe(true);
		const decoded = Buffer.from(out.audio.split(',')[1], 'base64');
		expect(decoded.subarray(0, 4).toString('ascii')).toBe('RIFF');
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it('NIM failure falls over to OpenAI with truthful provider fields', async () => {
		grpcFailure(14, 'upstream unavailable');
		const calls = stubOpenAi();
		const tool = await freshTool();
		const out = await tool.handler({ text: 'MCP backstop', voice: 'nova', format: 'mp3' });

		expect(out.ok).toBe(true);
		expect(out.provider).toBe('openai');
		expect(out.model).toBe('gpt-4o-mini-tts');
		expect(out.voice).toBe('nova');
		expect(out.mime).toBe('audio/mpeg');
		expect(calls).toHaveLength(1);
	});

	it('both lanes failing returns tts_failed with the attempt order; no key at all is not_configured', async () => {
		grpcFailure(16, 'bad key');
		stubOpenAi(401);
		let tool = await freshTool();
		const failed = await tool.handler({ text: 'MCP outage' });
		expect(failed.ok).toBe(false);
		expect(failed.error).toBe('tts_failed');
		expect(failed.message.indexOf('nvidia:')).toBeGreaterThanOrEqual(0);
		expect(failed.message.indexOf('openai:')).toBeGreaterThan(failed.message.indexOf('nvidia:'));

		delete process.env.NVIDIA_API_KEY;
		delete process.env.OPENAI_API_KEY;
		tool = await freshTool();
		const unconfigured = await tool.handler({ text: 'MCP unconfigured' });
		expect(unconfigured.ok).toBe(false);
		expect(unconfigured.error).toBe('not_configured');
	});
});
