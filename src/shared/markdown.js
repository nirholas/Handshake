// Shared sanitized Markdown renderer for every surface that shows model or
// user authored text (brain chat, bounty briefs, manifest previews, memory
// seeds, NPC analysis). Full CommonMark + GFM via `marked`, then a strict
// DOMPurify pass so the result is safe to assign via innerHTML even if a
// renderer bug or a hostile payload slips through upstream.
//
// This replaces eight hand-rolled per-file renderers that each carried their
// own escape logic and subset of Markdown. Do not add another one; extend
// this module instead.

import { Marked } from 'marked';
import createDOMPurify from 'dompurify';

const marked = new Marked({ gfm: true, breaks: true, async: false });

const purify = createDOMPurify(window);

// Markdown output only: no media, no forms, no style. Links are hardened in
// the hook below.
const SANITIZE_CFG = {
	ALLOWED_TAGS: [
		'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
		'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
		'strong', 'em', 'del', 'a', 'span',
		'table', 'thead', 'tbody', 'tr', 'th', 'td',
	],
	ALLOWED_ATTR: ['href', 'class', 'start', 'align', 'target', 'rel'],
};

const SAFE_HREF = /^(?:https?:|mailto:)/i;

purify.addHook('afterSanitizeAttributes', (node) => {
	if (node.tagName !== 'A') return;
	const href = node.getAttribute('href') || '';
	const ok = SAFE_HREF.test(href) || href.startsWith('/') || href.startsWith('#');
	if (!ok) node.removeAttribute('href');
	node.setAttribute('target', '_blank');
	node.setAttribute('rel', 'noopener noreferrer nofollow');
});

/**
 * Render Markdown to sanitized HTML.
 *
 * @param {string} src Markdown source (model output, user content).
 * @param {object} [opts]
 * @param {Record<string, string>} [opts.classes] CSS classes to add per
 *   selector, e.g. `{ pre: 'md-code', 'code:not(pre code)': 'md-ic' }`, so
 *   existing per-page stylesheets keep working.
 * @param {number} [opts.demoteHeadings] Shift headings down N levels
 *   (`# -> h3` for pages where the content sits under a section h2).
 * @returns {string} HTML string safe for innerHTML.
 */
export function renderMarkdown(src, { classes, demoteHeadings = 0 } = {}) {
	if (src == null || src === '') return '';
	const raw = marked.parse(String(src));
	const clean = purify.sanitize(raw, SANITIZE_CFG);
	if (!classes && !demoteHeadings) return clean;

	const tpl = document.createElement('template');
	tpl.innerHTML = clean;
	if (demoteHeadings > 0) {
		for (let lvl = 6; lvl >= 1; lvl--) {
			for (const el of [...tpl.content.querySelectorAll(`h${lvl}`)]) {
				const next = document.createElement(`h${Math.min(6, lvl + demoteHeadings)}`);
				next.innerHTML = el.innerHTML;
				for (const attr of el.attributes) next.setAttribute(attr.name, attr.value);
				el.replaceWith(next);
			}
		}
	}
	if (classes) {
		for (const [sel, cls] of Object.entries(classes)) {
			for (const el of tpl.content.querySelectorAll(sel)) el.classList.add(cls);
		}
	}
	return tpl.innerHTML;
}

/**
 * Strip Markdown syntax for plain-text contexts (voice narration, tooltips,
 * meta descriptions).
 */
export function stripMarkdown(src) {
	return String(src ?? '')
		.replace(/```[\s\S]*?```/g, ' ')
		.replace(/`([^`]+)`/g, '$1')
		.replace(/!?\[([^\]]*)\]\([^)\s]*\)/g, '$1')
		.replace(/^#{1,6}\s+/gm, '')
		.replace(/^\s*>\s?/gm, '')
		.replace(/^\s*[-*+]\s+/gm, '')
		.replace(/^\s*\d+[.)]\s+/gm, '')
		.replace(/(\*\*|__|[*_~])/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}
