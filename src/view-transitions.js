// Native View Transitions + persistent-shell navigation.
//
// Two tiers, one delegated click listener:
//
//   1. Every page: same-origin link clicks are wrapped in
//      document.startViewTransition() so the browser auto-morphs old → new
//      page state (Chrome 111+, Safari 18+; falls back to a normal location
//      change — no UX regression).
//
//   2. Shell pages (data-shell on the html element): navigation between two
//      shell-marked pages swaps ONLY the main element (plus title/meta) in
//      place. The header, footer, corner stack, command palette, and the
//      walking companion agent are never torn down — a live WebGL avatar or a
//      streaming answer survives the navigation. Page modules re-init through
//      src/shell/page-lifecycle.js (onPageReady), keyed off the
//      'shell:navigated' document event and the window.__shellNavId token
//      this file increments per swap. Shell pages must keep their main
//      element a DIRECT CHILD of body (the standard page skeleton).
//
// CONSTRAINTS (see the 'view-transitions' plugin in vite.config.js, which
// inlines this file as a classic script on every page): keep it dependency-
// free, keep exactly one `export function`, no other module syntax — and no
// HTML-looking sequences (angle-bracket tags) anywhere in comments or
// strings: the inlined source must stay inert if an HTML parser ever walks
// through it.

const SUPPORTED = typeof document !== 'undefined' && 'startViewTransition' in document;

function isInternalLink(a) {
	if (!a || !a.href) return false;
	if (a.target && a.target !== '_self') return false;
	if (a.hasAttribute('download')) return false;
	if (a.dataset?.noTransition === '1') return false;
	const url = new URL(a.href, location.href);
	if (url.origin !== location.origin) return false;
	// Same path + hash-only navigation — let the browser handle it.
	if (url.pathname === location.pathname && url.search === location.search && url.hash) return false;
	// Avoid stealing modifier-key clicks (open in new tab/window).
	return true;
}

// ── Persistent shell ─────────────────────────────────────────────────────────

const SHELL_ATTR = 'data-shell';
let shellFetchController = null; // in-flight swap fetch (latest click wins)
let popstateWired = false;

function isShellPage() {
	return document.documentElement.hasAttribute(SHELL_ATTR);
}

// Await any stylesheet the destination needs that this document doesn't have
// yet — appending after the swap would flash unstyled content.
function mergeStylesheets(doc) {
	const waits = [];
	doc.querySelectorAll('head link[rel="stylesheet"][href]').forEach((link) => {
		const href = link.getAttribute('href');
		if (document.querySelector(`link[rel="stylesheet"][href="${CSS.escape(href)}"]`)) return;
		waits.push(
			new Promise((resolveLoad) => {
				const el = document.createElement('link');
				el.rel = 'stylesheet';
				el.href = href;
				el.addEventListener('load', resolveLoad, { once: true });
				el.addEventListener('error', resolveLoad, { once: true });
				document.head.appendChild(el);
			}),
		);
	});
	return Promise.all(waits);
}

function syncMeta(doc) {
	document.title = doc.title;
	const copy = (selector) => {
		const next = doc.querySelector(selector);
		const cur = document.querySelector(selector);
		if (next && cur) {
			const attr = next.hasAttribute('content') ? 'content' : 'href';
			cur.setAttribute(attr, next.getAttribute(attr) || '');
		}
	};
	copy('meta[name="description"]');
	copy('link[rel="canonical"]');
	copy('meta[property="og:title"]');
	copy('meta[property="og:url"]');
}

// Bring in the destination's page modules. Same-src module scripts are a no-op
// by the browser's module map, so only genuinely new entries execute; already-
// loaded modules re-init via their onPageReady 'shell:navigated' listener.
function runPageScripts(doc) {
	doc.querySelectorAll('script[type="module"][src]').forEach((s) => {
		const src = s.getAttribute('src');
		if (document.querySelector(`script[type="module"][src="${CSS.escape(src)}"]`)) return;
		const el = document.createElement('script');
		el.type = 'module';
		el.src = src;
		document.body.appendChild(el);
	});
}

async function shellSwap(dest, { push = true } = {}) {
	shellFetchController?.abort();
	shellFetchController = new AbortController();
	const res = await fetch(dest, {
		headers: { accept: 'text/html' },
		signal: shellFetchController.signal,
	});
	if (!res.ok) return false;
	const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
	// Both ends must opt in — an unmarked destination gets a full navigation
	// (its scripts may assume a fresh document).
	if (!doc.documentElement.hasAttribute(SHELL_ATTR)) return false;
	// Body-scoped on purpose: the page skeleton keeps its main element a direct
	// child of body, and anything else matching 'main' deeper in the tree
	// (widget markup, injected fragments) must never be the swap target.
	const newMain = doc.body ? doc.body.querySelector(':scope > main') : null;
	const curMain = document.body.querySelector(':scope > main');
	if (!newMain || !curMain) return false;

	await mergeStylesheets(doc);

	if (push) history.pushState({ shell: true }, '', dest);
	wirePopstate();

	const apply = () => {
		syncMeta(doc);
		curMain.replaceWith(document.adoptNode(newMain));
		window.scrollTo(0, 0);
	};
	if (SUPPORTED) {
		const t = document.startViewTransition(apply);
		t?.ready?.catch(() => {});
		await t?.finished?.catch(() => {});
	} else {
		apply();
	}

	// Bump the nav token BEFORE scripts/events so a freshly injected module and
	// an already-loaded one agree on which navigation they are initializing for.
	window.__shellNavId = (window.__shellNavId || 0) + 1;
	runPageScripts(doc);
	document.dispatchEvent(new CustomEvent('shell:navigated', { detail: { url: String(dest) } }));

	// Accessibility: a swap is a navigation — move focus to the new content.
	const main = document.body.querySelector(':scope > main');
	if (main) {
		if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1');
		main.focus({ preventScroll: true });
	}
	return true;
}

function wirePopstate() {
	if (popstateWired) return;
	popstateWired = true;
	window.addEventListener('popstate', () => {
		// Back/forward across swapped entries: try to swap to the restored URL;
		// anything unexpected falls back to a real load of the current URL.
		shellSwap(location.href, { push: false })
			.then((ok) => {
				if (!ok) location.reload();
			})
			.catch(() => location.reload());
	});
}

// ── Click handling ───────────────────────────────────────────────────────────

function fallbackNavigate(dest) {
	if (!SUPPORTED) {
		location.href = dest;
		return;
	}
	const transition = document.startViewTransition(() => {
		location.href = dest;
	});
	// A rapid second navigation (double-tap, link spammed before the first
	// settles) aborts the in-flight transition; its `ready`/`finished` promises
	// then reject with an AbortError. That's expected, not a fault — swallow it
	// so it doesn't surface as an unhandled rejection in the error logs.
	transition?.ready?.catch(() => {});
	transition?.finished?.catch(() => {});
}

function handleClick(e) {
	if (e.defaultPrevented) return;
	if (e.button !== 0) return;
	if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
	const a = e.target.closest?.('a[href]');
	if (!a || !isInternalLink(a)) return;
	e.preventDefault();
	const dest = a.href;
	if (isShellPage()) {
		shellSwap(dest)
			.then((ok) => {
				if (!ok) fallbackNavigate(dest);
			})
			.catch((err) => {
				if (err?.name === 'AbortError') return; // superseded by a newer click
				fallbackNavigate(dest);
			});
		return;
	}
	fallbackNavigate(dest);
}

export function enableViewTransitions() {
	// The shell swap works without startViewTransition (it just skips the
	// morph), so wire the listener even where the API is missing.
	if (typeof document === 'undefined') return false;
	// Idempotent — safe to call from every page entry.
	if (document._viewTransitionsWired) return true;
	document._viewTransitionsWired = true;
	document.addEventListener('click', handleClick, { capture: true });
	return true;
}
