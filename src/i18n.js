// three.ws runtime i18n — client-side locale swap, the LobeHub model.
//
// Copy lives in static HTML annotated with data-i18n attributes; the source
// catalog and machine translations are committed as static JSON under
// /locales/<code>.json (built offline by scripts/i18n-translate.mjs). At
// runtime this module detects the visitor's locale, fetches that catalog once,
// and rewrites the annotated DOM — no per-request API calls, no translation
// cost, fully cacheable.
//
// Annotations (see scripts/i18n-extract.mjs):
//   data-i18n="key"            → element.textContent
//   data-i18n-html="key"       → element.innerHTML (values that contain markup)
//   data-i18n-attr="attr:key;attr2:key2" → element attributes (aria-label, content, …)
//
// Pure helpers (resolveKey, interpolate, applyCatalog) are exported for tests
// and run without a DOM.

const STORAGE_KEY = 'twx_lang';

// The catalogs live wherever this module was served from, which is not always
// the page's own origin: /i18n.js is published onto partner pages (the IBM
// partnership page hosts a copy on its own domain and loads this script from
// three.ws), where a root-relative fetch would resolve against THEIR origin and
// 404. Deriving the base from import.meta.url keeps the data with the code.
// Same-origin pages, which is every page on three.ws itself, get '' and the
// exact root-relative URLs they always had.
const ASSET_ORIGIN = (() => {
	try {
		const origin = new URL(import.meta.url).origin;
		return typeof location !== 'undefined' && origin !== location.origin ? origin : '';
	} catch {
		return '';
	}
})();
const LOCALES_BASE = `${ASSET_ORIGIN}/locales`;

const hasDOM = typeof document !== 'undefined';

// Some in-app webviews (Twitter/X Android, privacy-sandboxed frames) expose
// `document`/`window` but set `localStorage` to null or throw on access, so a
// raw localStorage.getItem blows up with "Cannot read properties of null". Wrap
// every access so locale persistence degrades silently instead of throwing.
const safeStorage = {
	get(key) {
		try {
			return globalThis.localStorage?.getItem(key) ?? null;
		} catch {
			return null;
		}
	},
	set(key, value) {
		try {
			globalThis.localStorage?.setItem(key, value);
		} catch {
			/* storage unavailable (private mode, sandboxed webview) — ignore */
		}
	},
};
const state = {
	manifest: null,
	current: 'en',
	catalog: {}, // active locale strings (nested)
	fallback: {}, // entryLocale strings, so a missing translation degrades to English
};

// --- pure helpers ----------------------------------------------------------

// Dot-path lookup against a nested catalog: resolveKey({a:{b:'x'}}, 'a.b') → 'x'.
export function resolveKey(catalog, key) {
	return key
		.split('.')
		.reduce(
			(node, part) => (node && typeof node === 'object' ? node[part] : undefined),
			catalog,
		);
}

// {{name}} interpolation. Missing vars are left as the literal token so they're
// visible in QA rather than silently blank.
export function interpolate(str, vars) {
	if (typeof str !== 'string' || !vars) return str;
	return str.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

// Translate one key with graceful fallback: active locale → entryLocale → key.
export function translate(key, vars, { catalog = state.catalog, fallback = state.fallback } = {}) {
	const hit = resolveKey(catalog, key);
	const value = hit !== undefined && hit !== '' ? hit : resolveKey(fallback, key);
	return interpolate(value !== undefined ? value : key, vars);
}

// Apply a catalog to a DOM subtree. Exported with an injectable root so tests
// can pass a jsdom document fragment.
// An element whose content is live data rather than copy sets
// `data-i18n-owned="1"` the moment its script writes a real value into it. The
// annotation still ships in the HTML so the pre-render placeholder is
// translated, but from the first render onwards the script owns the element:
// without this, the catalog pass (which lands after an async /api/locale fetch)
// reverts a freshly-rendered balance or status back to "Loading".
function scriptOwns(el) {
	return el.getAttribute('data-i18n-owned') === '1';
}

export function applyCatalog(root, t) {
	if (!root) return;
	root.querySelectorAll?.('[data-i18n]').forEach((el) => {
		if (scriptOwns(el)) return;
		const key = el.getAttribute('data-i18n');
		const v = t(key);
		// A total miss (both catalogs) echoes the key back. The element already
		// holds its English source text; keep it rather than showing "nav.c3spxn".
		if (v == null || v === key) return;
		// Some nav elements carry both data-i18n (a translatable label) and
		// data-auth-name (their text is the signed-in visitor's display name). The
		// name is not translatable copy and nav-auth owns it. Keep the translation
		// as the signed-out fallback so a locale switch still localizes the label,
		// but never clobber a live display name (data-auth-named === '1').
		if (el.hasAttribute('data-auth-name')) {
			el.dataset.authNameOriginal = v;
			if (el.dataset.authNamed === '1') return;
		}
		el.textContent = v;
	});
	root.querySelectorAll?.('[data-i18n-html]').forEach((el) => {
		if (scriptOwns(el)) return;
		const key = el.getAttribute('data-i18n-html');
		const v = t(key);
		if (v == null || v === key) return;
		// Same nav-auth ownership rule as the textContent loop above: never let a
		// translated markup value overwrite a live display name.
		if (el.hasAttribute('data-auth-name')) {
			el.dataset.authNameOriginal = v;
			if (el.dataset.authNamed === '1') return;
		}
		el.innerHTML = v;
	});
	root.querySelectorAll?.('[data-i18n-attr]').forEach((el) => {
		if (scriptOwns(el)) return;
		for (const pair of el.getAttribute('data-i18n-attr').split(';')) {
			const [attr, key] = pair.split(':').map((s) => s && s.trim());
			if (!attr || !key) continue;
			const v = t(key);
			if (v != null && v !== key) {
				el.setAttribute(attr, v);
				if (attr === 'data-i18n-title' || attr === 'title-text') document.title = v;
			}
		}
	});
}

// --- runtime ---------------------------------------------------------------

export const t = (key, vars) => translate(key, vars);

async function fetchJSON(url) {
	const res = await fetch(url, { credentials: 'same-origin' });
	if (!res.ok) throw new Error(`${url} → ${res.status}`);
	return res.json();
}

async function loadManifest() {
	if (state.manifest) return state.manifest;
	try {
		state.manifest = await fetchJSON(`${LOCALES_BASE}/manifest.json`);
	} catch {
		state.manifest = { default: 'en', locales: [{ code: 'en', name: 'English', dir: 'ltr' }] };
	}
	return state.manifest;
}

function supported(code, manifest) {
	return manifest.locales.find((l) => l.code === code);
}

// ?lang= → localStorage → navigator languages → manifest default.
// The URL param must outrank the stored preference: sitemap hreflang entries
// and shared links all carry ?lang=xx, and a returning visitor (whose first
// visit stored a locale) would otherwise see every one of those deep links
// silently ignored. Honoring the param also stores it, so the choice sticks.
// Pure and exported for tests; detectLocale feeds it the browser's values.
export function pickLocale({ query, stored, navLangs }, manifest) {
	if (query && supported(query, manifest)) return query;
	if (stored && supported(stored, manifest)) return stored;
	for (const nav of navLangs || []) {
		if (!nav) continue;
		if (supported(nav, manifest)) return nav;
		const base = nav.split('-')[0];
		const byBase = manifest.locales.find(
			(l) => l.code === base || l.code.split('-')[0] === base,
		);
		if (byBase) return byBase.code;
	}
	return manifest.default;
}

function detectLocale(manifest) {
	if (!hasDOM) return manifest.default;
	return pickLocale(
		{
			query: new URLSearchParams(location.search).get('lang'),
			stored: safeStorage.get(STORAGE_KEY),
			navLangs: navigator.languages || [navigator.language || ''],
		},
		manifest,
	);
}

// --- namespace-scoped catalog loading --------------------------------------
//
// A catalog file covers the whole site (585 sections, 1.8 MB for English), but a
// page uses a handful of them. Every key is a dot path whose first segment names
// its section, so the set a page needs is readable straight off the DOM: collect
// the first segment of every data-i18n key present and ask /api/locale for
// exactly those. See api/locale.js for the server side.
//
// Namespaces already fetched for the active locale, so re-entering setLocale or
// translating late-injected DOM never refetches what is already merged.
const loaded = { code: null, ns: new Set(), fallbackNs: new Set() };

// Sections that are not annotated in the initial HTML but are translated by
// runtime-built components (the global nav, the footer, the getting-started
// widget, corner cards). They are injected after first paint, and asking for
// them up front costs a few KB and saves a second round trip on every page.
const ALWAYS_NS = ['nav', 'footer', 'common'];

const I18N_SELECTOR = '[data-i18n],[data-i18n-html],[data-i18n-attr]';

// Every namespace referenced by annotations inside `root`. Exported for tests.
export function namespacesIn(root) {
	const out = new Set();
	if (!root?.querySelectorAll) return out;
	const add = (key) => {
		const ns = String(key || '').split('.')[0].trim();
		// Section names are plain identifiers (see api/locale.js NS_RE); anything
		// else is a malformed annotation and would just 400 the whole request.
		if (ns && /^[a-z0-9_]+$/i.test(ns)) out.add(ns);
	};
	for (const el of root.querySelectorAll(I18N_SELECTOR)) {
		add(el.getAttribute('data-i18n'));
		add(el.getAttribute('data-i18n-html'));
		for (const pair of (el.getAttribute('data-i18n-attr') || '').split(';')) {
			const [, key] = pair.split(':');
			if (key) add(key);
		}
	}
	// The root element itself may carry the annotation (an injected node passed
	// straight to applyCatalog), which querySelectorAll does not match.
	if (root.getAttribute) {
		add(root.getAttribute('data-i18n'));
		add(root.getAttribute('data-i18n-html'));
		for (const pair of (root.getAttribute('data-i18n-attr') || '').split(';')) {
			const [, key] = pair.split(':');
			if (key) add(key);
		}
	}
	return out;
}

// Merge a slice into an existing catalog. Sections are replaced wholesale (a
// slice is authoritative for the sections it carries) rather than deep-merged,
// so a re-fetch can never leave half of an old section behind.
function mergeCatalog(target, slice) {
	for (const [ns, value] of Object.entries(slice || {})) target[ns] = value;
	return target;
}

// Fetch `names` of `code` from the slice endpoint. Falls back to the whole-site
// catalog if the endpoint is unavailable, so a broken or not-yet-deployed
// /api/locale degrades to exactly the old behaviour rather than an untranslated
// page. `null` means even that failed and the caller should keep what it has.
async function fetchSlice(code, names) {
	if (!names.length) return {};
	try {
		return await fetchJSON(
			`${ASSET_ORIGIN}/api/locale?code=${encodeURIComponent(code)}&ns=${names.join(',')}`,
		);
	} catch {
		try {
			return await fetchJSON(`${LOCALES_BASE}/${code}.json`);
		} catch {
			return null;
		}
	}
}

// Load (or extend) the active locale's catalog and its fallback so that every
// namespace in `names` is present, then return whether anything new arrived.
async function ensureNamespaces(names, manifest) {
	const wanted = names.filter((n) => !loaded.ns.has(n));
	const fallbackWanted = state.current === manifest.default
		? []
		: names.filter((n) => !loaded.fallbackNs.has(n));
	if (!wanted.length && !fallbackWanted.length) return false;

	// The active locale and the English fallback are independent fetches, so they
	// go out together rather than one after the other.
	const [slice, fallbackSlice] = await Promise.all([
		wanted.length ? fetchSlice(state.current, wanted) : null,
		fallbackWanted.length ? fetchSlice(manifest.default, fallbackWanted) : null,
	]);

	if (slice) {
		mergeCatalog(state.catalog, slice);
		for (const n of wanted) loaded.ns.add(n);
	}
	if (fallbackSlice) {
		mergeCatalog(state.fallback, fallbackSlice);
		for (const n of fallbackWanted) loaded.fallbackNs.add(n);
	}
	// On the default locale the two catalogs are the same object, so one fetch
	// serves both roles and both ledgers advance together.
	if (state.current === manifest.default && slice) {
		for (const n of wanted) loaded.fallbackNs.add(n);
	}
	return !!(slice || fallbackSlice);
}

// Translate a subtree, fetching any catalog sections it needs first.
//
// What is already loaded is applied immediately, so known copy never waits on a
// round trip; a section the page has not fetched yet (runtime-injected content
// routinely introduces one) is fetched and the subtree re-applied. Until it
// lands the element keeps its English source text, which is what applyCatalog
// does for a miss anyway.
async function translateSubtree(root) {
	const target = root || (hasDOM ? document : null);
	if (!target) return;
	applyCatalog(target, t);
	const needed = [...namespacesIn(target)].filter((n) => !loaded.ns.has(n));
	if (!needed.length) return;
	const manifest = await loadManifest();
	if (await ensureNamespaces(needed, manifest)) applyCatalog(target, t);
}

export async function setLocale(code) {
	const manifest = await loadManifest();
	const entry = supported(code, manifest) ? code : manifest.default;

	// The entryLocale catalog is both the fallback (so partial translations never
	// leave blanks) AND what restores the original copy when switching back to
	// the default language: the committed English JSON, not the live DOM, is the
	// source of truth, so a default to translated round-trip is lossless.
	//
	// On the default locale the two are deliberately the SAME object, so one set
	// of fetches serves both roles.
	if (loaded.code !== entry) {
		loaded.code = entry;
		if (entry === manifest.default) {
			state.catalog = state.fallback;
			loaded.ns = new Set(loaded.fallbackNs);
		} else {
			state.catalog = {};
			loaded.ns = new Set();
		}
	}
	state.current = entry;

	// Sections this page needs: whatever its markup references, plus the ones
	// runtime-injected chrome always wants.
	await ensureNamespaces(
		[...new Set([...ALWAYS_NS, ...(hasDOM ? namespacesIn(document) : [])])],
		manifest,
	);

	if (hasDOM) {
		safeStorage.set(STORAGE_KEY, entry);
		const meta = supported(entry, manifest);
		document.documentElement.lang = entry;
		document.documentElement.dir = meta?.dir === 'rtl' ? 'rtl' : 'ltr';
		applyCatalog(document, t);
		window.dispatchEvent(new CustomEvent('i18n:change', { detail: { locale: entry } }));
	}
	return entry;
}

export function getLocale() {
	return state.current;
}

// "en" → "EN", "zh-CN" → "ZH", "pt-BR" → "PT". The two-letter code is what a
// compact control shows in place of the full language name; the picker itself
// still lists the names, so nothing is lost.
export function shortLocaleLabel(code) {
	const base = String(code || '').split(/[-_]/)[0].trim();
	return base ? base.toUpperCase().slice(0, 3) : 'EN';
}

export async function initI18n() {
	const manifest = await loadManifest();
	await setLocale(detectLocale(manifest));
}

// --- <lang-switcher> web component -----------------------------------------
//
// Accessible language picker for the global nav: a native <select> (keyboard +
// screen-reader friendly out of the box) styled to match the design tokens,
// with hover/focus/active states. Renders nothing until the manifest lists more
// than one locale, so it self-hides on a single-language deploy.

function registerLangSwitcher() {
	if (customElements.get('lang-switcher')) return;
	class LangSwitcher extends HTMLElement {
		async connectedCallback() {
			// connectedCallback re-fires whenever the element is moved to a new slot
			// (pages re-parent the switcher into footers/overflow menus), and a second
			// attachShadow on the same host throws. The sync flag also covers the
			// race where two rapid reconnects both clear the manifest await before
			// either has attached the shadow root.
			if (this._booted) return;
			this._booted = true;
			const manifest = await loadManifest();
			if (!manifest.locales || manifest.locales.length < 2) return;

			const root = this.attachShadow({ mode: 'open' });
			root.innerHTML = `
			<style>
				/* Shrinkable by default: the widest locale name makes this control
				   ~170px, which overflows a narrow header (a phone-width AR HUD, a
				   compact nav). A page that needs it smaller sets a max-width on the
				   host and the select follows instead of pushing its siblings off
				   screen. Unconstrained parents render exactly as before. */
				:host { display: inline-flex; max-width: 100%; min-width: 0; }
				.wrap { position: relative; display: inline-flex; align-items: center; max-width: 100%; min-width: 0; }
				svg { position: absolute; left: 8px; width: 14px; height: 14px; opacity: .6; pointer-events: none; z-index: 1; }
				/* Compact face: the locale CODE instead of its name. "English"
				   makes a 170px control; on a phone that either ran off the edge
				   of a HUD ("Englis…") or, as the floating FAB, laid a full-width
				   bar across the page's own bottom controls. The native <select>
				   still owns the interaction (it sits transparent on top, so the
				   picker, keyboard and screen readers behave exactly as before)
				   and its options keep the full language names. */
				.face {
					display: none; align-items: center; gap: 6px;
					font: inherit; font-size: 13px; font-weight: 600; line-height: 1;
					letter-spacing: .04em;
					color: var(--text-2, #cfcfd4);
					background: var(--surface-2, rgba(255,255,255,.04));
					border: 1px solid var(--border, rgba(255,255,255,.12));
					border-radius: 8px;
					padding: 7px 22px 7px 26px;
					transition: border-color .15s ease, background .15s ease, color .15s ease;
				}
				.wrap.is-compact .face { display: inline-flex; }
				.wrap.is-compact select {
					position: absolute; inset: 0; width: 100%; height: 100%;
					padding: 0; border: 0; background: transparent; opacity: 0;
				}
				.wrap.is-compact .chev { right: 7px; }
				.wrap.is-compact select:hover ~ .face { color: var(--text, #fff); border-color: var(--border-strong, rgba(255,255,255,.24)); }
				.wrap.is-compact select:focus-visible { opacity: 0; }
				.wrap.is-compact select:focus-visible ~ .face { outline: 2px solid var(--accent, #6d6dff); outline-offset: 2px; }
				select {
					appearance: none; -webkit-appearance: none;
					font: inherit; font-size: 13px; line-height: 1;
					color: var(--text-2, #cfcfd4);
					background: var(--surface-2, rgba(255,255,255,.04));
					border: 1px solid var(--border, rgba(255,255,255,.12));
					border-radius: 8px;
					padding: 7px 26px 7px 28px;
					max-width: 100%; min-width: 0;
					text-overflow: ellipsis;
					cursor: pointer;
					transition: border-color .15s ease, background .15s ease, color .15s ease;
				}
				select:hover { color: var(--text, #fff); border-color: var(--border-strong, rgba(255,255,255,.24)); }
				select:focus-visible { outline: 2px solid var(--accent, #6d6dff); outline-offset: 2px; }
				select:active { transform: translateY(1px); }
				.chev { right: 8px; left: auto; }
				option { color: #111; }
			</style>
			<span class="wrap">
				<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.6"/><path d="M3 12h18M12 3c2.5 2.5 3.8 5.7 3.8 9S14.5 18.5 12 21M12 3C9.5 5.5 8.2 8.7 8.2 12S9.5 18.5 12 21" stroke="currentColor" stroke-width="1.4"/></svg>
				<select aria-label="Choose language">
					${manifest.locales.map((l) => `<option value="${l.code}">${l.name}</option>`).join('')}
				</select>
				<span class="face" aria-hidden="true"></span>
				<svg class="chev" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="1.6"/></svg>
			</span>`;

			const select = root.querySelector('select');
			const wrap = root.querySelector('.wrap');
			const face = root.querySelector('.face');
			const paintFace = () => { face.textContent = shortLocaleLabel(select.value); };
			select.value = getLocale();
			paintFace();
			select.addEventListener('change', () => {
				paintFace();
				setLocale(select.value);
			});
			// Keep the control in sync if another instance or code path changes locale.
			window.addEventListener('i18n:change', (e) => {
				if (e.detail?.locale) {
					select.value = e.detail.locale;
					paintFace();
				}
			});

			// Compact below the phone breakpoint, or wherever a page asks for it
			// (a narrow HUD rail). matchMedia keeps it correct across rotation.
			const compactAttr = this.hasAttribute('compact');
			const mq = window.matchMedia?.('(max-width: 640px)');
			const syncCompact = () => wrap.classList.toggle('is-compact', compactAttr || !!mq?.matches);
			syncCompact();
			mq?.addEventListener?.('change', syncCompact);
		}
	}
	customElements.define('lang-switcher', LangSwitcher);
}

// Mount a compact, fixed-position language switcher on any page that ships the
// runtime but doesn't already place a <lang-switcher> itself. This is what lets
// the auto-annotator wire a page for translation without also hand-editing its
// layout to add a picker: pages that DO place their own switcher (e.g. the home
// nav) are left alone, and a page can opt out with <body data-no-lang-switcher>.
// Self-hides on single-language deploys because <lang-switcher> renders nothing
// when the manifest lists fewer than two locales.
async function mountFloatingSwitcher() {
	if (!hasDOM || !document.body) return;
	if (document.querySelector('lang-switcher')) return; // page placed its own
	if (document.body.hasAttribute('data-no-lang-switcher')) return;
	const manifest = await loadManifest();
	if (!manifest.locales || manifest.locales.length < 2) return;

	const host = document.createElement('div');
	host.className = 'twx-i18n-fab';
	host.setAttribute('data-no-i18n', ''); // never annotate/translate the control itself
	const style = document.createElement('style');
	style.textContent = `
		.twx-i18n-fab {
			position: fixed; z-index: 2147483000;
			inset-block-end: max(16px, env(safe-area-inset-bottom));
			inset-inline-end: max(16px, env(safe-area-inset-right));
			display: inline-flex;
			filter: drop-shadow(0 4px 14px rgba(0,0,0,.35));
			opacity: .92; transition: opacity .15s ease;
		}
		.twx-i18n-fab:hover { opacity: 1; }
		@media print { .twx-i18n-fab { display: none; } }`;
	document.head.appendChild(style);
	host.appendChild(document.createElement('lang-switcher'));
	// Flow into the shared bottom-right corner stack (public/corner-stack.js) so
	// the switcher never piles onto the "Getting started" pill or other corner
	// cards. The stack's #id CSS overrides the fixed positioning above, which
	// remains the standalone fallback on pages that don't ship the stack (embeds,
	// generated shells). Priority 10 sits above the pill (30 = owns the corner).
	host.setAttribute('data-corner-priority', '10');
	if (window.twsCornerStack) window.twsCornerStack.mount(host);
	else document.body.appendChild(host);
}

// Inject <link rel="alternate" hreflang> tags into <head> for the current path,
// one per committed locale plus x-default, so a page crawled directly (not just
// via the sitemap) advertises its translations. The default locale and
// x-default use the bare URL; others carry ?lang=xx, matching the URLs the
// sitemap emits and that detectLocale() honors. Idempotent and dependency-free.
async function injectHreflang() {
	if (!hasDOM || !document.head) return;
	if (document.querySelector('link[rel="alternate"][hreflang]')) return; // already present
	const manifest = await loadManifest();
	if (!manifest.locales || manifest.locales.length < 2) return;
	const origin = location.origin;
	const pathname = location.pathname;
	const href = (code) =>
		code === manifest.default ? `${origin}${pathname}` : `${origin}${pathname}?lang=${code}`;
	const frag = document.createDocumentFragment();
	const add = (hreflang, url) => {
		const link = document.createElement('link');
		link.rel = 'alternate';
		link.hreflang = hreflang;
		link.href = url;
		frag.appendChild(link);
	};
	for (const l of manifest.locales) add(l.code, href(l.code));
	add('x-default', `${origin}${pathname}`);
	document.head.appendChild(frag);
}

// Re-translate DOM that is injected AFTER the initial pass — the global nav,
// the getting-started widget, and any other runtime-built shell are fetched and
// rendered asynchronously, so they miss the initI18n applyCatalog(document).
// A MutationObserver translates each newly-added subtree that carries data-i18n
// annotations, batched on an animation frame so a burst of DOM writes costs one
// pass. setLocale still re-applies to the whole document on a language switch,
// so this only has to cover the first render of injected content.
function observeInjectedContent() {
	if (!hasDOM || typeof MutationObserver === 'undefined' || !document.body) return;
	const pending = new Set();
	let scheduled = false;
	const schedule = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 16);
	const flush = () => {
		scheduled = false;
		const roots = [...pending];
		pending.clear();
		// translateSubtree, not applyCatalog: injected chrome routinely references
		// a catalog section the initial HTML never did, and that section has to be
		// fetched before its copy can be translated.
		for (const root of roots) translateSubtree(root);
	};
	const SEL = '[data-i18n],[data-i18n-html],[data-i18n-attr]';
	const observer = new MutationObserver((mutations) => {
		for (const m of mutations) {
			for (const node of m.addedNodes) {
				if (node.nodeType !== 1) continue;
				if (node.matches?.(SEL) || node.querySelector?.(SEL)) pending.add(node);
			}
		}
		if (pending.size && !scheduled) {
			scheduled = true;
			schedule(flush);
		}
	});
	observer.observe(document.body, { childList: true, subtree: true });
}

// Auto-initialize on load so any page that ships this script is localized with
// zero per-page wiring.
if (hasDOM) {
	registerLangSwitcher();
	const boot = async () => {
		await initI18n();
		observeInjectedContent();
		// Catch content injected during init (before the observer was attached).
		translateSubtree(document);
		mountFloatingSwitcher();
		injectHreflang();
	};
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', boot);
	} else {
		boot();
	}
	// `apply` lets a runtime-built component (nav.js, getting-started.js) request
	// an immediate translation of the subtree it just rendered, without waiting
	// for the observer's next frame.
	// `apply` returns the translateSubtree promise so a caller that needs the
	// fetched sections applied (rather than just scheduled) can await it.
	window.threewsI18n = { t, setLocale, getLocale, initI18n, apply: (root) => translateSubtree(root) };
}
