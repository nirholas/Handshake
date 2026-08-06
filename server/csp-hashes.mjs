// Per-response CSP hardening: replaces `script-src 'unsafe-inline'` with the
// SHA-256 hashes of the inline scripts actually present in the HTML we are
// about to send.
//
// Why hashes and not a nonce: HTML on this site is cached at the CDN edge
// (`s-maxage=300` on the SSR/SEO paths, longer on plain static files). A
// per-request nonce baked into a cached document is the classic way to break a
// whole site: the first visitor's nonce is stored by the CDN and served to
// everybody else, whose CSP header carries a different nonce, so every inline
// script on the page is blocked. Hashes are a pure function of the bytes, so a
// cached document and its cached header always agree.
//
// The scanner below mirrors the HTML parser's own rules for finding script
// elements, because a missed script means a blocked script means a broken page:
// quoted attribute values may contain `>`, the element ends at the first
// `</script` regardless of what the source text looks like, and a `<script`
// inside a comment or a raw-text element is characters rather than markup.
// Over-matching is harmless: an extra hash allows a script that does not exist.
//
// Scripts with a `src` attribute are not hashed. Those are covered by the
// host allowlist in the directive; hashing an external script would require an
// `integrity` attribute to match.
//
// What this deliberately does NOT allow: inline event handler attributes
// (`onclick="..."`) and `javascript:` URLs. Those need `'unsafe-hashes'` or
// `'unsafe-inline'`, and allowing them back would hand the primary XSS
// mitigation straight back. scripts/audit-inline-handlers.mjs fails the build
// if any HTML in the repo reintroduces one.

import { createHash } from 'node:crypto';

// Elements whose content the HTML parser treats as raw text: a `<script>`
// written inside one is characters on the page, not a tag. Missing this is not
// a theoretical edge case. A CSS comment on /oracle that mentioned `<script>`
// made the scanner start a phantom script element there and run it to the next
// real `</script>`, which swallowed the PostHog snippet's opening tag. Its hash
// never reached the header and the browser blocked it.
const RAW_TEXT_ELEMENTS = ['style', 'textarea', 'title'];

// Walk the attribute list of an already-located `<script` tag, honouring
// quoted values, and return the index just past the tag's closing `>` plus the
// attribute text. Returns null for a tag that never closes (truncated document).
function readOpenTag(html, from) {
	let i = from;
	let quote = null;
	let attrs = '';
	while (i < html.length) {
		const ch = html[i];
		if (quote) {
			if (ch === quote) quote = null;
			attrs += ch;
		} else if (ch === '"' || ch === "'") {
			quote = ch;
			attrs += ch;
		} else if (ch === '>') {
			return { end: i + 1, attrs };
		} else {
			attrs += ch;
		}
		i++;
	}
	return null;
}

// Index of the first `</name` that actually terminates an element, i.e. one
// followed by a tag terminator. `lower` is a lowercased copy of the whole
// document so a page with many elements does not re-lowercase it each time.
function findClose(lower, name, from) {
	const needle = `</${name}`;
	let i = from;
	for (;;) {
		const idx = lower.indexOf(needle, i);
		if (idx === -1) return null;
		const after = lower[idx + needle.length];
		if (after === undefined || after === '>' || after === '/' || /\s/.test(after)) return idx;
		i = idx + needle.length;
	}
}

// True when `<` at `index` opens element `name` rather than one whose name
// merely starts with it (`<scripty`, `<styles`).
function opensElement(lower, index, name) {
	if (!lower.startsWith(`<${name}`, index)) return false;
	const next = lower[index + name.length + 1];
	return next === undefined || next === '>' || next === '/' || /\s/.test(next);
}

/**
 * Every inline script body in `html`, in document order, exactly as the CSP
 * hash algorithm sees it (the raw text between the tags).
 *
 * The scan walks the document once and steps over the three constructs where a
 * `<script` is text rather than markup: HTML comments, and the raw-text
 * elements above. Over-matching a script is harmless (an extra hash allows
 * something that does not exist); under-matching ships the page blank.
 *
 * @param {string} html
 * @returns {string[]}
 */
export function inlineScriptBodies(html) {
	const bodies = [];
	const lower = html.toLowerCase();
	let i = 0;
	while (i < html.length) {
		const lt = html.indexOf('<', i);
		if (lt === -1) break;

		if (lower.startsWith('<!--', lt)) {
			const end = html.indexOf('-->', lt + 4);
			i = end === -1 ? html.length : end + 3;
			continue;
		}

		const raw = RAW_TEXT_ELEMENTS.find((name) => opensElement(lower, lt, name));
		if (raw) {
			const tag = readOpenTag(html, lt + raw.length + 1);
			if (!tag) break;
			const close = findClose(lower, raw, tag.end);
			i = close === null ? html.length : close + raw.length + 2;
			continue;
		}

		if (!opensElement(lower, lt, 'script')) {
			i = lt + 1;
			continue;
		}

		const tag = readOpenTag(html, lt + 7);
		if (!tag) break;
		const isExternal = /\ssrc\s*=/i.test(tag.attrs);
		const close = findClose(lower, 'script', tag.end);
		if (close === null) {
			// Unterminated script: the parser treats the rest of the document as
			// its body, and so do we.
			if (!isExternal) bodies.push(html.slice(tag.end));
			break;
		}
		if (!isExternal) bodies.push(html.slice(tag.end, close));
		i = close + 8;
	}
	return bodies;
}

/**
 * CSP source expressions for every inline script in `html`, deduplicated.
 * @param {string} html
 * @returns {string[]} e.g. ["'sha256-47DEQpj8HBSa...'"]
 */
export function inlineScriptHashes(html) {
	const seen = new Set();
	for (const body of inlineScriptBodies(html)) {
		seen.add(`'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`);
	}
	return [...seen];
}

/**
 * Rewrite a CSP header value so `script-src` (and `script-src-elem`, when
 * present) allows exactly the inline scripts in `html` instead of all of them.
 *
 * A policy without `'unsafe-inline'` in its script directive is returned
 * untouched, so this is safe to run over every response.
 *
 * @param {string} csp the policy from the route table
 * @param {string} html the exact body being sent
 * @returns {string}
 */
export function hardenInlineScripts(csp, html) {
	if (typeof csp !== 'string' || !csp.includes("'unsafe-inline'")) return csp;
	const hashes = inlineScriptHashes(html);
	return csp
		.split(';')
		.map((directive) => {
			const trimmed = directive.trim();
			if (!trimmed) return directive;
			const name = trimmed.split(/\s+/, 1)[0].toLowerCase();
			if (name !== 'script-src' && name !== 'script-src-elem') return directive;
			if (!trimmed.includes("'unsafe-inline'")) return directive;
			const sources = trimmed
				.split(/\s+/)
				.slice(1)
				.filter((s) => s !== "'unsafe-inline'" && !s.startsWith("'sha256-"));
			return ` ${name} ${[...sources, ...hashes].join(' ')}`;
		})
		.join(';');
}

const CSP_KEYS = ['content-security-policy', 'Content-Security-Policy'];

/**
 * Apply {@link hardenInlineScripts} to whichever casing of the CSP key a
 * collected header bag happens to use. Mutates and returns the bag.
 * @param {Record<string, string>} headers
 * @param {string} html
 * @returns {Record<string, string>}
 */
export function hardenHeaderBag(headers, html) {
	if (!headers) return headers;
	for (const key of CSP_KEYS) {
		if (typeof headers[key] === 'string') headers[key] = hardenInlineScripts(headers[key], html);
	}
	return headers;
}
