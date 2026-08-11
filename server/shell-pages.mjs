// Existence checks for shared-shell pages (/docs/*, /tutorials/*).
// ---------------------------------------------------------------------------
// Those two surfaces rewrite EVERY slug under them to a single HTML shell, so
// the route table alone cannot tell a real page from a typo: /docs/anything
// answered 200 with the shell, which then rendered a bare "Page not found."
// line and no way back into the product. A soft 404 like that gets indexed as
// a live page, and a reader who mistypes a doc URL hits a dead end.
//
// Both shells render one markdown article fetched from dist/docs, so that file
// IS the page's existence test:
//
//   /docs/agent-runtime                    → dist/docs/agent-runtime.md
//   /docs/agent-abilities/chapters/02-motion → dist/docs/agent-abilities/chapters/02-motion.md
//   /tutorials/text-to-3d                  → dist/docs/tutorials/text-to-3d.md
//
// server/index.mjs consults this before serving a shell, so a slug with no
// article falls through to the designed /404.html with a real 404 status.

import { statSync } from 'node:fs';
import path from 'node:path';

// Rewrite dest → { request-path prefix the shell answers for, article root
// under dist/ }. Keyed on the dest rather than the request path so routes that
// resolve elsewhere before reaching the shell (/docs/world, /docs/walk/*,
// /docs/widgets) are never touched by this check.
const SHELLS = new Map([
	['/docs/index.html', { prefix: '/docs/', articles: 'docs' }],
	['/tutorial.html', { prefix: '/tutorials/', articles: 'docs/tutorials' }],
]);

// What a doc slug may look like: path segments of letters, digits, `-` and `_`
// (dist/docs holds both `agent-runtime` and `pumpfun-program/docs/CPI_README`).
// A dot is deliberately excluded, so `..` traversal and `foo.md` can never
// reach the filesystem probe below.
const ARTICLE_SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]*(\/[A-Za-z0-9][A-Za-z0-9_-]*)*$/;

/**
 * Is this request a shared-shell page whose article does not exist?
 *
 * @param {string} distRoot absolute path to the built dist/ directory
 * @param {string} dest the path the route table rewrote to (e.g. /docs/index.html)
 * @param {string} pathname the ORIGINAL request path (e.g. /docs/agent-runtime)
 * @returns {boolean} true only for a shell page that has no article behind it
 */
export function isMissingShellPage(distRoot, dest, pathname) {
	const shell = SHELLS.get(dest);
	if (!shell || !pathname.startsWith(shell.prefix)) return false;

	let slug;
	try {
		slug = decodeURIComponent(pathname.slice(shell.prefix.length));
	} catch {
		return true; // malformed encoding can never name an article
	}
	slug = slug.replace(/\/+$/, '');
	if (!slug) return false; // the shell's own index page
	if (!ARTICLE_SLUG.test(slug)) return true;

	const articleRoot = path.join(distRoot, ...shell.articles.split('/'));
	const file = path.join(articleRoot, `${slug}.md`);
	if (!file.startsWith(articleRoot + path.sep)) return true; // defense in depth
	try {
		return !statSync(file).isFile();
	} catch {
		return true;
	}
}
