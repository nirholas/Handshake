/**
 * GET /api/tts/eleven/voices
 *
 * Returns the ElevenLabs voice list (filtered to safe public fields), served
 * from the shared per-instance cache in _lib/elevenlabs.js. A request carrying
 * its own `x-eleven-key` header (BYOK) lists that account's voices instead,
 * uncached. Returns { enabled: false, voices: [] } when ELEVENLABS_API_KEY is
 * not set and no user key was sent, so the client can gate the UI without a
 * separate config check.
 */

import { getSessionUser, authenticateBearer, extractBearer } from '../../_lib/auth.js';
import { cors, json, method, wrap, error } from '../../_lib/http.js';
import { resolveElevenKey, listVoices, TTS_MODELS } from '../../_lib/elevenlabs.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	if (!session && !bearer) return error(res, 401, 'unauthorized', 'sign in required');

	// A user-supplied x-eleven-key (BYOK) lists THAT account's voices; otherwise
	// the platform account's. Unconfigured with no user key stays a soft-off so
	// the client can gate the UI without a separate config check.
	const { apiKey, byok } = resolveElevenKey(req);
	if (!apiKey) return json(res, 200, { enabled: false, voices: [], models: TTS_MODELS });

	let result;
	try {
		result = await listVoices(byok ? { apiKey } : {});
	} catch (e) {
		console.error('[tts/eleven/voices] listVoices failed', e);
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
		{ enabled: true, voices: result.voices, models: TTS_MODELS },
		{
			'cache-control': 'private, max-age=300',
			'x-voices-cache': result.cached ? 'hit' : 'miss',
		},
	);
});
