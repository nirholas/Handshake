// Live Docs: the verification layer.
//
// Live Docs (docs-live.js) lets a reader press Run on a documentation sample.
// This module answers the narrower question CI needs: *which* samples can be
// executed with no human in the loop, and what is each one supposed to answer?
//
// It is deliberately built on docs-live-core.js rather than beside it. The
// runner and the gate share one tokenizer, one curl parser, one placeholder
// detector and one safety assessment, so a sample the gate proves alive is
// exactly the sample the reader can run. Duplicating those rules is how the two
// halves drift apart and the gate starts certifying something nobody sees.
//
// Consumed by:
//   • scripts/check-runnable-docs.mjs: executes every verifiable sample in
//     docs/ against the live API and fails the build when one rots
//   • docs-live.js: reads the author directives below so an opt-out written for
//     the gate also suppresses the Run button
//
// ── Author directives ────────────────────────────────────────────────────────
// An HTML comment on the line above a fence controls both halves:
//
//   <!-- runnable: no the vault id is illustrative -->     never run, never probe
//   <!-- runnable: 402 the challenge is the lesson -->      probe, expect exactly 402
//   <!-- live: off -->                                      the runner's original
//                                                           opt-out, honoured here too
//
// DOM-free and dependency-free: it loads in a plain <script type="module"> and
// in Node with no build step.

import { classifyBlock, findPlaceholders } from './docs-live-core.js';

/** Hosts a probe is willing to call. Localhost is a runner convenience, not a target CI can verify. */
export const VERIFIABLE_HOSTS = Object.freeze(['three.ws', 'www.three.ws']);

/**
 * Paths that are never verifiable even as a bare GET. Some are account-scoped,
 * so the only thing CI could ever prove is that a logged-out probe gets a 401;
 * some are plumbing whose response teaches a reader nothing.
 */
export const UNVERIFIABLE_PREFIXES = Object.freeze([
	'/api/admin',
	'/api/auth',
	'/api/cron',
	'/api/credits',
	'/api/csrf-token',
	'/api/developer',
	'/api/keys',
	'/api/logout',
	'/api/session',
	'/api/user',
	'/api/webhook',
]);

/**
 * A value the doc shortened or left blank. `findPlaceholders` covers the slot
 * syntaxes the runner renders a field for (`$VAR`, `<id>`, `YOUR_KEY`); these
 * two conventions carry no fillable name, so only the gate needs to reject them.
 *
 *   an ellipsis, literal or percent-encoded, means the author elided the value
 *   BARE_CAPS_WITH_UNDERSCORES is the docs' shorthand for "your own id here"
 */
const ELIDED_VALUE = /\.\.\.|…|%E2%80%A6/i;
const BARE_CAPS_SLOT = /(^|[^A-Za-z0-9])[A-Z][A-Z0-9]*_[A-Z0-9_]+([^A-Za-z0-9]|$)/;

/**
 * Request headers that carry a secret, a session, or a device identity. A probe
 * that sends none of them can only ever see the endpoint's logged-out answer, so
 * a sample that needs one is not something CI can hold to a contract.
 */
const IDENTITY_HEADERS =
	/^(authorization|cookie|x-api-key|x-payment|x-forge-provider-key|x-admin-|x-cron-|x-signature|x-irl-|x-device|x-session)/i;

/**
 * Parse an author directive from an HTML comment.
 *
 * @param {string|null|undefined} comment the comment's inner text
 * @returns {{skip: true, note: string} | {expectStatus: number, note: string} | null}
 */
export function parseDirective(comment) {
	if (!comment) return null;
	const text = String(comment).trim();
	if (/^live\s*:\s*off\b/i.test(text)) return { skip: true, note: 'the author opted this block out' };
	const match = text.match(/^runnable:\s*(no|\d{3})\b\s*(.*)$/is);
	if (!match) return null;
	const note = match[2].trim();
	if (/^no$/i.test(match[1])) return { skip: true, note };
	return { expectStatus: Number(match[1]), note };
}

/**
 * Decide whether a documentation code block can be probed without a human.
 *
 * @param {string} code raw text of the code block
 * @param {string} [lang] the fence language
 * @param {string} [comment] an author directive sitting above the fence
 * @returns {{verifiable: true, url: string, path: string, accept: string|null,
 *            expectStatus: number|null, note: string}
 *          |{verifiable: false, reason: string}}
 */
export function verifiableSample(code, lang, comment) {
	const directive = parseDirective(comment);
	if (directive && directive.skip) {
		return { verifiable: false, reason: directive.note || 'the author opted this block out' };
	}

	const verdict = classifyBlock({ lang, code });
	if (!verdict || verdict.kind !== 'request') {
		return { verifiable: false, reason: 'not a runnable request' };
	}
	const request = verdict.request;

	if (request.method !== 'GET' && request.method !== 'HEAD') {
		return { verifiable: false, reason: `${request.method} is not read-only` };
	}
	if (request.body != null) return { verifiable: false, reason: 'sends a body' };

	for (const name of Object.keys(request.headers || {})) {
		if (IDENTITY_HEADERS.test(name.trim())) {
			return { verifiable: false, reason: 'needs a credential header' };
		}
	}
	// A slot the reader is expected to fill is exactly what CI cannot fill.
	if (findPlaceholders(request).length) {
		return { verifiable: false, reason: 'contains a placeholder the reader fills in' };
	}
	if (ELIDED_VALUE.test(request.url)) {
		return { verifiable: false, reason: 'the URL contains an elided value' };
	}
	if (BARE_CAPS_SLOT.test(request.url)) {
		return { verifiable: false, reason: 'the URL contains a placeholder id' };
	}

	let parsed;
	try {
		parsed = new URL(request.url);
	} catch {
		return { verifiable: false, reason: 'not an absolute URL' };
	}
	if (parsed.protocol !== 'https:') return { verifiable: false, reason: 'not https' };
	if (!VERIFIABLE_HOSTS.includes(parsed.hostname)) {
		return { verifiable: false, reason: 'not a three.ws URL' };
	}
	if (UNVERIFIABLE_PREFIXES.some((p) => parsed.pathname === p || parsed.pathname.startsWith(`${p}/`))) {
		return { verifiable: false, reason: 'account-scoped or privileged path' };
	}
	// Verifiable paths are API calls and small JSON manifests. Everything else on
	// the site is a page or a multi-megabyte binary, and probing those proves
	// nothing about whether the documented call still works.
	if (!parsed.pathname.startsWith('/api/') && !parsed.pathname.endsWith('.json')) {
		return { verifiable: false, reason: 'not an API or JSON path' };
	}

	const accept = Object.entries(request.headers || {}).find(([k]) => /^accept$/i.test(k));
	return {
		verifiable: true,
		url: parsed.toString(),
		path: `${parsed.pathname}${parsed.search}`,
		accept: accept ? accept[1] : null,
		expectStatus: directive ? directive.expectStatus : null,
		note: directive ? directive.note : '',
	};
}

/**
 * Pull every fenced code block out of a markdown document, along with any author
 * directive comment on the line above it.
 * @returns {Array<{lang: string, code: string, line: number, comment: string|null}>}
 */
export function codeBlocks(markdown) {
	const out = [];
	const lines = String(markdown || '').split('\n');
	let fence = null;
	let lang = '';
	let start = 0;
	let comment = null;
	let buffer = [];
	let pending = null;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!fence) {
			const html = line.match(/^\s*<!--([\s\S]*?)-->\s*$/);
			if (html) {
				pending = html[1];
				continue;
			}
		}
		const open = line.match(/^\s*(`{3,}|~{3,})\s*([A-Za-z0-9_-]*)\s*$/);
		if (!fence && open) {
			fence = open[1][0];
			lang = open[2] || '';
			start = i + 2;
			comment = pending;
			pending = null;
			buffer = [];
			continue;
		}
		if (fence) {
			const close = line.match(/^\s*(`{3,}|~{3,})\s*$/);
			if (close && close[1][0] === fence) {
				out.push({ lang, code: buffer.join('\n'), line: start, comment });
				fence = null;
				comment = null;
				buffer = [];
				continue;
			}
			buffer.push(line);
			continue;
		}
		// A directive only binds to the fence it immediately precedes.
		if (line.trim()) pending = null;
	}
	return out;
}

/**
 * Every verifiable sample in a markdown document, in document order.
 * @returns {Array<{url: string, path: string, accept: string|null, expectStatus: number|null,
 *                  note: string, line: number, code: string}>}
 */
export function verifiableSamples(markdown) {
	const out = [];
	for (const block of codeBlocks(markdown)) {
		const verdict = verifiableSample(block.code, block.lang, block.comment);
		if (verdict.verifiable) out.push({ ...verdict, line: block.line, code: block.code });
	}
	return out;
}
