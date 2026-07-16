/**
 * IRL Shareable Pin Cards — turn a placed agent into a rich, unfurlable link.
 *
 * POST /api/irl/share?pinId=<id>&deviceToken=<token>
 *   Body: raw PNG bytes (the composite AR photo captured client-side by
 *   src/irl/share-frame.js), content-type application/octet-stream (see the
 *   readBody() note in api/_lib/http.js for why octet-stream, not image/png).
 *   Caller must own the pin (session user OR device token, same ownership
 *   check as every other owner-gated /api/irl/pins mutation) and the pin must
 *   be public (an unpublished/hidden pin can't be turned into a public link —
 *   that would be a privacy downgrade the owner never asked for). Uploads the
 *   photo to R2 and mints a permanent token.
 *   → { token, url, imageUrl }
 *
 * GET /api/irl/share/[token].js serves the actual unfurl page for the token
 * this mints (og:image + a "Place your own agent" CTA) — see that file.
 *
 * The photo is the user's own real-world capture (their room, their street),
 * shared entirely at their own initiative — the same trust model as any
 * native camera-app share sheet. This endpoint adds no new privacy surface
 * beyond what the user just chose to photograph and explicitly tapped Share
 * on; it does NOT expose pin coordinates (the OG page only ever renders the
 * pin's caption/agent name, never lat/lng — see share/[token].js).
 */

import { wrap, cors, json, error, readBody } from '../_lib/http.js';
import { rateLimited } from '../_lib/http.js';
import { sql } from '../_lib/db.js';
import { getSessionUser } from '../_lib/auth.js';
import { readDeviceToken } from '../_lib/irl-auth.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { randomToken } from '../_lib/crypto.js';
import { putObject, publicUrl } from '../_lib/r2.js';
import { logIrlEvent, ensureIrlAnalyticsSchema, hashDeviceToken } from '../_lib/irl-analytics.js';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // a captured canvas PNG is typically a few hundred KB–2MB

function originFrom(req) {
	const host = req.headers['x-forwarded-host'] || req.headers.host || 'three.ws';
	const proto = req.headers['x-forwarded-proto'] || (/^localhost|127\.0\.0\.1/.test(host) ? 'http' : 'https');
	return `${proto}://${host}`;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS' })) return;
	if (req.method?.toUpperCase() !== 'POST') return error(res, 405, 'method_not_allowed', 'POST only');

	const ip = clientIp(req);
	const rl = await limits.irlShareIp(ip);
	if (!rl.success) return rateLimited(res, rl, 'Too many shares from this connection. Try again shortly.');

	const url = new URL(req.url, 'http://x');
	const pinId = (url.searchParams.get('pinId') || '').trim();
	if (!pinId) return error(res, 400, 'bad_request', 'pinId is required');

	const session = await getSessionUser(req).catch(() => null);
	const deviceToken = readDeviceToken(req);
	if (!session && !deviceToken) return error(res, 401, 'unauthorized', 'sign in or a device token is required');

	let bytes;
	try {
		bytes = await readBody(req, MAX_IMAGE_BYTES);
	} catch (err) {
		return error(res, err.status || 400, 'bad_request', err.message || 'could not read image body');
	}
	if (!bytes || bytes.length < 100) return error(res, 400, 'bad_request', 'a PNG image body is required');

	await ensureIrlAnalyticsSchema();

	const [pin] = await sql`
		SELECT id, lat, lng, caption, avatar_name, published, hidden_at, user_id, device_token
		FROM irl_pins WHERE id = ${pinId}::uuid
	`;
	if (!pin) return error(res, 404, 'not_found', 'pin not found');
	const owns =
		(session && pin.user_id === session.id) ||
		(deviceToken && pin.device_token === deviceToken);
	if (!owns) return error(res, 403, 'forbidden', 'you can only share your own placement');
	if (pin.published === false) return error(res, 409, 'not_shareable', 'unpublish this pin first if you want it private — a private pin can\'t be turned into a public link');
	if (pin.hidden_at) return error(res, 409, 'not_shareable', 'this pin is under review and can\'t be shared right now');

	const token = randomToken(16);
	const key = `irl-share/${token}.png`;

	try {
		await putObject({ key, body: bytes, contentType: 'image/png', metadata: { pinId } });
	} catch (err) {
		return error(res, 502, 'upload_failed', err?.message || 'could not store the share image');
	}

	const imageUrl = publicUrl(key);
	const deviceHash = await hashDeviceToken(deviceToken);
	await sql`
		INSERT INTO irl_pin_shares (pin_id, token, image_key, image_url, device_hash)
		VALUES (${pinId}::uuid, ${token}, ${key}, ${imageUrl}, ${deviceHash})
	`;

	await logIrlEvent({ type: 'share_created', pinId, lat: pin.lat, lng: pin.lng, deviceToken, metadata: { token } });

	const origin = originFrom(req);
	return json(res, 201, { token, url: `${origin}/irl/s/${token}`, imageUrl });
});
