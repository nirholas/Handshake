/**
 * Shared logic for the universal [hidden] guard — used by both the injector
 * (scripts/inject-hidden-guard.mjs, the writer) and the audit
 * (scripts/audit-hidden-guard.mjs, the verifier).
 *
 * Background: the `hidden` HTML attribute hides an element only while some CSS
 * maps `[hidden]` to `display:none`. The UA rule does that but its specificity
 * (0,1,0) loses to any component rule that sets `display` on a class/id
 * (`.modal{display:grid}`) — so a `hidden` element renders anyway. A full-screen
 * overlay authored that way then covers the page and blocks every click (this is
 * how the Brain Studio modal once broke /agent-studio#brain). The platform's
 * canonical guard lives in public/tokens.css (imported by style.css and nav.css),
 * and every page must resolve it; pages that link neither get an inline copy.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PAGES_DIR = resolve(ROOT, 'pages');
const PUBLIC_DIR = resolve(ROOT, 'public');

// A rule that makes `hidden` collapse: `[hidden] … { … display: none … }`.
// Tolerant of whitespace, `!important`, and combined selectors (`a[hidden], b`).
export const GUARD_RE = /\[hidden\][^{]*\{[^}]*display\s*:\s*none/i;

// The inline guard stamped into pages that don't otherwise resolve one. The
// MARKER makes injection idempotent and lets the audit recognise stamped pages.
export const MARKER = 'three.ws hidden-guard';
export const INLINE_GUARD =
	`<style>/* ${MARKER}: make the \`hidden\` attribute authoritative. See scripts/lib/hidden-guard.mjs */` +
	`[hidden]{display:none!important}</style>`;

/** Resolve a CSS href/import to an absolute path on disk, or null (external CDN). */
function resolveCssPath(spec, fromDir) {
	if (!spec || /^https?:|^\/\//.test(spec)) return null;
	const clean = spec.split(/[?#]/)[0];
	const candidates = clean.startsWith('/')
		? [join(PUBLIC_DIR, clean), join(ROOT, clean.slice(1))]
		: [join(fromDir, clean)];
	for (const c of candidates) if (existsSync(c)) return c;
	return null;
}

// Memoised "does this CSS file (transitively via @import) define the guard?"
const guardCache = new Map();
function cssProvidesGuard(absPath, seen = new Set()) {
	if (!absPath || seen.has(absPath)) return false;
	if (guardCache.has(absPath)) return guardCache.get(absPath);
	seen.add(absPath);
	let provides = false;
	try {
		const src = readFileSync(absPath, 'utf8');
		if (GUARD_RE.test(src)) provides = true;
		else {
			const dir = dirname(absPath);
			for (const m of src.matchAll(/@import\s+(?:url\()?\s*['"]?([^'")\s]+)['"]?/gi)) {
				const imp = resolveCssPath(m[1], dir);
				if (imp && cssProvidesGuard(imp, seen)) { provides = true; break; }
			}
		}
	} catch { provides = false; }
	guardCache.set(absPath, provides);
	return provides;
}

/** Does an HTML page resolve the guard — inline <style>, the stamped marker, or any linked CSS? */
export function pageIsGuarded(htmlPath) {
	const html = readFileSync(htmlPath, 'utf8');
	if (html.includes(MARKER)) return true;
	const fromDir = dirname(htmlPath);
	for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
		if (GUARD_RE.test(m[1])) return true;
	}
	for (const tag of html.matchAll(/<link\b[^>]*>/gi)) {
		const t = tag[0];
		if (!/rel\s*=\s*['"]?stylesheet/i.test(t)) continue;
		const href = t.match(/href\s*=\s*['"]([^'"]+)['"]/i)?.[1];
		const css = resolveCssPath(href, fromDir);
		if (css && cssProvidesGuard(css)) return true;
	}
	return false;
}

function walkHtml(dir) {
	const out = [];
	if (!existsSync(dir)) return out;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
			out.push(...walkHtml(full));
		} else if (entry.name.endsWith('.html')) out.push(full);
	}
	return out;
}

// Product HTML lives under pages/ (clean-URL surfaces) plus a curated set of
// standalone public/ pages. Vendored/generated public/ trees (sdk demos, model
// viewers) are not ours to guard — listing public pages explicitly avoids them.
const PUBLIC_GUARDED = ['login.html', 'paywall.html', 'bazaar.html', 'forever.html'];

/** The full set of product HTML pages the guard must cover. */
export function collectPages() {
	return [
		...walkHtml(PAGES_DIR),
		...PUBLIC_GUARDED.map((f) => join(PUBLIC_DIR, f)).filter(existsSync),
	];
}
