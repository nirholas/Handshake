/**
 * GET /api/tts/eleven/voices
 *
 * Returns the ElevenLabs voice list (filtered to safe public fields), served
 * from the shared per-instance cache in _lib/elevenlabs.js. A request carrying
 * its own `x-eleven-key` header (BYOK) lists that account's voices instead,
 * uncached, and so does a caller who saved an ElevenLabs key at
 * /api/user/provider-keys. Returns { enabled: false, voices: [] } when no
 * credential resolves at all, so the client can gate the UI without a separate
 * config check. `key_source` names the lane that answered.
 */

import { getSessionUser, authenticateBearer, extractBearer } from '../../_lib/auth.js';
import { cors, json, method, wrap, error } from '../../_lib/http.js';
import { listVoices, TTS_MODELS } from '../../_lib/elevenlabs.js';
import { resolveAgentElevenKey } from '../../_lib/agent-voice-key.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	if (!session && !bearer) return error(res, 401, 'unauthorized', 'sign in required');

	// A user-supplied x-eleven-key (BYOK) lists THAT account's voices, then the
	// caller's saved key, then the platform account's. No credential at all stays
	// a soft-off so the client can gate the UI without a separate config check.
	const { apiKey, source } = await resolveAgentElevenKey({
		req,
		ownerId: session?.id ?? bearer?.userId ?? null,
	});
	if (!apiKey)
		return json(res, 200, {
			enabled: false,
			voices: [],
			models: TTS_MODELS,
			key_source: null,
			byok_url: '/dashboard/account',
		});

	let result;
	try {
		result = await listVoices(source === 'platform' ? {} : { apiKey });
	} catch (e) {
		console.error('[tts/eleven/voices] listVoices failed', e);
		// ElevenLabs rejecting the key is not a gateway fault. When the key came
		// from the caller (an x-eleven-key header or one they saved), say so at
		// 401 so the client can prompt for a new key instead of retrying a 502
		// that will never clear.
		if (e.upstreamStatus === 401) {
			return error(
				res,
				source === 'platform' ? 503 : 401,
				source === 'platform' ? 'not_configured' : 'invalid_key',
				source === 'platform'
					? 'ElevenLabs rejected this server key'
					: 'ElevenLabs rejected your key. Check it at /dashboard/account.',
			);
		}
		return error(
			res,
			e.status || 502,
			'upstream_error',
			e.message || 'Could not reach ElevenLabs',
		);
	}

	return json(
		res,
		200,
		{ enabled: true, voices: result.voices, models: TTS_MODELS, key_source: source },
		{
			'cache-control': 'private, max-age=300',
			'x-voices-cache': result.cached ? 'hit' : 'miss',
		},
	);
});
