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
// elements (quoted attribute values may contain `>`, the element ends at the
// first `</script` regardless of what the source text looks like), because a
// missed script means a blocked script means a broken page. Over-matching is
// harmless: an extra hash allows a script that does not exist.
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

const SCRIPT_OPEN = /<script/gi;

// Walk the attribute list of an already-located `<script` tag, honouring
// quoted values, and return the index just past the tag's closing `>` plus
// whether the tag carried a `src` attribute. Returns null for a tag that never
// closes (truncated document).
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

// The HTML parser ends a script element at the first `</script` followed by a
// tag terminator, whatever the script text contains. `lower` is a lowercased
// copy of the whole document so a page with many scripts does not re-lowercase
// it once per script.
function findScriptCloseIn(lower, from) {
	let i = from;
	for (;;) {
		const idx = lower.indexOf('</script', i);
		if (idx === -1) return null;
		const after = lower[idx + 8];
		if (after === undefined || after === '>' || after === '/' || /\s/.test(after)) return idx;
		i = idx + 8;
	}
}

/**
 * Every inline script body in `html`, in document order, exactly as the CSP
 * hash algorithm sees it (the raw text between the tags).
 * @param {string} html
 * @returns {string[]}
 */
export function inlineScriptBodies(html) {
	const bodies = [];
	// One lowercase copy for the close-tag scan instead of one per script.
	const lower = html.toLowerCase();
	let cursor = 0;
	for (;;) {
		SCRIPT_OPEN.lastIndex = cursor;
		const open = SCRIPT_OPEN.exec(html);
		if (!open) break;
		const nameEnd = open.index + 7; // past "<script"
		const next = html[nameEnd];
		// `<scriptfoo` is not a script element.
		if (next !== undefined && !/[\s/>]/.test(next)) {
			cursor = nameEnd;
			continue;
		}
		const tag = readOpenTag(html, nameEnd);
		if (!tag) break;
		const close = findScriptCloseIn(lower, tag.end);
		if (close === null) {
			// Unterminated script: the parser treats the rest of the document as
			// its body, and so do we.
			if (!/\ssrc\s*=/i.test(tag.attrs)) bodies.push(html.slice(tag.end));
			break;
		}
		if (!/\ssrc\s*=/i.test(tag.attrs)) bodies.push(html.slice(tag.end, close));
		cursor = close + 8;
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
