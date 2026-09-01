// Same-origin, size-bounded URLs for remote artwork.
//
// Gallery cards paint stored renders (forge previews, marketplace art) into
// boxes a few hundred pixels wide, but the stored file is the full-resolution
// render: a 1 MB PNG per card was normal on /forge. /api/img resizes on the
// server (snapped to a fixed width ladder, re-encoded as WebP, cached
// immutably at the edge), so a card fetches ~20-40 KB instead. Pass the width
// the box paints at 2x; the endpoint rounds up to its ladder.
//
// Only remote http(s) sources go through the proxy. Same-origin paths,
// data: and blob: URLs are returned untouched: they are already local, or
// they are a capture the page just produced.
const PROXY_PATH = '/api/img';

export function resizedImageUrl(url, width) {
	if (typeof url !== 'string' || !url) return url;
	if (!/^https?:\/\//i.test(url)) return url;
	try {
		if (typeof location !== 'undefined' && new URL(url).origin === location.origin) return url;
	} catch {
		return url;
	}
	const w = Math.max(1, Math.round(Number(width) || 0));
	const params = new URLSearchParams({ url });
	if (w > 1) params.set('w', String(w));
	return `${PROXY_PATH}?${params}`;
}
