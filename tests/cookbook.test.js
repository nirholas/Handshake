import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The cookbook is five surfaces that have to agree with each other:
//
//   public/cookbook-manifest.js   the recipe list both pages render from
//   docs/cookbook/<slug>.md       the prose the viewer fetches at runtime
//   public/cookbook/recipes/*     the files the download buttons hand out
//   data/pages.json               sitemap, llms.txt, features.json, changelog
//   vercel.json                   the routes that make any of it reachable
//
// Each one fails silently on its own. A manifest entry with no markdown renders
// the viewer's error state; a recipe with no pages.json entry is invisible to
// search and to the changelog; a missing route 404s a page that exists on disk.
// None of that shows up in a build. This file makes each disagreement a test
// failure instead.
//
// The route-order assertion is the least obvious and the most load-bearing:
// /cookbook/self-correcting-3d is a static nbconvert export, not a markdown
// recipe, so the generic /cookbook/<slug> rule must come AFTER it or the viewer
// shadows the notebook and the page goes blank.

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const read = (rel) => readFileSync(resolve(root, rel), 'utf8');
const readJson = (rel) => JSON.parse(read(rel));

/** Evaluate the manifest the way a browser does: a classic script setting globals. */
function loadManifest() {
	const source = read('public/cookbook-manifest.js');
	const window = {};
	new Function('window', source)(window);
	return window;
}

/** Flatten data/pages.json, whatever grouping shape it currently uses. */
function allPages(node, out = []) {
	if (Array.isArray(node)) {
		for (const item of node) {
			if (item && typeof item === 'object' && typeof item.path === 'string') out.push(item);
			allPages(item, out);
		}
	} else if (node && typeof node === 'object') {
		for (const value of Object.values(node)) allPages(value, out);
	}
	return out;
}

const manifest = loadManifest();
const recipes = manifest.RECIPES;
const pagePaths = new Set(allPages(readJson('data/pages.json')).map((p) => p.path));
const routes = readJson('vercel.json').routes;

describe('cookbook manifest', () => {
	it('exposes the recipe list and its lookup helpers', () => {
		expect(Array.isArray(recipes)).toBe(true);
		expect(recipes.length).toBeGreaterThan(1);
		expect(manifest.recipeBySlug(recipes[0].slug)).toEqual(recipes[0]);
		expect(manifest.recipeBySlug('no-such-recipe')).toBeNull();
		expect(manifest.recipeIndex(recipes[1].slug)).toBe(1);
	});

	it('gives every recipe the fields both surfaces render', () => {
		for (const recipe of recipes) {
			const where = `recipe "${recipe.slug}"`;
			expect(recipe.slug, 'every recipe needs a slug').toMatch(/^[a-z0-9-]+$/);
			expect(recipe.title, `${where} needs a title`).toBeTruthy();
			expect(recipe.blurb, `${where} needs a blurb`).toBeTruthy();
			expect(recipe.builds, `${where} needs a builds line`).toBeTruthy();
			expect(recipe.language, `${where} needs a language`).toBeTruthy();
			expect(recipe.time, `${where} needs a time estimate`).toBeTruthy();
			expect(recipe.needs, `${where} needs a prerequisites line`).toBeTruthy();
			expect(['beginner', 'intermediate', 'advanced'], `${where} level`).toContain(recipe.level);
			expect(recipe.href, `${where} href`).toBe(`/cookbook/${recipe.slug}`);
		}
	});

	it('has no duplicate slugs', () => {
		const slugs = recipes.map((r) => r.slug);
		expect(new Set(slugs).size).toBe(slugs.length);
	});
});

describe('every recipe is fully wired', () => {
	it('ships the file its download button promises', () => {
		for (const recipe of recipes) {
			if (!recipe.download) continue;
			const href = recipe.download.href;
			expect(href.startsWith('/cookbook/'), `${recipe.slug} download path`).toBe(true);
			expect(
				existsSync(resolve(root, `public${href}`)),
				`${recipe.slug} advertises ${href}, which does not exist`,
			).toBe(true);
		}
	});

	it('has prose the viewer can fetch, or is an explicit static export', () => {
		for (const recipe of recipes) {
			const markdown = resolve(root, `docs/cookbook/${recipe.slug}.md`);
			if (recipe.external) {
				// A static export serves its own HTML instead of markdown.
				expect(
					existsSync(resolve(root, `public/cookbook/${recipe.slug}/index.html`)),
					`${recipe.slug} is marked external but ships no index.html`,
				).toBe(true);
			} else {
				expect(
					existsSync(markdown),
					`${recipe.slug} has no docs/cookbook/${recipe.slug}.md, so the viewer would error`,
				).toBe(true);
			}
		}
	});

	it('has a poster that exists, with alt text', () => {
		for (const recipe of recipes) {
			expect(recipe.poster, `${recipe.slug} needs a poster`).toBeTruthy();
			expect(
				existsSync(resolve(root, `public${recipe.poster}`)),
				`${recipe.slug} points at ${recipe.poster}, which does not exist`,
			).toBe(true);
			// The poster carries meaning (it is the recipe's own output), so empty alt
			// would be wrong here even though decorative images take alt="".
			expect(recipe.posterAlt, `${recipe.slug} poster needs alt text`).toBeTruthy();
		}
	});

	it('is declared in data/pages.json so it reaches the sitemap', () => {
		expect(pagePaths.has('/cookbook')).toBe(true);
		for (const recipe of recipes) {
			expect(
				pagePaths.has(`/cookbook/${recipe.slug}`),
				`/cookbook/${recipe.slug} is missing from data/pages.json`,
			).toBe(true);
		}
	});
});

describe('cookbook routing', () => {
	const cookbookRoutes = routes.filter((r) => (r.src || '').startsWith('/cookbook'));

	it('sends the index to the hub page, not the old notebook export', () => {
		const index = cookbookRoutes.find((r) => r.src === '/cookbook');
		expect(index, '/cookbook has no route').toBeTruthy();
		expect(index.dest).toBe('/cookbook.html');
	});

	it('routes recipe slugs to the viewer template', () => {
		const viewer = cookbookRoutes.find((r) => r.src === '/cookbook/([a-z0-9-]+)');
		expect(viewer, 'the /cookbook/<slug> route is missing').toBeTruthy();
		expect(viewer.dest).toBe('/recipe.html');
	});

	it('matches the static notebook export BEFORE the generic slug rule', () => {
		const notebook = cookbookRoutes.findIndex((r) => r.src.includes('self-correcting-3d'));
		const generic = cookbookRoutes.findIndex((r) => r.src === '/cookbook/([a-z0-9-]+)');
		expect(notebook, 'the notebook export has no explicit route').toBeGreaterThan(-1);
		expect(
			notebook,
			'the generic slug route shadows the notebook export; move the explicit route first',
		).toBeLessThan(generic);
	});

	it('registers both page templates as build inputs', () => {
		const config = read('vite.config.js');
		expect(config).toContain("resolve(__dirname, 'pages/cookbook.html')");
		expect(config).toContain("resolve(__dirname, 'pages/recipe.html')");
	});

	it('applies the same order in the dev middleware as in vercel.json', () => {
		// The ordering above is only half the guarantee. The dev server resolves
		// /cookbook/* with its own if/else chain in vite.config.js, so getting the
		// order right in one table and wrong in the other produces the worst
		// version of this bug: the notebook renders on localhost and serves a blank
		// viewer in production, or the reverse.
		const config = read('vite.config.js');
		const notebook = config.indexOf('/^\\/cookbook\\/self-correcting-3d\\/?$/');
		const generic = config.indexOf('/^\\/cookbook\\/[a-z0-9-]+\\/?$/');

		expect(notebook, 'vite.config.js has no notebook-export branch').toBeGreaterThan(-1);
		expect(generic, 'vite.config.js has no generic /cookbook/<slug> branch').toBeGreaterThan(-1);
		expect(
			notebook,
			'the dev middleware checks the generic slug branch first, so the viewer shadows the notebook in dev',
		).toBeLessThan(generic);
	});
});

describe('recipe prose', () => {
	const markdownRecipes = recipes.filter((r) => !r.external);

	it('opens with a download link to its own file', () => {
		for (const recipe of markdownRecipes) {
			const markdown = read(`docs/cookbook/${recipe.slug}.md`);
			expect(
				markdown.includes(recipe.download.href),
				`docs/cookbook/${recipe.slug}.md never links ${recipe.download.href}`,
			).toBe(true);
		}
	});

	it('links only to recipes that exist', () => {
		const known = new Set(recipes.map((r) => `/cookbook/${r.slug}`));
		// The one cookbook route that is not a recipe: the Pipeline Studio
		// (vercel.json routes /cookbook/pipeline to pipeline-studio.html).
		known.add('/cookbook/pipeline');
		for (const recipe of markdownRecipes) {
			const markdown = read(`docs/cookbook/${recipe.slug}.md`);
			for (const [, href] of markdown.matchAll(/\]\((\/cookbook\/[a-z0-9-]+)\)/g)) {
				expect(known.has(href), `docs/cookbook/${recipe.slug}.md links dead recipe ${href}`).toBe(
					true,
				);
			}
		}
	});
});
