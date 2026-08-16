// Every share/verification surface in this batch is a GET-only read, and each
// one used to render its full response for ANY verb: a POST to /api/page-og or
// /api/play-og drove a complete satori rasterization, a POST to
// /api/oracle-share ran the database read plus a live pump.fun fetch, and
// /api/og-leaderboard answered with an untyped `method not allowed` text body
// that a consumer sniffs as HTML.
//
// This locks the gate: a non-GET is a 405 carrying the shared JSON error shape
// and an Allow header, decided before any renderer, database, or upstream call
// runs. Nothing here needs a network, so a rejected method is fully offline.

import { describe, it, expect } from 'vitest';

import pageOg from '../api/page-og.js';
import playOg from '../api/play-og.js';
import ogLeaderboard from '../api/og-leaderboard.js';
import provenance from '../api/provenance.js';
import oracleShare from '../api/oracle-share.js';

function collector() {
	const chunks = [];
	const headers = {};
	let statusCode = 200;
	return {
		res: {
			setHeader(k, v) { headers[k.toLowerCase()] = v; },
			getHeader(k) { return headers[k.toLowerCase()]; },
			end(buf) { if (buf) chunks.push(Buffer.from(buf)); },
			get statusCode() { return statusCode; },
			set statusCode(v) { statusCode = v; },
			get headersSent() { return false; },
			get writableEnded() { return false; },
		},
		read: () => ({ body: Buffer.concat(chunks).toString('utf8'), headers, statusCode }),
	};
}

const SURFACES = [
	['page-og', pageOg, '/api/page-og?t=Test'],
	['play-og', playOg, '/api/play-og'],
	['og-leaderboard', ogLeaderboard, '/api/og-leaderboard'],
	['provenance', provenance, '/api/provenance'],
	['oracle-share', oracleShare, '/api/oracle-share?mint=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump'],
];

describe('share surfaces reject non-GET methods', () => {
	for (const [name, handler, url] of SURFACES) {
		it(`${name} answers POST with a 405 JSON error`, async () => {
			const c = collector();
			await handler({ method: 'POST', url, headers: { host: 'three.ws' } }, c.res);
			const r = c.read();
			expect(r.statusCode).toBe(405);
			expect(String(r.headers['content-type'])).toContain('application/json');
			expect(String(r.headers.allow)).toContain('GET');
			expect(JSON.parse(r.body).error).toBe('method_not_allowed');
		});

		it(`${name} still advertises GET as allowed`, async () => {
			const c = collector();
			await handler({ method: 'DELETE', url, headers: { host: 'three.ws' } }, c.res);
			const r = c.read();
			expect(r.statusCode).toBe(405);
			expect(String(r.headers.allow)).toMatch(/GET/);
			expect(String(r.headers.allow)).toMatch(/HEAD/);
		});
	}
});
