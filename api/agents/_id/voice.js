// Voice clone management for an agent.
//
// GET    /api/agents/:id/voice        — current voice status
// PUT    /api/agents/:id/voice        — assign a voice_id from the server's
//                                       ElevenLabs library (body { voice_id })
// POST   /api/agents/:id/voice/clone  — clone voice from uploaded audio
// DELETE /api/agents/:id/voice        — remove cloned voice / clear selection

import { sql } from '../../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../../_lib/auth.js';
import { cors, json, method, wrap, error, readJson } from '../../_lib/http.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { env } from '../../_lib/env.js';

const MAX_AUDIO_BYTES = 10 * 1024 * 1024; // 10 MB
const MIN_DURATION_SEC = 30;
const ELEVEN_BASE = 'https://api.elevenlabs.io/v1';

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

function readRawBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let total = 0;
		req.on('data', (chunk) => {
			total += chunk.length;
			if (total > MAX_AUDIO_BYTES) {
				reject(Object.assign(new Error('payload too large'), { status: 413 }));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => resolve(Buffer.concat(chunks)));
		req.on('error', reject);
	});
}

export const handleVoice = wrap(async (req, res, id, action) => {
	if (cors(req, res, { methods: 'GET,PUT,POST,DELETE,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'PUT', 'POST', 'DELETE'])) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	const [agent] =
		await sql`SELECT id, user_id, name FROM agent_identities WHERE id = ${id} AND deleted_at IS NULL`;
	if (!agent) return error(res, 404, 'not_found', 'agent not found');
	if (agent.user_id !== auth.userId) return error(res, 403, 'forbidden', 'not your agent');

	// ── GET — voice status ───────────────────────────────────────────────────

	if (req.method === 'GET') {
		const [row] =
			await sql`SELECT voice_provider, voice_id, voice_cloned_at FROM agent_identities WHERE id = ${id}`;
		return json(res, 200, {
			voice_provider: row.voice_provider || 'browser',
			voice_id: row.voice_id || null,
			voice_cloned_at: row.voice_cloned_at || null,
		});
	}

	// ── PUT — assign a voice from the ElevenLabs library ────────────────────
	//
	// Body: { voice_id: string | null }
	//   - null/empty: equivalent to DELETE (clear selection, free clone slot)
	//   - non-null:   must be a voice_id present in /v1/voices for this account
	//
	// If the agent currently holds a *cloned* voice and the new pick is
	// different, the old clone is freed in ElevenLabs to recover the quota
	// slot. voice_cloned_at is cleared (the new pick is a library voice,
	// not a clone owned by this user).

	if (req.method === 'PUT') {
		const apiKey = env.ELEVENLABS_API_KEY;
		if (!apiKey)
			return error(res, 503, 'not_configured', 'voice library is not configured on this server');

		let body;
		try { body = await readJson(req); }
		catch { return error(res, 400, 'validation_error', 'invalid JSON body'); }

		const nextVoiceId = body?.voice_id == null ? null : String(body.voice_id).trim() || null;

		const [current] =
			await sql`SELECT voice_id, voice_cloned_at FROM agent_identities WHERE id = ${id}`;
		const wasCloned = !!current?.voice_cloned_at;
		const oldVoiceId = current?.voice_id || null;

		// Validate library membership for non-null picks.
		if (nextVoiceId) {
			let voices;
			try {
				const resp = await fetch(`${ELEVEN_BASE}/voices`, {
					headers: { 'xi-api-key': apiKey },
				});
				if (!resp.ok) {
					console.error('[voice/put] elevenlabs voices fetch failed', resp.status);
					return error(res, 502, 'upstream_error', 'voice library is unavailable');
				}
				const data = await resp.json();
				voices = data?.voices || [];
			} catch (err) {
				console.error('[voice/put] elevenlabs fetch threw', err);
				return error(res, 502, 'upstream_error', 'voice library is unavailable');
			}
			if (!voices.some((v) => v.voice_id === nextVoiceId)) {
				return error(res, 400, 'validation_error', 'voice_id is not in the available library');
			}
		}

		// Free the prior cloned voice on ElevenLabs (best-effort) only when
		// we're actually replacing a clone with something else.
		if (wasCloned && oldVoiceId && oldVoiceId !== nextVoiceId) {
			fetch(`${ELEVEN_BASE}/voices/${encodeURIComponent(oldVoiceId)}`, {
				method: 'DELETE',
				headers: { 'xi-api-key': apiKey },
			}).catch(() => {});
		}

		if (nextVoiceId) {
			await sql`
				UPDATE agent_identities
				SET voice_provider = 'elevenlabs', voice_id = ${nextVoiceId}, voice_cloned_at = NULL
				WHERE id = ${id}
			`;
			return json(res, 200, { voice_provider: 'elevenlabs', voice_id: nextVoiceId, voice_cloned_at: null });
		}

		await sql`
			UPDATE agent_identities
			SET voice_provider = 'browser', voice_id = NULL, voice_cloned_at = NULL
			WHERE id = ${id}
		`;
		return json(res, 200, { voice_provider: 'browser', voice_id: null, voice_cloned_at: null });
	}

	// ── DELETE — remove cloned voice ─────────────────────────────────────────

	if (req.method === 'DELETE') {
		const [row] = await sql`SELECT voice_id FROM agent_identities WHERE id = ${id}`;
		if (row?.voice_id) {
			// Best-effort: free the quota slot on ElevenLabs.
			const apiKey = env.ELEVENLABS_API_KEY;
			if (apiKey) {
				fetch(`${ELEVEN_BASE}/voices/${encodeURIComponent(row.voice_id)}`, {
					method: 'DELETE',
					headers: { 'xi-api-key': apiKey },
				}).catch(() => {});
			}
		}
		await sql`
			UPDATE agent_identities
			SET voice_provider = 'browser', voice_id = NULL, voice_cloned_at = NULL
			WHERE id = ${id}
		`;
		return json(res, 200, { voice_provider: 'browser', voice_id: null });
	}

	// ── POST /clone ──────────────────────────────────────────────────────────

	if (req.method === 'POST' && action === 'clone') {
		const apiKey = env.ELEVENLABS_API_KEY;
		if (!apiKey)
			return error(res, 503, 'not_configured', 'voice cloning is not configured on this server');

		// Rate limit: 3 clones per user per day.
		const rl = await limits.voiceClone(auth.userId);
		if (!rl.success)
			return error(res, 429, 'rate_limited', 'voice clone limit reached (3 per day)');

		// Client can send recording duration in seconds so we can reject short clips
		// without decoding the audio.
		const durationSec = Number(req.headers['x-recording-duration'] || '0');
		if (durationSec > 0 && durationSec < MIN_DURATION_SEC) {
			return error(
				res,
				400,
				'audio_too_short',
				`recording must be at least ${MIN_DURATION_SEC} seconds (got ${Math.round(durationSec)}s)`,
			);
		}

		const ct = (req.headers['content-type'] || '').split(';')[0].trim();
		if (!ct.startsWith('audio/')) {
			return error(res, 415, 'unsupported_media_type', 'content-type must be audio/*');
		}

		let audioBuf;
		try {
			audioBuf = await readRawBody(req);
		} catch (err) {
			if (err.status === 413)
				return error(res, 413, 'payload_too_large', 'audio file must be under 10 MB');
			throw err;
		}

		if (audioBuf.length === 0) return error(res, 400, 'validation_error', 'audio body is empty');

		// Fallback size check when no duration header. WebM/Opus at 64 kbps:
		//   3 s ≈ 24 KB, 30 s ≈ 240 KB. 50 KB catches sub-6-second clips.
		if (!durationSec && audioBuf.length < 50_000) {
			return error(res, 400, 'audio_too_short', 'recording must be at least 30 seconds');
		}

		const url = new URL(req.url, 'http://x');
		const voiceName = url.searchParams.get('name') || agent.name || 'Agent Voice';
		const voiceDescription = url.searchParams.get('description') || '';

		// Map MIME type to a filename extension ElevenLabs can identify.
		const ext = ct.includes('webm')
			? 'audio.webm'
			: ct.includes('mpeg') || ct.includes('mp3')
				? 'audio.mp3'
				: ct.includes('wav')
					? 'audio.wav'
					: ct.includes('mp4') || ct.includes('m4a')
						? 'audio.m4a'
						: 'audio.webm';

		const form = new FormData();
		form.append('name', voiceName);
		if (voiceDescription) form.append('description', voiceDescription);
		form.append('files', new Blob([audioBuf], { type: ct }), ext);

		let elevenResp;
		try {
			elevenResp = await fetch(`${ELEVEN_BASE}/voices/add`, {
				method: 'POST',
				headers: { 'xi-api-key': apiKey },
				body: form,
			});
		} catch (err) {
			console.error('[voice/clone] elevenlabs fetch failed', err);
			return error(res, 502, 'upstream_error', 'voice cloning service unavailable');
		}

		if (!elevenResp.ok) {
			const body = await elevenResp.text().catch(() => '');
			console.error('[voice/clone] elevenlabs error', elevenResp.status, body);
			if (elevenResp.status === 422)
				return error(res, 400, 'audio_too_short', 'audio is too short or low quality for cloning');
			return error(res, 502, 'upstream_error', 'voice cloning failed');
		}

		const { voice_id } = await elevenResp.json();
		if (!voice_id) return error(res, 502, 'upstream_error', 'unexpected response from voice service');

		await sql`
			UPDATE agent_identities
			SET voice_provider = 'elevenlabs', voice_id = ${voice_id}, voice_cloned_at = now()
			WHERE id = ${id}
		`;

		return json(res, 201, { voice_id, name: voiceName });
	}

	return error(res, 404, 'not_found', 'unknown voice action');
});
