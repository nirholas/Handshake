// Which ElevenLabs credential serves a given agent's voice.
//
// There are three lanes, and they are not interchangeable: a cloned voice_id
// only exists inside the ElevenLabs account that created it. Cloning on the
// owner's key and synthesizing with the platform key returns a 404 from
// ElevenLabs, so the lane a voice was bound on is recorded on the agent
// (agent_identities.voice_key_source) and replayed on every synthesis.
//
//   request  — the caller sent `x-eleven-key` on this request. Highest priority:
//              an explicit per-request override, never stored.
//   owner    — the agent owner saved an ElevenLabs key at /api/user/provider-keys.
//              Stored encrypted at rest (AES-256-GCM, api/_lib/provider-keys.js)
//              and decrypted per request. The owner's ElevenLabs account is
//              billed, so platform credits never apply.
//   platform — the platform ELEVENLABS_API_KEY. Metered to $THREE credits
//              (owner policy 2026-08-06: no free platform lane).
//
// BYOK is the activation path while no platform key exists: setting
// ELEVENLABS_API_KEY on the service is the single change that lights up the
// platform lane for every agent whose owner has no key of their own.

import { sql } from './db.js';
import { decryptProviderKey } from './provider-keys.js';
import { elevenApiKey, resolveElevenKey } from './elevenlabs.js';

/** Provider slug in users.provider_keys for an ElevenLabs BYOK key. */
export const ELEVEN_PROVIDER = 'elevenlabs';

/**
 * Decrypt a user's stored ElevenLabs key, if they saved one.
 * A corrupt or undecryptable blob resolves to null rather than throwing: the
 * caller falls through to the next lane instead of failing the whole request.
 * @param {string} userId
 * @returns {Promise<string|null>}
 */
export async function loadOwnerElevenKey(userId) {
	if (!userId) return null;
	const [row] = await sql`SELECT provider_keys FROM users WHERE id = ${userId}`;
	const encrypted = row?.provider_keys?.[ELEVEN_PROVIDER];
	if (typeof encrypted !== 'string' || !encrypted) return null;
	try {
		return (await decryptProviderKey(encrypted)) || null;
	} catch (err) {
		console.warn('[voice-key] could not decrypt stored ElevenLabs key:', err?.message || err);
		return null;
	}
}

/**
 * Resolve the credential to use for an agent's voice.
 *
 * @param {object} opts
 * @param {import('http').IncomingMessage} [opts.req]  request, for the `x-eleven-key` override.
 * @param {string} [opts.ownerId]   the agent's owner. Their stored key is the BYOK lane.
 * @param {'owner'|'platform'|null} [opts.pin]  replay a recorded lane instead of
 *        re-deciding it. Used on playback so a voice cloned on the owner's key is
 *        never synthesized with the platform key (which cannot see it).
 * @returns {Promise<{ apiKey: string|null, source: 'request'|'owner'|'platform'|null }>}
 */
export async function resolveAgentElevenKey({ req = null, ownerId = null, pin = null } = {}) {
	const fromRequest = req ? resolveElevenKey(req) : { apiKey: null, byok: false };
	if (fromRequest.byok && fromRequest.apiKey) {
		return { apiKey: fromRequest.apiKey, source: 'request' };
	}

	if (pin === 'owner') {
		const ownerKey = await loadOwnerElevenKey(ownerId);
		return ownerKey ? { apiKey: ownerKey, source: 'owner' } : { apiKey: null, source: null };
	}
	if (pin === 'platform') {
		const platform = elevenApiKey();
		return platform ? { apiKey: platform, source: 'platform' } : { apiKey: null, source: null };
	}

	// Unpinned (binding a new voice): the owner's own key wins over the platform
	// key, because a user who saved one has opted into paying their own vendor
	// bill rather than spending $THREE credits.
	const ownerKey = await loadOwnerElevenKey(ownerId);
	if (ownerKey) return { apiKey: ownerKey, source: 'owner' };

	const platform = elevenApiKey();
	if (platform) return { apiKey: platform, source: 'platform' };

	return { apiKey: null, source: null };
}

/**
 * The lane recorded on an agent row, normalized. Legacy rows (written before
 * voice_key_source existed) predate BYOK binding and can only be platform clones.
 * @param {string|null|undefined} stored
 * @returns {'owner'|'platform'}
 */
export function normalizeKeySource(stored) {
	return stored === 'owner' ? 'owner' : 'platform';
}
