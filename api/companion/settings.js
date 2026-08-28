// GET   /api/companion/settings  → the user's companion configuration.
// PATCH /api/companion/settings  → update it.
// POST  /api/companion/settings  { rotate_token: true } → new bridge token.
//
// The bridge token is returned in full to its owner: it is what an iOS Shortcut
// or a Mac script posts with, so the setup page has to be able to show it.

import { z } from 'zod';
import { getRequestUser } from '../_lib/auth.js';
import { cors, json, method, wrap, error, readJson, rateLimited } from '../_lib/http.js';
import { requireCsrf } from '../_lib/csrf.js';
import { limits } from '../_lib/rate-limit.js';
import { parse } from '../_lib/validate.js';
import { getSettings, updateSettings, rotateIngestToken } from '../_lib/companion/store.js';
import { TTS_VOICE_IDS } from '../_lib/tts-voices.js';

const patchBody = z.object({
	enabled: z.boolean().optional(),
	threshold: z.number().int().min(0).max(100).optional(),
	quiet_start: z.number().int().min(0).max(23).nullable().optional(),
	quiet_end: z.number().int().min(0).max(23).nullable().optional(),
	timezone: z.string().min(1).max(64).optional(),
	avatar_glb_url: z.string().url().max(2048).nullable().optional(),
	voice: z.enum(TTS_VOICE_IDS).optional(),
	push_enabled: z.boolean().optional(),
});

const postBody = z.object({ rotate_token: z.literal(true) });

// The bridge URL is copy-pasted into an iOS Shortcut and a shell script, so it
// has to be the one that actually works from where the page was served. Behind
// the load balancer that is the forwarded proto; on a laptop talking to a local
// server over http, guessing https produced a URL whose every request died with
// ERR_SSL_PROTOCOL_ERROR, including the page's own "Send a test" button.
function originOf(req) {
	const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
	const proto = forwarded || (req.socket?.encrypted ? 'https' : 'http');
	return `${proto}://${req.headers.host || 'three.ws'}`;
}

function shape(row, req) {
	const origin = originOf(req);
	return {
		settings: {
			enabled: row.enabled,
			threshold: row.threshold,
			quiet_start: row.quiet_start,
			quiet_end: row.quiet_end,
			timezone: row.timezone,
			avatar_glb_url: row.avatar_glb_url,
			voice: row.voice,
			push_enabled: row.push_enabled,
			updated_at: row.updated_at,
		},
		bridge: {
			token: row.ingest_token,
			url: `${origin}/api/companion/ingest`,
		},
		voices: TTS_VOICE_IDS,
	};
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,PATCH,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'PATCH', 'POST'])) return;

	const user = await getRequestUser(req, res);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	if (req.method === 'GET') {
		const rl = await limits.companionRead(user.id);
		if (!rl.success) return rateLimited(res, rl);
		return json(res, 200, shape(await getSettings(user.id), req));
	}

	if (!(await requireCsrf(req, res, user.id))) return;
	const rl = await limits.companionWrite(user.id);
	if (!rl.success) return rateLimited(res, rl);

	const body = await readJson(req);

	if (req.method === 'POST') {
		parse(postBody, body);
		const token = await rotateIngestToken(user.id);
		return json(res, 200, shape({ ...(await getSettings(user.id)), ingest_token: token }, req));
	}

	const patch = parse(patchBody, body);
	// Quiet hours are a pair: setting one end without the other is refused by
	// the table constraint, so it is refused here with a message a human can act
	// on rather than a 500 from Postgres.
	const startGiven = patch.quiet_start !== undefined;
	const endGiven = patch.quiet_end !== undefined;
	if (startGiven !== endGiven) {
		return error(res, 400, 'validation_error', 'set quiet_start and quiet_end together, or send both as null');
	}
	if (startGiven && (patch.quiet_start === null) !== (patch.quiet_end === null)) {
		return error(res, 400, 'validation_error', 'quiet hours need both a start and an end');
	}
	return json(res, 200, shape(await updateSettings(user.id, patch), req));
});
