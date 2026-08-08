// Unit tests for the multi-provider voice registry (api/_lib/voice-providers.js)
// and the Gemini TTS lane (api/_lib/tts-gemini.js).
//
// fetch and the GCP token minter are mocked so these run with no network and no
// credentials. They pin the contract /api/tts/catalog and /api/tts/synthesize
// depend on: which lanes exist, which are free, what each lane's catalog looks
// like, and that a lane's failure is tagged with a code the router can map to
// an HTTP status.

import { vi, describe, it, expect, beforeEach, afterAll } from 'vitest';

const { getGcpAccessToken } = vi.hoisted(() => ({ getGcpAccessToken: vi.fn() }));
vi.mock('../api/_lib/gcp-auth.js', () => ({ getGcpAccessToken }));

import {
	VOICE_PROVIDERS,
	PROVIDER_IDS,
	getProvider,
	providerAvailability,
	providerModels,
	providerDefaultVoice,
	usdForSynthesis,
	creditActionFor,
	listProviderVoices,
	synthesizeVoice,
} from '../api/_lib/voice-providers.js';
import {
	GEMINI_VOICES,
	GEMINI_DEFAULT_VOICE,
	isGeminiVoice,
	synthesizeGeminiTts,
	geminiTtsConfigured,
} from '../api/_lib/tts-gemini.js';
import { TTS_ELEVEN_USD_PER_1K, TTS_OPENAI_USD_PER_1K } from '../api/_lib/pricing/catalog.js';

const realFetch = global.fetch;
const savedEnv = { ...process.env };

afterAll(() => {
	global.fetch = realFetch;
	process.env = savedEnv;
});

beforeEach(() => {
	global.fetch = vi.fn();
	getGcpAccessToken.mockReset();
	for (const key of [
		'GOOGLE_CLOUD_PROJECT',
		'GOOGLE_CLOUD_LOCATION_TTS',
		'GEMINI_API_KEY',
		'GOOGLE_API_KEY',
		'OPENAI_API_KEY',
		'NVIDIA_API_KEY',
		'ELEVENLABS_API_KEY',
	]) {
		delete process.env[key];
	}
});

/** A generateContent response carrying `bytes` of PCM. */
function geminiAudioResponse(bytes = 32) {
	return {
		ok: true,
		status: 200,
		json: async () => ({
			candidates: [
				{ content: { parts: [{ inlineData: { data: Buffer.alloc(bytes, 7).toString('base64') } }] } },
			],
		}),
	};
}

describe('registry shape', () => {
	it('exposes every lane the platform ships', () => {
		expect(PROVIDER_IDS).toEqual(['edge', 'gemini', 'nvidia', 'openai', 'elevenlabs']);
	});

	it('gives every lane the fields a picker renders', () => {
		for (const p of VOICE_PROVIDERS) {
			expect(typeof p.label).toBe('string');
			expect(typeof p.tagline).toBe('string');
			expect(['free', 'gcp', 'credits']).toContain(p.billing);
			expect(typeof p.anonymous).toBe('boolean');
		}
	});

	it('returns null for an unknown provider', () => {
		expect(getProvider('nope')).toBeNull();
	});
});

describe('availability', () => {
	it('keeps the keyless Edge lane on with no env at all', () => {
		expect(providerAvailability().edge).toBe(true);
	});

	it('gates the keyed lanes on their credentials', () => {
		expect(providerAvailability()).toMatchObject({
			gemini: false,
			nvidia: false,
			openai: false,
			elevenlabs: false,
		});
		process.env.OPENAI_API_KEY = 'sk-test';
		process.env.NVIDIA_API_KEY = 'nvapi-test';
		process.env.GOOGLE_CLOUD_PROJECT = 'proj';
		process.env.ELEVENLABS_API_KEY = 'sk_test';
		expect(providerAvailability()).toMatchObject({
			gemini: true,
			nvidia: true,
			openai: true,
			elevenlabs: true,
		});
	});

	it('counts a user-supplied ElevenLabs key as availability', () => {
		expect(providerAvailability({ elevenUserKey: true }).elevenlabs).toBe(true);
	});
});

describe('billing', () => {
	it('never charges for a free or GCP-credit lane', () => {
		for (const provider of ['edge', 'gemini', 'nvidia']) {
			expect(usdForSynthesis({ provider, chars: 100_000 })).toBe(0);
			expect(creditActionFor(provider)).toBeNull();
		}
	});

	it('meters the vendor-billed lanes per 1k characters', () => {
		expect(usdForSynthesis({ provider: 'elevenlabs', chars: 1000 })).toBeCloseTo(
			TTS_ELEVEN_USD_PER_1K,
			6,
		);
		expect(usdForSynthesis({ provider: 'openai', chars: 1000 })).toBeCloseTo(
			TTS_OPENAI_USD_PER_1K,
			6,
		);
		expect(creditActionFor('elevenlabs')).toBe('tts.eleven');
		expect(creditActionFor('openai')).toBe('tts.openai');
	});

	it('charges a floor rather than zero for a very short clip', () => {
		expect(usdForSynthesis({ provider: 'openai', chars: 1 })).toBeGreaterThan(0);
	});

	it('bypasses the charge entirely for BYOK', () => {
		expect(usdForSynthesis({ provider: 'elevenlabs', chars: 5000, byok: true })).toBe(0);
	});
});

describe('catalogs', () => {
	it('lists all 30 Gemini prebuilt voices with a character each', async () => {
		const voices = await listProviderVoices('gemini');
		expect(voices).toHaveLength(30);
		expect(voices.every((v) => v.provider === 'gemini' && v.labels.description)).toBe(true);
		expect(isGeminiVoice(GEMINI_DEFAULT_VOICE)).toBe(true);
		expect(isGeminiVoice('NotAVoice')).toBe(false);
		expect(GEMINI_VOICES).toHaveLength(30);
	});

	it('lists the OpenAI voice set', async () => {
		const voices = await listProviderVoices('openai');
		expect(voices.length).toBeGreaterThan(0);
		expect(voices.map((v) => v.id)).toContain('nova');
	});

	it('lists only the NVIDIA voices Magpie actually maps', async () => {
		const voices = await listProviderVoices('nvidia');
		expect(voices.every((v) => v.labels.persona)).toBe(true);
	});

	it('returns an empty ElevenLabs catalog rather than throwing with no key', async () => {
		expect(await listProviderVoices('elevenlabs')).toEqual([]);
	});

	it('returns an empty list for an unknown provider', async () => {
		expect(await listProviderVoices('nope')).toEqual([]);
	});

	it('reports the models and default voice a lane offers', () => {
		expect(providerModels('gemini').length).toBeGreaterThan(0);
		expect(providerModels('edge')).toEqual([]);
		expect(providerDefaultVoice('edge')).toBe('en-US-AriaNeural');
		expect(providerDefaultVoice('gemini')).toBe(GEMINI_DEFAULT_VOICE);
	});
});

describe('gemini synthesis', () => {
	it('is unconfigured without a project or a key', () => {
		expect(geminiTtsConfigured()).toBe(false);
	});

	it('accepts GOOGLE_API_KEY as well as GEMINI_API_KEY', async () => {
		process.env.GOOGLE_API_KEY = 'gk-test';
		expect(geminiTtsConfigured()).toBe(true);
		global.fetch.mockResolvedValue(geminiAudioResponse());
		const out = await synthesizeGeminiTts({ text: 'hello' });
		expect(out.lane).toBe('api-key');
		expect(out.contentType).toBe('audio/wav');
		// 44-byte RIFF header wrapped around the PCM.
		expect(out.audio.subarray(0, 4).toString()).toBe('RIFF');
	});

	it('prefixes the direction onto the prompt', async () => {
		process.env.GEMINI_API_KEY = 'gk-test';
		global.fetch.mockResolvedValue(geminiAudioResponse());
		await synthesizeGeminiTts({ text: 'hello', direction: 'slowly and low' });
		const body = JSON.parse(global.fetch.mock.calls[0][1].body);
		expect(body.contents[0].parts[0].text).toBe('Say the following, slowly and low: hello');
		expect(body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe(
			GEMINI_DEFAULT_VOICE,
		);
	});

	it('falls back from Vertex to the API key rung', async () => {
		process.env.GOOGLE_CLOUD_PROJECT = 'proj';
		process.env.GEMINI_API_KEY = 'gk-test';
		getGcpAccessToken.mockResolvedValue('ya29.token');
		global.fetch
			.mockResolvedValueOnce({ ok: false, status: 404, text: async () => 'not found' })
			.mockResolvedValueOnce({ ok: false, status: 404, text: async () => 'not found' })
			.mockResolvedValueOnce(geminiAudioResponse());
		const out = await synthesizeGeminiTts({ text: 'hello' });
		// Both Vertex regions 404 before the key rung serves.
		expect(out.lane).toBe('api-key');
		expect(global.fetch).toHaveBeenCalledTimes(3);
	});

	it('stops trying regions once auth is the problem', async () => {
		process.env.GOOGLE_CLOUD_PROJECT = 'proj';
		getGcpAccessToken.mockResolvedValue('ya29.token');
		global.fetch.mockResolvedValue({ ok: false, status: 403, text: async () => 'denied' });
		await expect(synthesizeGeminiTts({ text: 'hello' })).rejects.toThrow(/Gemini TTS failed/);
		expect(global.fetch).toHaveBeenCalledTimes(1);
	});

	it('keeps a safety block distinct from a provider error', async () => {
		process.env.GEMINI_API_KEY = 'gk-test';
		global.fetch.mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ promptFeedback: { blockReason: 'SAFETY' }, candidates: [] }),
		});
		await expect(synthesizeGeminiTts({ text: 'hello' })).rejects.toMatchObject({
			code: 'content_blocked',
		});
	});

	it('retries without the direction when the model answers instead of speaking', async () => {
		process.env.GEMINI_API_KEY = 'gk-test';
		global.fetch
			.mockResolvedValueOnce({
				ok: false,
				status: 400,
				text: async () =>
					'{"error":{"message":"Model tried to generate text, but it should only be used for TTS."}}',
			})
			.mockResolvedValueOnce(geminiAudioResponse());
		const out = await synthesizeGeminiTts({ text: 'hello', direction: 'brightly' });
		expect(out.lane).toBe('api-key');
		// The retry drops the style framing so the transcript is unambiguous.
		expect(JSON.parse(global.fetch.mock.calls[1][1].body).contents[0].parts[0].text).toBe('hello');
	});

	it('does not retry the same prompt when there was no direction to drop', async () => {
		process.env.GEMINI_API_KEY = 'gk-test';
		global.fetch.mockResolvedValue({
			ok: false,
			status: 400,
			text: async () => 'Model tried to generate text, but it should only be used for TTS.',
		});
		await expect(synthesizeGeminiTts({ text: 'hello' })).rejects.toMatchObject({
			code: 'answered_instead_of_spoke',
		});
		expect(global.fetch).toHaveBeenCalledTimes(1);
	});

	it('keeps a quota failure distinct so the caller can answer 429', async () => {
		process.env.GEMINI_API_KEY = 'gk-test';
		global.fetch.mockResolvedValue({ ok: false, status: 429, text: async () => 'quota' });
		await expect(synthesizeGeminiTts({ text: 'hello' })).rejects.toMatchObject({
			code: 'rate_limited',
		});
	});
});

describe('router', () => {
	it('rejects an unknown provider with invalid_argument', async () => {
		await expect(synthesizeVoice({ provider: 'nope', text: 'hi' })).rejects.toMatchObject({
			code: 'invalid_argument',
		});
	});

	it('rejects empty text before touching a lane', async () => {
		await expect(synthesizeVoice({ provider: 'edge', text: '   ' })).rejects.toMatchObject({
			code: 'invalid_argument',
		});
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it('requires an ElevenLabs key', async () => {
		await expect(
			synthesizeVoice({ provider: 'elevenlabs', text: 'hi', voiceId: 'v1' }),
		).rejects.toMatchObject({ code: 'not_configured' });
	});

	it('requires a voiceId for ElevenLabs', async () => {
		await expect(
			synthesizeVoice({ provider: 'elevenlabs', text: 'hi', elevenKey: 'sk_x' }),
		).rejects.toMatchObject({ code: 'invalid_argument' });
	});

	it('sends only a supported OpenAI direction and clamps speed', async () => {
		process.env.OPENAI_API_KEY = 'sk-test';
		global.fetch.mockResolvedValue({
			ok: true,
			status: 200,
			arrayBuffer: async () => new ArrayBuffer(16),
		});
		await synthesizeVoice({
			provider: 'openai',
			text: 'hi',
			voiceId: 'nova',
			model: 'tts-1',
			direction: 'whisper it',
			speed: 9,
		});
		const body = JSON.parse(global.fetch.mock.calls[0][1].body);
		expect(body.instructions).toBeUndefined(); // tts-1 rejects instructions
		expect(body.speed).toBe(2);

		global.fetch.mockClear();
		await synthesizeVoice({
			provider: 'openai',
			text: 'hi',
			voiceId: 'nova',
			model: 'gpt-4o-mini-tts',
			direction: 'whisper it',
		});
		expect(JSON.parse(global.fetch.mock.calls[0][1].body).instructions).toBe('whisper it');
	});

	it('falls back to a valid OpenAI voice rather than forwarding a bad one', async () => {
		process.env.OPENAI_API_KEY = 'sk-test';
		global.fetch.mockResolvedValue({
			ok: true,
			status: 200,
			arrayBuffer: async () => new ArrayBuffer(16),
		});
		const out = await synthesizeVoice({ provider: 'openai', text: 'hi', voiceId: 'not-a-voice' });
		expect(out.voiceId).toBe('nova');
	});

	it('maps an OpenAI 429 to rate_limited', async () => {
		process.env.OPENAI_API_KEY = 'sk-test';
		global.fetch.mockResolvedValue({ ok: false, status: 429, text: async () => 'slow down' });
		await expect(
			synthesizeVoice({ provider: 'openai', text: 'hi', voiceId: 'nova' }),
		).rejects.toMatchObject({ code: 'rate_limited' });
	});

	it('maps an ElevenLabs 401 to invalid_key', async () => {
		global.fetch.mockResolvedValue({ ok: false, status: 401, text: async () => 'bad key' });
		await expect(
			synthesizeVoice({ provider: 'elevenlabs', text: 'hi', voiceId: 'v1', elevenKey: 'sk_x' }),
		).rejects.toMatchObject({ code: 'invalid_key' });
	});
});
