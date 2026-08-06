// Voice clone management for an agent.
//
// GET    /api/agents/:id/voice        — current voice status (provider, id, model, settings)
// PUT    /api/agents/:id/voice        — assign a library voice and/or tune the
//                                       synthesis model + voice_settings
// POST   /api/agents/:id/voice/clone  — clone voice from uploaded audio
// DELETE /api/agents/:id/voice        — remove cloned voice / clear selection

import { sql } from '../../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../../_lib/auth.js';
import { cors, json, method, wrap, error, readJson, rateLimited } from '../../_lib/http.js';
import { randomUUID } from 'node:crypto';
import { limits } from '../../_lib/rate-limit.js';
import { requireCsrf } from '../../_lib/csrf.js';
import { chargeCreditsForAction, refundCredits } from '../../_lib/credits.js';
import {
	isConfigured,
	listVoices,
	createClonedVoice,
	deleteVoice,
	isValidModel,
	normalizeVoiceSettings,
} from '../../_lib/elevenlabs.js';

// Fire-and-forget ElevenLabs voice deletion. The clone slot is best-effort
// cleanup — a failure must be logged, never crash the process as an
// unhandled rejection.
function deleteVoiceBestEffort(voiceId) {
	deleteVoice(voiceId).catch((err) =>
		console.warn('[voice] deleteVoice failed for', voiceId, err?.message || err),
	);
}

const MAX_AUDIO_BYTES = 10 * 1024 * 1024; // 10 MB
const MIN_DURATION_SEC = 30;

// Canonical voice-status response shape, shared by GET and the PUT branches.
function voiceStatus(row) {
	return {
		voice_provider: row?.voice_provider || 'browser',
		voice_id: row?.voice_id || null,
		voice_cloned_at: row?.voice_cloned_at || null,
		voice_model: row?.voice_model || null,
		voice_settings: row?.voice_settings || null,
	};
}

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

	// CSRF on state-changing session-cookie requests; bearer tokens are exempt.
	if (req.method !== 'GET' && !(await requireCsrf(req, res, auth.userId))) return;

	const [agent] =
		await sql`SELECT id, user_id, name FROM agent_identities WHERE id = ${id} AND deleted_at IS NULL`;
	if (!agent) return error(res, 404, 'not_found', 'agent not found');
	if (agent.user_id !== auth.userId) return error(res, 403, 'forbidden', 'not your agent');

	// ── GET — voice status ───────────────────────────────────────────────────

	if (req.method === 'GET') {
		const [row] =
			await sql`SELECT voice_provider, voice_id, voice_cloned_at, voice_model, voice_settings FROM agent_identities WHERE id = ${id}`;
		return json(res, 200, voiceStatus(row));
	}

	// ── PUT — assign a voice and/or tune its settings ───────────────────────
	//
	// Body (every field optional; only keys that are present are applied):
	//   voice_id:       string | null  — library voice id (null/'' clears to browser)
	//   voice_model:    string | null  — synthesis model id (null = platform default)
	//   voice_settings: object | null  — { stability, similarity_boost, style,
	//                                       use_speaker_boost }; null = defaults
	//
	// A settings/model-only PUT (no voice_id key) updates just those columns and
	// leaves voice_id / voice_cloned_at untouched, so tuning a cloned voice never
	// drops the clone marker. Assigning a new voice_id over an existing *clone*
	// frees the old clone in ElevenLabs to recover the quota slot.

	if (req.method === 'PUT') {
		if (!isConfigured())
			return error(
				res,
				503,
				'not_configured',
				'voice library is not configured on this server',
			);

		let body;
		try {
			body = await readJson(req);
		} catch {
			return error(res, 400, 'validation_error', 'invalid JSON body');
		}

		const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
		const hasVoiceId = has('voice_id');
		const hasModel = has('voice_model');
		const hasSettings = has('voice_settings');
		if (!hasVoiceId && !hasModel && !hasSettings)
			return error(res, 400, 'validation_error', 'nothing to update');

		// Validate model + settings up front.
		let model;
		if (hasModel) {
			model = body.voice_model == null ? null : String(body.voice_model);
			if (model !== null && !isValidModel(model))
				return error(res, 400, 'validation_error', 'unsupported voice_model');
		}
		let settings;
		if (hasSettings) {
			try {
				settings = normalizeVoiceSettings(body.voice_settings);
			} catch (e) {
				return error(res, 400, 'validation_error', e.message);
			}
		}

		const [current] =
			await sql`SELECT voice_id, voice_cloned_at, voice_model, voice_settings FROM agent_identities WHERE id = ${id}`;

		// Carry forward whatever wasn't explicitly provided.
		const finalModel = hasModel ? model : (current?.voice_model ?? null);
		const finalSettings = hasSettings ? settings : (current?.voice_settings ?? null);
		const settingsParam = finalSettings == null ? null : JSON.stringify(finalSettings);

		if (hasVoiceId) {
			const nextVoiceId = body.voice_id == null ? null : String(body.voice_id).trim() || null;
			const wasCloned = !!current?.voice_cloned_at;
			const oldVoiceId = current?.voice_id || null;

			if (nextVoiceId) {
				let voices;
				try {
					({ voices } = await listVoices());
				} catch (err) {
					console.error('[voice/put] listVoices failed', err);
					return error(res, 502, 'upstream_error', 'voice library is unavailable');
				}
				if (!voices.some((v) => v.voice_id === nextVoiceId))
					return error(
						res,
						400,
						'validation_error',
						'voice_id is not in the available library',
					);

				if (wasCloned && oldVoiceId && oldVoiceId !== nextVoiceId)
					deleteVoiceBestEffort(oldVoiceId);

				const [row] = await sql`
					UPDATE agent_identities
					SET voice_provider = 'elevenlabs', voice_id = ${nextVoiceId}, voice_cloned_at = NULL,
					    voice_model = ${finalModel}, voice_settings = ${settingsParam}::jsonb
					WHERE id = ${id}
					RETURNING voice_provider, voice_id, voice_cloned_at, voice_model, voice_settings
				`;
				return json(res, 200, voiceStatus(row));
			}

			// Clear to browser — resets every voice column.
			if (wasCloned && oldVoiceId) deleteVoiceBestEffort(oldVoiceId);
			const [row] = await sql`
				UPDATE agent_identities
				SET voice_provider = 'browser', voice_id = NULL, voice_cloned_at = NULL,
				    voice_model = NULL, voice_settings = NULL
				WHERE id = ${id}
				RETURNING voice_provider, voice_id, voice_cloned_at, voice_model, voice_settings
			`;
			return json(res, 200, voiceStatus(row));
		}

		// Settings/model-only update — leave the voice assignment untouched.
		const [row] = await sql`
			UPDATE agent_identities
			SET voice_model = ${finalModel}, voice_settings = ${settingsParam}::jsonb
			WHERE id = ${id}
			RETURNING voice_provider, voice_id, voice_cloned_at, voice_model, voice_settings
		`;
		return json(res, 200, voiceStatus(row));
	}

	// ── DELETE — remove cloned voice ─────────────────────────────────────────

	if (req.method === 'DELETE') {
		const [row] =
			await sql`SELECT voice_id, voice_cloned_at FROM agent_identities WHERE id = ${id}`;
		// Only free *cloned* voices on ElevenLabs — library voices are shared
		// across the account and must never be deleted here.
		if (row?.voice_id && row?.voice_cloned_at) deleteVoiceBestEffort(row.voice_id);
		await sql`
			UPDATE agent_identities
			SET voice_provider = 'browser', voice_id = NULL, voice_cloned_at = NULL
			WHERE id = ${id}
		`;
		return json(res, 200, { voice_provider: 'browser', voice_id: null });
	}

	// ── POST /clone ──────────────────────────────────────────────────────────

	if (req.method === 'POST' && action === 'clone') {
		if (!isConfigured())
			return error(
				res,
				503,
				'not_configured',
				'voice cloning is not configured on this server',
			);

		// Rate limit: 3 clones per user per day.
		const rl = await limits.voiceClone(auth.userId);
		if (!rl.success) return rateLimited(res, rl, 'voice clone limit reached (3 per day)');

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

		if (audioBuf.length === 0)
			return error(res, 400, 'validation_error', 'audio body is empty');

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

		const audioFile = new File([audioBuf], ext, { type: ct });

		// Agent clones always run on the platform key, so the caller pays for
		// the paid IVC slot: charge the voice.clone catalog action (holder-tier
		// discount applies) before the upstream call, refunded on any failure.
		// No free lane (owner policy 2026-08-06).
		let creditCharge = null;
		{
			const idempotencyKey = `agent-voice-clone:${randomUUID()}`;
			try {
				const charged = await chargeCreditsForAction({
					user: { id: auth.userId },
					action: 'voice.clone',
					refType: 'agent',
					refId: id,
					idempotencyKey,
					meta: { agent: id, name: voiceName },
				});
				creditCharge = { idempotencyKey, chargedUsd: charged.chargedUsd };
			} catch (err) {
				if (err?.code === 'insufficient_credits') {
					return json(res, 402, {
						error: 'insufficient_credits',
						feature: 'voice.clone',
						available_usd: err.available_usd,
						required_usd: err.required_usd,
						top_up_url: '/credits',
						message:
							'Voice cloning is metered to your credit balance. Top up with $THREE at /credits.',
					});
				}
				throw err;
			}
		}
		const refundClone = async (reason) => {
			if (!creditCharge?.chargedUsd) return;
			await refundCredits({
				userId: auth.userId,
				amountUsd: creditCharge.chargedUsd,
				action: 'voice.clone',
				refType: 'agent',
				refId: id,
				idempotencyKey: `${creditCharge.idempotencyKey}:refund`,
				meta: { reason },
			}).catch((e) => console.warn('[voice/clone] credit refund failed:', e?.message || e));
		};

		let voiceId;
		try {
			({ voiceId } = await createClonedVoice({
				name: voiceName,
				description: voiceDescription || undefined,
				files: [audioFile],
			}));
		} catch (err) {
			await refundClone('clone_failed');
			console.error(
				'[voice/clone] createClonedVoice failed',
				err.status,
				err.upstreamBody || err.message,
			);
			if (err.status === 422)
				return error(
					res,
					400,
					'audio_too_short',
					'audio is too short or low quality for cloning',
				);
			return error(res, 502, 'upstream_error', 'voice cloning failed');
		}

		// Persist the clone. If the DB write fails the voice we just created would
		// leak in ElevenLabs (counting against the account quota with no DB
		// reference), so delete it before surfacing the error.
		try {
			await sql`
				UPDATE agent_identities
				SET voice_provider = 'elevenlabs', voice_id = ${voiceId}, voice_cloned_at = now()
				WHERE id = ${id}
			`;
		} catch (dbErr) {
			console.error('[voice/clone] DB persist failed, rolling back clone', dbErr);
			await deleteVoice(voiceId).catch((err) =>
				console.warn(
					'[voice/clone] rollback deleteVoice failed for',
					voiceId,
					err?.message || err,
				),
			);
			await refundClone('persist_failed');
			return error(res, 500, 'internal_error', 'failed to save cloned voice');
		}

		return json(res, 201, { voice_id: voiceId, name: voiceName });
	}

	return error(res, 404, 'not_found', 'unknown voice action');
});
