/**
 * GET  /api/tts/eleven/library — search the public ElevenLabs Voice Library
 * POST /api/tts/eleven/library — add one of those voices to the account
 *
 * The Voice Library is the several-thousand-voice catalog ElevenLabs users
 * share publicly. It is a different surface from /api/tts/eleven/voices, which
 * lists only the voices already attached to the account. A shared voice cannot
 * be synthesized directly: it has to be added to an account first, which is
 * what the POST does (ElevenLabs returns a normal voice_id you can then pass
 * to /api/tts/synthesize).
 *
 * GET query:
 *   q, gender, accent, age, category, language, use_cases, page_size (<=100), page
 * GET response: { voices: [...], has_more, page }
 *
 * POST body: { publicUserId, voiceId, name? }
 * POST response: { voiceId, name }
 *
 * BYOK: an `x-eleven-key` header adds the voice to the caller's own ElevenLabs
 * account instead of the platform's, which is the only way a user on a free
 * ElevenLabs plan can grow their own library without spending platform quota.
 */

import { getSessionUser, authenticateBearer, extractBearer } from '../../_lib/auth.js';
import { cors, json, method, wrap, error, readJson, rateLimited } from '../../_lib/http.js';
import { limits } from '../../_lib/rate-limit.js';
import { ELEVEN_BASE, resolveElevenKey, invalidateVoiceCache } from '../../_lib/elevenlabs.js';

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 30;

// Pass-through filters the shared-voices endpoint understands. Anything else a
// client sends is dropped rather than forwarded, so a typo can't turn into an
// opaque upstream 422.
const FILTERS = ['gender', 'accent', 'age', 'category', 'language', 'use_cases', 'descriptives'];

/** Trim a shared-voice record to the fields a picker actually renders. */
function normalize(v) {
	return {
		id: v.voice_id,
		publicUserId: v.public_owner_id,
		name: v.name,
		provider: 'elevenlabs',
		shared: true,
		description: v.description || null,
		gender: v.gender || null,
		accent: v.accent || null,
		age: v.age || null,
		category: v.category || null,
		language: v.language || 'multi',
		useCase: v.use_case || null,
		descriptive: v.descriptive || null,
		preview_url: v.preview_url || null,
		clonedByCount: v.cloned_by_count ?? null,
		usageCharacterCount1y: v.usage_character_count_1y ?? null,
		freeUsersAllowed: v.free_users_allowed !== false,
		labels: {
			gender: v.gender || null,
			accent: v.accent || null,
			age: v.age || null,
			use_case: v.use_case || null,
			descriptive: v.descriptive || null,
		},
	};
}

async function handleGet(req, res, apiKey) {
	const url = new URL(req.url, 'http://localhost');
	const pageSize = Math.min(
		MAX_PAGE_SIZE,
		Math.max(1, Number(url.searchParams.get('page_size')) || DEFAULT_PAGE_SIZE),
	);
	const page = Math.max(0, Number(url.searchParams.get('page')) || 0);

	const upstream = new URL(`${ELEVEN_BASE}/shared-voices`);
	upstream.searchParams.set('page_size', String(pageSize));
	upstream.searchParams.set('page', String(page));
	const q = (url.searchParams.get('q') || '').trim();
	if (q) upstream.searchParams.set('search', q);
	for (const f of FILTERS) {
		const value = (url.searchParams.get(f) || '').trim();
		if (value) upstream.searchParams.set(f, value);
	}

	let resp;
	try {
		resp = await fetch(upstream, {
			headers: { 'xi-api-key': apiKey },
			signal: AbortSignal.timeout(15_000),
		});
	} catch (e) {
		console.error('[tts/eleven/library] fetch failed', e);
		return error(res, 502, 'upstream_unreachable', 'Could not reach the ElevenLabs voice library');
	}
	if (!resp.ok) {
		const detail = await resp.text().catch(() => '');
		console.error('[tts/eleven/library] upstream error', resp.status, detail.slice(0, 300));
		return error(res, 502, 'upstream_error', `ElevenLabs returned ${resp.status}`);
	}

	const data = await resp.json();
	return json(
		res,
		200,
		{
			voices: (data.voices || []).map(normalize),
			has_more: Boolean(data.has_more),
			page,
			page_size: pageSize,
		},
		{ 'cache-control': 'private, max-age=300' },
	);
}

async function handlePost(req, res, apiKey, userId) {
	const rl = await limits.ttsSpeakUser(String(userId));
	if (!rl.success) return rateLimited(res, rl, 'Too many requests, try again later');

	const body = await readJson(req);
	const publicUserId = String(body.publicUserId || '').trim();
	const voiceId = String(body.voiceId || '').trim();
	const name = String(body.name || '').trim().slice(0, 64);

	if (!publicUserId) return error(res, 400, 'validation_error', 'publicUserId is required');
	if (!voiceId) return error(res, 400, 'validation_error', 'voiceId is required');
	if (!name) return error(res, 400, 'validation_error', 'name is required');

	let resp;
	try {
		resp = await fetch(
			`${ELEVEN_BASE}/voices/add/${encodeURIComponent(publicUserId)}/${encodeURIComponent(voiceId)}`,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json', 'xi-api-key': apiKey },
				body: JSON.stringify({ new_name: name }),
				signal: AbortSignal.timeout(20_000),
			},
		);
	} catch (e) {
		console.error('[tts/eleven/library] add failed', e);
		return error(res, 502, 'upstream_unreachable', 'Could not reach ElevenLabs');
	}

	if (!resp.ok) {
		// The quota and plan errors here are the ones users actually hit (voice
		// slots full, shared voice restricted to paid plans), so the upstream
		// detail is surfaced verbatim rather than flattened to "502".
		const detail = await resp.text().catch(() => '');
		let message = `ElevenLabs returned ${resp.status}`;
		try {
			const parsed = JSON.parse(detail);
			message = parsed?.detail?.message || parsed?.detail?.status || message;
		} catch {
			// Non-JSON body: keep the status-only message.
		}
		return error(res, resp.status === 401 ? 401 : 422, 'upstream_error', message);
	}

	const data = await resp.json().catch(() => ({}));
	invalidateVoiceCache();
	return json(res, 200, { voiceId: data.voice_id || voiceId, name });
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	if (!session && !bearer) return error(res, 401, 'unauthorized', 'sign in required');
	const userId = session?.id ?? bearer.userId;

	const { apiKey } = resolveElevenKey(req);
	if (!apiKey)
		return error(
			res,
			503,
			'not_configured',
			'ElevenLabs is not configured on this server. Send your own key in the x-eleven-key header to browse the library.',
		);

	return req.method === 'POST'
		? handlePost(req, res, apiKey, userId)
		: handleGet(req, res, apiKey);
});
