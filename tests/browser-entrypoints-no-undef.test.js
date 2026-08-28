// The browser code that runs on OTHER people's websites must not reference an
// identifier that does not exist.
//
// This is not a style rule. On 2026-08-28 `src/element.js` read `bodyURI`, a
// variable that only exists in `src/manifest.js`, so every `<agent-3d>` boot
// that reached that line threw "bodyURI is not defined" and the element showed
// its error overlay instead of the avatar. eslint knew: it reports `no-undef`,
// but as a WARNING, and nothing in the pipeline fails on warnings, so a
// guaranteed runtime crash shipped in the published bundle.
//
// Repo-wide `no-undef` is still a warning (there is a backlog of other hits in
// pages that are not third-party facing). These three files are the ones that
// load inside someone else's page, where a crash is invisible to us and fatal
// to them, so they are held to the stricter bar here.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const ENTRYPOINTS = [
	// The <agent-3d> element: the whole embeddable product.
	'src/element.js',
	// The embed loader third-party pages include directly.
	'public/embed/v1.js',
	// The <agent-glance> card element, same deal.
	'public/glance/element.js',
];

function undefinedIdentifiersIn(file) {
	const raw = execFileSync(
		'npx',
		['eslint', '--no-color', '--format', 'json', resolve(process.cwd(), file)],
		{ encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
	);
	const [report] = JSON.parse(raw);
	return (report?.messages || [])
		.filter((m) => m.ruleId === 'no-undef')
		.map((m) => `${file}:${m.line} ${m.message}`);
}

describe('third-party browser entry points', () => {
	for (const file of ENTRYPOINTS) {
		it(`${file} references no undefined identifier`, () => {
			expect(undefinedIdentifiersIn(file)).toEqual([]);
		}, 120_000);
	}
});
