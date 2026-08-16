/**
 * Size-capped remote image fetch for dynamic OG cards.
 *
 * Every OG handler that inlines a portrait does the same three things: fetch the
 * URL, base64 it, and drop it into an `<image href="data:...">`. The URL comes
 * from user-controlled profile data (`agent_identities.profile_image_url`,
 * an avatar thumbnail), so a naive `await resp.arrayBuffer()` lets any account
 * point a crawler-facing endpoint at an arbitrarily large body and pull all of it
 * into the render process. A 1200x630 portrait needs a few hundred KB at most.
 *
 * This helper is the one place that boundary is enforced:
 *   - only http(s) URLs are fetched at all,
 *   - the response must declare an image content type,
 *   - a declared content-length over the cap is rejected before reading a byte,
 *   - the body is streamed and abandoned the moment it crosses the cap, so a
 *     server that omits or lies about content-length cannot get past it either.
 *
 * It never throws. A dead host, a timeout, an HTML error page, or an oversized
 * body all return null, which every caller already renders as a monogram.
 */

/** A portrait that does not fit in 1.5 MB is not a portrait we want to inline. */
export const MAX_OG_IMAGE_BYTES = 1_500_000;

const DEFAULT_TIMEOUT_MS = 3000;

/**
 * @param {string|null|undefined} url  remote image URL (user-supplied)
 * @param {{ timeoutMs?: number, maxBytes?: number }} [opts]
 * @returns {Promise<{ ct: string, b64: string }|null>} inline-ready image, or null
 */
export async function fetchOgImage(url, opts = {}) {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxBytes = opts.maxBytes ?? MAX_OG_IMAGE_BYTES;

	if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null;

	try {
		const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
		if (!resp.ok) return null;

		const ct = resp.headers.get('content-type') || '';
		if (!/^image\//i.test(ct)) return null;

		const declared = Number(resp.headers.get('content-length') || 0);
		if (declared > maxBytes) return null;

		const bytes = await readCapped(resp, maxBytes);
		if (!bytes) return null;

		return { ct: ct.split(';')[0].trim(), b64: Buffer.from(bytes).toString('base64') };
	} catch {
		// A slow host, a DNS failure, or an aborted read is never worth a broken
		// unfurl. The caller draws its monogram instead.
		return null;
	}
}

/**
 * Read at most `maxBytes` from a fetch response, returning null the moment the
 * body proves larger. Falls back to a buffered read only when the runtime gave us
 * no stream to walk, in which case content-length above is the only guard left.
 */
async function readCapped(resp, maxBytes) {
	if (!resp.body || typeof resp.body.getReader !== 'function') {
		const buf = Buffer.from(await resp.arrayBuffer());
		return buf.byteLength > maxBytes ? null : buf;
	}

	const reader = resp.body.getReader();
	const chunks = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel();
				return null;
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock?.();
	}
	return Buffer.concat(chunks.map((c) => Buffer.from(c)), total);
}
