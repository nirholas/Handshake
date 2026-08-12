// POST /api/avatars/thumbnail: upload a PNG poster for an existing avatar.
// Body: { avatar_id: uuid, png_base64: "data:image/png;base64,..." | "<raw base64>" }
// The caller must own the avatar OR be an admin (for the backfill script).
//
// PNGs are stored under thumb/<avatarId>.png in R2 and the avatars row's
// thumbnail_key is updated. The frontend then fetches via publicUrl() so the
// browser sees a 50KB PNG instead of a 5MB GLB.

import { sql } from '../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer, hasScope } from '../_lib/auth.js';
import { putObject, deleteObject, publicUrl } from '../_lib/r2.js';
import { cors, error, json, method, readJson, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { generateAltText } from '../_lib/avatar-alt-text.js';

const MAX_PNG_BYTES = 1_500_000; // 1.5 MB max, generous for 1024² posters.
const MIN_PNG_BYTES = 512; // a real poster is KBs; a 1×1 PNG is ~70 bytes.
const MIN_THUMB_DIM = 64; // reject 1px / degenerate posters; the gallery needs a real image.
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Read width/height from a PNG's IHDR chunk, which the spec fixes immediately
// after the 8-byte signature: [4-byte length][\"IHDR\"][4-byte width][4-byte
// height]. Returns null if the buffer is too short or isn't an IHDR-led PNG.
export function readPngSize(buf) {
	if (!Buffer.isBuffer(buf) || buf.length < 24) return null;
	if (!buf.subarray(0, 8).equals(PNG_HEADER)) return null;
	if (buf.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
	const width = buf.readUInt32BE(16);
	const height = buf.readUInt32BE(20);
	if (!width || !height) return null;
	return { width, height };
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in or provide a valid bearer token');

	const rl = await limits.upload(auth.userId);
	if (!rl.success) return rateLimited(res, rl, 'thumbnail upload rate exceeded');

	const body = await readJson(req).catch(() => null);
	const avatarId = body?.avatar_id;
	const pngB64 = body?.png_base64;

	if (!avatarId || typeof avatarId !== 'string' || avatarId.length > 100) {
		return error(res, 400, 'invalid_request', 'avatar_id required');
	}
	if (!pngB64 || typeof pngB64 !== 'string') {
		return error(res, 400, 'invalid_request', 'png_base64 required');
	}

	// Strip an optional "data:image/png;base64," prefix.
	const raw = pngB64.replace(/^data:image\/png;base64,/, '');
	let buf;
	try {
		buf = Buffer.from(raw, 'base64');
	} catch {
		return error(res, 400, 'invalid_request', 'png_base64 not valid base64');
	}
	if (buf.length < MIN_PNG_BYTES || buf.length > MAX_PNG_BYTES) {
		return error(res, 413, 'too_large', `png must be ${MIN_PNG_BYTES}..${MAX_PNG_BYTES} bytes`);
	}
	if (!buf.subarray(0, 8).equals(PNG_HEADER)) {
		return error(res, 400, 'invalid_request', 'body is not a PNG');
	}
	// Reject 1px / degenerate posters: a blank or 1×1 PNG passes the header check
	// but would publish an empty thumbnail to the gallery. Require a real image.
	const dims = readPngSize(buf);
	if (!dims || dims.width < MIN_THUMB_DIM || dims.height < MIN_THUMB_DIM) {
		return error(res, 422, 'thumbnail_too_small', `thumbnail must be at least ${MIN_THUMB_DIM}×${MIN_THUMB_DIM}px`);
	}

	// Look up the avatar; permit owner OR admin (admins are needed to backfill
	// thumbnails for legacy avatars whose owners may be inactive).
	const [row] = await sql`
		SELECT a.id, a.owner_id, a.name, a.thumbnail_key, u.is_admin
		FROM avatars a
		LEFT JOIN users u ON u.id = ${auth.userId}
		WHERE a.id = ${avatarId} AND a.deleted_at IS NULL
		LIMIT 1
	`;
	if (!row) return error(res, 404, 'not_found', 'avatar not found');
	const isOwner = row.owner_id === auth.userId;
	const isAdmin = row.is_admin === true;
	if (!isOwner && !isAdmin) return error(res, 403, 'forbidden', 'not your avatar');

	const key = `thumb/${avatarId}.png`;
	await putObject({
		key,
		body: buf,
		contentType: 'image/png',
		metadata: { 'avatar-id': avatarId, 'uploaded-by': auth.userId },
	});

	// If the avatar previously had a different thumbnail key, drop the old one.
	if (row.thumbnail_key && row.thumbnail_key !== key) {
		queueMicrotask(() => deleteObject(row.thumbnail_key).catch(() => {}));
	}

	await sql`
		UPDATE avatars
		SET thumbnail_key = ${key}, updated_at = now()
		WHERE id = ${avatarId}
	`;

	// Generate accessibility alt text from the poster we just received
	// (Consumer 3). Fire-and-forget on the buffer we already hold: no extra
	// fetch, no dependency on the object being publicly reachable yet, and it
	// never delays or fails the upload response (fail-open per generateAltText).
	queueMicrotask(async () => {
		try {
			const altText = await generateAltText({
				imageBase64: buf.toString('base64'),
				mimeType: 'image/png',
				name: row.name,
				track: { userId: auth.userId, avatarId },
			});
			if (altText) {
				await sql`UPDATE avatars SET alt_text = ${altText} WHERE id = ${avatarId}`;
			}
		} catch (e) {
			console.warn('[avatar-alt-text] generation failed', e?.message);
		}
	});

	return json(res, 200, {
		data: {
			avatar_id: avatarId,
			thumbnail_key: key,
			thumbnail_url: publicUrl(key),
			bytes: buf.length,
		},
	});
});

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (!bearer) return null;
	if (!hasScope(bearer.scope, 'avatars:write')) return null;
	return { userId: bearer.userId };
}
