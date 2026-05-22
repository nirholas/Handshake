// `speak` — synthesize audio for the avatar via OpenAI's text-to-speech
// API. Returns the audio as a base64 data URL by default so clients can
// embed it directly. The avatar's voice (set when spawn_avatar runs) is
// used unless explicitly overridden.
//
// Requires OPENAI_API_KEY in the MCP server's environment.

import { z } from 'zod';

import { OPENAI_API_KEY } from '../config.js';
import { getSession, updateSession } from '../lib/avatars.js';

const VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];
const MODELS = ['tts-1', 'tts-1-hd', 'gpt-4o-mini-tts'];
const FORMATS = {
	mp3: 'audio/mpeg',
	opus: 'audio/ogg',
	aac: 'audio/aac',
	flac: 'audio/flac',
	wav: 'audio/wav',
	pcm: 'audio/pcm',
};

export const def = {
	name: 'speak',
	title: 'Avatar speaks (OpenAI TTS)',
	description:
		'Synthesize speech for an avatar session via OpenAI TTS and return a base64 audio data URL the client can play. Picks the session\'s configured voice unless overridden. Requires OPENAI_API_KEY on the MCP server.',
	inputSchema: {
		sessionId: z.string().optional()
			.describe('Avatar session id (optional — when omitted, voice falls back to the override or "nova").'),
		text: z.string().min(1).max(4096).describe('Text the avatar should say.'),
		voice: z.enum(VOICES).optional().describe('Override the session voice for this call.'),
		model: z.enum(MODELS).optional().describe('TTS model (default gpt-4o-mini-tts).'),
		format: z.enum(Object.keys(FORMATS)).optional().describe('Audio format (default mp3).'),
		speed: z.number().min(0.5).max(2.0).optional().describe('Playback speed multiplier.'),
	},
	async handler(args) {
		if (!OPENAI_API_KEY) {
			return {
				ok: false,
				error: 'not_configured',
				message: 'OPENAI_API_KEY is not set on the MCP server. Set it to enable TTS.',
			};
		}
		const { sessionId, text } = args || {};
		const session = sessionId ? getSession(sessionId) : null;
		if (sessionId && !session) {
			return { ok: false, error: 'unknown_session', message: `No session ${sessionId}.` };
		}
		const voice = args.voice || session?.voice || 'nova';
		const model = args.model || 'gpt-4o-mini-tts';
		const format = args.format || 'mp3';
		const speed = typeof args.speed === 'number' ? args.speed : 1.0;
		const mime = FORMATS[format];

		const t0 = Date.now();
		const r = await fetch('https://api.openai.com/v1/audio/speech', {
			method: 'POST',
			headers: {
				authorization: `Bearer ${OPENAI_API_KEY}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ input: text, voice, model, response_format: format, speed }),
		});
		if (!r.ok) {
			const errText = await r.text().catch(() => '');
			return {
				ok: false,
				error: 'tts_failed',
				status: r.status,
				message: errText.slice(0, 500),
			};
		}
		const buf = Buffer.from(await r.arrayBuffer());
		const base64 = buf.toString('base64');
		const dataUrl = `data:${mime};base64,${base64}`;
		if (session) updateSession(session.id, { lastSpoken: text.slice(0, 200) });
		return {
			ok: true,
			sessionId: session?.id || null,
			voice,
			model,
			format,
			mime,
			sizeBytes: buf.length,
			durationMs: Date.now() - t0,
			audio: dataUrl,
			text,
		};
	},
};
