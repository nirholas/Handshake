// Atlas: the site-wide Cmd+K palette.
//
// Three things are worth pinning here, and they are the three things that fail
// silently rather than loudly:
//
//   1. RANKING. A palette that returns the wrong page first is not "broken" in
//      any way a smoke test notices. It just quietly wastes everyone's time. The
//      orderings below are the ones a person would call obviously right, so a
//      scoring tweak that breaks one of them shows up as a red test rather than
//      as a slow drift in usefulness.
//   2. THE INTENT GATE. Every intent step points at a real route. The whole
//      point of generating the index at build time is that an onboarding path
//      can never dead-end on a 404, so the gate itself needs a test proving it
//      actually rejects a bad target.
//   3. COVERAGE. atlas.js is dead code unless something injects it into the
//      built pages, which is exactly how it shipped the first time: committed,
//      complete, and loaded by nothing.

import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

import { rankPages, rankIntents, highlight, normalize, tokenize } from '../public/atlas/score.js';
import { shouldInject, injectInto, ATLAS_TAG } from '../scripts/inject-atlas.mjs';

const root = resolve(import.meta.dirname, '..');
const index = JSON.parse(readFileSync(resolve(root, 'public/atlas-index.json'), 'utf8'));

/** First result's path for a query, which is the only rank most people ever see. */
const top = (q) => rankPages(q, index.pages)[0]?.page[0];
const paths = (q, n = 5) => rankPages(q, index.pages).slice(0, n).map((r) => r.page[0]);

describe('atlas index', () => {
	it('never offers a route that no longer exists', () => {
		// Only ONE direction of drift can reach a visitor. A page added to
		// data/pages.json but not yet in the committed index self-heals: `prebuild`
		// regenerates the index on every build, so it is current by the time
		// anything ships. A page DELETED from data/pages.json while a stale index
		// still lists it is the harmful direction, because search then sends people
		// to a 404. Assert only that direction, which is also the only one that is
		// not racy while several agents are adding pages to this worktree.
		const routes = new Set(
			JSON.parse(readFileSync(resolve(root, 'data/pages.json'), 'utf8')).sections.flatMap((s) =>
				(s.pages || []).map((p) => p.path),
			),
		);
		const orphans = index.pages.map((p) => p[0]).filter((path) => !routes.has(path));
		expect(orphans, 'regenerate with: node scripts/build-atlas-index.mjs').toEqual([]);
	});

	it('carries every section and a plausible number of pages', () => {
		expect(index.sections.length).toBeGreaterThanOrEqual(10);
		expect(index.pageCount).toBe(index.pages.length);
		expect(index.pageCount).toBeGreaterThan(500);
		for (const page of index.pages) {
			expect(page[0].startsWith('/')).toBe(true);
			expect(page[1].length).toBeGreaterThan(0);
			expect(typeof page[3]).toBe('string');
		}
	});

	it('never lists the same route twice', () => {
		const seen = new Set(index.pages.map((p) => p[0]));
		expect(seen.size).toBe(index.pages.length);
	});
});

describe('the intent catalog gate', () => {
	const known = new Set(index.pages.map((p) => p[0]));
	// Targets the generator allows that are not pages: API endpoints and static
	// machine files. Kept in sync with NON_PAGE_TARGETS in the generator.
	const allowed = new Set(['/docs/start-here', '/api/status', '/llms.txt']);

	it('points every step at a route that exists', () => {
		for (const intent of index.intents) {
			for (const step of intent.steps) {
				if (!step.to || /^https?:\/\//.test(step.to)) continue;
				expect(
					known.has(step.to) || allowed.has(step.to),
					`intent "${intent.id}" points at ${step.to}, which is not a route`,
				).toBe(true);
			}
		}
	});

	it('gives every intent trigger phrases and a first destination', () => {
		for (const intent of index.intents) {
			expect(intent.match.length, `intent "${intent.id}" is unreachable`).toBeGreaterThan(0);
			expect(intent.steps.length).toBeGreaterThan(0);
			expect(intent.steps.some((s) => s.to), `intent "${intent.id}" goes nowhere`).toBe(true);
		}
	});

	it('FAILS the build when a step points at a route that does not exist', () => {
		// The gate is the entire reason the index is generated instead of fetched
		// at runtime. Run the REAL generator against a deliberately broken catalog:
		// a gate nobody has ever watched fail is a gate nobody knows works.
		const catalog = JSON.parse(readFileSync(resolve(root, 'data/atlas-intents.json'), 'utf8'));
		catalog.intents[0].steps[0].to = '/this-route-was-never-built';

		const scratch = resolve(root, 'node_modules/.cache/atlas');
		mkdirSync(scratch, { recursive: true });
		const brokenCatalog = resolve(scratch, 'intents.json');
		writeFileSync(brokenCatalog, JSON.stringify(catalog));

		let exitCode = 0;
		let stderr = '';
		try {
			execFileSync('node', [resolve(root, 'scripts/build-atlas-index.mjs')], {
				cwd: root,
				encoding: 'utf8',
				env: {
					...process.env,
					ATLAS_INTENTS: brokenCatalog,
					// Never let the failing run touch the committed index.
					ATLAS_OUT: resolve(scratch, 'index.json'),
				},
			});
		} catch (e) {
			exitCode = e.status;
			stderr = String(e.stderr || '');
		}
		expect(exitCode).toBe(1);
		expect(stderr).toContain('/this-route-was-never-built');
		expect(stderr).toContain('not a route in data/pages.json');
	});
});

describe('page ranking', () => {
	it('puts the canonical route above the docs that describe it', () => {
		// The failure this guards: typing a product name and getting its
		// documentation instead of the product.
		expect(top('x402')).toBe('/x402');
		expect(top('marketplace')).toBe('/marketplace');
		expect(top('status')).toBe('/status');
	});

	it('resolves an exact path typed straight into the box', () => {
		expect(top('/atlas')).toBe('/atlas');
		expect(top('/pricing')).toBe('/pricing');
	});

	it('requires every term to match, so extra words narrow instead of widen', () => {
		const broad = rankPages('agent', index.pages, { limit: 400 }).length;
		const narrow = rankPages('agent wallet', index.pages, { limit: 400 }).length;
		expect(narrow).toBeLessThan(broad);
		expect(narrow).toBeGreaterThan(0);
		for (const { page } of rankPages('agent wallet', index.pages, { limit: 400 })) {
			const hay = `${page[0]} ${page[1]} ${page[2]}`.toLowerCase();
			expect(hay).toContain('wallet');
		}
	});

	it('recovers from a typo without letting fuzzy matches outrank real ones', () => {
		expect(paths('marketplce', 3)).toContain('/marketplace');
		// A real substring hit must still win outright over any subsequence hit.
		const ranked = rankPages('gallery', index.pages);
		expect(ranked[0].page[0]).toBe('/gallery');
	});

	it('returns nothing for a query that matches nothing, rather than noise', () => {
		expect(rankPages('zzzqqxwv', index.pages)).toHaveLength(0);
	});

	it('is fast enough to run on every keystroke', () => {
		const started = performance.now();
		for (let i = 0; i < 20; i++) rankPages('agent wallet', index.pages, { limit: 400 });
		// 20 full passes over the whole route table. Generous ceiling: the point is
		// to catch an accidental O(n^2), not to benchmark the machine.
		expect(performance.now() - started).toBeLessThan(1500);
	});
});

describe('intent ranking', () => {
	it('surfaces the task shortcut for the words a newcomer actually types', () => {
		expect(rankIntents('get started', index.intents)[0].intent.id).toBe('first-time');
		expect(rankIntents('launch a coin', index.intents)[0].intent.id).toBe('launch-coin');
		expect(rankIntents('embed', index.intents)[0].intent.id).toBe('embed-on-site');
		expect(rankIntents('is it down', index.intents)[0].intent.id).toBe('status');
	});

	it('handles a question phrased around a trigger phrase', () => {
		expect(rankIntents('how do i get paid', index.intents)[0].intent.id).toBe('get-paid');
	});

	it('stays silent on a single letter and on an unrelated query', () => {
		expect(rankIntents('a', index.intents)).toHaveLength(0);
		expect(rankIntents('quaternion skinning', index.intents)).toHaveLength(0);
	});
});

describe('highlighting', () => {
	it('marks the typed run and leaves the rest alone', () => {
		const runs = highlight('Agent Wallet', 'wallet');
		expect(runs.map((r) => r.t).join('')).toBe('Agent Wallet');
		expect(runs.filter((r) => r.hit).map((r) => r.t)).toEqual(['Wallet']);
	});

	it('merges overlapping term hits instead of nesting them', () => {
		const runs = highlight('agentic', 'agent agentic');
		expect(runs.filter((r) => r.hit)).toHaveLength(1);
		expect(runs.find((r) => r.hit).t).toBe('agentic');
	});

	it('never drops or duplicates a character', () => {
		for (const page of index.pages.slice(0, 200)) {
			expect(highlight(page[1], 'a e i').map((r) => r.t).join('')).toBe(page[1]);
		}
	});

	it('folds accents so an unaccented query still matches', () => {
		expect(normalize('Café')).toBe('cafe');
		expect(tokenize('x402 / Studio')).toEqual(['x402', 'studio']);
	});
});

describe('injection coverage', () => {
	it('adds the palette to an ordinary page exactly once', () => {
		const page = '<html><head></head><body><h1>hi</h1></body></html>';
		const once = injectInto(page);
		expect(once).toContain(ATLAS_TAG);
		expect(injectInto(once)).toBe(once);
	});

	it('still lands on a page with no closing body tag', () => {
		expect(injectInto('<div>fragment-less page</div>')).toContain(ATLAS_TAG);
	});

	it('refuses embeds and the nav/footer fragments', () => {
		// Embeds run inside third-party pages: taking their Cmd+K is hostile.
		// nav.html/footer.html are assigned via innerHTML, where a script tag
		// renders as visible text.
		for (const f of ['widget.html', 'embed.html', 'avatar-embed.html', 'nav.html', 'footer.html']) {
			expect(shouldInject(`dist/${f}`), `${f} must not get the palette`).toBe(false);
		}
		for (const f of ['index.html', 'atlas.html', 'status.html', 'docs/mcp.html']) {
			expect(shouldInject(`dist/${f}`), `${f} should get the palette`).toBe(true);
		}
	});

	it('is wired into the build, not just available to it', () => {
		// The first release of Atlas was complete and loaded by nothing. This test
		// is the reason that cannot happen twice.
		const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
		expect(pkg.scripts.build).toContain('inject-atlas.mjs');
		expect(pkg.scripts.prebuild).toContain('build-atlas-index.mjs');
		const vite = readFileSync(resolve(root, 'vite.config.js'), 'utf8');
		expect(vite).toContain("name: 'three-ws-atlas'");
		expect(vite).toContain("'/atlas': resolve(root, 'pages/atlas.html')");
	});
});
