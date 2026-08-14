// GET /api/cron/x402-directory-registrar — keeps three.ws's paid x402
// endpoints registered (and their listings fresh) on the external x402
// directories that accept programmatic submission. Currently: 402index.io.
//
// Design — stateless, bounded, self-healing:
//   • 402index's POST /api/v1/register is an UPSERT keyed by url (verified:
//     re-registering returns the same service id and refreshes name /
//     description), and its public search does not reliably surface fresh
//     registrations — so presence-checking is pointless. Instead each hourly
//     tick re-upserts the next WINDOW of catalog entries under a rotating
//     cursor derived from the hour number. Every endpoint is (re)registered
//     every ~⌈catalog/WINDOW⌉ hours, new endpoints join the rotation the tick
//     after they enter the service catalog, and description drift on the
//     directory heals itself on the next pass.
//   • 402index rate-limits registration to 10/hour/IP; WINDOW=8 stays under.
//   • Each candidate is first probed against our own origin to confirm the
//     route is deployed. Registering a not-yet-deployed route burns a
//     rate-limited slot on a probe failure at their end.
//
// Registrar strategy + the manual surfaces (x402scan, Bazaar, PR-based lists):
// docs/x402-distribution.md. One-off/local batches: scripts/x402-register-directories.mjs.

import { json, wrapCron, method, error } from '../_lib/http.js';
import { getCatalog } from '../_lib/service-catalog/index.js';
import { requireCron } from '../_lib/cron-auth.js';

const FOUR02INDEX_REGISTER = 'https://402index.io/api/v1/register';
const WINDOW = 8;
const HOUR_MS = 3_600_000;

/**
 * Is this catalog endpoint actually deployed at our origin?
 *
 * The probe exists for exactly one reason: keep a not-yet-shipped route from
 * burning one of 402index's 10 registrations/hour. So the question it must
 * answer is "does this route exist", NOT "does a bare, parameterless request
 * come back 402". Those two differ for any endpoint whose paywall sits behind a
 * parameter: `/api/x402/vanity-premium` answers 200 to a bare GET (the free
 * inventory browse) and 402 only to `?address=<in-stock base58>` (the buy).
 * Demanding a bare 402 excluded every such paid endpoint from the directory
 * permanently and silently, on every hourly tick, forever, and the registrar has no
 * way to synthesize a valid paid request for an arbitrary endpoint, so there was
 * no tick on which it could ever have passed.
 *
 * An undeployed route answers a clean JSON 404 from our origin, so 404 / 5xx /
 * unreachable is the honest "not deployed" signal and every other status (402,
 * 200, 401, 405, …) proves the route is live and worth listing.
 *
 * @param {object} entry live x402 catalog entry
 * @returns {Promise<{ live: boolean, status?: number, reason?: string }>}
 */
export async function probeDeployed(entry) {
	try {
		const r = await fetch(entry.endpoint, {
			method: entry.method,
			headers: {
				accept: 'application/json',
				...(entry.method === 'POST' ? { 'content-type': 'application/json' } : {}),
			},
			...(entry.method === 'POST' ? { body: '{}' } : {}),
			signal: AbortSignal.timeout(10_000),
		});
		if (r.status === 404 || r.status >= 500) {
			return { live: false, status: r.status, reason: `origin_${r.status}` };
		}
		return { live: true, status: r.status };
	} catch {
		return { live: false, reason: 'origin_unreachable' };
	}
}

async function upsertAt402Index(entry) {
	const r = await fetch(FOUR02INDEX_REGISTER, {
		method: 'POST',
		headers: { 'content-type': 'application/json', accept: 'application/json' },
		body: JSON.stringify({
			url: entry.endpoint,
			name: `three.ws ${entry.slug}`,
			protocol: 'x402',
			description: entry.useCase,
		}),
		signal: AbortSignal.timeout(15_000),
	});
	const body = await r.text();
	return { ok: r.ok, status: r.status, body: body.slice(0, 200) };
}

/**
 * Which slice of the live paid catalog this hour re-upserts.
 *
 * The cursor is derived from the hour number rather than persisted, so the
 * rotation survives a cold start, a redeploy, and a skipped tick without any
 * state of its own: hour N always maps to the same window. Callers pass `nowMs`
 * so the mapping is testable without a clock.
 *
 * @param {Array<object>} candidates live x402 catalog entries
 * @param {number} nowMs epoch milliseconds
 * @param {number} [windowSize] entries per tick (402index rate-limits to 10/h/IP)
 * @returns {{ windows: number, cursor: number, batch: Array<object> }}
 */
export function registrarWindow(candidates, nowMs, windowSize = WINDOW) {
	// An empty catalog would make `% windows` a modulo by zero (NaN), which slices
	// to nothing and reports "window NaN/0". The handler refuses an empty catalog
	// outright; this keeps the pure function total regardless.
	const windows = Math.max(1, Math.ceil(candidates.length / windowSize));
	const cursor = Math.floor(nowMs / HOUR_MS) % windows;
	const start = cursor * windowSize;
	return { windows, cursor, batch: candidates.slice(start, start + windowSize) };
}

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET', 'POST'])) return;
	if (!requireCron(req, res)) return;

	const catalog = await getCatalog();
	const candidates = catalog.filter((e) => e.source === 'x402' && e.status === 'live');
	if (!candidates.length) {
		return error(res, 500, 'empty_catalog', 'paid catalog rendered empty — refusing to run');
	}

	const { windows, cursor, batch } = registrarWindow(candidates, Date.now());

	const results = [];
	for (const entry of batch) {
		const probe = await probeDeployed(entry);
		if (!probe.live) {
			results.push({ slug: entry.slug, action: 'skipped', reason: probe.reason });
			continue;
		}
		try {
			const r = await upsertAt402Index(entry);
			results.push({ slug: entry.slug, action: 'upserted', ok: r.ok, status: r.status, probe: probe.status });
			if (!r.ok) console.warn(`[x402-directory-registrar] ${entry.slug} → ${r.status} ${r.body}`);
		} catch (err) {
			results.push({ slug: entry.slug, action: 'error', error: err.message });
		}
	}

	return json(res, 200, {
		ok: true,
		directory: '402index',
		catalog_size: candidates.length,
		window: `${cursor + 1}/${windows}`,
		results,
	});
});
