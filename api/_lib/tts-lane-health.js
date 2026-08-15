// Circuit breaker for the voice lanes behind /api/tts/*.
//
// A TTS lane can be perfectly configured and still be dead: on 2026-08-15 the
// Gemini lane answered every synthesis with a 403 ("Lightning dunning decision
// is deny") because Google's billing dunning system denied the whole project,
// while `geminiTtsConfigured()` still reported true (the project id and the key
// are both present). The catalog therefore advertised 30 Gemini voices, the
// Voice Lab sorted them first, and the first Preview a visitor clicked failed.
//
// Configuration presence cannot answer "can this lane serve right now"; only a
// real call can. So the synthesis path records what it learns, and the catalog
// reads it back: a lane that just failed on a credential/billing error is
// reported unavailable with the reason attached, instead of being offered as if
// it worked. The window expires on its own, so a lane that is fixed upstream
// comes back with no deploy and no manual step.
//
// The cooldown store is the shared one (`provider-health.js`: Upstash Redis when
// configured, per-instance memory otherwise), so one instance learning that a
// lane is down spares every other instance the same failure. Best-effort by
// design: a cache miss reads as "no outage known", which is exactly the
// pre-breaker behaviour.

import {
	markProviderCooldown,
	providersInCooldown,
	clearProviderCooldown,
	AUTH_COOLDOWN_SECONDS,
} from './provider-health.js';

// Namespaced so a TTS lane outage can never collide with the LLM chain's
// cooldown for a provider of the same name (both have an "openai").
const KEY_PREFIX = 'tts-lane:';

/** Cooldown key for one voice lane. */
export function ttsLaneKey(providerId) {
	return `${KEY_PREFIX}${providerId}`;
}

// How long each failure class silences a lane, and how the picker explains it.
// A credential/billing refusal will not fix itself in a minute, so it is held
// for the shared auth window; a timeout or a 5xx often will, so it is held just
// long enough to stop a burst of previews all failing the same way.
const OUTAGE_BY_CODE = {
	invalid_key: {
		seconds: AUTH_COOLDOWN_SECONDS,
		reason: 'auth',
		copy: "the provider rejected this deployment's credentials",
	},
	not_configured: {
		seconds: AUTH_COOLDOWN_SECONDS,
		reason: 'auth',
		copy: 'the lane is not configured on this server',
	},
	rate_limited: { seconds: 60, reason: 'health', copy: 'the provider is rate limiting this deployment' },
	provider_unreachable: { seconds: 60, reason: 'health', copy: 'the provider was unreachable' },
	provider_error: { seconds: 45, reason: 'health', copy: 'the provider returned an error' },
};

/** Human sentence for a cooled lane, e.g. for a pill title or an error body. */
export function laneOutageCopy(reason) {
	return reason === 'auth'
		? OUTAGE_BY_CODE.invalid_key.copy
		: OUTAGE_BY_CODE.provider_error.copy;
}

/**
 * Record that a lane just failed a real synthesis, so the catalog stops
 * offering it and the next caller is not the one who discovers it.
 *
 * Only the codes above trip the breaker: a caller-side failure (`invalid_argument`,
 * `content_blocked`) says nothing about the lane's health and must never take a
 * working lane off the menu. Never throws.
 *
 * @param {string} providerId
 * @param {string} code the tagged upstream error code
 */
export async function noteLaneFailure(providerId, code) {
	const outage = OUTAGE_BY_CODE[code];
	if (!providerId || !outage) return;
	await markProviderCooldown(ttsLaneKey(providerId), outage.seconds, outage.reason).catch(() => {});
}

/**
 * Record that a lane just served a real clip, clearing any cooldown on it. A
 * lane that has demonstrably recovered should be back in the picker on the next
 * catalog read, not at the end of the window. Never throws.
 *
 * @param {string} providerId
 */
export async function noteLaneHealthy(providerId) {
	if (!providerId) return;
	await clearProviderCooldown(ttsLaneKey(providerId)).catch(() => {});
}

/**
 * Which of `providerIds` are currently cooling, mapped to why ('auth' for a
 * credential/billing refusal, 'health' for a throttle or a blip). Never throws.
 *
 * @param {string[]} providerIds
 * @returns {Promise<Map<string, 'auth'|'health'>>} keyed by provider id, not cache key
 */
export async function laneOutages(providerIds) {
	const cooling = await providersInCooldown(providerIds.map(ttsLaneKey)).catch(() => new Map());
	const out = new Map();
	for (const [key, reason] of cooling) out.set(key.slice(KEY_PREFIX.length), reason);
	return out;
}
