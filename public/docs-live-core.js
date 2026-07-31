// Live Docs — the pure half.
//
// Every runnable code sample on three.ws docs is decided here: what kind of
// runner a fenced block deserves, how a `curl` line becomes a real request,
// which requests a reader is allowed to fire from a documentation page, and how
// a snippet is wrapped into a sandboxed preview document.
//
// Nothing in this file touches the DOM, the network, or `window`. That is
// deliberate: the interesting logic (shell tokenizing, placeholder detection,
// the money-path guard) is exactly the logic that must be unit-tested in Node,
// and the runner in docs-live.js is then a thin, boring shell around it.
// tests/docs-live-core.test.js imports this module directly.
//
// Design rule that shapes the whole file: a documentation page is READ by
// people who are evaluating the platform, often signed in. A "Run" button on
// such a page is a loaded gun unless it is narrow by construction. So:
//   - only three.ws origins are reachable (no arbitrary host from a snippet),
//   - GET/HEAD run on one click,
//   - other verbs demand an explicit second confirmation,
//   - anything whose path can move money or mint is never runnable at all.
// The guard lives here, in the tested layer, not in a click handler.

/** Fence languages that can carry an inline HTML/web-component preview. */
export const PREVIEW_LANGS = Object.freeze(['html', 'xml', 'svg']);

/** Fence languages that can carry a shell request. */
export const SHELL_LANGS = Object.freeze(['bash', 'sh', 'shell', 'zsh', 'console', 'curl']);

/** Fence languages that can carry a runnable browser script. */
export const SCRIPT_LANGS = Object.freeze(['js', 'javascript', 'mjs']);

/** Origins a docs sample is allowed to call. Anything else is not runnable. */
export const ALLOWED_HOSTS = Object.freeze(['three.ws', 'www.three.ws', 'localhost', '127.0.0.1']);

// Paths that move value or create something irreversible. A reader clicking
// "Run" in a doc must never be able to reach these, confirmation or not: the
// blast radius of a mis-click is someone else's money. Matched against the
// pathname, case-insensitively, as a substring.
const IRREVERSIBLE_PATH_PARTS = Object.freeze([
	'/pay',
	'/send',
	'/transfer',
	'/withdraw',
	'/fund',
	'/swap',
	'/trade',
	'/buy',
	'/sell',
	'/wallet',
	'/mint',
	'/launch',
	'/autopilot',
	'/x402',
	'/checkout',
	'/billing',
	'/subscribe',
	'/sniper',
	'/vault',
]);

const SAFE_METHODS = Object.freeze(['GET', 'HEAD']);
const KNOWN_METHODS = Object.freeze(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

// ── Fence classification ─────────────────────────────────────────────────────

/**
 * Decide what a fenced code block can do.
 *
 * @param {{ lang?: string, code?: string }} block
 * @returns {null | { kind: 'preview'|'request'|'script', reason?: string, request?: object }}
 *   null when the block is ordinary prose-adjacent code with nothing to run.
 */
export function classifyBlock(block = {}) {
	const lang = String(block.lang || '').toLowerCase().trim();
	const code = String(block.code || '');
	if (!code.trim()) return null;

	if (PREVIEW_LANGS.includes(lang) && hasRenderableMarkup(code)) {
		return { kind: 'preview' };
	}

	if (SHELL_LANGS.includes(lang)) {
		const request = parseCurl(code);
		if (request) return { kind: 'request', request };
		return null;
	}

	if (SCRIPT_LANGS.includes(lang) && isRunnableScript(code)) {
		return { kind: 'script' };
	}

	return null;
}

// A preview is only worth offering when the snippet actually renders something.
// A block of `<meta>` tags or a bare `<div>` produces an empty box, which reads
// as a broken feature; the three.ws embed elements and plain visible markup do
// not. `<script>`-only snippets are excluded for the same reason.
function hasRenderableMarkup(code) {
	if (/<(agent-3d|model-viewer|three-ws-[a-z-]+)\b/i.test(code)) return true;
	if (/^\s*<(!doctype|html)\b/i.test(code)) return true;
	// Visible structural markup with text or an element inside it.
	return /<(div|section|main|button|p|h[1-6]|ul|ol|table|img|canvas|iframe|form|a)\b[^>]*>/i.test(code);
}

// Scripts are only offered a runner when they visibly do something observable:
// a network call or console output. Running a snippet whose whole body is a
// type definition produces an empty result panel and teaches the reader that
// the feature is broken.
function isRunnableScript(code) {
	if (/\bimport\s+[^;]*from\s+['"][^./'"]/.test(code)) return false; // bare specifier, needs a bundler
	if (/\brequire\s*\(/.test(code)) return false; // Node sample
	if (/\bprocess\.env\b/.test(code)) return false; // Node sample
	return /\bfetch\s*\(|\bconsole\.(log|info|warn|error|table)\s*\(/.test(code);
}

// ── Shell parsing ────────────────────────────────────────────────────────────

/**
 * Split a shell command into argv, honouring single/double quotes, backslash
 * line continuations, and `$'...'`-free simple escaping. Comment lines and a
 * leading `$ ` prompt are dropped so a copy-pasted console transcript parses.
 *
 * @param {string} input
 * @returns {string[]}
 */
export function tokenizeShell(input) {
	const text = String(input || '')
		.split('\n')
		.map((line) => line.replace(/^\s*\$\s+/, ''))
		.filter((line) => !/^\s*#/.test(line))
		.join('\n')
		.replace(/\\\r?\n/g, ' ');

	const out = [];
	let cur = '';
	let quote = null;
	let started = false;

	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i];
		if (quote) {
			if (ch === '\\' && quote === '"' && i + 1 < text.length) {
				i += 1;
				cur += text[i];
				continue;
			}
			if (ch === quote) {
				quote = null;
				continue;
			}
			cur += ch;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			started = true;
			continue;
		}
		if (ch === '\\' && i + 1 < text.length) {
			i += 1;
			cur += text[i];
			started = true;
			continue;
		}
		if (/\s/.test(ch)) {
			if (started) out.push(cur);
			cur = '';
			started = false;
			continue;
		}
		cur += ch;
		started = true;
	}
	if (started) out.push(cur);
	return out;
}

/**
 * Turn a `curl` invocation into a request description.
 *
 * Returns null for anything that is not a single, self-contained curl call:
 * pipelines, multiple commands, `curl | sh`, and non-curl shell lines all fall
 * through to "not runnable" rather than being guessed at.
 *
 * @param {string} command
 * @returns {null | { method: string, url: string, headers: Record<string,string>, body: string|null }}
 */
export function parseCurl(command) {
	const raw = String(command || '');
	// One command only. A pipeline or a chained command means the sample is a
	// recipe, not a request, and running just the curl half would mislead.
	if (/[|;]|&&/.test(raw.replace(/\\\r?\n/g, ' '))) return null;

	const argv = tokenizeShell(raw);
	if (!argv.length || argv[0] !== 'curl') return null;

	const headers = {};
	let method = null;
	let url = null;
	let body = null;

	for (let i = 1; i < argv.length; i += 1) {
		const arg = argv[i];
		const next = () => argv[++i];

		if (arg === '-X' || arg === '--request') {
			method = String(next() || '').toUpperCase();
		} else if (arg === '-H' || arg === '--header') {
			const h = String(next() || '');
			const idx = h.indexOf(':');
			if (idx > 0) headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
		} else if (arg === '-d' || arg === '--data' || arg === '--data-raw' || arg === '--data-binary') {
			const chunk = String(next() || '');
			body = body == null ? chunk : `${body}&${chunk}`;
		} else if (arg === '--url') {
			url = String(next() || '');
		} else if (arg === '-o' || arg === '--output' || arg === '-A' || arg === '--user-agent' || arg === '-u' || arg === '--user') {
			next(); // consumes its value; irrelevant to an in-page fetch
		} else if (arg.startsWith('-')) {
			// Bare flags (-s, -L, -i, --compressed, …) carry no value.
			continue;
		} else if (!url) {
			url = arg;
		}
	}

	if (!url) return null;
	if (!method) method = body != null ? 'POST' : 'GET';
	if (!KNOWN_METHODS.includes(method)) return null;

	return { method, url, headers, body };
}

// ── Safety ───────────────────────────────────────────────────────────────────

/**
 * Resolve a sample URL against three.ws and say whether it may be run.
 *
 * @param {{ method?: string, url?: string }} request
 * @param {{ origin?: string }} [opts]  the origin a relative URL resolves against
 * @returns {{ ok: boolean, confirm: boolean, url: string|null, reason: string|null }}
 */
export function assessRequest(request = {}, opts = {}) {
	const origin = normalizeOrigin(opts.origin) || 'https://three.ws';
	const method = String(request.method || 'GET').toUpperCase();
	const deny = (reason) => ({ ok: false, confirm: false, url: null, reason });

	let parsed;
	try {
		parsed = new URL(String(request.url || ''), origin);
	} catch {
		return deny('That URL could not be parsed.');
	}

	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
		return deny('Only http(s) requests can run from the docs.');
	}
	if (!ALLOWED_HOSTS.includes(parsed.hostname)) {
		return deny(`Only three.ws endpoints run here. This sample calls ${parsed.hostname}.`);
	}

	const path = parsed.pathname.toLowerCase();
	if (IRREVERSIBLE_PATH_PARTS.some((part) => path.includes(part))) {
		return deny('This endpoint can move funds or mint. Copy it and run it yourself.');
	}
	if (!KNOWN_METHODS.includes(method)) {
		return deny(`${method} is not a method the docs runner sends.`);
	}

	return {
		ok: true,
		confirm: !SAFE_METHODS.includes(method),
		url: parsed.toString(),
		reason: null,
	};
}

function normalizeOrigin(origin) {
	if (!origin) return null;
	try {
		return new URL(String(origin)).origin;
	} catch {
		return null;
	}
}

// ── Placeholders ─────────────────────────────────────────────────────────────

// Two characters is the floor, not three: `<id>` and `$ID` are both real slot
// names in the API reference, and a three-character minimum silently skipped
// them, leaving the reader with a request that called /api/agents/<id>.
const PLACEHOLDER_PATTERNS = Object.freeze([
	/\$\{([A-Z][A-Z0-9_]+)\}/g,
	/\$([A-Z][A-Z0-9_]+)\b/g,
	/<([A-Za-z][A-Za-z0-9_-]+)>/g,
	/\b(YOUR_[A-Z0-9_]+)\b/g,
]);

/**
 * Every `$API_KEY` / `<agent-id>` / `YOUR_TOKEN` slot in a request, in the order
 * a reader would fill them in. The runner renders one field per name, so a doc
 * sample stops being a thing you copy, edit elsewhere and paste back.
 *
 * @param {{ url?: string, headers?: object, body?: string|null }} request
 * @returns {Array<{ name: string, secret: boolean }>}
 */
export function findPlaceholders(request = {}) {
	const haystack = [
		String(request.url || ''),
		...Object.entries(request.headers || {}).map(([k, v]) => `${k}: ${v}`),
		String(request.body || ''),
	].join('\n');

	const names = [];
	const seen = new Set();
	for (const pattern of PLACEHOLDER_PATTERNS) {
		pattern.lastIndex = 0;
		let match = pattern.exec(haystack);
		while (match) {
			const name = match[1];
			if (!seen.has(name) && !isHtmlishTag(name)) {
				seen.add(name);
				names.push({ name, secret: isSecretName(name) });
			}
			match = pattern.exec(haystack);
		}
	}
	return names;
}

// `<html>`-shaped captures come from prose in a header value, not from a slot
// the reader is meant to fill.
const HTMLISH = new Set(['html', 'body', 'head', 'div', 'span', 'br', 'p', 'a', 'pre', 'code', 'em', 'strong']);
function isHtmlishTag(name) {
	return HTMLISH.has(String(name).toLowerCase());
}

/** Names whose value must never be written to storage. */
export function isSecretName(name) {
	return /(KEY|TOKEN|SECRET|PASSWORD|PASS|AUTH|CREDENTIAL|PRIVATE)/i.test(String(name));
}

/**
 * Substitute placeholder values into a parsed request. Unfilled slots are left
 * exactly as they are so the reader sees which field they skipped rather than a
 * request that silently calls `/api/agents/undefined`.
 *
 * @param {object} request
 * @param {Record<string,string>} values
 * @returns {object} a new request; the input is not mutated
 */
export function applyPlaceholders(request = {}, values = {}) {
	const fill = (text) => {
		let out = String(text == null ? '' : text);
		for (const [name, value] of Object.entries(values)) {
			if (value === '' || value == null) continue;
			const v = String(value);
			// `${NAME}` first: replacing `$NAME` first would leave a stray `}`.
			out = out.split(`\${${name}}`).join(v).split(`$${name}`).join(v).split(`<${name}>`).join(v);
			// A bare, unsigilled name is only substituted for the YOUR_* convention.
			// Replacing any bare name would rewrite unrelated prose that happens to
			// contain the same word (a header called `API_KEY`, say).
			if (/^YOUR_/.test(name)) out = out.split(name).join(v);
		}
		return out;
	};

	const headers = {};
	for (const [k, v] of Object.entries(request.headers || {})) headers[fill(k)] = fill(v);

	return {
		method: request.method,
		url: fill(request.url),
		headers,
		body: request.body == null ? null : fill(request.body),
	};
}

// ── Preview documents ────────────────────────────────────────────────────────

/**
 * Point a snippet's three.ws asset URLs at the origin the reader is actually on.
 *
 * A doc sample correctly hardcodes `https://three.ws/agent-3d/…` because that is
 * what a reader pastes into their own site. Inside the preview iframe on a dev
 * server or a preview deploy, that URL loads the PRODUCTION component, so the
 * preview stops reflecting the build under test. On three.ws itself this is a
 * no-op.
 *
 * @param {string} html
 * @param {string} origin
 * @returns {string}
 */
export function rewriteAssetOrigin(html, origin) {
	const target = normalizeOrigin(origin);
	if (!target) return String(html || '');
	if (/^https:\/\/(www\.)?three\.ws$/.test(target)) return String(html || '');
	return String(html || '').replace(/https:\/\/(?:www\.)?three\.ws(?=\/)/g, target);
}

/**
 * Wrap a snippet into a complete document for a sandboxed iframe.
 *
 * The frame runs with `allow-scripts` and WITHOUT `allow-same-origin`, so it is
 * a unique opaque origin: it can load the three.ws web component over the
 * network but cannot read cookies, storage, or the parent document. That is why
 * the preview is safe to offer on a page a signed-in reader is looking at.
 *
 * @param {string} snippet
 * @param {{ origin?: string, theme?: 'dark'|'light' }} [opts]
 * @returns {string} a full HTML document
 */
export function buildPreviewDoc(snippet, opts = {}) {
	const theme = opts.theme === 'light' ? 'light' : 'dark';
	const body = rewriteAssetOrigin(snippet, opts.origin);
	const bg = theme === 'light' ? '#f6f7f9' : '#0e0f13';
	const fg = theme === 'light' ? '#16181d' : '#e8eaf0';

	// A snippet that already declares a full document is used verbatim (minus
	// the origin rewrite): wrapping it again would nest <html> inside <body>.
	if (/^\s*<(!doctype|html)\b/i.test(body)) return body;

	return `<!doctype html>
<html lang="en" data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
	:root { color-scheme: ${theme}; }
	html, body { margin: 0; height: 100%; }
	body {
		background: ${bg};
		color: ${fg};
		font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 16px;
		box-sizing: border-box;
	}
	agent-3d, model-viewer { max-width: 100%; }
	img, canvas, iframe { max-width: 100%; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

/**
 * Wrap a JS snippet into a document that reports its console output and any
 * throw back to the parent via postMessage. Same opaque-origin sandbox as the
 * preview, so a sample's `fetch` runs without the reader's three.ws cookies.
 *
 * @param {string} snippet
 * @param {{ origin?: string }} [opts]
 * @returns {string}
 */
export function buildScriptDoc(snippet, opts = {}) {
	const code = rewriteAssetOrigin(snippet, opts.origin);
	// The snippet is injected as a module body. `</script>` inside a string
	// literal would otherwise close the tag early and break the document.
	const safe = code.replace(/<\/script/gi, '<\\/script');
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"></head><body>
<script type="module">
const send = (level, args) => {
	const parts = args.map((a) => {
		if (typeof a === 'string') return a;
		try { return JSON.stringify(a, null, 2); } catch { return String(a); }
	});
	parent.postMessage({ __docsLive: true, level, text: parts.join(' ') }, '*');
};
for (const level of ['log', 'info', 'warn', 'error']) {
	const original = console[level].bind(console);
	console[level] = (...args) => { send(level, args); original(...args); };
}
window.addEventListener('unhandledrejection', (e) => send('error', [String(e.reason)]));
window.addEventListener('error', (e) => send('error', [String(e.message)]));
try {
${safe}
	parent.postMessage({ __docsLive: true, level: 'done' }, '*');
} catch (err) {
	send('error', [String(err && err.stack ? err.stack : err)]);
	parent.postMessage({ __docsLive: true, level: 'done' }, '*');
}
<\/script>
</body></html>`;
}

// ── Result formatting ────────────────────────────────────────────────────────

/** "1.2 kB" / "840 B" / "3.4 MB" — never a bare byte count in the UI. */
export function formatBytes(n) {
	// `Number(null)` is 0, so a missing value would otherwise render as "0 B" —
	// an unknown size dressed up as a measured one.
	if (n == null || n === '') return '—';
	const v = Number(n);
	if (!Number.isFinite(v) || v < 0) return '—';
	if (v < 1000) return `${Math.round(v)} B`;
	if (v < 1_000_000) return `${(v / 1000).toFixed(1)} kB`;
	return `${(v / 1_000_000).toFixed(2)} MB`;
}

/** "142 ms" under a second, "1.42 s" above it. */
export function formatDuration(ms) {
	if (ms == null || ms === '') return '—'; // see formatBytes: 0 is a measurement, null is not
	const v = Number(ms);
	if (!Number.isFinite(v) || v < 0) return '—';
	return v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(2)} s`;
}

/** Colour band for an HTTP status chip. */
export function statusTone(status) {
	const s = Number(status);
	if (!Number.isFinite(s)) return 'err';
	if (s >= 200 && s < 300) return 'ok';
	if (s >= 300 && s < 400) return 'redirect';
	if (s === 402) return 'paid';
	if (s >= 400 && s < 500) return 'warn';
	return 'err';
}

/**
 * Pretty-print a response body, truncating anything a docs panel should not try
 * to render. JSON is re-indented; everything else is passed through.
 *
 * @param {string} text
 * @param {{ contentType?: string, limit?: number }} [opts]
 * @returns {{ text: string, language: string, truncated: boolean }}
 */
export function formatResponseBody(text, opts = {}) {
	const limit = Number.isFinite(opts.limit) ? opts.limit : 20_000;
	const raw = String(text == null ? '' : text);
	const type = String(opts.contentType || '').toLowerCase();

	let out = raw;
	let language = 'text';
	if (type.includes('json') || looksLikeJson(raw)) {
		try {
			out = JSON.stringify(JSON.parse(raw), null, 2);
			language = 'json';
		} catch {
			language = 'text';
		}
	} else if (type.includes('html')) {
		language = 'html';
	}

	if (out.length > limit) {
		return { text: `${out.slice(0, limit)}\n…truncated at ${formatBytes(limit)}`, language, truncated: true };
	}
	return { text: out, language, truncated: false };
}

function looksLikeJson(text) {
	const t = String(text || '').trim();
	return (t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'));
}

/** A one-line label for the Run button, so the verb always matches the action. */
export function runLabel(kind, request) {
	if (kind === 'preview') return 'Run preview';
	if (kind === 'script') return 'Run script';
	const method = String(request?.method || 'GET').toUpperCase();
	return SAFE_METHODS.includes(method) ? 'Send request' : `Send ${method}`;
}
