// Tests for the x402 ring catalog — the single source of truth for every paid
// endpoint on three.ws (api/_lib/x402/ring-catalog.js) and the rotation the ring
// drivers walk. Pure logic + a filesystem scan; no DB, no chain, no network.
//
// What these lock down:
//   • schema — every entry is structurally valid and its body()/query matches its
//     method, so a rotation call never spends money on a malformed request.
//   • 100% coverage — every `paidEndpoint(` construction site in api/ is cataloged
//     (a new paid endpoint fails this test until it is added).
//   • stale paths — every path resolves to a real handler file under api/.
//   • hourly coverage — the wired rotation touches every autobuy slug within a
//     simulated default-cadence hour.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
	RING_CATALOG,
	autobuyEntries,
	rotationPlan,
	bySlug,
	AUTONOMOUS_TICKS_PER_HOUR,
	RING_CANARY_MINT,
	RING_CANARY_UUID,
} from '../api/_lib/x402/ring-catalog.js';

const KINDS = new Set(['tip', 'service', 'intel', 'health', 'commerce', 'settle']);
const TIERS = new Set(['settle', 'commerce', 'intel', 'service', 'health']);

describe('ring-catalog schema', () => {
	it('every entry is structurally valid', () => {
		for (const e of RING_CATALOG) {
			expect(typeof e.slug, `${e.slug} slug`).toBe('string');
			expect(e.slug.length, `${e.slug} slug non-empty`).toBeGreaterThan(0);
			expect(typeof e.sourceFile, `${e.slug} sourceFile`).toBe('string');
			expect(e.path.startsWith('/api/'), `${e.slug} path`).toBe(true);
			expect(['GET', 'POST'].includes(e.method), `${e.slug} method`).toBe(true);
			expect(KINDS.has(e.kind), `${e.slug} kind=${e.kind}`).toBe(true);
			expect(TIERS.has(e.tier), `${e.slug} tier=${e.tier}`).toBe(true);
			expect(Number.isInteger(e.priceAtomicDefault), `${e.slug} price int`).toBe(true);
			expect(e.priceAtomicDefault, `${e.slug} price >= 0`).toBeGreaterThanOrEqual(0);
			expect(typeof e.priceSlug, `${e.slug} priceSlug`).toBe('string');
			expect(typeof e.autobuy, `${e.slug} autobuy`).toBe('boolean');
			expect(typeof e.body, `${e.slug} body is fn`).toBe('function');
			expect(typeof e.businessEffect, `${e.slug} businessEffect`).toBe('string');
			expect(e.businessEffect.length, `${e.slug} businessEffect non-empty`).toBeGreaterThan(0);
		}
	});

	it('slugs are unique', () => {
		const slugs = RING_CATALOG.map((e) => e.slug);
		expect(new Set(slugs).size).toBe(slugs.length);
	});

	it('body() returns parseable JSON for POST and null for GET', () => {
		for (const e of RING_CATALOG) {
			const body = e.body();
			if (e.method === 'GET') {
				expect(body, `${e.slug} GET body null`).toBeNull();
			} else {
				expect(body, `${e.slug} POST body object`).toBeTypeOf('object');
				expect(body, `${e.slug} POST body non-null`).not.toBeNull();
				// Round-trips through JSON without throwing.
				expect(() => JSON.parse(JSON.stringify(body))).not.toThrow();
			}
		}
	});

	it('GET entries with query params carry a plain-object query', () => {
		for (const e of RING_CATALOG) {
			if (e.query !== undefined) {
				expect(e.method, `${e.slug} query only on GET`).toBe('GET');
				expect(e.query, `${e.slug} query object`).toBeTypeOf('object');
				for (const [k, v] of Object.entries(e.query)) {
					expect(['string', 'number'].includes(typeof v), `${e.slug} query.${k} scalar`).toBe(true);
				}
			}
		}
	});

	it('autobuy entries carry a positive weight; non-autobuy entries justify themselves', () => {
		for (const e of RING_CATALOG) {
			if (e.autobuy) {
				expect(e.weight, `${e.slug} autobuy weight >= 1`).toBeGreaterThanOrEqual(1);
			} else {
				expect(typeof e.note, `${e.slug} autobuy:false needs a note`).toBe('string');
				expect(e.note.length, `${e.slug} note non-empty`).toBeGreaterThan(0);
			}
		}
	});

	it('canary identifiers are well-formed and inert', () => {
		// A valid base58 pump-style mint (32–44 chars, no 0/O/I/l) that maps to no
		// real coin-world, so a looped billboard buy writes an inert placement.
		expect(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(RING_CANARY_MINT)).toBe(true);
		// A well-formed v4 UUID that resolves to no registered agent.
		expect(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(RING_CANARY_UUID)).toBe(true);
	});

	it('bySlug resolves every entry and returns null for unknown', () => {
		for (const e of RING_CATALOG) expect(bySlug(e.slug)).toBe(e);
		expect(bySlug('does-not-exist')).toBeNull();
	});
});

// ── 100% coverage: every paidEndpoint( construction site is cataloged ─────────

// Walk api/ and return every .js file that constructs a paidEndpoint, as a set of
// repo-relative paths. A construction site is `= paidEndpoint(`, `default
// paidEndpoint(`, or `return paidEndpoint(` — the helper's own definition file is
// excluded.
function paidEndpointSites() {
	const root = process.cwd();
	const CONSTRUCT = /(?:=|default|return)\s*paidEndpoint\s*\(/;
	const sites = new Set();
	const walk = (dir) => {
		for (const name of readdirSync(dir)) {
			const full = join(dir, name);
			const st = statSync(full);
			if (st.isDirectory()) {
				if (name === 'node_modules') continue;
				walk(full);
			} else if (name.endsWith('.js')) {
				const rel = full.slice(root.length + 1);
				if (rel === 'api/_lib/x402-paid-endpoint.js') continue; // the helper itself
				const src = readFileSync(full, 'utf8');
				if (CONSTRUCT.test(src)) sites.add(rel);
			}
		}
	};
	walk(join(root, 'api'));
	return sites;
}

// Construction sites that are intentionally NOT ring-catalog entries.
//   api/_lib/aggregator.js builds the dynamic /api/v1/x/<provider>/<endpoint>
//   API-aggregator proxy family per descriptor — a separate product surface, not
//   a fixed ring endpoint.
const SITE_ALLOWLIST = new Set(['api/_lib/aggregator.js']);

describe('ring-catalog covers 100% of paid endpoints', () => {
	it('every paidEndpoint( construction site is in the catalog', () => {
		const sites = paidEndpointSites();
		const cataloged = new Set(RING_CATALOG.map((e) => e.sourceFile));
		const missing = [...sites].filter((f) => !SITE_ALLOWLIST.has(f) && !cataloged.has(f));
		expect(missing, `uncataloged paid endpoints: ${missing.join(', ')}`).toEqual([]);
	});

	it('every catalog sourceFile is a real file under api/', () => {
		for (const e of RING_CATALOG) {
			expect(existsSync(e.sourceFile), `${e.slug} sourceFile ${e.sourceFile}`).toBe(true);
			expect(e.sourceFile.startsWith('api/'), `${e.slug} sourceFile under api/`).toBe(true);
		}
	});
});

// ── stale-path: every path resolves to a handler file under api/ ───────────────

describe('ring-catalog paths resolve', () => {
	it('every path maps to a real handler file (api<path>.js)', () => {
		for (const e of RING_CATALOG) {
			expect(existsSync(`.${e.path}.js`), `${e.slug} -> .${e.path}.js`).toBe(true);
		}
	});
});

// ── hourly rotation coverage ───────────────────────────────────────────────────

describe('rotation covers every autobuy endpoint within an hour', () => {
	it('rotationPlan includes every autobuy slug at least once', () => {
		const plan = rotationPlan();
		const covered = new Set(plan.map((e) => e.slug));
		for (const e of autobuyEntries()) {
			expect(covered.has(e.slug), `${e.slug} in rotation plan`).toBe(true);
		}
		// weighted entries appear `weight` times.
		for (const e of autobuyEntries()) {
			const n = plan.filter((p) => p.slug === e.slug).length;
			expect(n, `${e.slug} appears weight times`).toBe(e.weight);
		}
	});

	it('a simulated default-cadence hour selects every autobuy slug', () => {
		const plan = rotationPlan();
		// Match volume-shared.reserveWindow: a cursor advances by the batch each
		// tick, indices taken modulo the rotation length. Default cadence:
		// AUTONOMOUS_TICKS_PER_HOUR ticks × batch selections/tick. The fallback
		// mirrors VOLUME_BATCH_PER_RUN's default in pipelines/volume-shared.js.
		const BATCH = Number(process.env.X402_VOLUME_BATCH_PER_RUN || 6);
		const callsPerHour = AUTONOMOUS_TICKS_PER_HOUR * BATCH;
		expect(callsPerHour, 'calls/hour >= rotation length').toBeGreaterThanOrEqual(plan.length);

		const seen = new Set();
		let cursor = 0;
		for (let tick = 0; tick < AUTONOMOUS_TICKS_PER_HOUR; tick++) {
			for (let i = 0; i < BATCH; i++) {
				seen.add(plan[cursor % plan.length].slug);
				cursor++;
			}
		}
		const missed = autobuyEntries().map((e) => e.slug).filter((s) => !seen.has(s));
		expect(missed, `slugs never selected in an hour: ${missed.join(', ')}`).toEqual([]);
	});
});

// ── the wired rotation (volume-shared) reflects the catalog ────────────────────

describe('volume-shared rotation is catalog-derived', () => {
	it('VOLUME_ENDPOINTS mirrors the autobuy rotation, GET query baked into path', async () => {
		const { VOLUME_ENDPOINTS, RING_SETTLE_ENDPOINT, CHEAP_ENDPOINTS } = await import(
			'../api/_lib/x402/pipelines/volume-shared.js'
		);
		const plan = rotationPlan();
		expect(VOLUME_ENDPOINTS.length).toBe(plan.length);

		// ring-settle is the settle carrier; everything else is "cheap".
		expect(RING_SETTLE_ENDPOINT?.key).toBe('ring-settle');
		expect(CHEAP_ENDPOINTS.some((e) => e.key === 'ring-settle')).toBe(false);

		for (const ve of VOLUME_ENDPOINTS) {
			const entry = bySlug(ve.key);
			expect(entry, `${ve.key} maps to a catalog entry`).toBeTruthy();
			expect(ve.method).toBe(entry.method);
			// GET → query in path, null body; POST → object body, no query in path.
			if (entry.method === 'GET') {
				expect(ve.body).toBeNull();
				if (entry.query) expect(ve.path.includes('?')).toBe(true);
			} else {
				expect(ve.body).toBeTypeOf('object');
				expect(ve.path.includes('?')).toBe(false);
			}
		}
	});
});
