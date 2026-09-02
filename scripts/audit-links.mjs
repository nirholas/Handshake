#!/usr/bin/env node
/**
 * audit-links.mjs — static link & route integrity audit for the whole site.
 *
 * Crawls every navigable target across pages/, public/ and src/ — `href`,
 * `action`, `data-href`/`data-route`/`data-link`, JS `location`/`window.open`
 * navigations, and internal `fetch()` targets — then resolves each one against
 * the real routing model so a dead path can never ship unseen:
 *
 *   • internal clean URL (/marketplace, /u/:id …) → must resolve to a specific
 *     vercel.json route OR a real source file (pages/**, public/**). The two
 *     catch-alls (/(.*) and the asset glob) are NOT treated as proof — they only
 *     serve a literal file, so existence is checked directly.
 *   • internal /api/* → must resolve to a vercel route or an api/ handler file.
 *   • stub hrefs (#, "", javascript:void(0)) → flagged; never allowed to ship.
 *   • dangling routes — a vercel route whose .html dest has no source file.
 *   • external http(s) links → collected; liveness checked only with --external
 *     (network) so the default run is deterministic and offline/CI-safe.
 *
 * Dynamic targets (template literals with ${…}, string concatenation) are
 * reported separately as "skipped" rather than guessed — they're not failures.
 *
 * Usage:
 *   node scripts/audit-links.mjs              # offline integrity audit (gate)
 *   node scripts/audit-links.mjs --external   # also probe external links (slow)
 *   node scripts/audit-links.mjs --json       # machine-readable report to stdout
 *   node scripts/audit-links.mjs --report     # write reports/link-audit-*.json
 *
 * Exit code is non-zero when broken internal links, stub hrefs, or dangling
 * routes are found — so it can gate CI. External failures only warn.
 */

import { readFileSync, existsSync, statSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const args = new Set(process.argv.slice(2));
const CHECK_EXTERNAL = args.has('--external');
const AS_JSON = args.has('--json');
const WRITE_REPORT = args.has('--report');

// ── Filesystem walk ──────────────────────────────────────────────────────────
function walk(dir, exts, out = []) {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		if (e.name.startsWith('.') || e.name === 'node_modules') continue;
		const full = join(dir, e.name);
		if (e.isDirectory()) walk(full, exts, out);
		else if (exts.has(extname(e.name))) out.push(full);
	}
	return out;
}

function fileExists(p) {
	try {
		return statSync(p).isFile();
	} catch {
		return false;
	}
}

// ── Route table from vercel.json ─────────────────────────────────────────────
const vercel = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));

const ASSET_CATCHALL = '/(.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|woff2|woff|ttf|otf|glb|gltf|hdr|exr|ktx2|basis|bin))$';
const isCatchAll = (src) => src === '/(.*)' || src === ASSET_CATCHALL;

const isRedirect = (r) => typeof r.status === 'number' && r.status >= 300 && r.status < 400;
// The terminal `{"src":"/(?!_vercel/).*","status":404,"dest":"/404.html"}` rewrite
// is the miss handler, not a destination. It carries a dest and its src is not the
// literal `/(.*)` catch-all, so without this it entered the route table, matched
// every path, and made every root-absolute link resolve: the broken-link count
// read 0 because nothing could ever be counted, not because nothing was broken.
const isErrorFallback = (r) => typeof r.status === 'number' && r.status >= 400;
// Specific routes that resolve a request to something: a rewrite (dest) OR a
// 3xx redirect to a real page. Both are valid link destinations.
const destRoutes = (vercel.routes || []).filter(
	(r) => (r.dest || isRedirect(r)) && !isCatchAll(r.src) && !isErrorFallback(r)
);

const compiledRoutes = destRoutes.map((r) => {
	let s = r.src;
	if (!s.startsWith('^')) s = '^' + s;
	if (!s.endsWith('$')) s = s + '$';
	let re = null;
	try {
		re = new RegExp(s);
	} catch {
		re = null;
	}
	return { re, dest: r.dest, src: r.src };
});

function matchRoute(path) {
	for (const r of compiledRoutes) {
		if (r.re && r.re.test(path)) return r;
	}
	return null;
}

// Content trees that live at the repo root and are copied into dist/ verbatim by
// the closeBundle plugins in vite.config.js (copy-docs, copy-blog, copy-src-to-
// dist, the avatar-sdk mirror). `/blog/a-post.html` has no vercel route because
// the slug route only matches extensionless paths, so without these the whole
// blog reads as broken while production serves every one of them.
const BUILD_COPIED_ROOTS = ['blog', 'docs', 'pump-fun-skills', 'avatar-sdk'];

// Emitted at build time, so there is no source file to point at. vite-plugin-pwa
// writes the web manifest from the `manifest` block in vite.config.js, which is
// what the 250 pages linking `/manifest.webmanifest` actually get, and
// scripts/write-build-info.mjs writes dist/build-info.json, the static file the
// build stamps the running commit into and /api/version reads back.
const GENERATED_TARGETS = new Set(['/manifest.webmanifest', '/build-info.json']);
// Route dests written by a build step rather than committed, so they are absent
// in any tree that has not built and present in one that has. Left unlisted, the
// dangling check passes only where a stale build artifact happens to survive,
// which is the opposite of what this audit is for.
//   /news/index.html: scripts/build-news.mjs, run from `prebuild`; public/news/
//   is gitignored. scripts/verify-routes.mjs models the same file from
//   data/rss/items.json, and check:dist runs after the build to confirm it landed.
const GENERATED_DESTS = new Set(['/news/index.html']);

// Does a clean path resolve to a real source file (what the catch-all serves)?
function fileForCleanPath(path) {
	const p = path.replace(/^\/+/, '').replace(/\/+$/, '');
	if (p === '') return 'pages/home.html'; // root served from a real homepage
	// /src/** and /node_modules/** are served straight from the repo by vite in dev
	// and rewritten to hashed assets at build time — resolve against the real tree.
	if (p.startsWith('src/') || p.startsWith('node_modules/')) {
		return fileExists(join(ROOT, p)) ? p : null;
	}
	if (BUILD_COPIED_ROOTS.includes(p.split('/')[0])) {
		for (const c of [p, p + '.html', join(p, 'index.html')]) {
			if (fileExists(join(ROOT, c))) return c;
		}
		return null;
	}
	const candidates = [
		join('public', p),
		join('public', p + '.html'),
		join('public', p, 'index.html'),
		join('pages', p + '.html'),
		join('pages', p, 'index.html'),
		join('pages', p), // already has extension (e.g. /foo.html)
	];
	for (const c of candidates) {
		if (fileExists(join(ROOT, c))) return c;
	}
	return null;
}

// Resolve a relative (non-/) link against the directory of the file it lives in.
function fileForRelative(rel, baseDir) {
	const cleaned = rel.replace(/\/+$/, '');
	const base = join(ROOT, baseDir);
	const candidates = [
		join(base, cleaned),
		join(base, cleaned + '.html'),
		join(base, cleaned, 'index.html'),
	];
	return candidates.some((c) => fileExists(c));
}

function apiResolves(path) {
	// vercel route maps it, or an api/ handler file exists.
	if (matchRoute(path)) return true;
	const p = path.replace(/^\/+/, '');
	const bases = [join(ROOT, p), join(ROOT, p + '.js'), join(ROOT, p, 'index.js')];
	return bases.some((b) => fileExists(b));
}

// ── Resolve a single internal target ─────────────────────────────────────────
function resolveInternal(rawTarget, baseDir) {
	const target = rawTarget.split('#')[0].split('?')[0];
	if (target === '') return { ok: true }; // pure #anchor / query on current page
	if (GENERATED_TARGETS.has(target)) return { ok: true, via: 'build output' };
	// Relative path (not root-absolute) → resolve against the file's own directory.
	if (!target.startsWith('/')) {
		return fileForRelative(target, baseDir) ? { ok: true } : { ok: false, kind: 'relative' };
	}
	if (target.startsWith('/api/')) {
		return apiResolves(target) ? { ok: true } : { ok: false, kind: 'api' };
	}
	const route = matchRoute(target);
	if (route) {
		// Route maps it — confirm an html dest's source actually exists (dangling check
		// happens separately; here a matched route is enough to call the link reachable).
		return { ok: true, via: route.src };
	}
	const file = fileForCleanPath(target);
	if (file) return { ok: true, via: file };
	return { ok: false, kind: 'page' };
}

// ── Target extraction ────────────────────────────────────────────────────────
const STUB_VALUES = new Set(['#', '', 'javascript:void(0)', 'javascript:void(0);', 'javascript:;', 'javascript:']);

// Self-origins: a link written as an absolute URL back to our own domain is really
// an internal route — resolve it locally instead of probing the live deploy (which
// lags source and yields false 404s). This also surfaces genuinely wrong self-links.
const SELF_ORIGINS = /^https?:\/\/(?:www\.)?(?:three\.ws|3d-agent\.vercel\.app)(\/[^\s]*)?$/i;

function classifyTarget(value) {
	const v = (value || '').trim();
	if (STUB_VALUES.has(v.toLowerCase())) return { type: 'stub', value: v };
	// javascript:void(0) is a stub; any other javascript: URL runs real code → scheme.
	if (/^(mailto:|tel:|sms:|data:|blob:|javascript:)/i.test(v)) return { type: 'scheme', value: v };
	// Dynamic FIRST — a template-literal/concatenated URL is not a concrete target,
	// even when it starts with https:// (e.g. `https://solscan.io/tx/${sig}`).
	if (v.includes('${') || /["'`]\s*\+/.test(v) || v.includes('+ ')) return { type: 'dynamic', value: v };
	const self = v.match(SELF_ORIGINS);
	if (self) return { type: 'internal', value: self[1] || '/' };
	if (/^https?:\/\//i.test(v)) return { type: 'external', value: v };
	if (/^\/\//.test(v)) return { type: 'external', value: 'https:' + v };
	if (v.startsWith('#')) return { type: 'anchor', value: v };
	if (v.startsWith('/') || /^[\w.-]/.test(v)) return { type: 'internal', value: v };
	return { type: 'dynamic', value: v };
}

// Lookbehind blocks `data-action`/`reaction`/etc. from matching the bare `action`
// attribute — only a real navigable attribute (preceded by whitespace or tag-open).
const htmlAttrRe = /(?<![\w-])(?:href|formaction|action|data-href|data-route|data-link|data-target-href)\s*=\s*("([^"]*)"|'([^']*)')/gi;
// The `href:` alternative targets an object-literal property (`{ href: '/x' }`).
// The lookbehind keeps it off a *property read* followed by a ternary colon -
// `new URL(x, origin).href : ''` is a value expression, not a navigation.
const jsNavRe = /(\.href\s*=|location\.(?:assign|replace)\s*\(|window\.open\s*\(|(?<![.\w$])href\s*:|\bnavigateTo\s*\(|\brouteTo\s*\()\s*("([^"]*)"|'([^']*)'|`([^`$]*)`)/gi;
const fetchRe = /\bfetch\s*\(\s*("([^"]*)"|'([^']*)'|`([^`$]*)`)/gi;

// A string literal immediately followed by `+` is only the *head* of a computed
// URL (`dot.href = '#' + section.id`, `fetch('/login?next=' + to)`). Its path
// prefix is still worth resolving, that catches a renamed route, but it can
// never be a stub: the part that makes the target real is the concatenated tail.
function concatenatedAfter(content, endIndex) {
	let i = endIndex;
	while (i < content.length && (content[i] === ' ' || content[i] === '\t')) i++;
	return content[i] === '+';
}

// Prose in a comment is not a link. A comment explaining why a control became a
// button, quoting the href="#" it replaced, must not read back as that stub.
//
// This needs a real forward pass, not a backwards search for the nearest `/*`:
// a line comment mentioning `/api/coin/*` would open a block comment that never
// closes, and every finding below it in the file would vanish. Tracking strings,
// template literals (with `${…}` nesting) and regex literals keeps the scanner
// in sync, so a comment is only a comment when it actually starts in code.

// A `/` here starts a regex literal, not a division: nothing that could end an
// operand precedes it. Getting this wrong only risks re-syncing on the next
// quote, never a false comment.
const REGEX_PRECEDERS = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '^', '~', '<', '>', 'return']);

function skipQuoted(content, i, quote) {
	i++;
	while (i < content.length) {
		const ch = content[i];
		if (ch === '\\') i += 2;
		else if (ch === quote || ch === '\n') return i + 1; // newline: unterminated, re-sync
		else i++;
	}
	return i;
}

function skipRegexLiteral(content, i) {
	i++;
	let inClass = false;
	while (i < content.length) {
		const ch = content[i];
		if (ch === '\\') i += 2;
		else if (ch === '\n') return i + 1; // unterminated, re-sync
		else if (ch === '[') { inClass = true; i++; }
		else if (ch === ']') { inClass = false; i++; }
		else if (ch === '/' && !inClass) return i + 1;
		else i++;
	}
	return i;
}

// Byte mask of the file: 1 where a character sits inside a JS comment.
function commentMask(content) {
	const mask = new Uint8Array(content.length);
	const stack = [{ mode: 'code', depth: 0 }];
	let prev = '';
	let i = 0;
	while (i < content.length) {
		const top = stack[stack.length - 1];
		const ch = content[i];
		if (top.mode === 'template') {
			if (ch === '\\') i += 2;
			else if (ch === '`') { stack.pop(); i++; }
			else if (ch === '$' && content[i + 1] === '{') { stack.push({ mode: 'code', depth: 0 }); i += 2; }
			else i++;
			continue;
		}
		if (ch === '/' && content[i + 1] === '/') {
			const nl = content.indexOf('\n', i);
			const stop = nl === -1 ? content.length : nl;
			mask.fill(1, i, stop);
			i = stop;
			continue;
		}
		if (ch === '/' && content[i + 1] === '*') {
			const close = content.indexOf('*/', i + 2);
			const stop = close === -1 ? content.length : close + 2;
			mask.fill(1, i, stop);
			i = stop;
			continue;
		}
		if (ch === '"' || ch === "'") { i = skipQuoted(content, i, ch); prev = 'x'; continue; }
		if (ch === '`') { stack.push({ mode: 'template', depth: 0 }); i++; continue; }
		if (ch === '/' && REGEX_PRECEDERS.has(prev)) { i = skipRegexLiteral(content, i); prev = 'x'; continue; }
		if (ch === '{') { top.depth++; prev = ch; i++; continue; }
		if (ch === '}') {
			if (top.depth === 0 && stack.length > 1) { stack.pop(); i++; continue; }
			top.depth--; prev = ch; i++; continue;
		}
		if (!/\s/.test(ch)) prev = ch;
		i++;
	}
	return mask;
}

function lineOf(content, index) {
	let line = 1;
	for (let i = 0; i < index && i < content.length; i++) if (content[i] === '\n') line++;
	return line;
}

const findings = {
	brokenInternal: [],
	stubs: [],
	external: new Map(), // url -> [{file,line}]
	dynamic: 0,
	scanned: 0,
};

// A JS assignment like `el.href = "/x"` is matched by both the attribute pass and
// the navigation pass. Same file, same line, same target is one link, not two.
const seen = new Set();

function record(target, file, line, isPrefix = false) {
	const rel = file.replace(ROOT + '/', '');
	const dedupeKey = `${rel}:${line}:${target}`;
	if (seen.has(dedupeKey)) return;
	seen.add(dedupeKey);
	const baseDir = dirname(rel); // for resolving relative links from this file's dir
	const c = classifyTarget(target);
	if (c.type === 'stub') {
		if (isPrefix) findings.dynamic++; // head of a computed URL, not a dead target
		else findings.stubs.push({ file: rel, line, value: c.value });
		return;
	}
	if (c.type === 'external') {
		// `href = 'http://' + cap[0]` is an origin being assembled, not a link to
		// the bare scheme. An internal prefix below stays worth resolving (its path
		// head still catches a renamed route); a bare origin resolves to nothing.
		if (isPrefix) {
			findings.dynamic++;
			return;
		}
		const list = findings.external.get(c.value) || [];
		list.push({ file: rel, line });
		findings.external.set(c.value, list);
		return;
	}
	if (c.type === 'internal') {
		const r = resolveInternal(c.value, baseDir);
		if (!r.ok) findings.brokenInternal.push({ file: rel, line, value: c.value, kind: r.kind });
		return;
	}
	if (c.type === 'dynamic') findings.dynamic++;
	// scheme / anchor → fine
}

// Third-party/minified bundles whose internals aren't our navigable links.
// Scoped to the real vendored trees: `public/three/` is the shipped three.js
// runtime, while `src/three/` is OUR $THREE access SDK and must stay audited.
const VENDOR_RE = /(?:^public\/three\/|\bvendor\b|\.min\.js$|wasm_wrapper)/;

// Most of this app's markup is rendered from JS template strings, so the same
// `href="…"` attributes live inside .js as inside .html. Scan them there too, but
// with a narrower attribute set than the HTML pass: a bare `action="…"` in JS is
// far more often a plain variable (`const action = 'delete'`) than a form target.
const jsAttrRe = /(?<![\w-])(?:href|data-href|data-route|data-link|data-target-href)\s*=\s*("([^"]*)"|'([^']*)')/gi;

// An HTML file's inert regions: a rendered code sample (`<pre>`/`<code>`) is text
// on the page, not navigation, and an `<!-- -->` comment is not markup at all.
// A docs page quoting `action="Summarize"` inside a JSX sample must not read back
// as a form target, exactly as a JS comment quoting an href must not read back as
// a link.
const htmlInertRe = /<(pre|code)\b[^>]*>[\s\S]*?<\/\1>|<!--[\s\S]*?-->/gi;
// An inline <script> body is JS, so JS rules apply inside it: its comments are
// comments, and `a.href = '#' + doc` is the head of a computed anchor.
const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;

// `<link rel="preconnect" href="https://fonts.gstatic.com">` names an origin to
// open a socket to, not a document to navigate to. Probing it as a link reports
// the font API root as a dead 404 forever, on pages whose fonts load fine. The
// stylesheet request itself is a separate <link> and stays audited. These hints
// also appear inside JS template strings (api/discover-detail.js renders one),
// so both mask paths apply it.
const linkHintRe = /<link\b[^>]*\brel\s*=\s*["']?(?:preconnect|dns-prefetch)\b[^>]*>/gi;

function maskLinkHints(content, mask) {
	linkHintRe.lastIndex = 0;
	let m;
	while ((m = linkHintRe.exec(content))) mask.fill(1, m.index, m.index + m[0].length);
	return mask;
}

function htmlMask(content) {
	const mask = new Uint8Array(content.length);
	let m;
	htmlInertRe.lastIndex = 0;
	while ((m = htmlInertRe.exec(content))) mask.fill(1, m.index, m.index + m[0].length);
	scriptRe.lastIndex = 0;
	while ((m = scriptRe.exec(content))) {
		const bodyStart = m.index + m[0].length - '</script>'.length - m[1].length;
		const sub = commentMask(m[1]);
		for (let i = 0; i < sub.length; i++) if (sub[i]) mask[bodyStart + i] = 1;
	}
	return mask;
}

function scanFile(file) {
	const rel = file.replace(ROOT + '/', '');
	if (VENDOR_RE.test(rel)) return; // skip vendored libs — not our link surface
	const content = readFileSync(file, 'utf8');
	const isJs = /\.m?js$/.test(file);
	const mask = maskLinkHints(content, isJs ? commentMask(content) : htmlMask(content));
	const inComment = (index) => mask[index] === 1;
	findings.scanned++;
	let m;
	const attrRe = isJs ? jsAttrRe : htmlAttrRe;
	attrRe.lastIndex = 0;
	while ((m = attrRe.exec(content))) {
		if (inComment(m.index)) continue;
		// `dot.href = '#' + section.id` is the head of a computed anchor, not a stub.
		// True in an inline <script> as much as in a .js file; a real markup
		// attribute is never followed by a `+`, so the test is safe on both.
		const isPrefix = concatenatedAfter(content, m.index + m[0].length);
		record(m[2] ?? m[3] ?? '', file, lineOf(content, m.index), isPrefix);
	}
	jsNavRe.lastIndex = 0;
	while ((m = jsNavRe.exec(content))) {
		const target = m[3] ?? m[4] ?? m[5] ?? '';
		// `window.open('')` opens a blank tab the caller then writes into, a real
		// pattern, not a link to nowhere.
		if (target === '' && /^window\.open/i.test(m[1])) continue;
		// `{ href: '' }` in an object literal is the ABSENCE of a link, and every
		// consumer of a link-descriptor object in this repo guards on it before
		// rendering an anchor. That is the opposite of markup: `<a href="">` is a
		// live element that navigates to the current URL, which is why the empty
		// string stays a stub everywhere else. Only the object-literal form is
		// exempt, so a real `el.href = ''` assignment is still reported.
		if (target === '' && /href\s*:$/i.test(m[1])) continue;
		if (inComment(m.index)) continue;
		record(target, file, lineOf(content, m.index), concatenatedAfter(content, m.index + m[0].length));
	}
	fetchRe.lastIndex = 0;
	while ((m = fetchRe.exec(content))) {
		// Masked exactly like the two scanners above. This one skipped the check,
		// so a module's own header comment explaining what NOT to call was read as
		// a call: the line warning against raw `fetch('/api…')` was reported as a
		// broken link to `/api…`, a path no code ever requests.
		if (inComment(m.index)) continue;
		const t = m[2] ?? m[3] ?? m[4] ?? '';
		if (t.startsWith('/')) record(t, file, lineOf(content, m.index)); // only internal fetches
	}
}

// ── Dangling-route check: vercel route → missing source file ─────────────────
function danglingRoutes() {
	const out = [];
	for (const r of destRoutes) {
		if (!r.dest) continue; // redirect route — no file to dangle
		const dest = r.dest.split('?')[0];
		if (!dest.endsWith('.html')) continue;
		if (dest.includes('$')) continue; // dest uses a capture group — resolved per-request
		if (GENERATED_DESTS.has(dest)) continue; // written by a build step, see above
		const p = dest.replace(/^\/+/, '');
		// pages/ and public/ cover most dests, but a few top-level content trees
		// (docs/, blog/) sit directly at the repo root as siblings of pages/ —
		// check there too, or every one of their vercel.json routes false-positives
		// as dangling despite serving real 200s in production.
		const exists =
			fileExists(join(ROOT, 'pages', p)) ||
			fileExists(join(ROOT, 'public', p)) ||
			fileExists(join(ROOT, p));
		if (!exists) out.push({ src: r.src, dest: r.dest });
	}
	return out;
}

// ── External liveness (opt-in) ───────────────────────────────────────────────

// A bare `fetch` sends no User-Agent that any CDN recognizes, so Cloudflare and
// friends answer with a TLS reset or an interstitial. That read back as a dead
// link for pages a browser opens fine (t.me, solflare.com, ibm.com), which is
// worse than no report: a list that is mostly false positives gets ignored, and
// the real 404 hiding in it ships. Ask for the page the way a browser does.
const PROBE_HEADERS = {
	'user-agent':
		'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
	accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
	'accept-language': 'en-US,en;q=0.9',
};

// x.com serves a logged-out `/status/<id>` page as a 404 to every client that
// does not run its JS, including a real browser with cookies cleared. The probe
// therefore cannot tell a live post from a deleted one there, so it must not
// claim either. Profiles and every other path still get probed normally.
const UNPROBEABLE_RE = /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[^/]+\/status\//i;

// 401/403/429/405 mean the host answered but bot-blocks automated probes, so the
// page exists. Only 404/410/5xx and DNS/timeout failures are truly dead.
const aliveStatus = (s) => s < 400 || [401, 403, 405, 429].includes(s);

// A HEAD is cheap but some hosts route it differently from a GET: alibabacloud
// sends one to a geo-router that 500s while the GET loads the page. A 404, an
// explicit method rejection, or any 5xx therefore earns one GET before the link
// is called dead. 403 is deliberately absent: it already reads as alive, and
// re-asking a bot-blocking CDN with a GET trades that answer for a reset.
const retryWithGet = (s) => s === 404 || s === 405 || s === 501 || s >= 500;

// undici caps response headers at 16 KB and throws past it. The host answered,
// so the page is there; only the probe could not read the preamble.
const ANSWERED_ANYWAY = new Set(['UND_ERR_HEADERS_OVERFLOW']);

function errorCode(e) {
	if (e.name === 'AbortError') return 'timeout';
	const code = e.cause?.code || e.cause?.name;
	return code ? `error:${code}` : 'error';
}

async function probeExternal(urls) {
	const dead = [];
	const queue = urls.filter((u) => !UNPROBEABLE_RE.test(u));
	// Eight at a time, not twelve: the probe shares one egress with whatever else
	// this machine is doing, and a saturated pool shows up as ETIMEDOUT on live
	// hosts, which is exactly the false positive this whole pass exists to kill.
	const CONCURRENCY = 8;
	async function worker() {
		while (queue.length) {
			const url = queue.shift();
			const once = async (method) => {
				const ctrl = new AbortController();
				const t = setTimeout(() => ctrl.abort(), 15000);
				try {
					const res = await fetch(url, { method, redirect: 'follow', signal: ctrl.signal, headers: PROBE_HEADERS });
					return { status: res.status };
				} catch (e) {
					if (ANSWERED_ANYWAY.has(e.cause?.code)) return { status: 200 };
					return { error: errorCode(e) };
				} finally {
					clearTimeout(t);
				}
			};
			let res = await once('HEAD');
			// A network error is as often this machine's egress as the host, and a
			// method rejection says nothing about the page, so both earn a GET. The
			// GET answers the actual question, but a GET that itself fails to connect
			// must not overwrite an answer the host already gave. A failed retry gets
			// one more attempt after a pause, since a saturated pool clears on its own.
			if (res.error || retryWithGet(res.status)) {
				let retry = await once('GET');
				if (retry.error) {
					await new Promise((r) => setTimeout(r, 1500));
					retry = await once('GET');
				}
				if (!retry.error) res = retry;
			}
			if (res.error) dead.push({ url, status: res.error });
			else if (!aliveStatus(res.status)) dead.push({ url, status: res.status });
		}
	}
	await Promise.all(Array.from({ length: CONCURRENCY }, worker));
	return dead;
}

// ── Run ──────────────────────────────────────────────────────────────────────
const exts = new Set(['.html', '.js', '.mjs']);
// Every tree vercel.json can route a request into. `docs/`, `blog/` and `chat/`
// sit at the repo root as siblings of `pages/` and serve real 200s in production
// (see the dangling-route check below, which already resolves dests there), so a
// dead link in one of them ships exactly as visibly as a dead link in `pages/`.
const LINK_SURFACES = ['pages', 'public', 'src', 'docs', 'blog', 'chat'];
const files = LINK_SURFACES.flatMap((d) => walk(join(ROOT, d), exts));
for (const f of files) scanFile(f);

const dangling = danglingRoutes();
const externalUrls = [...findings.external.keys()];

let externalDead = [];
if (CHECK_EXTERNAL) externalDead = await probeExternal(externalUrls);

const report = {
	scannedFiles: findings.scanned,
	brokenInternal: findings.brokenInternal,
	stubs: findings.stubs,
	danglingRoutes: dangling,
	externalCount: externalUrls.length,
	externalDead,
	dynamicSkipped: findings.dynamic,
};

if (AS_JSON) {
	console.log(JSON.stringify(report, null, 2));
} else {
	const line = (s = '') => console.log(s);
	line(`Link audit — scanned ${findings.scanned} files`);
	line('');
	line(`Broken internal links : ${findings.brokenInternal.length}`);
	for (const b of findings.brokenInternal.slice(0, 60)) line(`  ✗ ${b.value}  (${b.kind})  — ${b.file}:${b.line}`);
	if (findings.brokenInternal.length > 60) line(`  … +${findings.brokenInternal.length - 60} more`);
	line('');
	line(`Stub hrefs (#, void(0)) : ${findings.stubs.length}`);
	for (const s of findings.stubs.slice(0, 40)) line(`  ✗ "${s.value}"  — ${s.file}:${s.line}`);
	if (findings.stubs.length > 40) line(`  … +${findings.stubs.length - 40} more`);
	line('');
	line(`Dangling routes (→ missing file) : ${dangling.length}`);
	for (const d of dangling) line(`  ✗ ${d.src} → ${d.dest}`);
	line('');
	line(`External links collected : ${externalUrls.length}`);
	if (CHECK_EXTERNAL) {
		line(`Dead external links : ${externalDead.length}`);
		for (const d of externalDead) line(`  ✗ [${d.status}] ${d.url}`);
	} else {
		line('  (run with --external to probe liveness)');
	}
	line('');
	line(`Dynamic targets skipped : ${findings.dynamic}`);
}

if (WRITE_REPORT) {
	mkdirSync(join(ROOT, 'reports'), { recursive: true });
	const out = join(ROOT, 'reports', `link-audit-${Date.now()}.json`);
	writeFileSync(out, JSON.stringify(report, null, 2));
	console.log(`\nReport: ${out.replace(ROOT + '/', '')}`);
}

const hardFails = findings.brokenInternal.length + findings.stubs.length + dangling.length;
if (hardFails > 0) process.exitCode = 1;
