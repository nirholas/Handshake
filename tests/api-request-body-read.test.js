// Guards against the drained-request-stream bug class.
//
// The Cloud Run server (server/index.mjs) runs express body parsers ahead of
// every api/ handler. They fully drain the raw request stream (preserving the
// bytes on req.rawBody), so any handler that reads the stream directly with
// `for await (... of req)` receives an EMPTY body in production while working
// fine in dev harnesses that skip the parsers. This broke every paid x402 POST
// endpoint for a month (zero settled forge payments ever) before being caught
// on 2026-07-25. Handlers must read bodies via readBody/readJson from
// api/_lib/http.js, which prefer req.rawBody.
//
// This test statically scans api/ for the anti-pattern. If you legitimately
// need a raw stream read (a route the server exempts from body parsing, e.g.
// multipart or a streaming proxy), add the file to ALLOWED with a comment
// saying why.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const API_ROOT = path.resolve(__dirname, '..', 'api');

// Files allowed to iterate the raw request stream. Keep this list justified.
const ALLOWED = new Set([
	// api/_lib/http.js itself: readBody's stream fallback for runtimes without
	// the express parsers (Vercel serverless, local harnesses, mcp-server).
	'_lib/http.js',
	// api/x402/auth-health.js: checks req.body first, so the stream read is a
	// dead fallback on Cloud Run and correct elsewhere.
	'x402/auth-health.js',
]);

const STREAM_READ = /for await \((?:const|let|var) \w+ of req\b/;

function walk(dir, out = []) {
	for (const name of readdirSync(dir)) {
		const p = path.join(dir, name);
		if (name === 'node_modules') continue;
		if (statSync(p).isDirectory()) walk(p, out);
		else if (name.endsWith('.js') || name.endsWith('.mjs')) out.push(p);
	}
	return out;
}

describe('api handlers do not read the drained request stream directly', () => {
	it('every body read goes through readBody/readJson (req.rawBody-aware)', () => {
		const offenders = [];
		for (const file of walk(API_ROOT)) {
			const rel = path.relative(API_ROOT, file);
			if (ALLOWED.has(rel)) continue;
			const src = readFileSync(file, 'utf8');
			if (STREAM_READ.test(src)) offenders.push(rel);
		}
		expect(
			offenders,
			`These api/ files read the raw request stream directly, which yields an empty body behind the Cloud Run body parsers. Use readBody/readJson from api/_lib/http.js instead: ${offenders.join(', ')}`,
		).toEqual([]);
	});
});
