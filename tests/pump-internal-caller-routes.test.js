import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { globSync } from 'glob';

// Regression guard for a real production outage: `api/pump/[action].js` has NO
// catch-all route — every action needs its OWN explicit `/api/pump/<action>`
// line in vercel.json. Two things silently broke the autonomous economy because
// of this:
//   1. Internal callers used the QUERY form `/api/pump?action=<x>`, which has no
//      route at all and 404s → the launcher failed every mint on "metadata build
//      404: no url" and tripped its breaker; the fee claimer 404'd on every claim.
//   2. Actions like `fee-info` / `collect-creator-fee-agent` had no route even in
//      PATH form, so the claim→fee→buyback chain never ran.
// This test fails if either regresses.

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
const routeSrcs = new Set((vercel.routes || []).map((r) => r.src));

// Server-side files that call the pump API over HTTP against our own origin.
const serverFiles = globSync('api/**/*.js', { cwd: repoRoot }).filter(
	(f) => !f.includes('node_modules'),
);

function readCalls() {
	const queryForm = [];
	const pathForm = new Set();
	for (const rel of serverFiles) {
		const src = readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
		// Only count actual request URLs (string literals), not doc comments.
		for (const line of src.split('\n')) {
			if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) continue;
			for (const m of line.matchAll(/['"`]\/api\/pump\?action=([a-z-]+)/g)) {
				queryForm.push({ rel, action: m[1] });
			}
			for (const m of line.matchAll(/['"`]\/api\/pump\/([a-z-]+)(?:[?'"`])/g)) {
				pathForm.add(m[1]);
			}
		}
	}
	return { queryForm, pathForm: [...pathForm] };
}

describe('internal pump API callers hit routed path-form URLs', () => {
	const { queryForm, pathForm } = readCalls();

	it('no server file calls the unrouted /api/pump?action= query form', () => {
		expect(
			queryForm,
			`These callers use the query form which has NO route and 404s. Use /api/pump/<action> instead:\n` +
				queryForm.map((c) => `  ${c.rel}: /api/pump?action=${c.action}`).join('\n'),
		).toEqual([]);
	});

	it('every /api/pump/<action> handled by [action].js and called internally has a route', () => {
		// A path-form call resolves one of two ways:
		//   · a standalone file api/pump/<x>.js  → served by the filesystem handler
		//   · an action inside [action].js's switch → needs an EXPLICIT route to
		//     inject ?action=<x>, since the filesystem handler can't address it.
		// Only the second kind can silently 404, so only it is asserted here.
		const actionSrc = readFileSync(new URL('../api/pump/[action].js', import.meta.url), 'utf8');
		const isActionCase = (a) => new RegExp(`case ['"]${a}['"]`).test(actionSrc);
		const hasStandaloneFile = (a) =>
			serverFiles.includes(`api/pump/${a}.js`);
		const missing = pathForm.filter(
			(a) => !routeSrcs.has(`/api/pump/${a}`) && !hasStandaloneFile(a) && isActionCase(a),
		);
		expect(
			missing,
			`These [action].js actions are called internally but have no route in vercel.json (they 404):\n` +
				missing.map((a) => `  /api/pump/${a}`).join('\n'),
		).toEqual([]);
	});
});
