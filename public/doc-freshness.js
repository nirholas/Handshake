// Doc freshness badge: the reader's half of the drift measurement.
//
// /docs/freshness ranks documentation drift for the people who fix it. This is
// the same measurement pointed at the person actually reading the page, which
// is where it matters most: someone following a tutorial deserves to know
// whether anyone has checked it against the product lately.
//
// The badge is deliberately quiet. A verified page gets a small, calm line. A
// page whose code has moved says so plainly, names how many files moved, and
// links to the evidence. It never scolds and never blocks the content.
//
// Data comes from /docs-freshness-summary.json (about 50kB, four fields per
// doc), written by `npm run docs:freshness`. The full report is a megabyte and
// is only fetched by the dashboard.
//
// Mounted by the docs SPA and the tutorial viewer, which dynamically import
// this module and call mountBadge(el, docPath) with the doc's repo path.

const SUMMARY_URL = '/docs-freshness-summary.json';
const STYLE_ID = 'doc-freshness-style';

let summaryPromise = null;

/** Fetch (once per page load) and cache the compact report. */
function loadSummary() {
	if (!summaryPromise) {
		summaryPromise = fetch(SUMMARY_URL)
			.then((res) => {
				if (!res.ok) throw new Error('HTTP ' + res.status);
				return res.json();
			})
			.catch(() => null);
	}
	return summaryPromise;
}

/**
 * Resolve a docs route to the markdown file the report is keyed by.
 *
 * The SPA knows a page as a slug ("forge", "agent-abilities/chapters/01-the-body")
 * and the tutorial viewer knows one as a tutorial slug. Both map onto docs/<x>.md.
 */
export function docPathForSlug(slug, { tutorial = false } = {}) {
	const clean = String(slug || '')
		.replace(/^\/+|\/+$/g, '')
		.replace(/\.md$/, '');
	if (!clean) return null;
	if (clean.startsWith('docs/')) return clean + '.md';
	return `docs/${tutorial && !clean.startsWith('tutorials/') ? 'tutorials/' : ''}${clean}.md`;
}

const TONE = {
	fresh: {
		cls: 'is-fresh',
		icon: '✓',
		title: 'Verified against the code',
	},
	watch: {
		cls: 'is-watch',
		icon: '~',
		title: 'Lightly out of date',
	},
	stale: {
		cls: 'is-stale',
		icon: '!',
		title: 'The code this page describes has changed',
	},
	unverifiable: {
		cls: 'is-conceptual',
		icon: '·',
		title: 'Conceptual page',
	},
};

function fmtDate(iso) {
	if (!iso) return null;
	const d = new Date(iso + 'T00:00:00Z');
	if (Number.isNaN(d.getTime())) return null;
	return d.toLocaleDateString(undefined, {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
		timeZone: 'UTC',
	});
}

/** The sentence under the badge. Says what happened, never what the reader did wrong. */
function describe(entry) {
	const when = fmtDate(entry.d);
	const files = entry.f;
	switch (entry.s) {
		case 'fresh':
			return `Last written ${when}. None of the ${entry.n} source file${entry.n === 1 ? '' : 's'} this page documents has changed since.`;
		case 'watch':
			return `Last written ${when}. ${files} file${files === 1 ? '' : 's'} it documents changed since, so a detail here may have moved.`;
		case 'stale':
			return `Last written ${when}. ${files} file${files === 1 ? '' : 's'} it documents changed since, and nobody has re-checked the page against them.`;
		default:
			return `Last written ${when}. This page explains concepts rather than specific files, so there is nothing to check it against.`;
	}
}

function injectStyle() {
	if (document.getElementById(STYLE_ID)) return;
	const style = document.createElement('style');
	style.id = STYLE_ID;
	style.textContent = `
.doc-freshness{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;margin:0 0 26px;padding:10px 13px;
	border:1px solid rgba(127,140,170,0.22);border-radius:11px;background:rgba(127,140,170,0.05);
	font-size:0.8rem;line-height:1.45;color:inherit}
.doc-freshness-chip{display:inline-flex;align-items:center;gap:6px;flex:none;font-weight:600;
	letter-spacing:0.01em;white-space:nowrap}
.doc-freshness-mark{display:inline-grid;place-items:center;width:17px;height:17px;border-radius:99px;
	font-size:0.72rem;line-height:1;font-weight:700;color:#07080c;background:currentColor}
.doc-freshness-mark span{color:#07080c}
.doc-freshness.is-fresh{border-color:rgba(124,246,196,0.3);background:rgba(124,246,196,0.06)}
.doc-freshness.is-fresh .doc-freshness-chip{color:#5fd8a8}
.doc-freshness.is-watch{border-color:rgba(255,209,102,0.32);background:rgba(255,209,102,0.07)}
.doc-freshness.is-watch .doc-freshness-chip{color:#e0b141}
.doc-freshness.is-stale{border-color:rgba(255,143,107,0.34);background:rgba(255,143,107,0.07)}
.doc-freshness.is-stale .doc-freshness-chip{color:#ff8f6b}
.doc-freshness.is-conceptual .doc-freshness-chip{opacity:0.62}
.doc-freshness-text{flex:1 1 240px;min-width:0;opacity:0.78}
.doc-freshness-link{flex:none;color:inherit;opacity:0.72;text-decoration:none;border-bottom:1px solid currentColor;
	padding-bottom:1px;transition:opacity .15s ease}
.doc-freshness-link:hover{opacity:1}
.doc-freshness-link:focus-visible{outline:2px solid currentColor;outline-offset:3px;border-radius:3px}
:root[data-theme="light"] .doc-freshness.is-fresh .doc-freshness-chip{color:#0a8f66}
:root[data-theme="light"] .doc-freshness.is-watch .doc-freshness-chip{color:#a16207}
:root[data-theme="light"] .doc-freshness.is-stale .doc-freshness-chip{color:#c2410c}
:root[data-theme="light"] .doc-freshness-mark span{color:#fbfbfd}
@media (max-width:520px){.doc-freshness{font-size:0.76rem;padding:9px 11px}}
`;
	document.head.appendChild(style);
}

/**
 * Render the badge for one doc into `host`, replacing anything already there.
 *
 * Returns the entry it rendered, or null when the doc is not in the report (a
 * brand-new page, or a build where the generator never ran). A missing entry
 * renders nothing at all: an empty box that says "unknown" is worse for the
 * reader than no box.
 *
 * @param {Element} host       where the badge goes, usually just above the article
 * @param {string}  docPath    repo path of the markdown, e.g. "docs/forge.md"
 */
export async function mountBadge(host, docPath) {
	if (!host || !docPath) return null;
	const summary = await loadSummary();
	const entry = summary?.docs?.[docPath];
	if (!entry) {
		host.replaceChildren();
		return null;
	}

	injectStyle();
	const tone = TONE[entry.s] || TONE.unverifiable;

	const box = document.createElement('div');
	box.className = `doc-freshness ${tone.cls}`;

	const chip = document.createElement('span');
	chip.className = 'doc-freshness-chip';
	const mark = document.createElement('span');
	mark.className = 'doc-freshness-mark';
	mark.setAttribute('aria-hidden', 'true');
	const glyph = document.createElement('span');
	glyph.textContent = tone.icon;
	mark.appendChild(glyph);
	chip.append(mark, document.createTextNode(tone.title));

	const text = document.createElement('span');
	text.className = 'doc-freshness-text';
	text.textContent = describe(entry);

	box.append(chip, text);

	// Only the pages with real drift earn a link out. On a verified page the
	// dashboard is a distraction from what the reader came for.
	if (entry.s === 'stale' || entry.s === 'watch') {
		const link = document.createElement('a');
		link.className = 'doc-freshness-link';
		link.href = '/docs/freshness#' + encodeURIComponent(docPath);
		link.textContent = 'See what changed';
		box.appendChild(link);
	}

	host.replaceChildren(box);
	return entry;
}

export default { mountBadge, docPathForSlug };
