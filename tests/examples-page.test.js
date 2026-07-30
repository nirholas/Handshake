import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The /examples page renders two halves that fail in different ways:
//
//   curated snippets   hand-written runnable documents in public/examples.js
//   generated index    every example found by scanning the repo
//
// tests/examples-index.test.js guards how the generator writes. This file
// guards what reaches the browser, which is a separate failure surface.
//
// The specific bug it prevents: the generator writes data/examples.json, but
// only public/ is copied into dist/ and served, so an index that is generated
// and never mirrored leaves the page fetching a 404 and rendering its error
// state in production while looking perfect in review.
//
// The second property is that the page consumes the index rather than naming
// examples inline. A hand-listed section looks identical to a working one until
// an example is renamed, which is how the section this replaced ended up naming
// 5 of the 39 examples that actually ship.

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const readJson = (rel) => JSON.parse(readFileSync(resolve(root, rel), 'utf8'));

describe('examples index: generated, mirrored, and served', () => {
	it('carries real entries', () => {
		const index = readJson('data/examples.json');
		expect(Array.isArray(index.examples)).toBe(true);
		expect(index.examples.length).toBeGreaterThan(10);
	});

	it('gives every entry the fields the gallery renders', () => {
		for (const example of readJson('data/examples.json').examples) {
			expect(example.id, `${example.path} needs an id`).toBeTruthy();
			expect(example.title, `${example.path} needs a title`).toBeTruthy();
			expect(example.path, 'every entry needs a path').toBeTruthy();
			expect(example.group, `${example.path} needs a group`).toBeTruthy();
		}
	});

	it('never names a path that is not on disk', () => {
		// The whole point of generating this index is that it cannot advertise a
		// file that is not there. If it can, the generator is reading stale state.
		const missing = readJson('data/examples.json')
			.examples.map((e) => e.path)
			.filter((p) => !existsSync(resolve(root, p)));
		expect(missing, `indexed paths that do not exist: ${missing.join(', ')}`).toEqual([]);
	});

	it('is mirrored into public/, the only directory that gets served', () => {
		expect(
			existsSync(resolve(root, 'public/examples.json')),
			'public/examples.json is missing: run `npm run build:examples`',
		).toBe(true);
	});

	it('keeps the served mirror equal to the generated source', () => {
		const source = readJson('data/examples.json');
		const served = readJson('public/examples.json');
		expect(served.examples.map((e) => e.id).sort()).toEqual(source.examples.map((e) => e.id).sort());
	});

	it('runs the mirror from `npm run build:examples`, not only the generator', () => {
		// Chaining is what keeps the two files in step. Without it the mirror is a
		// one-time copy that drifts the next time an example is added.
		const pkg = readJson('package.json');
		expect(pkg.scripts['build:examples']).toContain('build-examples-index.mjs');
		expect(pkg.scripts['build:examples']).toContain('mirror-examples-index.mjs');
	});

	it('refuses to publish an empty index', () => {
		// An empty index means the scan broke. Publishing it would swap the gallery
		// for its "no matches" state, which reads as a content problem, not a bug.
		const script = readFileSync(resolve(root, 'scripts/mirror-examples-index.mjs'), 'utf8');
		expect(script).toMatch(/length === 0/);
		expect(script).toMatch(/process\.exit\(1\)/);
	});

	it('mirrors idempotently, so a rebuild produces no phantom diff', () => {
		// Compare two consecutive mirror runs rather than the committed file
		// against one run: other agents share this worktree and regenerate
		// data/examples.json, and a legitimately updated source would otherwise
		// read as a broken mirror.
		const read = () => readFileSync(resolve(root, 'public/examples.json'), 'utf8');
		const run = () => execFileSync('node', ['scripts/mirror-examples-index.mjs'], { cwd: root, encoding: 'utf8' });
		run();
		const first = read();
		run();
		expect(read()).toBe(first);
	});
});

describe('/examples page wiring', () => {
	const page = () => readFileSync(resolve(root, 'pages/examples.html'), 'utf8');

	it('is registered in data/pages.json, which feeds the sitemap and llms.txt', () => {
		const paths = readJson('data/pages.json')
			.sections.flatMap((s) => s.pages || [])
			.map((p) => p.path);
		expect(paths).toContain('/examples');
	});

	it('is routed, so /examples resolves to the built page', () => {
		const { routes } = readJson('vercel.json');
		expect(routes.some((r) => r.src === '/examples/?' && r.dest === '/examples.html')).toBe(true);
	});

	it('is a build entry, so the page is emitted into dist/', () => {
		expect(readFileSync(resolve(root, 'vite.config.js'), 'utf8')).toContain('pages/examples.html');
	});

	it('loads the script that renders the generated index', () => {
		expect(page()).toContain('/examples-index.js');
	});

	it('ships every hook that script renders into', () => {
		// A rename on either side silently degrades the section to "nothing
		// happens", with no error logged anywhere.
		for (const role of ['ex-browse', 'ex-grid', 'ex-search', 'ex-chips', 'ex-count', 'ex-error', 'ex-empty-search']) {
			expect(page(), `missing [data-role="${role}"]`).toContain(`data-role="${role}"`);
		}
	});

	it('renders the repo index from a fetch, never a hand-listed array', () => {
		const renderer = readFileSync(resolve(root, 'public/examples-index.js'), 'utf8');
		expect(renderer).toContain("fetch('/examples.json'");
		expect(renderer).not.toMatch(/const\s+EXAMPLES\s*=\s*\[/);
	});

	it('designs the loading, empty, and error states instead of failing blank', () => {
		const html = page();
		expect(html).toContain('data-role="ex-loading"');
		expect(html).toContain('data-role="ex-retry"');
		expect(html).toContain('data-role="ex-clear"');
	});
});
