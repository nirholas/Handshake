/**
 * Glance card, as a PNG.
 * ----------------------
 * Android's RemoteViews, WidgetKit, and every other native widget host takes
 * a bitmap and nothing else: no SVG, no HTML, no WebGL. This module turns the
 * SVG encoding of a glance card into that bitmap with sharp (librsvg under the
 * hood), which is a few milliseconds of CPU rather than a chromium boot, and
 * which the API container already ships for thumbnails.
 *
 * Two things the SVG renderer leaves to the browser have to be settled here:
 *
 *   1. The avatar image. librsvg does not fetch over the network, so the
 *      thumbnail is pulled once and inlined as a data URI. A thumbnail that
 *      cannot be fetched in time degrades to the monogram, which is the same
 *      fallback every other renderer uses; the card never fails on its image.
 *   2. The theme. There is no reader to honour `prefers-color-scheme`, so
 *      `auto` resolves to dark, which is the palette a home screen widget
 *      sits on in every launcher's default look.
 *
 * Rendered bitmaps for real agents are cached in R2 on a stable key with the
 * card's ETag in the object metadata: a stale object is overwritten in place
 * rather than piling up one key per metric change, and a cache that is not
 * configured or not reachable simply means rendering again, never an error.
 */

import sharp from 'sharp';
import { renderGlanceSvg, GLANCE_SIZES } from './glance-svg.js';
import { glanceEtag } from './glance-card.js';
import { getObjectWithMetadata, objectStorageConfigured, putObject } from './r2.js';

// Scale 2 is the density a modern phone draws at; 3 covers xxhdpi without the
// bitmap outgrowing what RemoteViews will ship across Binder.
export const GLANCE_PNG_SCALES = [1, 2, 3];
const DEFAULT_SCALE = 2;
const IMAGE_TIMEOUT_MS = 6000;
const IMAGE_MAX_BYTES = 4 * 1024 * 1024;
const CACHE_PREFIX = 'glance/png/v1';

/**
 * Resolve the query-string knobs a PNG caller can set.
 * @param {URLSearchParams} params
 */
export function pngOptions(params) {
	const size = GLANCE_SIZES[params.get('size')] ? params.get('size') : 'medium';
	const theme = params.get('theme') === 'light' ? 'light' : 'dark';
	const scale = GLANCE_PNG_SCALES.includes(Number(params.get('scale')))
		? Number(params.get('scale'))
		: DEFAULT_SCALE;
	return { size, theme, scale };
}

/**
 * Fetch the card's thumbnail and return it as a data URI, or null when it
 * cannot be had within budget. The URL is the platform's own CDN (it came out
 * of thumbnailUrl()), so this is a first-party fetch, not user input.
 */
async function inlineImage(url) {
	if (!url) return null;
	try {
		const res = await fetch(url, {
			signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
			headers: { accept: 'image/*' },
		});
		if (!res.ok) return null;
		const type = res.headers.get('content-type') || '';
		if (!type.startsWith('image/')) return null;
		const length = Number(res.headers.get('content-length') || 0);
		if (length > IMAGE_MAX_BYTES) return null;
		const bytes = Buffer.from(await res.arrayBuffer());
		if (bytes.length > IMAGE_MAX_BYTES) return null;
		// librsvg decodes PNG and JPEG data URIs; anything else (WebP, AVIF) is
		// transcoded so the portrait never comes out as an empty square.
		const mime = type.split(';')[0].trim();
		if (mime === 'image/png' || mime === 'image/jpeg') {
			return `data:${mime};base64,${bytes.toString('base64')}`;
		}
		const png = await sharp(bytes).png().toBuffer();
		return `data:image/png;base64,${png.toString('base64')}`;
	} catch {
		return null;
	}
}

/**
 * Rasterize a card. Pure apart from the thumbnail fetch: no cache, no
 * database, so the tests can run it against a built card.
 *
 * @param {object} card a model from buildGlanceCard() or noticeCard()
 * @param {{ size?: string, theme?: 'light'|'dark', scale?: number }} [opts]
 * @returns {Promise<{ png: Buffer, width: number, height: number }>}
 */
export async function rasterizeGlanceCard(card, { size = 'medium', theme = 'dark', scale = DEFAULT_SCALE } = {}) {
	const dim = GLANCE_SIZES[size] || GLANCE_SIZES.medium;
	const image = await inlineImage(card.image);
	const svg = renderGlanceSvg({ ...card, image }, { size, theme });
	const png = await sharp(Buffer.from(svg), { density: 72 * scale })
		.resize(dim.w * scale, dim.h * scale)
		.png({ compressionLevel: 9 })
		.toBuffer();
	return { png, width: dim.w * scale, height: dim.h * scale };
}

function cacheKey(card, { size, theme, scale }) {
	return `${CACHE_PREFIX}/${card.id}/${size}-${theme}-${scale}x.png`;
}

/**
 * The PNG for a real agent card, through the R2 cache. Notice cards (id
 * "notice") are rendered every time: they carry no image and take a
 * millisecond, and caching them would mean one key per message.
 *
 * @returns {Promise<{ png: Buffer, width: number, height: number, etag: string, cache: 'hit'|'miss'|'off' }>}
 */
export async function glancePng(card, opts) {
	const etag = await glanceEtag(card);
	// Object metadata travels as an HTTP header, so the stamp is the ETag's
	// digest alone, without the weak-validator prefix and quotes.
	const stamp = etag.replace(/[^a-z0-9-]/gi, '');
	const dim = GLANCE_SIZES[opts.size] || GLANCE_SIZES.medium;
	const cacheable = card.id !== 'notice' && card.id !== 'missing' && objectStorageConfigured();
	const key = cacheable ? cacheKey(card, opts) : null;

	if (key) {
		try {
			const hit = await getObjectWithMetadata(key);
			if (hit && hit.metadata.etag === stamp && hit.body.length > 0) {
				return { png: hit.body, width: dim.w * opts.scale, height: dim.h * opts.scale, etag, cache: 'hit' };
			}
		} catch {
			/* a cache read failure is a miss, never a failed card */
		}
	}

	const rendered = await rasterizeGlanceCard(card, opts);
	if (key) {
		// Written after the bytes are in hand and served from those same bytes:
		// nothing ever points at this key before the object exists, which is the
		// thumbnail rule (docs/avatar-thumbnails.md) applied to a cache.
		putObject({ key, body: rendered.png, contentType: 'image/png', metadata: { etag: stamp } }).catch(() => {});
	}
	return { ...rendered, etag, cache: key ? 'miss' : 'off' };
}
