/**
 * Wire the universal top-left brand mark (/brand.js) into every standalone
 * site page under pages/ and public/.
 *
 * /brand.js is idempotent and self-guarding: it injects a top-left brand chip
 * only when a page has no existing top-left logo, so it is safe to include on
 * every page. This codemod just guarantees the <script> tag is present.
 *
 * Excluded:
 *   - HTML fragments / partials (no </body>) — e.g. nav.html, footer.html
 *   - Embeddable surfaces meant to render inside host pages: anything whose
 *     path matches embed / widget / iframe / artifact / snippet / overlay-control
 *   - The JS-shell dashboards under pages/dashboard that mount their own
 *     branded rail asynchronously (avoids a first-paint double-logo flash)
 *
 * Usage:
 *   node scripts/add-brand-mark.mjs --dry   # report only
 *   node scripts/add-brand-mark.mjs         # apply
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DRY = process.argv.includes('--dry');
const SCRIPT_TAG = '\t<script src="/brand.js" defer></script>\n';

// Genuine embeddable runtimes only — destination pages that merely mention
// "widget"/"embed" in their name (the widgets gallery, widget docs, embed-policy
// settings) are intentionally NOT matched and DO get the brand mark.
const EXCLUDE_PATH = new RegExp(
	[
		'(^|/)a-embed\\.html$',
		'(^|/)agent-embed\\.html$',
		'(^|/)avatar-embed\\.html$',
		'(^|/)embed\\.html$',
		'(^|/)embed-(demo|test|walk|example)\\.html$',
		'(^|/)walk-embed(-sdk)?\\.html$',
		'embed/v1/preview\\.html$',
		'(^|/)overlay-control\\.html$',
		'(^|/)avatar-artifact\\.html$',
		'(^|/)artifact/',
		'(^|/)widget\\.html$',
		'(^|/)widget-demo\\.html$',
		'-widget\\.html$',
		'/iframe/',
	].join('|'),
	'i'
);
const EXCLUDE_SHELL_DASHBOARD = /^pages\/dashboard(-next)?\//;
// Generator-owned / separately-built output — branded at its own source so a
// rebuild keeps it (news + sitemap via scripts/build-*.mjs; chat is the Svelte
// sub-app under chat/ that builds into public/chat/).
const EXCLUDE_GENERATED = /(^|\/)(news|sitemap|chat)\//;

function walk(dir, out = []) {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) walk(full, out);
		else if (entry.endsWith('.html')) out.push(full);
	}
	return out;
}

const files = [...walk(join(ROOT, 'pages')), ...walk(join(ROOT, 'public'))];

const added = [];
const already = [];
const skipped = [];

for (const file of files) {
	const rel = relative(ROOT, file).split('\\').join('/');
	const html = readFileSync(file, 'utf8');

	if (!html.includes('</body>')) {
		skipped.push([rel, 'fragment (no </body>)']);
		continue;
	}
	if (EXCLUDE_PATH.test(rel)) {
		skipped.push([rel, 'embeddable surface']);
		continue;
	}
	if (EXCLUDE_SHELL_DASHBOARD.test(rel)) {
		skipped.push([rel, 'JS-shell dashboard (own rail)']);
		continue;
	}
	if (EXCLUDE_GENERATED.test(rel)) {
		skipped.push([rel, 'generated (branded at template source)']);
		continue;
	}
	if (html.includes('/brand.js')) {
		already.push(rel);
		continue;
	}

	const idx = html.lastIndexOf('</body>');
	const next = html.slice(0, idx) + SCRIPT_TAG + html.slice(idx);
	if (!DRY) writeFileSync(file, next);
	added.push(rel);
}

const log = (title, list) => {
	console.log(`\n${title} (${list.length})`);
	for (const item of list) console.log('  ' + (Array.isArray(item) ? `${item[0]}  — ${item[1]}` : item));
};

console.log(DRY ? '── DRY RUN ──' : '── APPLIED ──');
log(DRY ? 'WOULD ADD' : 'ADDED', added);
log('ALREADY PRESENT', already);
log('SKIPPED', skipped);
console.log(`\nTotal: ${files.length} html · +${added.length} · =${already.length} · −${skipped.length}`);
