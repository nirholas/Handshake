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
//   • Each candidate is first probed against our own origin for a live 402 —
//     registering a not-yet-deployed route burns a rate-limited slot on a
//     probe failure at their end.
//
// Registrar strategy + the manual surfaces (x402scan, Bazaar, PR-based lists):
// docs/x402-distribution.md. One-off/local batches: scripts/x402-register-directories.mjs.

import { json, wrapCron, method, error } from '../_lib/http.js';
import { getCatalog } from '../_lib/service-catalog/index.js';
import { requireCron } from '../_lib/cron-auth.js';

const FOUR02INDEX_REGISTER = 'https://402index.io/api/v1/register';
const WINDOW = 8;
const HOUR_MS = 3_600_000;

async function serves402(entry) {
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
		return r.status === 402;
	} catch {
		return false;
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
		const live = await serves402(entry);
		if (!live) {
			results.push({ slug: entry.slug, action: 'skipped', reason: 'no_402_in_production' });
			continue;
		}
		try {
			const r = await upsertAt402Index(entry);
			results.push({ slug: entry.slug, action: 'upserted', ok: r.ok, status: r.status });
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
