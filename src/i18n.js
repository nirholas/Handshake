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
const LOCALES_BASE = '/locales';

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
export function applyCatalog(root, t) {
	if (!root) return;
	root.querySelectorAll?.('[data-i18n]').forEach((el) => {
		const v = t(el.getAttribute('data-i18n'));
		if (v != null) el.textContent = v;
	});
	root.querySelectorAll?.('[data-i18n-html]').forEach((el) => {
		const v = t(el.getAttribute('data-i18n-html'));
		if (v != null) el.innerHTML = v;
	});
	root.querySelectorAll?.('[data-i18n-attr]').forEach((el) => {
		for (const pair of el.getAttribute('data-i18n-attr').split(';')) {
			const [attr, key] = pair.split(':').map((s) => s && s.trim());
			if (!attr || !key) continue;
			const v = t(key);
			if (v != null) {
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

// localStorage → ?lang= → navigator languages → manifest default.
function detectLocale(manifest) {
	if (!hasDOM) return manifest.default;
	const stored = safeStorage.get(STORAGE_KEY);
	if (stored && supported(stored, manifest)) return stored;
	const q = new URLSearchParams(location.search).get('lang');
	if (q && supported(q, manifest)) return q;
	for (const nav of navigator.languages || [navigator.language || '']) {
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

async function loadCatalog(code) {
	return fetchJSON(`${LOCALES_BASE}/${code}.json`).catch(() => ({}));
}

export async function setLocale(code) {
	const manifest = await loadManifest();
	const entry = supported(code, manifest) ? code : manifest.default;

	// The entryLocale catalog is both the fallback (so partial translations never
	// leave blanks) AND what restores the original copy when switching back to
	// the default language — the committed English JSON, not the live DOM, is the
	// source of truth, so a default ⇄ translated round-trip is lossless.
	if (!Object.keys(state.fallback).length) {
		state.fallback = await loadCatalog(manifest.default);
	}
	state.catalog = entry === manifest.default ? state.fallback : await loadCatalog(entry);
	state.current = entry;

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
			const manifest = await loadManifest();
			if (!manifest.locales || manifest.locales.length < 2) return;

			const root = this.attachShadow({ mode: 'open' });
			root.innerHTML = `
			<style>
				:host { display: inline-flex; }
				.wrap { position: relative; display: inline-flex; align-items: center; }
				svg { position: absolute; left: 8px; width: 14px; height: 14px; opacity: .6; pointer-events: none; }
				select {
					appearance: none; -webkit-appearance: none;
					font: inherit; font-size: 13px; line-height: 1;
					color: var(--text-2, #cfcfd4);
					background: var(--surface-2, rgba(255,255,255,.04));
					border: 1px solid var(--border, rgba(255,255,255,.12));
					border-radius: 8px;
					padding: 7px 26px 7px 28px;
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
				<svg class="chev" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="1.6"/></svg>
			</span>`;

			const select = root.querySelector('select');
			select.value = getLocale();
			select.addEventListener('change', () => setLocale(select.value));
			// Keep the control in sync if another instance or code path changes locale.
			window.addEventListener('i18n:change', (e) => {
				if (e.detail?.locale) select.value = e.detail.locale;
			});
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
	document.body.appendChild(host);
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

// Auto-initialize on load so any page that ships this script is localized with
// zero per-page wiring.
if (hasDOM) {
	registerLangSwitcher();
	const boot = async () => {
		await initI18n();
		mountFloatingSwitcher();
		injectHreflang();
	};
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', boot);
	} else {
		boot();
	}
	window.threewsI18n = { t, setLocale, getLocale, initI18n };
}
