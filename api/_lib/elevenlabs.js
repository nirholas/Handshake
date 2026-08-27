// @ts-check
// Shared ElevenLabs client + helpers.
//
// Centralizes the base URL, the API-key gate, the cached voice catalog, voice
// cloning (via the official SDK), and best-effort voice deletion so the TTS
// proxy (api/tts/*) and the agent-voice endpoints (api/agents/:id/voice) don't
// each reimplement them. Lazy: nothing here touches the network at import time.

import { env } from './env.js';
import { fetchUpstream } from './upstream-fetch.js';

export const ELEVEN_BASE = 'https://api.elevenlabs.io/v1';

// Default real-time synthesis model. Flash v2.5 has roughly half the latency
// (and cost) of Turbo v2.5, which matters for a talking avatar; callers can
// still override per request with `modelId`.
export const DEFAULT_TTS_MODEL = 'eleven_flash_v2_5';

// Selectable synthesis models surfaced in the voice editor. Keep ids in sync
// with ElevenLabs' model catalog; the agent voice API validates against this.
export const TTS_MODELS = [
	{ id: 'eleven_flash_v2_5', label: 'Flash v2.5', note: 'Lowest latency · real-time' },
	{ id: 'eleven_turbo_v2_5', label: 'Turbo v2.5', note: 'Balanced latency & quality' },
	{
		id: 'eleven_multilingual_v2',
		label: 'Multilingual v2',
		note: 'Highest quality · 29 languages',
	},
];
const TTS_MODEL_IDS = new Set(TTS_MODELS.map((m) => m.id));

export function isValidModel(id) {
	return typeof id === 'string' && TTS_MODEL_IDS.has(id);
}

/**
 * Normalize a client-supplied voice_settings object to the canonical ElevenLabs
 * shape with every numeric field clamped to 0..1.
 * @returns the normalized object, or null for null input ("use defaults").
 * @throws  {Error & { status:400 }} for a non-object, non-null input.
 */
export function normalizeVoiceSettings(input) {
	if (input == null) return null;
	if (typeof input !== 'object' || Array.isArray(input))
		throw upstreamError('voice_settings must be an object', 400);
	const clamp01 = (v, d) => {
		const n = Number(v);
		return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : d;
	};
	return {
		stability: clamp01(input.stability, 0.5),
		similarity_boost: clamp01(input.similarity_boost, 0.75),
		style: clamp01(input.style, 0.5),
		use_speaker_boost: input.use_speaker_boost !== undefined ? !!input.use_speaker_boost : true,
	};
}

export function elevenApiKey() {
	return env.ELEVENLABS_API_KEY || null;
}

export function isConfigured() {
	return !!env.ELEVENLABS_API_KEY;
}

// ── BYOK (bring your own key) ────────────────────────────────────────────────
// Users can supply their own ElevenLabs API key per request via the
// `x-eleven-key` header. A user key routes the call to THEIR ElevenLabs
// account (their voices, their quota, their bill), so the platform's char
// budget and credit metering do not apply. The key is used for the one request
// and never stored server-side.

const USER_KEY_MAX_LEN = 256;

/**
 * Resolve the API key for a request: a valid `x-eleven-key` header wins,
 * otherwise the platform key. Returns { apiKey, byok } where apiKey may be
 * null when neither is available.
 * @param {import('http').IncomingMessage} req
 */
export function resolveElevenKey(req) {
	const raw = req?.headers?.['x-eleven-key'];
	const userKey = typeof raw === 'string' ? raw.trim() : '';
	if (userKey && userKey.length <= USER_KEY_MAX_LEN && /^[\x21-\x7e]+$/.test(userKey)) {
		return { apiKey: userKey, byok: true };
	}
	return { apiKey: elevenApiKey(), byok: false };
}

/** Build an Error tagged with an HTTP status (and optional upstream detail). */
function upstreamError(message, status, extra = {}) {
	return Object.assign(new Error(message), { status, ...extra });
}

// ── Voice catalog ────────────────────────────────────────────────────────────
// The catalog changes only when an account adds/clones/removes a voice, but the
// agent editor and the PUT validator both read it. Cache the filtered list per
// warm serverless instance; a short TTL keeps freshly cloned voices visible.

const VOICE_TTL_MS = 5 * 60 * 1000;
let voiceCache = null; // { at: epochMs, voices: [...] }

export function invalidateVoiceCache() {
	voiceCache = null;
}

/**
 * Fetch the account's voices, filtered to safe public fields.
 * A user-supplied `apiKey` (BYOK) reads that user's own account and bypasses
 * the shared per-instance cache, so one user's catalog never leaks to another.
 * @returns {Promise<{ voices: Array, cached: boolean }>}
 * @throws  {Error & { status:number }} 503 when unconfigured, 502 on upstream failure.
 */
export async function listVoices({ force = false, apiKey: keyOverride = null } = {}) {
	const apiKey = keyOverride || elevenApiKey();
	if (!apiKey) throw upstreamError('ElevenLabs is not configured', 503);
	const shareCache = !keyOverride || keyOverride === elevenApiKey();

	if (shareCache && !force && voiceCache && Date.now() - voiceCache.at < VOICE_TTL_MS) {
		return { voices: voiceCache.voices, cached: true };
	}

	let resp;
	try {
		resp = await fetchUpstream(`${ELEVEN_BASE}/voices`, { headers: { 'xi-api-key': apiKey } }, { name: 'elevenlabs', timeoutMs: 10_000, attempts: 2, okWhen: () => true });
	} catch (e) {
		throw upstreamError('Could not reach ElevenLabs', 502, { cause: e });
	}
	if (!resp.ok) {
		console.error('[elevenlabs] listVoices error', resp.status);
		// `status` stays 502 so existing callers are unchanged; `upstreamStatus`
		// lets a handler that knows whose key it sent tell "their key is wrong"
		// (401) apart from "ElevenLabs is broken" and answer accordingly.
		throw upstreamError(`ElevenLabs returned ${resp.status}`, 502, {
			upstreamStatus: resp.status,
		});
	}

	const data = await resp.json();
	const voices = (data.voices || []).map((v) => ({
		voice_id: v.voice_id,
		name: v.name,
		category: v.category,
		labels: v.labels || {},
		preview_url: v.preview_url || null,
	}));

	if (shareCache) voiceCache = { at: Date.now(), voices };
	return { voices, cached: false };
}

// ── Cloning ──────────────────────────────────────────────────────────────────

/**
 * Instant Voice Cloning via the official SDK. A user-supplied `apiKey` (BYOK)
 * clones onto that user's own ElevenLabs account.
 * @param {{ name:string, description?:string, files:File[], apiKey?:string|null }} input
 * @returns {Promise<{ voiceId:string, requiresVerification:boolean }>}
 * @throws  {Error & { status:number, upstreamBody?:string }} on failure. IVC is
 *          a paid-tier feature; the free tier surfaces `can_not_use_instant_
 *          voice_cloning` here, which callers can pass through verbatim.
 */
export async function createClonedVoice({ name, description, files, apiKey: keyOverride = null }) {
	const apiKey = keyOverride || elevenApiKey();
	if (!apiKey) throw upstreamError('ElevenLabs is not configured', 503);

	// Dynamic import: the official SDK's module graph takes ~5s to evaluate,
	// which would otherwise be paid on every cold start of every handler that
	// imports this lib — only the clone path actually needs it.
	const { ElevenLabsClient } = await import('@elevenlabs/elevenlabs-js');
	const client = new ElevenLabsClient({ apiKey });
	let result;
	try {
		result = await client.voices.ivc.create({ name, description, files });
	} catch (err) {
		const status = err?.statusCode || err?.status || 502;
		const upstreamBody =
			(err?.body && typeof err.body === 'object' ? JSON.stringify(err.body) : err?.body) ||
			err?.message ||
			'upstream error';
		throw upstreamError(`ElevenLabs returned ${status}`, status, { upstreamBody });
	}

	// SDK ≥2 returns camelCase model fields (voiceId); tolerate the legacy
	// snake_case wire shape too so an SDK downgrade can't silently break cloning.
	const raw = /** @type {any} */ (result);
	const voiceId = raw?.voiceId ?? raw?.voice_id;
	if (!voiceId) throw upstreamError('ElevenLabs response missing voice_id', 502);

	invalidateVoiceCache();
	return {
		voiceId,
		requiresVerification: !!(raw.requiresVerification ?? raw.requires_verification),
	};
}

/**
 * Best-effort deletion to free a quota slot. Never throws — a failed cleanup is
 * logged and swallowed so it can't break the caller's primary flow.
 *
 * A voice only exists inside the account that created it, so `apiKey` must be
 * the same credential the clone was made with (BYOK clones live on the user's
 * own account, not the platform's).
 * @param {string} voiceId
 * @param {{ apiKey?: string|null }} [opts]
 */
export async function deleteVoice(voiceId, { apiKey: keyOverride = null } = {}) {
	const apiKey = keyOverride || elevenApiKey();
	if (!apiKey || !voiceId) return;
	try {
		await fetchUpstream(`${ELEVEN_BASE}/voices/${encodeURIComponent(voiceId)}`, {
			method: 'DELETE',
			headers: { 'xi-api-key': apiKey },
		}, { name: 'elevenlabs', timeoutMs: 10_000, attempts: 2, okWhen: () => true });
		invalidateVoiceCache();
	} catch (e) {
		console.warn('[elevenlabs] deleteVoice failed', voiceId, e?.message);
	}
}
