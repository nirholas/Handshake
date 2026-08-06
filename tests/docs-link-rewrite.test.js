// Docs reader: internal link rewriting.
//
// The reader renders markdown authored for GitHub inside a hash-routed viewer,
// so every relative link in a doc has to be re-pointed at render time. Three
// classes exist and each fails differently when it breaks:
//
//   ../other-doc.md          → must hash-route inside the viewer
//   ../../api/_lib/foo.js    → must go to GitHub; the viewer serves docs, not
//                              the tree, so leaving it relative resolves to a
//                              site path that 404s (this was every source
//                              citation in docs/, ~1900 links)
//   /forge, ./img/shot.png   → real routes and real assets, must be left alone
//
// None of those throw when they regress. They just quietly send readers
// nowhere, which is why the rules are pinned here.
//
// The logic lives inline in docs/index.html (the reader is a single shipped
// file, not a module), so the test extracts the actual shipped callback and
// runs it. Reimplementing it here would test a copy, which is the drift this
// file exists to prevent.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SHELL = readFileSync(resolve(ROOT, 'docs/index.html'), 'utf8');
const REPO = 'https://github.com/nirholas/three.ws/blob/main';
const ORIGIN = 'https://three.ws';

/** Pull the shipped `a[href]` rewrite callback body out of the reader. */
function extractRewriteBody() {
	const marker = "content.querySelectorAll('a[href]').forEach(a => {";
	const start = SHELL.indexOf(marker);
	if (start === -1) throw new Error('link-rewrite callback not found in docs/index.html');
	const open = SHELL.indexOf('{', start + marker.length - 1);
	let depth = 0;
	for (let j = open; j < SHELL.length; j++) {
		if (SHELL[j] === '{') depth++;
		else if (SHELL[j] === '}') {
			depth--;
			if (depth === 0) return SHELL.slice(open + 1, j);
		}
	}
	throw new Error('unbalanced braces in the link-rewrite callback');
}

const run = new Function('a', 'path', 'REPO', 'location', extractRewriteBody());

/** Minimal stand-in for the anchor the reader mutates. */
function anchor(href) {
	return {
		href,
		target: '',
		rel: '',
		getAttribute: () => href,
		closest: () => null,
	};
}

function rewrite(href, path = 'x402-endpoints') {
	const a = anchor(href);
	run(a, path, REPO, { origin: ORIGIN });
	return a;
}

describe('docs reader: link rewriting', () => {
	it('hash-routes a sibling doc', () => {
		expect(rewrite('x402-endpoints.md', 'start-here').href).toBe('#x402-endpoints');
	});

	it('resolves a relative doc link from inside a nested doc', () => {
		expect(rewrite('../3d-api.md', 'api/forge-x402').href).toBe('#3d-api');
		expect(rewrite('tutorials/image-to-3d.md', 'forge').href).toBe('#tutorials/image-to-3d');
	});

	it('keeps a same-page section link on the current doc', () => {
		expect(rewrite('#pricing', 'api/forge-x402').href).toBe('#api/forge-x402@pricing');
	});

	it('routes a cross-doc link that also targets a heading', () => {
		// "@" is the reader's doc/section separator: the doc part navigates, the
		// rest scrolls. Before this, the trailing #section failed the .md test and
		// the link rendered unrewritten, so it moved the reader nowhere at all.
		expect(rewrite('start-here.md#install', 'forge').href).toBe('#start-here@install');
	});

	it('sends a relative source-code citation to GitHub, in a new tab', () => {
		const a = rewrite('../api/_lib/x402-spec.js');
		expect(a.href).toBe(`${REPO}/api/_lib/x402-spec.js`);
		expect(a.target).toBe('_blank');
		expect(a.rel).toBe('noopener');
	});

	it('resolves a source citation relative to the nested doc that wrote it', () => {
		expect(rewrite('../../scripts/gcp-triage.mjs', 'ops/runbook').href).toBe(
			`${REPO}/scripts/gcp-triage.mjs`,
		);
	});

	it('sends a doc link that escapes /docs/ to GitHub', () => {
		expect(rewrite('../../packages/sdk/README.md', 'api/forge-x402').href).toBe(
			`${REPO}/packages/sdk/README.md`,
		);
	});

	it('leaves site routes and in-docs assets alone', () => {
		expect(rewrite('/forge').href).toBe('/forge');
		expect(rewrite('./img/screenshot.png').href).toBe('./img/screenshot.png');
		expect(rewrite('https://x402.org').href).toBe('https://x402.org');
		expect(rewrite('mailto:hi@three.ws').href).toBe('mailto:hi@three.ws');
	});
});
