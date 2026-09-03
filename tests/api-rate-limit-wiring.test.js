// Static wiring checks for the two rate-limit mistakes that produce a 500 on a
// plain GET and cannot be caught by reading the handler in isolation.
//
// /api/oracle/model shipped `rateLimited(req, res, limits.publicRead, ip)` for
// as long as the endpoint existed. Two independent bugs in one line: the helper
// takes (res, result), so `res` bound to the request object and the first
// header write threw "res.setHeader is not a function"; and `limits.publicRead`
// has never been defined, so the limiter argument was undefined anyway. The
// endpoint answered 500 to every caller, and the Oracle Lab page that reads it
// rendered its error state instead of the model.
//
// Both are shape errors a linter cannot see and a unit test only catches if
// someone writes one per handler. Checking them across api/** costs one pass.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { limits } from '../api/_lib/rate-limit.js';

const API_DIR = new URL('../api/', import.meta.url).pathname;

function jsFilesUnder(dir) {
	const out = [];
	for (const entry of readdirSync(dir)) {
		if (entry === 'node_modules') continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...jsFilesUnder(full));
		else if (entry.endsWith('.js')) out.push(full);
	}
	return out;
}

const FILES = jsFilesUnder(API_DIR).map((f) => [f.slice(API_DIR.length), readFileSync(f, 'utf8')]);

describe('rate-limit wiring across api/**', () => {
	it('finds handler files to check, so a broken walk cannot pass vacuously', () => {
		expect(FILES.length).toBeGreaterThan(100);
	});

	// rateLimited(res, result) writes headers on its first argument. Passing the
	// request there throws on the first setHeader and the handler 500s.
	it('never calls rateLimited with the request as its first argument', () => {
		const offenders = FILES.filter(([, src]) => /\brateLimited\(\s*req\b/.test(src)).map(([name]) => name);
		expect(offenders).toEqual([]);
	});

	// A limiter that does not exist reads as `undefined` at the call site and
	// silently disables the limit rather than failing loudly. Only files that
	// bind the rate-limit module's export to the bare name `limits` are checked:
	// several handlers keep their own unrelated `limits` object (plan quotas,
	// retention windows) and one of them aliases the import to `rateLimits`.
	it('only references limiters that api/_lib/rate-limit.js actually exports', () => {
		const known = new Set(Object.keys(limits));
		const unknown = [];
		for (const [name, src] of FILES) {
			if (!/import\s*\{[^}]*\blimits\b(?!\s+as)[^}]*\}\s*from\s*'[^']*rate-limit\.js'/.test(src)) continue;
			for (const m of src.matchAll(/\blimits\.([A-Za-z0-9_]+)/g)) {
				if (!known.has(m[1])) unknown.push(`${name}: limits.${m[1]}`);
			}
		}
		expect(unknown).toEqual([]);
	});

	it('checks a meaningful number of rate-limited handlers, not zero', () => {
		const wired = FILES.filter(([, src]) =>
			/import\s*\{[^}]*\blimits\b(?!\s+as)[^}]*\}\s*from\s*'[^']*rate-limit\.js'/.test(src),
		);
		expect(wired.length).toBeGreaterThan(50);
	});
});
