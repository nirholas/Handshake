// Voice clone management for an agent.
//
// GET    /api/agents/:id/voice        — current voice status (provider, id, model, settings)
// PUT    /api/agents/:id/voice        — assign a library voice and/or tune the
//                                       synthesis model + voice_settings
// POST   /api/agents/:id/voice/clone  — clone voice from uploaded audio
// DELETE /api/agents/:id/voice        — remove cloned voice / clear selection
//
// Credentials. Every branch that touches ElevenLabs resolves its key through
// api/_lib/agent-voice-key.js, which picks between an `x-eleven-key` request
// override, the owner's stored BYOK key, and the platform key. The winning lane
// is written to agent_identities.voice_key_source so playback replays the same
// credential — a voice cloned onto the owner's account is invisible to the
// platform key. Only the platform lane charges $THREE credits; a BYOK clone is
// billed by ElevenLabs directly to the user whose key made it.

import { sql } from '../../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../../_lib/auth.js';
import { cors, json, method, wrap, error, readJson, rateLimited } from '../../_lib/http.js';
import { randomUUID } from 'node:crypto';
import { limits } from '../../_lib/rate-limit.js';
import { requireCsrf } from '../../_lib/csrf.js';
import { chargeCreditsForAction, refundCredits } from '../../_lib/credits.js';
import {
	listVoices,
	createClonedVoice,
	deleteVoice,
	isValidModel,
	normalizeVoiceSettings,
} from '../../_lib/elevenlabs.js';
import { resolveAgentElevenKey, normalizeKeySource } from '../../_lib/agent-voice-key.js';

// Fire-and-forget ElevenLabs voice deletion. The clone slot is best-effort
// cleanup — a failure must be logged, never crash the process as an
// unhandled rejection.
function deleteVoiceBestEffort(voiceId, apiKey) {
	deleteVoice(voiceId, { apiKey }).catch((err) =>
		console.warn('[voice] deleteVoice failed for', voiceId, err?.message || err),
	);
}

const MAX_AUDIO_BYTES = 10 * 1024 * 1024; // 10 MB
const MIN_DURATION_SEC = 30;

// Every ElevenLabs branch shares this shape when no credential is available at
// all: neither the caller, the owner's saved key, nor the platform. It names the
// two ways out so the UI can render a real next step instead of a dead 503.
function noCredential(res, what) {
	return json(res, 503, {
		error: 'not_configured',
		error_description: `${what} needs an ElevenLabs key. Save your own at /dashboard/account, or ask the operator to set ELEVENLABS_API_KEY.`,
		byok_url: '/dashboard/account',
		provider: 'elevenlabs',
	});
}

// Canonical voice-status response shape, shared by GET and the PUT branches.
function voiceStatus(row, extra = {}) {
	return {
		voice_provider: row?.voice_provider || 'browser',
		voice_id: row?.voice_id || null,
		voice_cloned_at: row?.voice_cloned_at || null,
		voice_model: row?.voice_model || null,
		voice_settings: row?.voice_settings || null,
		voice_key_source: row?.voice_id ? normalizeKeySource(row?.voice_key_source) : null,
		...extra,
	};
}

// Binding a voice to an agent must use a credential that still exists on the
// next request, because playback has to reach the same ElevenLabs account. The
// stateless `x-eleven-key` header is explicitly never stored, so it is not a
// binding lane here: only the owner's saved key (encrypted in users.provider_keys)
// and the platform key qualify. The per-request override still works on the
// stateless /api/tts/* endpoints where nothing is persisted.
function resolveBindingKey(ownerId) {
	return resolveAgentElevenKey({ ownerId });
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
			await sql`SELECT voice_provider, voice_id, voice_cloned_at, voice_model, voice_settings, voice_key_source FROM agent_identities WHERE id = ${id}`;
		// Tell the client which lane is actually open, so it can render the
		// "no key" state up front instead of discovering it on a failed clone.
		const { source } = await resolveBindingKey(auth.userId);
		return json(res, 200, voiceStatus(row, { available_key_source: source }));
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
		const { apiKey, source: boundSource } = await resolveBindingKey(auth.userId);
		if (!apiKey) return noCredential(res, 'The voice library');

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
			await sql`SELECT voice_id, voice_cloned_at, voice_model, voice_settings, voice_key_source FROM agent_identities WHERE id = ${id}`;
		// The old voice lives in whichever account cloned it; free it with that
		// same credential, not with whichever one is winning today.
		const oldKey =
			normalizeKeySource(current?.voice_key_source) === boundSource
				? apiKey
				: (await resolveAgentElevenKey({
						ownerId: auth.userId,
						pin: normalizeKeySource(current?.voice_key_source),
					})).apiKey;

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
					({ voices } = await listVoices({ apiKey }));
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
					deleteVoiceBestEffort(oldVoiceId, oldKey);

				const [row] = await sql`
					UPDATE agent_identities
					SET voice_provider = 'elevenlabs', voice_id = ${nextVoiceId}, voice_cloned_at = NULL,
					    voice_model = ${finalModel}, voice_settings = ${settingsParam}::jsonb,
					    voice_key_source = ${boundSource}
					WHERE id = ${id}
					RETURNING voice_provider, voice_id, voice_cloned_at, voice_model, voice_settings, voice_key_source
				`;
				return json(res, 200, voiceStatus(row));
			}

			// Clear to browser — resets every voice column.
			if (wasCloned && oldVoiceId) deleteVoiceBestEffort(oldVoiceId, oldKey);
			const [row] = await sql`
				UPDATE agent_identities
				SET voice_provider = 'browser', voice_id = NULL, voice_cloned_at = NULL,
				    voice_model = NULL, voice_settings = NULL, voice_key_source = NULL
				WHERE id = ${id}
				RETURNING voice_provider, voice_id, voice_cloned_at, voice_model, voice_settings, voice_key_source
			`;
			return json(res, 200, voiceStatus(row));
		}

		// Settings/model-only update — leave the voice assignment untouched.
		const [row] = await sql`
			UPDATE agent_identities
			SET voice_model = ${finalModel}, voice_settings = ${settingsParam}::jsonb
			WHERE id = ${id}
			RETURNING voice_provider, voice_id, voice_cloned_at, voice_model, voice_settings, voice_key_source
		`;
		return json(res, 200, voiceStatus(row));
	}

	// ── DELETE — remove cloned voice ─────────────────────────────────────────

	if (req.method === 'DELETE') {
		const [row] =
			await sql`SELECT voice_id, voice_cloned_at, voice_key_source FROM agent_identities WHERE id = ${id}`;
		// Only free *cloned* voices on ElevenLabs — library voices are shared
		// across the account and must never be deleted here. The clone lives in
		// whichever account made it, so free it with that same credential.
		if (row?.voice_id && row?.voice_cloned_at) {
			const { apiKey } = await resolveAgentElevenKey({
				ownerId: auth.userId,
				pin: normalizeKeySource(row.voice_key_source),
			});
			deleteVoiceBestEffort(row.voice_id, apiKey);
		}
		await sql`
			UPDATE agent_identities
			SET voice_provider = 'browser', voice_id = NULL, voice_cloned_at = NULL,
			    voice_key_source = NULL
			WHERE id = ${id}
		`;
		return json(res, 200, { voice_provider: 'browser', voice_id: null });
	}

	// ── POST /clone ──────────────────────────────────────────────────────────

	if (req.method === 'POST' && action === 'clone') {
		const { apiKey, source: boundSource } = await resolveBindingKey(auth.userId);
		if (!apiKey) return noCredential(res, 'Voice cloning');

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

		// A clone on the platform key consumes a paid IVC slot the platform pays
		// for, so the caller pays for it: charge the voice.clone catalog action
		// (holder-tier discount applies) before the upstream call, refunded on any
		// failure. No free lane (owner policy 2026-08-06). A BYOK clone lands in
		// the user's own ElevenLabs account and is billed there, so credits never
		// apply to it.
		let creditCharge = null;
		if (boundSource === 'platform') {
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
				apiKey,
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
			// 401 only ever means the credential itself was rejected. On the BYOK
			// lane that is the user's own key, and the fix is theirs to make, so
			// say so instead of blaming a generic upstream failure.
			if (err.status === 401)
				return error(
					res,
					502,
					'upstream_error',
					boundSource === 'owner'
						? 'ElevenLabs rejected your API key. Check it at /dashboard/account and try again.'
						: 'ElevenLabs rejected the server key.',
				);
			// Instant Voice Cloning is a paid-tier ElevenLabs feature; a free-tier
			// key returns 403 here. Pass the real reason through.
			if (err.status === 403)
				return error(
					res,
					502,
					'upstream_error',
					boundSource === 'owner'
						? 'Your ElevenLabs plan does not include voice cloning. Instant Voice Cloning needs a paid ElevenLabs tier.'
						: 'voice cloning is not available on the server ElevenLabs plan',
				);
			return error(res, 502, 'upstream_error', 'voice cloning failed');
		}

		// Persist the clone. If the DB write fails the voice we just created would
		// leak in ElevenLabs (counting against the account quota with no DB
		// reference), so delete it before surfacing the error.
		try {
			await sql`
				UPDATE agent_identities
				SET voice_provider = 'elevenlabs', voice_id = ${voiceId}, voice_cloned_at = now(),
				    voice_key_source = ${boundSource}
				WHERE id = ${id}
			`;
		} catch (dbErr) {
			console.error('[voice/clone] DB persist failed, rolling back clone', dbErr);
			await deleteVoice(voiceId, { apiKey }).catch((err) =>
				console.warn(
					'[voice/clone] rollback deleteVoice failed for',
					voiceId,
					err?.message || err,
				),
			);
			await refundClone('persist_failed');
			return error(res, 500, 'internal_error', 'failed to save cloned voice');
		}

		return json(res, 201, {
			voice_id: voiceId,
			name: voiceName,
			voice_key_source: boundSource,
			billing: boundSource === 'owner' ? 'byok' : 'credits',
		});
	}

	return error(res, 404, 'not_found', 'unknown voice action');
});
