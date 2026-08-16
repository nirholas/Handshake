/**
 * Forge poster — attach a client-rendered thumbnail to a creation.
 *
 *   POST /api/forge-poster   { creation_id, image }   (image: data URL)
 *
 * Image-intermediate engines store their flux reference image as the
 * creation's preview, but the geometry-first and sketch lanes paint no image
 * at all — their gallery and showcase cards rendered as glyph placeholders.
 * After the finished GLB loads, the browser renders the actual mesh to a
 * small webp and posts it here; the store uploads it to object storage and
 * fills the row's empty preview slot.
 *
 * Fill-only and owner-scoped: a row that already has a preview keeps it (the
 * reference image is half of the training pair), and writes only match rows
 * created by the same anonymous client key (x-forge-client header). When the
 * store is unconfigured this returns a clean { ok: false } — same contract as
 * /api/forge-feedback.
 */

import { cors, json, method, readJson, wrap, rateLimited } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { hashClient, attachPoster, forgeStoreEnabled } from './_lib/forge-store.js';
import { isUuid } from './_lib/validate.js';

// Posters are 640px webp/png/jpeg renders — ~30-80 KB typical. The caps leave
// generous headroom without letting the endpoint ingest arbitrary blobs.
const MAX_POSTER_BYTES = 1_500_000;
const MAX_BODY_BYTES = 2_500_000; // base64 inflation + JSON envelope

const DATA_URL_RE = /^data:image\/(webp|png|jpeg);base64,([A-Za-z0-9+/=]+)$/;
const EXT_BY_TYPE = { webp: 'webp', png: 'png', jpeg: 'jpg' };

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;

	const rl = await limits.mcp3dStatus(clientIp(req));
	if (!rl.success) {
		return rateLimited(res, rl);
	}

	if (!forgeStoreEnabled()) {
		return json(res, 200, { ok: false, stored: false, reason: 'persistence_unconfigured' });
	}

	const body = await readJson(req, MAX_BODY_BYTES).catch(() => null);
	const creationId = typeof body?.creation_id === 'string' ? body.creation_id.trim() : '';
	if (!isUuid(creationId)) {
		return json(res, 400, { error: 'invalid_creation', message: 'creation_id must be a uuid.' });
	}

	const match = DATA_URL_RE.exec(typeof body?.image === 'string' ? body.image : '');
	if (!match) {
		return json(res, 400, {
			error: 'invalid_image',
			message: 'image must be a base64 data URL (webp, png, or jpeg).',
		});
	}
	const [, subtype, base64] = match;
	const buf = Buffer.from(base64, 'base64');
	if (buf.length === 0 || buf.length > MAX_POSTER_BYTES) {
		return json(res, 400, {
			error: 'invalid_image',
			message: `Poster must be between 1 and ${MAX_POSTER_BYTES} bytes.`,
		});
	}

	const rawClient = req.headers['x-forge-client'];
	const clientKey = hashClient(Array.isArray(rawClient) ? rawClient[0] : rawClient);

	const url = await attachPoster({
		id: creationId,
		clientKey,
		body: buf,
		contentType: `image/${subtype}`,
		ext: EXT_BY_TYPE[subtype],
	});

	// `stored: false` covers all benign no-ops — row not found for this client,
	// or the creation already has a preview. Not an error worth a 4xx.
	return json(res, 200, { ok: true, stored: Boolean(url), preview_image_url: url });
});
