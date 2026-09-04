#!/usr/bin/env node
// Generate the PUBLISHED IBM partnership page (pages/ibm/hello.html) from the
// editable source (pages/ibm/hello.live.html).
//
// The published file is fully SELF-CONTAINED: it carries the complete page —
// markup, styles, and every demo script — so it renders and runs with ZERO
// dependency on three.ws. three.ws is an ENHANCEMENT, not a requirement: on load
// the page quietly fetches the latest version from https://three.ws/ibm/hello.live
// and, if reachable, swaps it in (and caches it). If three.ws is slow, down, or
// blocked, the baked-in page runs instead — the visitor never sees a blank screen
// or a "couldn't load" card.
//
// Why a generator instead of hand-maintaining two files: hello.live.html is the
// single source of truth. Editing it is enough for the deployed page to update
// itself live. Re-run this script (npm run build:ibm-shell) before re-publishing
// only when you want to refresh the offline baseline that ships in the file.
//
// How it works: the published file's demo scripts are stored INERT (an unknown
// `type` the browser won't execute) so nothing auto-runs at parse time. A small
// boot script decides the source ONCE — live if reachable, else the baked copy —
// then runs that source's scripts a single time. Running exactly one set avoids
// double-initialising custom elements / timers that an in-place swap would cause.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'pages/ibm/hello.live.html');
const OUT = join(ROOT, 'pages/ibm/hello.html');
const LIVE_URL = 'https://three.ws/ibm/hello.live';

const SITE_ORIGIN = 'https://three.ws';

const EXEC_TYPES = new Set(['', 'module', 'text/javascript', 'application/javascript']);
const INERT_TYPE = 'application/ibm-baked';

function attr(attrs, name) {
	const m = attrs.match(new RegExp(name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i'));
	return m ? (m[2] ?? m[3] ?? m[4] ?? '') : '';
}

// The live page loads its own assets same-origin ('/x402.js'), which is what
// keeps it working on every origin three.ws itself is served from: production,
// a preview deploy, a local run, an audit sweep. The baked page is the opposite
// case. It is published once onto somebody else's domain, where a root-relative
// src resolves against THEIR origin and 404s, so every asset it names has to
// carry ours. Baking is the moment that difference is known, so it is where the
// rewrite belongs, rather than forcing the live page to hardcode an origin it is
// not always served from.
function absolutize(src) {
	return src.startsWith('/') && !src.startsWith('//') ? SITE_ORIGIN + src : src;
}

// Replace each executable <script> in the body with an inert twin that preserves
// its source and type in data-* attributes. Non-executable scripts (ld+json) are
// left untouched. The boot reads these back to run the baked page when offline.
function inertizeBodyScripts(bodyInner) {
	return bodyInner.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (full, attrs, code) => {
		const type = attr(attrs, 'type').toLowerCase();
		if (!EXEC_TYPES.has(type)) return full; // leave data scripts as-is
		const src = attr(attrs, 'src');
		// `</script` can never appear literally inside a <script> the browser
		// parsed (it would have closed the tag); guard anyway so the inert copy
		// is bulletproof regardless of how the source was authored.
		const safe = code.replace(/<\/script/gi, '<\\/script');
		const data = ['type="' + INERT_TYPE + '"', 'data-ibm-type="' + type + '"'];
		if (src) data.push('data-ibm-src="' + absolutize(src).replace(/"/g, '&quot;') + '"');
		return '<script ' + data.join(' ') + '>' + safe + '</script>';
	});
}

function boot() {
	// Serialised verbatim into the page. Self-contained, CSP-safe (fetch +
	// DOMParser + createElement; no eval). Talks ONLY to https://three.ws —
	// already permitted by both CSP tiers in HOSTING.md.
	return `
(function () {
  var LIVE = ${JSON.stringify(LIVE_URL)};
  var CACHE_KEY = 'ibm-hello-live-v1';
  var TIMEOUT_MS = 3000;
  var app = document.getElementById('ibm-app');
  if (!app) return;
  var baked = [].slice.call(app.querySelectorAll('script[type="${INERT_TYPE}"]'));

  function descFromInert(n) {
    return { src: n.getAttribute('data-ibm-src') || '', type: n.getAttribute('data-ibm-type') || '', code: n.textContent || '' };
  }
  function descFromLive(n) {
    return { src: n.getAttribute('src') || '', type: (n.getAttribute('type') || '').toLowerCase(), code: n.textContent || '' };
  }
  // Run a list of script descriptors in order. src scripts are awaited so anything
  // that depends on x402.js / agent-3d.js (earlier in the page) sees it loaded.
  function run(descs) {
    var i = 0;
    (function next() {
      if (i >= descs.length) return;
      var d = descs[i++];
      var el = document.createElement('script');
      if (d.type === 'module') el.type = 'module';
      else if (d.type) el.type = d.type;
      if (d.src) {
        el.src = d.src;
        el.addEventListener('load', next);
        el.addEventListener('error', next);
        document.body.appendChild(el);
      } else {
        el.textContent = d.code;
        document.body.appendChild(el);
        next();
      }
    })();
  }

  function activateBaked() {
    document.documentElement.setAttribute('data-ibm-source', 'baked');
    run(baked.map(descFromInert));
  }

  function activateLive(doc) {
    // Carry over the live page's <head> styles, then replace the body markup and
    // run the live scripts — exactly once, so nothing double-initialises.
    var hs = doc.head.querySelectorAll('style, link[rel="stylesheet"]');
    for (var s = 0; s < hs.length; s++) document.head.appendChild(document.importNode(hs[s], true));
    if (doc.title) document.title = doc.title;
    var live = [];
    var all = doc.querySelectorAll('script');
    for (var k = 0; k < all.length; k++) {
      var ty = (all[k].getAttribute('type') || '').toLowerCase();
      if (ty === '' || ty === 'module' || ty === 'text/javascript' || ty === 'application/javascript') live.push(all[k]);
    }
    var bodyScripts = doc.body.querySelectorAll('script');
    for (var b = 0; b < bodyScripts.length; b++) bodyScripts[b].parentNode.removeChild(bodyScripts[b]);
    app.innerHTML = doc.body.innerHTML;
    document.documentElement.setAttribute('data-ibm-source', 'live');
    run(live.map(descFromLive));
  }

  function fromCache() {
    try {
      var html = localStorage.getItem(CACHE_KEY);
      if (!html) return false;
      var doc = new DOMParser().parseFromString(html, 'text/html');
      if (!doc.body) return false;
      activateLive(doc);
      return true;
    } catch (e) { return false; }
  }

  var ctrl = ('AbortController' in window) ? new AbortController() : null;
  var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, TIMEOUT_MS);
  fetch(LIVE, { cache: 'no-cache', credentials: 'omit', signal: ctrl ? ctrl.signal : undefined })
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
    .then(function (html) {
      clearTimeout(timer);
      if (!html || html.indexOf('<body') === -1) throw new Error('empty');
      try { localStorage.setItem(CACHE_KEY, html); } catch (e) {}
      activateLive(new DOMParser().parseFromString(html, 'text/html'));
    })
    .catch(function () {
      clearTimeout(timer);
      if (!fromCache()) activateBaked();
    });
})();
`.trim();
}

function generate(live) {
	const headEnd = live.indexOf('</head>');
	const bodyOpen = live.indexOf('<body');
	const bodyClose = live.lastIndexOf('</body>');
	if (headEnd === -1 || bodyOpen === -1 || bodyClose === -1) {
		throw new Error('hello.live.html: could not locate <head>/<body> boundaries');
	}
	const headAndBefore = live.slice(0, live.indexOf('>', bodyOpen) + 1); // up to and incl `<body ...>`
	const bodyInner = live.slice(live.indexOf('>', bodyOpen) + 1, bodyClose);

	const banner = `
<!-- ════════════════════════════════════════════════════════════════════════════
     GENERATED — do not edit by hand. Source: pages/ibm/hello.live.html
     Regenerate with: npm run build:ibm-shell

     This is the PUBLISH-ONCE file. It is the complete partnership page, baked in,
     so it renders with no dependency on three.ws. On load it fetches the latest
     version from ${LIVE_URL} and swaps it in if reachable (and caches it); if
     three.ws is unreachable the baked page below runs instead. Edit the content
     at hello.live.html on three.ws — your edits go live here automatically, with
     no re-publish. See HOSTING.md.
     ════════════════════════════════════════════════════════════════════════════ -->`;

	const out =
		headAndBefore +
		banner +
		'\n<div id="ibm-app">' +
		inertizeBodyScripts(bodyInner) +
		'</div>\n\n<script>\n' +
		boot() +
		'\n</script>\n</body>\n</html>\n';
	return out;
}

const live = readFileSync(SRC, 'utf8');
const out = generate(live);
writeFileSync(OUT, out);

const inertCount = (out.match(new RegExp('<script type="' + INERT_TYPE + '"', 'g')) || []).length;
console.log(
	`build:ibm-shell — wrote pages/ibm/hello.html (${out.length} bytes, ${inertCount} baked demo script(s); live source: ${LIVE_URL})`,
);
