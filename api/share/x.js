/**
 * Share a Walk capture to X
 * --------------------------
 * POST /api/share/x?avatar=<id>&text=<optional caption>
 *
 * Body: the raw media bytes (image/png for a screenshot, video/mp4 for a clip).
 * The Content-Type header carries the media type. Authenticated with the
 * caller's three.ws session; the post is published through their connected X
 * account using the real X API v2 (media chunked-upload → create tweet with the
 * media attached). See api/_lib/x-post.js for the upload + publish plumbing.
 *
 * No connected X account → 409 not_connected with a connect_url the client can
 * route the user to (/api/auth/x/connect). The OAuth scope requested there
 * includes media.write so the upload is authorized. An X token that can no
 * longer be refreshed (reauth_required) takes the same 409 + connect_url shape:
 * it is the same recovery, and answering 401 there would collide with this
 * endpoint's own auth_required and send a signed-in user to /login instead.
 */

import { cors, method, wrap, error, json, readBody } from '../_lib/http.js';
import { getSessionUser, isSameSiteOrigin } from '../_lib/auth.js';
import { env } from '../_lib/env.js';
import { publishTweet, XPostError, MAX_TWEET_LEN } from '../_lib/x-post.js';

// X media ceilings we enforce up front so an oversized body fails fast with a
// clear message instead of deep inside the chunked upload.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB (X still image limit)
const MAX_VIDEO_BYTES = 64 * 1024 * 1024; // 64 MB, generous for a 10s 1080p clip
const ALLOWED = {
	'image/png': { kind: 'image', max: MAX_IMAGE_BYTES },
	'image/jpeg': { kind: 'image', max: MAX_IMAGE_BYTES },
	'image/gif': { kind: 'image', max: MAX_IMAGE_BYTES },
	'video/mp4': { kind: 'video', max: MAX_VIDEO_BYTES },
};

// Dev convenience: the vite dev server runs on localhost, so allow it past the
// same-site CSRF guard outside production (mirrors the CORS allowlist policy).
function isTrustedOrigin(req) {
	if (isSameSiteOrigin(req)) return true;
	if (process.env.NODE_ENV === 'production') return false;
	const origin = req.headers.origin || '';
	return /^https?:\/\/localhost(:\d+)?$/.test(origin);
}

function captionFor(avatarId, override) {
	if (override) return override.slice(0, MAX_TWEET_LEN);
	const url = avatarId
		? `three.ws/walk?avatar=${avatarId}`
		: 'three.ws/walk';
	return `I walked my avatar around three.ws. Try yours: ${url}`;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	if (!isTrustedOrigin(req)) {
		return error(res, 403, 'forbidden', 'cross-site request rejected');
	}

	const user = await getSessionUser(req, res);
	if (!user) {
		return json(res, 401, {
			error: 'auth_required',
			error_description: 'sign in to three.ws to share to X',
			login_url: '/login',
		});
	}

	const contentType = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
	const spec = ALLOWED[contentType];
	if (!spec) {
		return error(res, 415, 'unsupported_media_type', 'body must be image/png, image/jpeg, image/gif or video/mp4');
	}

	let buffer;
	try {
		buffer = await readBody(req, spec.max);
	} catch (err) {
		if (err?.status === 413) {
			const mb = Math.round(spec.max / (1024 * 1024));
			return error(res, 413, 'too_large', `${spec.kind} exceeds the ${mb} MB limit`);
		}
		throw err;
	}
	if (!buffer || buffer.length === 0) {
		return error(res, 400, 'empty_body', 'no media in request body');
	}

	const url = new URL(req.url, env.APP_ORIGIN);
	const avatarId = (url.searchParams.get('avatar') || '').trim().slice(0, 64);
	const text = captionFor(avatarId, (url.searchParams.get('text') || '').trim());

	try {
		const result = await publishTweet({
			userId: user.id,
			text,
			mediaBuffer: buffer,
			mediaMimeType: contentType,
		});
		return json(res, 200, { ok: true, ...result });
	} catch (err) {
		if (err instanceof XPostError) {
			const extra = { ...err.extra };
			const needsConnect = err.code === 'not_connected' || err.code === 'reauth_required';
			if (needsConnect) {
				extra.connect_url = '/api/auth/x/connect';
			}
			return json(res, needsConnect ? 409 : err.status, {
				error: err.code,
				error_description: err.message,
				...extra,
			});
		}
		throw err;
	}
});
