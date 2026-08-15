/**
 * GET /api/tts/catalog
 *
 * Every voice the platform can synthesize, across every lane, in one shape.
 * This is what the Voice Lab picker and the agent voice editor read, so a
 * voice that appears in a picker is always a voice /api/tts/synthesize will
 * actually render.
 *
 * Query:
 *   provider=edge|gemini|nvidia|openai|elevenlabs   restrict to one lane (400 on an unknown id)
 *   q=<text>                                        substring filter (name, locale, labels)
 *   language=<tag>                                  e.g. "en", "ja"
 *   limit=<n>                                       cap voices returned (default 400, max 2000)
 *
 * Auth: optional. Anonymous callers get the keyless lanes (Edge, Gemini,
 * NVIDIA); the metered lanes (OpenAI, ElevenLabs) need a session, and
 * ElevenLabs additionally needs either the platform key or an `x-eleven-key`
 * BYOK header. A lane that cannot serve is reported in `providers` as false
 * rather than omitted, so the UI can explain *why* it is empty. A lane whose
 * last real synthesis was refused upstream (expired key, billing hold) is
 * withheld the same way, from the breaker in api/_lib/tts-lane-health.js.
 *
 * Response: {
 *   providers: [{ id, label, tagline, billing, usdPer1k, byok, clone,
 *                 direction, available, models, defaultVoice, reason? }],
 *   voices: [{ id, name, provider, gender, locale, language, labels, preview_url }],
 *   counts: { <provider>: n }, total, truncated
 * }
 */

import { cors, json, method, wrap, error } from '../_lib/http.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { resolveElevenKey } from '../_lib/elevenlabs.js';
import {
	VOICE_PROVIDERS,
	PROVIDER_IDS,
	getProvider,
	providerAvailability,
	providerModels,
	providerDefaultVoice,
	listProviderVoices,
} from '../_lib/voice-providers.js';
import { laneOutages, laneOutageCopy } from '../_lib/tts-lane-health.js';

const DEFAULT_LIMIT = 400;
const MAX_LIMIT = 2000;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const url = new URL(req.url, 'http://localhost');
	const only = (url.searchParams.get('provider') || '').trim();
	// An unrecognized provider used to answer 200 with an empty catalog, which the
	// picker can only render as "no voices" with no way to tell a typo from a lane
	// that is genuinely down. /api/tts/synthesize already rejects the same id.
	if (only && !getProvider(only)) {
		return error(
			res,
			400,
			'validation_error',
			`unknown provider "${only}". Known lanes: ${PROVIDER_IDS.join(', ')}`,
		);
	}
	const q = (url.searchParams.get('q') || '').trim().toLowerCase();
	const language = (url.searchParams.get('language') || '').trim().toLowerCase();
	const limit = Math.min(
		MAX_LIMIT,
		Math.max(1, Number(url.searchParams.get('limit')) || DEFAULT_LIMIT),
	);

	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	const signedIn = Boolean(session || bearer);
	const { apiKey: elevenKey, byok } = resolveElevenKey(req);

	const availability = providerAvailability({ elevenUserKey: byok });
	// Configuration presence says a lane *could* serve; only a real call knows
	// whether it does. /api/tts/synthesize records what it learns, and a lane
	// that just refused credentials is withheld here rather than advertised with
	// voices nobody can render. A user's own ElevenLabs key is unaffected by the
	// platform key's outage.
	const outages = await laneOutages(PROVIDER_IDS);

	// A lane is listed even when it cannot serve, with the reason attached, so
	// the picker can show "sign in" or "add a key" instead of a silent gap.
	const providers = VOICE_PROVIDERS.map((p) => {
		let available = availability[p.id];
		let reason = null;
		const outage = p.id === 'elevenlabs' && byok ? null : outages.get(p.id);
		if (!available) {
			reason = p.id === 'elevenlabs' ? 'Add your own ElevenLabs key below' : 'Not configured on this server';
		} else if (!p.anonymous && !signedIn) {
			available = false;
			reason = 'Sign in to use this lane';
		} else if (outage === 'auth') {
			available = false;
			reason = `Temporarily unavailable: ${laneOutageCopy(outage)}`;
		}
		return {
			...p,
			available,
			reason,
			models: providerModels(p.id),
			defaultVoice: providerDefaultVoice(p.id),
		};
	});

	const wanted = providers.filter(
		(p) => p.available && (!only || p.id === only),
	);

	// One slow lane must never blank the whole picker: each catalog is fetched
	// independently and a failure degrades that lane to empty + a reason.
	const settled = await Promise.all(
		wanted.map(async (p) => {
			try {
				const voices = await listProviderVoices(p.id, { elevenKey, byok });
				return { id: p.id, voices };
			} catch (e) {
				console.warn('[tts/catalog] lane failed', p.id, e?.message || e);
				return { id: p.id, voices: [], error: e?.message || 'catalog unavailable' };
			}
		}),
	);

	const counts = {};
	let all = [];
	for (const lane of settled) {
		let voices = lane.voices;
		if (language) {
			voices = voices.filter(
				(v) =>
					String(v.language || '').toLowerCase().startsWith(language) ||
					String(v.locale || '').toLowerCase().startsWith(language),
			);
		}
		if (q) {
			voices = voices.filter((v) => {
				const hay = [
					v.name,
					v.id,
					v.locale,
					v.language,
					v.category,
					...Object.values(v.labels || {}).flat(),
				]
					.filter(Boolean)
					.join(' ')
					.toLowerCase();
				return hay.includes(q);
			});
		}
		counts[lane.id] = voices.length;
		all = all.concat(voices);
		if (lane.error) {
			const p = providers.find((x) => x.id === lane.id);
			if (p) {
				p.available = false;
				p.reason = lane.error;
			}
		}
	}

	const total = all.length;
	const truncated = total > limit;

	return json(
		res,
		200,
		{
			providers,
			voices: truncated ? all.slice(0, limit) : all,
			counts,
			total,
			truncated,
			signedIn,
			byok,
		},
		{ 'cache-control': 'private, max-age=60' },
	);
});
