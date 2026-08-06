// Unit tests for GET/PUT/POST/DELETE /api/agents/:id/voice.
//
// Covers the full surface without any real network calls or DB connections:
//   GET  — returns the current voice status
//   PUT  — assign library voice, settings-only update, clear voice, validation
//   POST /clone — auth, size/type guards, clone flow, DB rollback on failure
//   DELETE — clears voice, frees cloned ElevenLabs quota slot

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';

// wrap() calls these; stub them out before the module under test is imported.
vi.mock('../../api/_lib/zauth.js', () => ({ instrument: () => false, drain: async () => {} }));
vi.mock('../../api/_lib/sentry.js', () => ({ captureException: () => {} }));
vi.mock('../../api/_lib/csrf.js', () => ({ requireCsrf: vi.fn(async () => true) }));

// ── Shared mutable state ──────────────────────────────────────────────────────
const state = {
	session: null,
	agentRow: null,
	voiceRow: null,
	elevenConfigured: true,
	voices: [
		{ voice_id: 'rachel', name: 'Rachel', category: 'premade', labels: {}, preview_url: null },
	],
	cloneResult: { voiceId: 'cloned-1', requiresVerification: false },
	cloneThrows: false,
	cloneThrowErr: null,
	rateLimitOk: true,
	creditsShort: false,
	sqlQueue: [],
};

// ── Credits mock ──────────────────────────────────────────────────────────────
// The clone route charges the voice.clone action before the upstream call and
// refunds it on failure. Tests run with a funded wallet unless creditsShort.
const { chargeCreditsMock, refundCreditsMock } = vi.hoisted(() => ({
	chargeCreditsMock: vi.fn(),
	refundCreditsMock: vi.fn(async () => ({})),
}));
vi.mock('../../api/_lib/credits.js', () => ({
	chargeCreditsForAction: chargeCreditsMock,
	refundCredits: refundCreditsMock,
}));

// ── Auth mock ─────────────────────────────────────────────────────────────────
vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => state.session),
	authenticateBearer: vi.fn(async () => null),
	extractBearer: vi.fn(() => null),
}));

// ── DB mock ───────────────────────────────────────────────────────────────────
vi.mock('../../api/_lib/db.js', () => ({
	sql: vi.fn((strings, ...vals) => {
		const q = (typeof strings === 'string' ? strings : strings.join('?'))
			.toLowerCase()
			.replace(/\s+/g, ' ')
			.trim();

		if (state.sqlQueue.length) {
			const next = state.sqlQueue.shift();
			if (next instanceof Error) return Promise.reject(next);
			return Promise.resolve(next);
		}

		if (q.startsWith('select') && q.includes('from agent_identities') && q.includes('name')) {
			return Promise.resolve(state.agentRow ? [state.agentRow] : []);
		}
		if (q.startsWith('select') && q.includes('from agent_identities') && q.includes('voice')) {
			return Promise.resolve(state.voiceRow ? [state.voiceRow] : []);
		}
		if (q.startsWith('update')) {
			return Promise.resolve(state.voiceRow ? [state.voiceRow] : []);
		}
		return Promise.resolve([]);
	}),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

// ── ElevenLabs mock ───────────────────────────────────────────────────────────
vi.mock('../../api/_lib/elevenlabs.js', () => ({
	isConfigured: vi.fn(() => state.elevenConfigured),
	listVoices: vi.fn(async () => ({ voices: state.voices, cached: false })),
	createClonedVoice: vi.fn(async () => {
		if (state.cloneThrows)
			throw state.cloneThrowErr ?? Object.assign(new Error('clone failed'), { status: 502 });
		return state.cloneResult;
	}),
	deleteVoice: vi.fn(async () => {}),
	isValidModel: vi.fn((id) =>
		['eleven_flash_v2_5', 'eleven_turbo_v2_5', 'eleven_multilingual_v2'].includes(id),
	),
	normalizeVoiceSettings: vi.fn((input) => {
		if (input == null) return null;
		if (typeof input !== 'object' || Array.isArray(input))
			throw Object.assign(new Error('voice_settings must be an object'), { status: 400 });
		return {
			stability: Number(input.stability ?? 0.5),
			similarity_boost: Number(input.similarity_boost ?? 0.75),
			style: Number(input.style ?? 0.5),
			use_speaker_boost: input.use_speaker_boost !== false,
		};
	}),
}));

// ── Rate limit mock ───────────────────────────────────────────────────────────
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { voiceClone: vi.fn(async () => ({ success: state.rateLimitOk })) },
}));

// ── Module under test ─────────────────────────────────────────────────────────
const { handleVoice } = await import('../../api/agents/_id/voice.js');

// ── Test helpers ──────────────────────────────────────────────────────────────
function makeRes() {
	const res = {
		statusCode: 200,
		writableEnded: false,
		headersSent: false,
		body: null,
		_headers: {},
	};
	res.setHeader = (k, v) => {
		res._headers[k.toLowerCase()] = v;
	};
	res.getHeader = (k) => res._headers[k.toLowerCase()];
	res.end = (b) => {
		res.writableEnded = true;
		res.headersSent = true;
		if (b)
			try {
				res.body = JSON.parse(b);
			} catch {
				res.body = b;
			}
	};
	res.write = () => {};
	return res;
}

function makeReq(method, bodyObj) {
	const bodyStr = bodyObj !== undefined ? JSON.stringify(bodyObj) : '';
	const req = Readable.from(bodyStr ? [Buffer.from(bodyStr)] : []);
	req.method = method;
	req.url = '/api/agents/agent-1/voice';
	req.headers = {
		'content-type': 'application/json',
		'content-length': String(bodyStr.length),
		origin: 'https://three.ws',
	};
	return req;
}

function makeAudioReq(audioBytes, mimeType, durationSec) {
	const req = Readable.from([audioBytes]);
	req.method = 'POST';
	req.url = '/api/agents/agent-1/voice/clone';
	req.headers = {
		'content-type': mimeType,
		'content-length': String(audioBytes.length),
		origin: 'https://three.ws',
		...(durationSec != null ? { 'x-recording-duration': String(durationSec) } : {}),
	};
	return req;
}

async function invoke(method, body, opts = {}) {
	const res = makeRes();
	let req;
	if (method === 'POST' && Buffer.isBuffer(body)) {
		req = makeAudioReq(body, opts.contentType ?? 'audio/webm', opts.duration ?? null);
	} else {
		req = makeReq(method, body);
	}
	await handleVoice(req, res, 'agent-1', opts.action);
	return { status: res.statusCode, body: res.body };
}

beforeEach(() => {
	state.session = { id: 'user-1' };
	state.agentRow = { id: 'agent-1', user_id: 'user-1', name: 'Test Agent' };
	state.voiceRow = {
		voice_provider: 'browser',
		voice_id: null,
		voice_cloned_at: null,
		voice_model: null,
		voice_settings: null,
	};
	state.elevenConfigured = true;
	state.voices = [
		{ voice_id: 'rachel', name: 'Rachel', category: 'premade', labels: {}, preview_url: null },
	];
	state.cloneResult = { voiceId: 'cloned-1', requiresVerification: false };
	state.cloneThrows = false;
	state.cloneThrowErr = null;
	state.rateLimitOk = true;
	state.creditsShort = false;
	state.sqlQueue = [];
	chargeCreditsMock.mockReset().mockImplementation(async () => {
		if (state.creditsShort)
			throw Object.assign(new Error('not enough credits'), {
				status: 402,
				code: 'insufficient_credits',
				available_usd: 0,
				required_usd: 0.5,
			});
		return { chargedUsd: 0.5, ledgerId: 'led-1', replay: false };
	});
	refundCreditsMock.mockClear();
});

// ── GET ───────────────────────────────────────────────────────────────────────
describe('GET /api/agents/:id/voice', () => {
	it('returns browser status when no voice is set', async () => {
		const { status, body } = await invoke('GET');
		expect(status).toBe(200);
		expect(body.voice_provider).toBe('browser');
		expect(body.voice_id).toBeNull();
	});

	it('returns elevenlabs status when a voice is assigned', async () => {
		state.voiceRow = {
			voice_provider: 'elevenlabs',
			voice_id: 'rachel',
			voice_cloned_at: null,
			voice_model: 'eleven_flash_v2_5',
			voice_settings: null,
		};
		const { status, body } = await invoke('GET');
		expect(status).toBe(200);
		expect(body.voice_provider).toBe('elevenlabs');
		expect(body.voice_id).toBe('rachel');
		expect(body.voice_model).toBe('eleven_flash_v2_5');
	});

	it('returns 401 when unauthenticated', async () => {
		state.session = null;
		const { status } = await invoke('GET');
		expect(status).toBe(401);
	});

	it('returns 404 for a non-existent agent', async () => {
		state.agentRow = null;
		const { status } = await invoke('GET');
		expect(status).toBe(404);
	});

	it('returns 403 when the agent belongs to another user', async () => {
		state.agentRow = { id: 'agent-1', user_id: 'other-user', name: 'Theirs' };
		const { status } = await invoke('GET');
		expect(status).toBe(403);
	});
});

// ── PUT ───────────────────────────────────────────────────────────────────────
describe('PUT /api/agents/:id/voice', () => {
	it('returns 503 when ElevenLabs is not configured', async () => {
		state.elevenConfigured = false;
		const { status } = await invoke('PUT', { voice_id: 'rachel' });
		expect(status).toBe(503);
	});

	it('returns 400 with no fields to update', async () => {
		const { status, body } = await invoke('PUT', {});
		expect(status).toBe(400);
		expect(body.error).toBe('validation_error');
	});

	it('assigns a valid library voice', async () => {
		// Queue: SELECT agent → SELECT current cols → UPDATE RETURNING
		state.sqlQueue = [
			[{ id: 'agent-1', user_id: 'user-1', name: 'Test Agent' }],
			[{ voice_id: null, voice_cloned_at: null, voice_model: null, voice_settings: null }],
			[
				{
					voice_provider: 'elevenlabs',
					voice_id: 'rachel',
					voice_cloned_at: null,
					voice_model: null,
					voice_settings: null,
				},
			],
		];
		const { status, body } = await invoke('PUT', { voice_id: 'rachel' });
		expect(status).toBe(200);
		expect(body.voice_provider).toBe('elevenlabs');
		expect(body.voice_id).toBe('rachel');
	});

	it('returns 400 when voice_id is not in the library', async () => {
		state.sqlQueue = [[{ id: 'agent-1', user_id: 'user-1', name: 'Test Agent' }]];
		const { status, body } = await invoke('PUT', { voice_id: 'nonexistent-voice' });
		expect(status).toBe(400);
		expect(body.error).toBe('validation_error');
	});

	it('clears the voice when voice_id is null', async () => {
		state.sqlQueue = [
			[{ id: 'agent-1', user_id: 'user-1', name: 'Test Agent' }],
			[
				{
					voice_id: 'rachel',
					voice_cloned_at: null,
					voice_model: null,
					voice_settings: null,
				},
			],
			[
				{
					voice_provider: 'browser',
					voice_id: null,
					voice_cloned_at: null,
					voice_model: null,
					voice_settings: null,
				},
			],
		];
		const { status, body } = await invoke('PUT', { voice_id: null });
		expect(status).toBe(200);
		expect(body.voice_provider).toBe('browser');
		expect(body.voice_id).toBeNull();
	});

	it('updates model and settings without touching the voice assignment', async () => {
		state.sqlQueue = [
			[{ id: 'agent-1', user_id: 'user-1', name: 'Test Agent' }],
			[
				{
					voice_id: 'rachel',
					voice_cloned_at: null,
					voice_model: 'eleven_flash_v2_5',
					voice_settings: null,
				},
			],
			[
				{
					voice_provider: 'elevenlabs',
					voice_id: 'rachel',
					voice_cloned_at: null,
					voice_model: 'eleven_turbo_v2_5',
					voice_settings: null,
				},
			],
		];
		const { status, body } = await invoke('PUT', { voice_model: 'eleven_turbo_v2_5' });
		expect(status).toBe(200);
		expect(body.voice_model).toBe('eleven_turbo_v2_5');
		expect(body.voice_id).toBe('rachel');
	});

	it('rejects an unsupported voice_model', async () => {
		state.sqlQueue = [[{ id: 'agent-1', user_id: 'user-1', name: 'Test Agent' }]];
		const { status, body } = await invoke('PUT', { voice_model: 'gpt-4o-audio' });
		expect(status).toBe(400);
		expect(body.error).toBe('validation_error');
	});

	it('rejects invalid voice_settings (non-object)', async () => {
		state.sqlQueue = [[{ id: 'agent-1', user_id: 'user-1', name: 'Test Agent' }]];
		const { status } = await invoke('PUT', { voice_settings: 'loud' });
		expect(status).toBe(400);
	});
});

// ── POST /clone ───────────────────────────────────────────────────────────────
describe('POST /api/agents/:id/voice/clone', () => {
	const VALID_AUDIO = Buffer.alloc(60_000);

	it('returns 503 when ElevenLabs is not configured', async () => {
		state.elevenConfigured = false;
		const { status } = await invoke('POST', VALID_AUDIO, { action: 'clone' });
		expect(status).toBe(503);
	});

	it('returns 429 when the per-user rate limit is hit', async () => {
		state.rateLimitOk = false;
		const { status } = await invoke('POST', VALID_AUDIO, { action: 'clone' });
		expect(status).toBe(429);
	});

	it('returns 415 for a non-audio content-type', async () => {
		const { status } = await invoke('POST', Buffer.alloc(60_000), {
			action: 'clone',
			contentType: 'video/mp4',
		});
		expect(status).toBe(415);
	});

	it('returns 400 for audio shorter than 30s (duration header)', async () => {
		const { status, body } = await invoke('POST', VALID_AUDIO, {
			action: 'clone',
			duration: 10,
		});
		expect(status).toBe(400);
		expect(body.error).toBe('audio_too_short');
	});

	it('returns 400 for a tiny body with no duration header (size proxy)', async () => {
		const tiny = Buffer.alloc(1_000);
		const { status, body } = await invoke('POST', tiny, { action: 'clone' });
		expect(status).toBe(400);
		expect(body.error).toBe('audio_too_short');
	});

	it('clones successfully, charges voice.clone, and returns the new voice id', async () => {
		state.sqlQueue = [[{ id: 'agent-1', user_id: 'user-1', name: 'Test Agent' }], []];
		const { status, body } = await invoke('POST', VALID_AUDIO, { action: 'clone' });
		expect(status).toBe(201);
		expect(body.voice_id).toBe('cloned-1');
		expect(chargeCreditsMock).toHaveBeenCalledWith(
			expect.objectContaining({ action: 'voice.clone', user: { id: 'user-1' } }),
		);
		expect(refundCreditsMock).not.toHaveBeenCalled();
	});

	it('returns 402 with a top-up pointer when the credit balance is short', async () => {
		const { createClonedVoice } = await import('../../api/_lib/elevenlabs.js');
		vi.mocked(createClonedVoice).mockClear();
		state.creditsShort = true;
		state.sqlQueue = [[{ id: 'agent-1', user_id: 'user-1', name: 'Test Agent' }]];
		const { status, body } = await invoke('POST', VALID_AUDIO, { action: 'clone' });
		expect(status).toBe(402);
		expect(body.error).toBe('insufficient_credits');
		expect(body.top_up_url).toBe('/credits');
		expect(vi.mocked(createClonedVoice)).not.toHaveBeenCalled();
	});

	it('rolls back the clone, refunds the charge, and returns 500 when DB persist fails', async () => {
		const { deleteVoice } = await import('../../api/_lib/elevenlabs.js');
		vi.mocked(deleteVoice).mockClear();
		state.sqlQueue = [
			[{ id: 'agent-1', user_id: 'user-1', name: 'Test Agent' }],
			new Error('DB lost'),
		];
		const { status } = await invoke('POST', VALID_AUDIO, { action: 'clone' });
		expect(status).toBe(500);
		expect(vi.mocked(deleteVoice)).toHaveBeenCalledWith('cloned-1');
		expect(refundCreditsMock).toHaveBeenCalledWith(
			expect.objectContaining({ action: 'voice.clone', amountUsd: 0.5 }),
		);
	});

	it('maps a 422 upstream error to audio_too_short', async () => {
		state.cloneThrows = true;
		state.cloneThrowErr = Object.assign(new Error('audio is too short'), { status: 422 });
		state.sqlQueue = [[{ id: 'agent-1', user_id: 'user-1', name: 'Test Agent' }]];
		const { status, body } = await invoke('POST', VALID_AUDIO, { action: 'clone' });
		expect(status).toBe(400);
		expect(body.error).toBe('audio_too_short');
	});
});

// ── DELETE ────────────────────────────────────────────────────────────────────
describe('DELETE /api/agents/:id/voice', () => {
	it('clears all voice columns and returns browser status', async () => {
		state.sqlQueue = [
			[{ id: 'agent-1', user_id: 'user-1', name: 'Test Agent' }],
			[{ voice_id: null, voice_cloned_at: null }],
			[],
		];
		const { status, body } = await invoke('DELETE');
		expect(status).toBe(200);
		expect(body.voice_provider).toBe('browser');
		expect(body.voice_id).toBeNull();
	});

	it('does NOT delete a library voice (only cloned voices are freed)', async () => {
		const { deleteVoice } = await import('../../api/_lib/elevenlabs.js');
		vi.mocked(deleteVoice).mockClear();
		state.sqlQueue = [
			[{ id: 'agent-1', user_id: 'user-1', name: 'Test Agent' }],
			[{ voice_id: 'rachel', voice_cloned_at: null }],
			[],
		];
		await invoke('DELETE');
		expect(vi.mocked(deleteVoice)).not.toHaveBeenCalled();
	});

	it('calls deleteVoice for a cloned voice to free the quota slot', async () => {
		const { deleteVoice } = await import('../../api/_lib/elevenlabs.js');
		vi.mocked(deleteVoice).mockClear();
		state.sqlQueue = [
			[{ id: 'agent-1', user_id: 'user-1', name: 'Test Agent' }],
			[{ voice_id: 'my-clone', voice_cloned_at: new Date().toISOString() }],
			[],
		];
		await invoke('DELETE');
		expect(vi.mocked(deleteVoice)).toHaveBeenCalledWith('my-clone');
	});
});
