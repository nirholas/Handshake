/**
 * Client country resolution for cookieless analytics
 * --------------------------------------------------
 * Returns an ISO 3166-1 alpha-2 country code for a request, or null.
 *
 * The country is read from a geo header set by the edge that terminated the
 * connection. It is never derived from the raw client IP, so nothing here
 * touches or stores an address: analytics callers only ever persist the
 * two-letter code.
 *
 * Header priority, most-trusted edge first:
 *   1. x-client-geo-location  Google Cloud external Application Load Balancer.
 *                             Value is comma-joined, region first, e.g.
 *                             "US,Mountain View" or "US,California,Mountain View".
 *   2. x-client-region        A GCLB custom request header populated with the
 *                             {client_region} variable on the backend service.
 *   3. cf-ipcountry           Cloudflare, for any origin fronted by it.
 *   4. x-vercel-ip-country    Vercel, for preview deployments still on it.
 *
 * three.ws production serves from Cloud Run behind the GCLB, so 1 and 2 are the
 * live lanes; see docs/ops/gcp-production.md for the backend-service header
 * setup that populates them.
 *
 * Every value is validated down to two ASCII letters before it is returned, so
 * a client that forges one of these headers can at worst mislabel its own row
 * with a well-formed code. It can no longer write unbounded attacker-chosen
 * text into an analytics column.
 */

const GEO_HEADERS = [
	'x-client-geo-location',
	'x-client-region',
	'cf-ipcountry',
	'x-vercel-ip-country',
];

// Cloudflare returns XX when it cannot geolocate and T1 for Tor exit nodes.
// Both are well-formed but carry no country, so they resolve to null.
const NOT_A_COUNTRY = new Set(['XX', 'T1']);

export function clientCountry(req) {
	for (const name of GEO_HEADERS) {
		const code = normalizeCountry(headerOnce(req?.headers, name));
		if (code) return code;
	}
	return null;
}

export function normalizeCountry(raw) {
	if (typeof raw !== 'string') return null;
	// x-client-geo-location packs region and city into one comma-joined value.
	const region = raw.split(',')[0].trim().toUpperCase();
	if (!/^[A-Z]{2}$/.test(region)) return null;
	return NOT_A_COUNTRY.has(region) ? null : region;
}

function headerOnce(headers, name) {
	const v = headers?.[name];
	if (Array.isArray(v)) return v[0] ?? null;
	return v ?? null;
}
