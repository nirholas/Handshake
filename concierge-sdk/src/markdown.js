/**
 * Markdown renderer: @three-ws/concierge
 * ======================================
 *
 * Answers stream back from the model as Markdown and land in the panel via
 * innerHTML, on a customer's own page. That makes this the most
 * safety-critical module in the SDK, so it does not hand-roll parsing: it
 * renders with `marked` (CommonMark + GFM) and then hardens the result with
 * DOMPurify under an allowlist that permits only text-level markup. Media,
 * forms, styles, and event handlers cannot survive the pass, and link hrefs
 * are restricted to http(s)/mailto plus same-site relative paths.
 */

import { Marked } from 'marked';
import createDOMPurify from 'dompurify';

const marked = new Marked({ gfm: true, breaks: true, async: false });

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** HTML-escape a string for interpolation into a template. */
export function escapeHtml(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
}

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

// Built on first use so the module can be imported in a non-DOM context
// (bundler analysis, unit tests) without touching `window` at load time.
let purify = null;
function getPurify() {
	if (purify) return purify;
	purify = createDOMPurify(window);
	purify.addHook('afterSanitizeAttributes', (node) => {
		if (node.tagName !== 'A') return;
		const href = node.getAttribute('href') || '';
		const ok = SAFE_HREF.test(href) || href.startsWith('/') || href.startsWith('#');
		if (!ok) node.removeAttribute('href');
		node.setAttribute('target', '_blank');
		node.setAttribute('rel', 'noopener noreferrer');
	});
	return purify;
}

/**
 * Render `text` as Markdown to sanitized HTML. Safe to assign via innerHTML.
 */
export function renderMarkdown(text) {
	if (text == null || text === '') return '';
	return getPurify().sanitize(marked.parse(String(text)), SANITIZE_CFG);
}

/**
 * Strip markdown for the voice channel: what the narrator speaks should be
 * the words, not the syntax.
 */
export function stripMarkdown(text) {
	return String(text ?? '')
		.replace(/```[\s\S]*?```/g, ' code sample. ')
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
