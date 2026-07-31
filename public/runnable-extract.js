// three.ws runnable-sample extractor.
//
// One source of truth for the question "is this documentation code block safe to
// execute for the reader, and if so, what exactly does it call?" It is imported
// unchanged by two very different callers:
//
//   • public/runnable-samples.js  — the browser, to put a Run button on a block
//   • scripts/check-runnable-docs.mjs — Node, to execute every runnable sample in
//     docs/ against the live API and fail the build when a documented call rots
//
// Because both sides share this file, a sample the gate proves alive is exactly
// the sample the reader can run, and a rule tightened here tightens both at once.
//
// The module is deliberately DOM-free and dependency-free so it loads in a plain
// <script type="module"> and in Node with no build step.

/** Hosts whose URLs we are willing to call on the reader's behalf. */
export const SAFE_HOSTS = new Set(['three.ws', 'www.three.ws']);

/**
 * Paths that are never runnable even when the request is a bare GET.
 * Some are account-scoped (the reader would only ever see their own 401), some
 * move money or run scheduled work, and some are pure plumbing that teaches the
 * reader nothing. A GET here is not dangerous so much as dishonest: a Run button
 * that always returns 401 is a broken promise.
 */
export const BLOCKED_PREFIXES = [
	'/api/admin',
	'/api/auth',
	'/api/cron',
	'/api/credits',
	'/api/csrf-token',
	'/api/logout',
	'/api/pay',
	'/api/session',
	'/api/user',
	'/api/wallet',
	'/api/webhook',
];

/**
 * Request headers that mean the sample only works with a secret, a session, or a
 * device identity the reader does not have. A Run button on one of these can
 * only ever show the reader a 400 or a 401.
 */
const CREDENTIAL_HEADERS =
	/^(authorization|cookie|x-api-key|x-payment|x-forge-provider-key|x-admin-|x-cron-|x-signature|x-irl-|x-device|x-session)/i;

/** curl flags that take a value we must skip over when scanning for the URL. */
const VALUE_FLAGS = new Set([
	'-H',
	'--header',
	'-d',
	'--data',
	'--data-raw',
	'--data-binary',
	'--data-urlencode',
	'-F',
	'--form',
	'-X',
	'--request',
	'-o',
	'--output',
	'-u',
	'--user',
	'-b',
	'--cookie',
	'-A',
	'--user-agent',
	'-e',
	'--referer',
	'-T',
	'--upload-file',
	'-w',
	'--write-out',
	'--connect-timeout',
	'--max-time',
	'-m',
	'--retry',
]);

/** Flags that prove the sample writes, uploads, or authenticates. */
const DISQUALIFYING_FLAGS = new Set([
	'-d',
	'--data',
	'--data-raw',
	'--data-binary',
	'--data-urlencode',
	'-F',
	'--form',
	'-T',
	'--upload-file',
	'-u',
	'--user',
	'-b',
	'--cookie',
	'-O',
	'--remote-name',
	'-o',
	'--output',
]);

/**
 * Anything that says "the author left a blank here". A Run button on a URL with
 * a placeholder in it produces a confusing 400 and teaches the reader nothing.
 */
const PLACEHOLDER_PATTERNS = [
	/[$<>{}]/, // shell vars, angle placeholders, template braces
	/\.\.\./,
	/…/, // ellipsis character
	/[A-Z][A-Z0-9]*_[A-Z0-9_]+/, // JOB_ID, AGENT_ID, YOUR_KEY
	/\byour[-_]/i,
	/\bexample\.(com|org|net)\b/i,
	/\breplace[-_]me\b/i,
];

/** Split a shell-ish command into tokens, honouring single and double quotes. */
export function tokenize(command) {
	const tokens = [];
	let current = '';
	let quote = null;
	let started = false;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote) {
			if (ch === quote) quote = null;
			else current += ch;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			started = true;
			continue;
		}
		if (/\s/.test(ch)) {
			if (started || current) tokens.push(current);
			current = '';
			started = false;
			continue;
		}
		current += ch;
	}
	if (started || current) tokens.push(current);
	return tokens;
}

/**
 * Reduce a fenced shell block to the single command it contains, or null.
 * Handles backslash line-continuations, `$`/`>` prompts, and `#` comments. A
 * block holding two commands is not runnable: we will not guess which one the
 * reader meant.
 */
export function singleCommand(source) {
	const joined = String(source || '')
		.replace(/\\\r?\n[ \t]*/g, ' ')
		.replace(/\r/g, '');
	const lines = joined
		.split('\n')
		.map((line) => line.replace(/^\s*[$>]\s+/, '').trim())
		.filter((line) => line && !line.startsWith('#'));
	if (lines.length !== 1) return null;
	return lines[0];
}

function hasPlaceholder(value) {
	return PLACEHOLDER_PATTERNS.some((re) => re.test(value));
}

function blocked(pathname) {
	return BLOCKED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Parse an author directive written as an HTML comment directly above a fence:
 *
 *   <!-- runnable: no the vault id is illustrative -->
 *   <!-- runnable: 402 the x402 challenge is the lesson -->
 *
 * `no` opts a block out of the Run button and out of the gate. A status code
 * declares what this endpoint is supposed to answer, so the gate can hold a
 * paywalled or deliberately-empty endpoint to its real contract instead of
 * demanding a blanket 200.
 *
 * @param {string|null|undefined} comment the comment's inner text
 * @returns {{skip: true, note: string}|{expectStatus: number, note: string}|null}
 */
export function parseDirective(comment) {
	if (!comment) return null;
	const match = String(comment)
		.trim()
		.match(/^runnable:\s*(no|\d{3})\b\s*(.*)$/is);
	if (!match) return null;
	const note = match[2].trim();
	if (/^no$/i.test(match[1])) return { skip: true, note };
	return { expectStatus: Number(match[1]), note };
}

/**
 * Decide whether a documentation code block can be executed for the reader.
 *
 * @param {string} source raw text of the code block
 * @param {string} [lang] the fence language, when the caller knows it
 * @param {string} [comment] an author directive comment sitting above the fence
 * @returns {{runnable: true, method: 'GET', url: string, path: string, accept: string|null,
 *            expectStatus: number|null, note: string}
 *          |{runnable: false, reason: string}}
 */
export function extractRunnable(source, lang, comment) {
	const directive = parseDirective(comment);
	if (directive && directive.skip) {
		return { runnable: false, reason: directive.note || 'the author opted this block out' };
	}
	if (lang && !/^(bash|sh|shell|console|zsh|curl)$/i.test(lang)) {
		return { runnable: false, reason: 'not a shell block' };
	}
	const command = singleCommand(source);
	if (!command) return { runnable: false, reason: 'not a single command' };
	if (!/^curl(\s|$)/.test(command)) return { runnable: false, reason: 'not a curl command' };

	const tokens = tokenize(command);
	let method = 'GET';
	let accept = null;
	let url = null;

	for (let i = 1; i < tokens.length; i++) {
		const token = tokens[i];

		if (token === '-X' || token === '--request') {
			method = String(tokens[++i] || '').toUpperCase();
			continue;
		}
		if (token === '-H' || token === '--header') {
			const header = String(tokens[++i] || '');
			if (CREDENTIAL_HEADERS.test(header.trim())) {
				return { runnable: false, reason: 'needs a credential header' };
			}
			const [name, ...rest] = header.split(':');
			if (/^accept$/i.test(name.trim())) accept = rest.join(':').trim();
			continue;
		}
		if (DISQUALIFYING_FLAGS.has(token)) {
			return { runnable: false, reason: 'writes, uploads, or authenticates' };
		}
		if (VALUE_FLAGS.has(token)) {
			i++;
			continue;
		}
		if (token.startsWith('-')) continue; // a bundled boolean flag such as -sL or -i
		if (url) return { runnable: false, reason: 'more than one URL' };
		url = token;
	}

	if (method !== 'GET' && method !== 'HEAD') {
		return { runnable: false, reason: `method ${method} is not read-only` };
	}
	if (!url) return { runnable: false, reason: 'no URL in the command' };
	if (hasPlaceholder(url)) return { runnable: false, reason: 'the URL contains a placeholder' };

	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		return { runnable: false, reason: 'not an absolute URL' };
	}
	if (parsed.protocol !== 'https:') return { runnable: false, reason: 'not https' };
	if (!SAFE_HOSTS.has(parsed.hostname)) return { runnable: false, reason: 'not a three.ws URL' };
	if (blocked(parsed.pathname)) return { runnable: false, reason: 'account-scoped or privileged path' };

	// Runnable paths are API calls and small JSON manifests. Everything else on
	// the site is a page or a multi-megabyte binary; neither belongs in an
	// inline response console.
	const isApi = parsed.pathname.startsWith('/api/');
	const isJson = parsed.pathname.endsWith('.json');
	if (!isApi && !isJson) return { runnable: false, reason: 'not an API or JSON path' };

	return {
		runnable: true,
		method: 'GET',
		url: parsed.toString(),
		path: `${parsed.pathname}${parsed.search}`,
		accept,
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
	let lastComment = null;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!fence) {
			const html = line.match(/^\s*<!--([\s\S]*?)-->\s*$/);
			if (html) {
				lastComment = html[1];
				continue;
			}
		}
		const open = line.match(/^\s*(`{3,}|~{3,})\s*([A-Za-z0-9_-]*)\s*$/);
		if (!fence && open) {
			fence = open[1][0].repeat(3);
			lang = open[2] || '';
			start = i + 2;
			comment = lastComment;
			lastComment = null;
			buffer = [];
			continue;
		}
		if (fence) {
			const close = line.match(/^\s*(`{3,}|~{3,})\s*$/);
			if (close && close[1][0] === fence[0]) {
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
		if (line.trim()) lastComment = null;
	}
	return out;
}

/**
 * Every runnable sample in a markdown document, in document order.
 * @returns {Array<{url: string, path: string, accept: string|null, expectStatus: number|null,
 *                  note: string, line: number, code: string}>}
 */
export function runnableSamples(markdown) {
	const out = [];
	for (const block of codeBlocks(markdown)) {
		const verdict = extractRunnable(block.code, block.lang, block.comment);
		if (verdict.runnable) out.push({ ...verdict, line: block.line, code: block.code });
	}
	return out;
}
