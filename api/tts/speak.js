// POST /api/tts/speak — text-to-speech used by /demos/lipsync-tts and the
// avatar speech surfaces.
//
// Body: { text, voice?, model?, format?, language?, speed? }
// Response: complete audio in the served format (content-type is truthful).
//
// Provider policy (api/_lib/llm.js doctrine — free first, paid backstop):
//   1. NVIDIA NIM Magpie TTS (free, gRPC — api/_lib/tts-nvidia.js) leads
//      whenever NVIDIA_API_KEY is set. Note: Magpie emits raw PCM, so every
//      non-pcm request is served as WAV — the content-type and x-tts-*
//      headers always describe the bytes actually sent.
//   2. OpenAI /v1/audio/speech is the paid last-resort backstop (the prod key
//      is routinely over quota — nothing may depend on it).
// Failover happens only while zero audio bytes have been written; 503 only
// when no lane is configured at all.
//
// The browser pipes the response into a Web Audio source and feeds the
// analyser into wawa-lipsync for real-time viseme generation — decodeAudioData
// sniffs the container, so wav/ogg/mp3 all work without caller changes.

import { env } from '../_lib/env.js';
import { cors, method, readJson, error, wrap, rateLimited } from '../_lib/http.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { synthesizeNvidiaTts, nvidiaTtsConfigured } from '../_lib/tts-nvidia.js';
import { TTS_VOICE_IDS } from '../_lib/tts-voices.js';

export const maxDuration = 60;

// Validate against the shared catalog (api/_lib/tts-voices.js) so /api/tts/voices
// and this endpoint can never disagree about which voices exist.
const VOICES = new Set(TTS_VOICE_IDS);
const MODELS = new Set(['tts-1', 'tts-1-hd', 'gpt-4o-mini-tts']);
const FORMATS = {
	mp3: 'audio/mpeg',
	opus: 'audio/ogg',
	aac: 'audio/aac',
	flac: 'audio/flac',
	wav: 'audio/wav',
	pcm: 'audio/pcm',
};

// Per-attempt budget for the free lane: generous enough for 4096 chars of
// synthesis, small enough that the paid backstop still fits in maxDuration.
const NVIDIA_TIMEOUT_MS = 30_000;
// The backstop's OWN budget. It used to reuse NVIDIA_TIMEOUT_MS, which reads as
// a shared 30s but is not: lane 1 can spend all of it before lane 2 starts, and
// the platform kills the invocation while OpenAI is still allowed 30 more
// seconds. A shorter, separate budget is what makes the second lane a real
// fallback rather than one that exists only when the first fails instantly.
const OPENAI_TIMEOUT_MS = 20_000;

export default wrap(async function handler(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;

	const nvidiaLane = nvidiaTtsConfigured();
	const openaiKey = env.OPENAI_API_KEY;
	if (!nvidiaLane && !openaiKey) {
		return error(res, 503, 'not_configured', 'No TTS provider configured (set NVIDIA_API_KEY or OPENAI_API_KEY)');
	}

	// TTS is metered (free tier is credit-limited, OpenAI bills per character),
	// so budget every call. Authenticated callers get a per-user budget;
	// anonymous callers a tight per-IP one. Without this the endpoint is an
	// open, unbounded synthesis drain.
	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	const userId = session?.id ?? bearer?.userId ?? null;
	if (userId) {
		const rl = await limits.ttsSpeakUser(userId);
		if (!rl.success) return rateLimited(res, rl, 'TTS rate limit exceeded, try again later');
	} else {
		const rl = await limits.ttsSpeakIp(clientIp(req));
		if (!rl.success) return rateLimited(res, rl, 'TTS rate limit exceeded, sign in for a higher limit');
	}

	let body;
	try {
		body = await readJson(req, 50_000);
	} catch (e) {
		return error(res, e.status || 400, 'bad_request', e.message);
	}

	const text = typeof body.text === 'string' ? body.text.trim() : '';
	if (!text) return error(res, 400, 'bad_request', 'text is required');
	if (text.length > 4096) {
		return error(res, 400, 'bad_request', 'text exceeds 4096 characters');
	}

	const voice = VOICES.has(body.voice) ? body.voice : 'nova';
	const model = MODELS.has(body.model) ? body.model : 'gpt-4o-mini-tts';
	const formatKey = body.format && FORMATS[body.format] ? body.format : 'mp3';
	const language = typeof body.language === 'string' ? body.language : 'en-US';
	const speed = Math.min(Math.max(Number(body.speed) || 1.0, 0.5), 2.0);

	const laneErrors = [];

	// ── Lane 1: NVIDIA NIM Magpie (free) ─────────────────────────────────────
	// The whole clip is buffered before a single byte is written, so a failure
	// here always falls through to the paid backstop cleanly.
	if (nvidiaLane) {
		try {
			const out = await synthesizeNvidiaTts({
				text, voice, language, format: formatKey, timeoutMs: NVIDIA_TIMEOUT_MS,
			});
			res.statusCode = 200;
			res.setHeader('content-type', out.contentType);
			res.setHeader('cache-control', 'no-store');
			res.setHeader('x-tts-voice', out.voiceName);
			res.setHeader('x-tts-model', out.model);
			res.setHeader('x-tts-format', out.format);
			res.end(out.audio);
			return;
		} catch (e) {
			laneErrors.push(`nvidia: ${e?.code || 'error'} — ${e?.message || 'failed'}`);
		}
	}

	// ── Lane 2: OpenAI (paid backstop) ───────────────────────────────────────
	if (!openaiKey) {
		return error(res, 502, 'upstream_error', `All TTS lanes failed: ${laneErrors.join('; ')}`);
	}

	let upstream;
	try {
		upstream = await fetch('https://api.openai.com/v1/audio/speech', {
			method: 'POST',
			headers: {
				'authorization': `Bearer ${openaiKey}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				model, voice, input: text, response_format: formatKey, speed,
			}),
			signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
		});
	} catch (e) {
		laneErrors.push(`openai: ${e?.message || 'fetch failed'}`);
		return error(res, 502, 'upstream_unreachable', `All TTS lanes failed: ${laneErrors.join('; ')}`);
	}

	if (!upstream.ok || !upstream.body) {
		let detail = '';
		try { detail = (await upstream.text()).slice(0, 500); } catch {}
		laneErrors.push(`openai: ${upstream.status} ${detail}`);
		return error(res, 502, 'upstream_error', `All TTS lanes failed: ${laneErrors.join('; ')}`);
	}

	res.statusCode = 200;
	res.setHeader('content-type', FORMATS[formatKey]);
	res.setHeader('cache-control', 'no-store');
	res.setHeader('x-tts-voice', voice);
	res.setHeader('x-tts-model', model);
	res.setHeader('x-tts-format', formatKey);

	const reader = upstream.body.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			res.write(Buffer.from(value));
		}
	} finally {
		res.end();
	}
});
