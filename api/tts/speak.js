// POST /api/tts/speak — OpenAI TTS proxy used by /demos/lipsync-tts.
//
// Body: { text, voice?, model?, format? }
// Response: streaming audio in the requested format (default audio/mpeg).
//
// The browser pipes the response into a Web Audio source and feeds the
// analyser into wawa-lipsync for real-time viseme generation — no server-side
// audio analysis required.

import { env } from '../_lib/env.js';
import { cors, method, readJson, error, wrap } from '../_lib/http.js';

export const maxDuration = 60;

const VOICES = new Set([
	'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable',
	'nova', 'onyx', 'sage', 'shimmer', 'verse',
]);
const MODELS = new Set(['tts-1', 'tts-1-hd', 'gpt-4o-mini-tts']);
const FORMATS = {
	mp3: 'audio/mpeg',
	opus: 'audio/ogg',
	aac: 'audio/aac',
	flac: 'audio/flac',
	wav: 'audio/wav',
	pcm: 'audio/pcm',
};

export default wrap(async function handler(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;

	const key = env.OPENAI_API_KEY;
	if (!key) return error(res, 503, 'not_configured', 'OPENAI_API_KEY not set');

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
	const speed = Math.min(Math.max(Number(body.speed) || 1.0, 0.5), 2.0);

	let upstream;
	try {
		upstream = await fetch('https://api.openai.com/v1/audio/speech', {
			method: 'POST',
			headers: {
				'authorization': `Bearer ${key}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				model, voice, input: text, response_format: formatKey, speed,
			}),
		});
	} catch (e) {
		return error(res, 502, 'upstream_unreachable', e?.message || 'fetch failed');
	}

	if (!upstream.ok || !upstream.body) {
		let detail = '';
		try { detail = (await upstream.text()).slice(0, 500); } catch {}
		return error(res, 502, 'upstream_error', `OpenAI TTS ${upstream.status}: ${detail}`);
	}

	res.statusCode = 200;
	res.setHeader('content-type', FORMATS[formatKey]);
	res.setHeader('cache-control', 'no-store');
	res.setHeader('x-tts-voice', voice);
	res.setHeader('x-tts-model', model);

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
