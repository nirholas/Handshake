// Tests for the productized speech package: POST /api/v1/ai/tts + /api/v1/ai/asr.
//
// Contract under test:
//   • Free tier: a per-IP DAILY quota (10 TTS / 5 ASR) served on the free NVIDIA
//     NIM lanes; above it the request falls through to the x402 402 challenge.
//   • Env gating is honest: a missing NVIDIA key answers 503 not_configured
//     naming the exact var — never a 500, never a fake response.
//   • Input is validated at the boundary (bad body 400, oversize 413, bad
//     Content-Type 415) BEFORE any lane is tried or any payment is prompted.
//   • The catalog (api/v1/_catalog.js) lists both endpoints.
//
// The NIM boundary (the @grpc/grpc-js transport) is fixtured with captured Riva
// response shapes — none of OUR code (ai-speech, asr-nvidia, tts-nvidia, the
// routes) is mocked.

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { Readable } from 'node:stream';

// ── NIM transport (gRPC) fixture ──────────────────────────────────────────────
const grpcState = vi.hoisted(() => ({
	synthesize: null, // (req, md, opts, cb)
	recognize: null, // (req, md, opts, cb)
	synthCalls: [],
	recogCalls: [],
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
		synthesize(request, metadata, opts, cb) {
			grpcState.synthCalls.push({ request, metadata });
			grpcState.synthesize(request, metadata, opts, cb);
		}
	}
	class RivaSpeechRecognition {
		recognize(request, metadata, opts, cb) {
			grpcState.recogCalls.push({ request, metadata });
			grpcState.recognize(request, metadata, opts, cb);
		}
	}
	const grpc = {
		Metadata,
		credentials: { createSsl: () => ({ ssl: true }) },
		loadPackageDefinition: () => ({
			nvidia: { riva: { tts: { RivaSpeechSynthesis }, asr: { RivaSpeechRecognition } } },
		}),
	};
	return { default: grpc };
});

vi.mock('@grpc/proto-loader', () => ({
	default: { fromJSON: () => ({ mockPackageDefinition: true }) },
}));

// Captured Riva shapes.
const PCM_BYTES = Buffer.alloc(2000, 0x42); // clearly not RIFF
function grpcTtsSuccess() {
	grpcState.synthesize = (_r, _m, _o, cb) => cb(null, { audio: PCM_BYTES });
}
function grpcAsrSuccess(transcript = 'schedule the deploy for friday') {
	grpcState.recognize = (_r, _m, _o, cb) =>
		cb(null, {
			results: [
				{
					alternatives: [{ transcript, confidence: 0.94, language_code: ['en-US'] }],
					audio_processed: 2.1,
				},
			],
		});
}

// ── env ───────────────────────────────────────────────────────────────────────
const ENV_KEYS = [
	'NVIDIA_API_KEY',
	'NVIDIA_ASR_FUNCTION_ID',
	'X402_PAY_TO_SOLANA',
	'X402_ASSET_MINT_SOLANA',
	'X402_FEE_PAYER_SOLANA',
];
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

// ── request/response harness ──────────────────────────────────────────────────
function makeReq({ method = 'POST', url = '/api/v1/ai/tts', headers = {}, body }) {
	const buf = body == null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(body);
	const req = Readable.from(buf.length ? [buf] : []);
	req.method = method;
	req.url = url;
	req.headers = { 'content-length': String(buf.length), ...headers };
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

let ttsHandler;
let asrHandler;
async function callTts(req) {
	const res = makeRes();
	await ttsHandler(req, res);
	return res;
}
async function callAsr(req) {
	const res = makeRes();
	await asrHandler(req, res);
	return res;
}

function jsonReq(url, obj, extraHeaders = {}) {
	return makeReq({
		method: 'POST',
		url,
		headers: { 'content-type': 'application/json', ...extraHeaders },
		body: JSON.stringify(obj),
	});
}

let ipCounter = 0;
// Production sits behind Google's load balancer, which appends `<client>, <lb>` to
// X-Forwarded-For — so that is what a distinct caller looks like on the wire. (The
// old `x-vercel-forwarded-for` is caller-settable on GCP and clientIp ignores it.)
const LB_HOP = '35.191.0.1';
function freshIp() {
	return { 'x-forwarded-for': `10.20.30.${++ipCounter}, ${LB_HOP}` };
}

beforeAll(async () => {
	// Warm the cold import of the x402-heavy route modules once (see vitest.config.js).
	ttsHandler = (await import('../../api/v1/ai/tts.js')).default;
	asrHandler = (await import('../../api/v1/ai/asr.js')).default;
}, 240_000);

beforeEach(() => {
	grpcState.synthesize = () => {
		throw new Error('grpc synthesize called without a test stub');
	};
	grpcState.recognize = () => {
		throw new Error('grpc recognize called without a test stub');
	};
	grpcState.synthCalls.length = 0;
	grpcState.recogCalls.length = 0;
	process.env.NVIDIA_API_KEY = 'nvapi-test-key';
	process.env.NVIDIA_ASR_FUNCTION_ID = 'test-asr-fn-id';
	// Minimal x402 config so the 402 fall-through can build a Solana accept.
	process.env.X402_PAY_TO_SOLANA = 'THREEsynthetic1111111111111111111111111PayTo';
	process.env.X402_ASSET_MINT_SOLANA = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
	process.env.X402_FEE_PAYER_SOLANA = 'THREEsynthetic1111111111111111111111111PayTo';
});

afterEach(() => {
	for (const k of ENV_KEYS) {
		if (ORIGINAL_ENV[k] === undefined) delete process.env[k];
		else process.env[k] = ORIGINAL_ENV[k];
	}
});

// ── TTS ─────────────────────────────────────────────────────────────────────
describe('POST /api/v1/ai/tts', () => {
	it('GET ?voices=1 lists voices free (no lane call)', async () => {
		const res = await callTts(makeReq({ method: 'GET', url: '/api/v1/ai/tts?voices=1', headers: freshIp() }));
		expect(res.statusCode).toBe(200);
		const data = res.json().data;
		expect(Array.isArray(data.voices)).toBe(true);
		expect(data.voices.length).toBeGreaterThan(0);
		expect(data.default).toBe('nova');
		expect(grpcState.synthCalls).toHaveLength(0);
	});

	it('serves the free tier on the NIM lane and returns base64 WAV', async () => {
		grpcTtsSuccess();
		const res = await callTts(jsonReq('/api/v1/ai/tts', { text: 'Deploy finished', voice: 'nova' }, freshIp()));
		expect(res.statusCode).toBe(200);
		const data = res.json().data;
		expect(data.tier).toBe('free');
		expect(data.content_type).toBe('audio/wav');
		expect(data.characters).toBe('Deploy finished'.length);
		const audio = Buffer.from(data.audio, 'base64');
		expect(audio.subarray(0, 4).toString('ascii')).toBe('RIFF');
		expect(audio.length).toBe(44 + PCM_BYTES.length);
		expect(grpcState.synthCalls).toHaveLength(1);
	});

	it('rejects empty text with 400 before any lane call', async () => {
		const res = await callTts(jsonReq('/api/v1/ai/tts', { text: '   ' }, freshIp()));
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toBe('bad_request');
		expect(grpcState.synthCalls).toHaveLength(0);
	});

	it('rejects invalid JSON with 400', async () => {
		const res = await callTts(
			makeReq({ url: '/api/v1/ai/tts', headers: { 'content-type': 'application/json', ...freshIp() }, body: '{not json' }),
		);
		expect(res.statusCode).toBe(400);
		expect(grpcState.synthCalls).toHaveLength(0);
	});

	it('rejects text over the paid ceiling with 400 text_too_long', async () => {
		const res = await callTts(jsonReq('/api/v1/ai/tts', { text: 'a'.repeat(5000) }, freshIp()));
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toBe('text_too_long');
	});

	it('text over the free char cap (≤4096) falls through to the 402 challenge', async () => {
		const res = await callTts(jsonReq('/api/v1/ai/tts', { text: 'b'.repeat(600) }, freshIp()));
		expect(res.statusCode).toBe(402);
		expect(grpcState.synthCalls).toHaveLength(0);
	});

	it('falls through to 402 once the daily free quota is exhausted', async () => {
		grpcTtsSuccess();
		const ip = { 'x-forwarded-for': `10.99.99.10, ${LB_HOP}` };
		for (let i = 0; i < 10; i++) {
			const ok = await callTts(jsonReq('/api/v1/ai/tts', { text: `call ${i}` }, ip));
			expect(ok.statusCode).toBe(200);
		}
		const over = await callTts(jsonReq('/api/v1/ai/tts', { text: 'one too many' }, ip));
		expect(over.statusCode).toBe(402);
	});

	it('returns 503 not_configured (naming NVIDIA_API_KEY) when the lane is absent', async () => {
		delete process.env.NVIDIA_API_KEY;
		const res = await callTts(jsonReq('/api/v1/ai/tts', { text: 'anyone there?' }, freshIp()));
		expect(res.statusCode).toBe(503);
		expect(res.json().error).toBe('not_configured');
		expect(res.json().error_description).toContain('NVIDIA_API_KEY');
		expect(grpcState.synthCalls).toHaveLength(0);
	});
});

// ── ASR ─────────────────────────────────────────────────────────────────────
describe('POST /api/v1/ai/asr', () => {
	// Build a tiny valid WAV from raw PCM so parseWav strips it correctly.
	async function wavClip(pcmBytes = 3200, sampleRate = 16000) {
		const { pcmToWav } = await import('../../api/_lib/tts-nvidia.js');
		return pcmToWav(Buffer.alloc(pcmBytes, 0x01), { sampleRateHz: sampleRate });
	}

	it('GET returns the capability probe', async () => {
		const res = await callAsr(makeReq({ method: 'GET', url: '/api/v1/ai/asr', headers: freshIp() }));
		expect(res.statusCode).toBe(200);
		const data = res.json().data;
		expect(data.configured).toBe(true);
		expect(data.encodings).toEqual(expect.arrayContaining(['wav', 'pcm', 'flac', 'ogg']));
	});

	it('transcribes a base64 WAV on the free tier', async () => {
		grpcAsrSuccess('hello world');
		const wav = await wavClip();
		const res = await callAsr(jsonReq('/api/v1/ai/asr', { audio: wav.toString('base64'), format: 'wav' }, freshIp()));
		expect(res.statusCode).toBe(200);
		const data = res.json().data;
		expect(data.tier).toBe('free');
		expect(data.text).toBe('hello world');
		expect(data.confidence).toBeCloseTo(0.94, 5);
		expect(data.duration).toBeCloseTo(2.1, 5);
		expect(grpcState.recogCalls).toHaveLength(1);
	});

	it('rejects a JSON body with no audio (400)', async () => {
		const res = await callAsr(jsonReq('/api/v1/ai/asr', { language: 'en-US' }, freshIp()));
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toBe('bad_request');
		expect(grpcState.recogCalls).toHaveLength(0);
	});

	it('rejects an unsupported audio Content-Type (415)', async () => {
		const res = await callAsr(
			makeReq({ url: '/api/v1/ai/asr', headers: { 'content-type': 'audio/webm', ...freshIp() }, body: Buffer.alloc(500, 1) }),
		);
		expect(res.statusCode).toBe(415);
		expect(res.json().error).toBe('unsupported_media_type');
		expect(grpcState.recogCalls).toHaveLength(0);
	});

	it('rejects oversize audio with 413', async () => {
		const big = Buffer.alloc(8 * 1024 * 1024 + 1024, 0x00); // > 8 MiB decoded cap
		const res = await callAsr(
			makeReq({ url: '/api/v1/ai/asr', headers: { 'content-type': 'audio/wav', ...freshIp() }, body: big }),
		);
		expect(res.statusCode).toBe(413);
		expect(res.json().error).toBe('payload_too_large');
		expect(grpcState.recogCalls).toHaveLength(0);
	});

	it('audio longer than the free 60s cap falls through to the 402 challenge', async () => {
		// 16 kHz mono s16 → 60s = 1,920,000 PCM bytes; make it clearly longer.
		const longWav = await wavClip(2_100_000, 16000);
		const res = await callAsr(jsonReq('/api/v1/ai/asr', { audio: longWav.toString('base64'), format: 'wav' }, freshIp()));
		expect(res.statusCode).toBe(402);
		expect(grpcState.recogCalls).toHaveLength(0);
	});

	it('falls through to 402 once the daily free quota is exhausted', async () => {
		grpcAsrSuccess('ok');
		const wav = await wavClip();
		const ip = { 'x-forwarded-for': `10.99.99.20, ${LB_HOP}` };
		const b64 = wav.toString('base64');
		for (let i = 0; i < 5; i++) {
			const ok = await callAsr(jsonReq('/api/v1/ai/asr', { audio: b64, format: 'wav' }, ip));
			expect(ok.statusCode).toBe(200);
		}
		const over = await callAsr(jsonReq('/api/v1/ai/asr', { audio: b64, format: 'wav' }, ip));
		expect(over.statusCode).toBe(402);
	});

	it('returns 503 not_configured (naming the ASR env) when the lane is absent', async () => {
		delete process.env.NVIDIA_ASR_FUNCTION_ID;
		const wav = await wavClip();
		const res = await callAsr(jsonReq('/api/v1/ai/asr', { audio: wav.toString('base64'), format: 'wav' }, freshIp()));
		expect(res.statusCode).toBe(503);
		expect(res.json().error).toBe('not_configured');
		expect(res.json().error_description).toContain('NVIDIA_ASR_FUNCTION_ID');
		expect(grpcState.recogCalls).toHaveLength(0);
	});
});

// ── Catalog ───────────────────────────────────────────────────────────────────
describe('catalog registration', () => {
	it('lists both speech endpoints in api/v1/_catalog.js', async () => {
		const { CATALOG } = await import('../../api/v1/_catalog.js');
		const tts = CATALOG.find((e) => e.id === 'v1.ai.tts');
		const asr = CATALOG.find((e) => e.id === 'v1.ai.asr');
		expect(tts).toBeTruthy();
		expect(tts.path).toBe('/api/v1/ai/tts');
		expect(tts.method).toBe('POST');
		expect(asr).toBeTruthy();
		expect(asr.path).toBe('/api/v1/ai/asr');
		expect(asr.method).toBe('POST');
	});
});
