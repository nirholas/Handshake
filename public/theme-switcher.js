// three.ws site-wide theme switcher.
//
// Owns the dark ⇄ light theme at runtime. The brand default is dark; light is
// the single alternate palette (remapped at the token layer in tokens.css).
//
// Preference model — shared with the dashboard Appearance setting:
//   localStorage key  : 'twx_theme'
//   values            : 'dark' | 'light' | 'auto'   ('auto' follows the OS)
//   unset             : treated as 'dark' (the platform's brand default)
//
// Capability gating — the platform is dark-first and many bespoke pages still
// hardcode their own dark backgrounds instead of consuming the design tokens.
// Forcing light on those would float a light header over a black body. So this
// module probes, with NO visible flash, whether the current page actually
// honours the light palette (its <body> goes light when data-theme='light').
// If it does not, the page is pinned dark and the toggle is hidden — light is
// simply "not available here yet". The probe is synchronous (it reads computed
// style without yielding a paint), so it costs nothing visually. The instant a
// page migrates its colours to tokens, the probe passes and light turns on
// there automatically — no list to maintain.
//
// An inline boot script (scripts/inject-theme-boot.mjs) applies the stored
// theme to <html data-theme> before first paint; this module then gates,
// wires the nav toggle, syncs across tabs, and follows the OS in 'auto' mode.
// Everything is exposed on window.threeTheme for other surfaces (e.g. the
// dashboard settings panel) to drive the same single source of truth.

(function () {
	'use strict';
	if (window.threeTheme) return; // idempotent — only one switcher per document

	var STORAGE_KEY = 'twx_theme';
	var prefersLight =
		window.matchMedia && window.matchMedia('(prefers-color-scheme: light)');
	var islandCache = null; // memoised capability result for this page
	// Is that verdict final? A page whose light palette arrives only through
	// tokens.css gets it via nav.css's @import, which is a second round trip
	// after an async-injected <link>. Probing before that lands reads the
	// page's own dark --bg and memoises "island" for the whole visit, so a
	// user with light saved was served dark on roughly a third of loads. A
	// not-capable verdict therefore stays provisional until every stylesheet
	// has loaded; a capable one is final, since later sheets only ever add
	// light support.
	var islandSettled = false;

	function getMode() {
		try {
			var v = localStorage.getItem(STORAGE_KEY);
			if (v === 'light' || v === 'dark' || v === 'auto') return v;
		} catch (e) {
			/* storage blocked (private mode / sandboxed iframe) — fall through */
		}
		return 'dark';
	}

	// Resolve a stored mode to the concrete theme that should paint right now.
	function resolve(mode) {
		var m = mode || getMode();
		if (m === 'auto') return prefersLight && prefersLight.matches ? 'light' : 'dark';
		return m === 'light' ? 'light' : 'dark';
	}

	// Is <body> dark right now? (Opaque + low luminance.) A transparent body
	// (shows the html canvas, which is token-driven) counts as light-capable.
	function bodyIsDark() {
		if (!document.body) return false;
		var bg = getComputedStyle(document.body).backgroundColor;
		var m = bg.match(/(\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/);
		if (!m) return false;
		var alpha = m[4] === undefined ? 1 : parseFloat(m[4]);
		if (alpha < 0.5) return false;
		var lum = 0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3];
		return lum < 140;
	}

	// Does this page honour the light palette? Probe synchronously: flip the
	// attribute to 'light', read the body (forces a style recalc, NOT a paint),
	// then restore — all in one JS turn, so nothing flashes on screen.
	function pageSupportsLight() {
		if (islandCache !== null && islandSettled) return !islandCache;
		if (!document.body) return true; // can't tell yet — assume capable
		var el = document.documentElement;
		var prev = el.getAttribute('data-theme');
		el.setAttribute('data-theme', 'light');
		var dark = bodyIsDark();
		el.setAttribute('data-theme', prev || 'dark');
		islandCache = dark; // true ⇒ island (light not supported)
		// Capable is final; not-capable only once the stylesheets are all in.
		islandSettled = !dark || document.readyState === 'complete';
		return !dark;
	}

	function setToggleVisible(on) {
		var btn = document.getElementById('nav-theme-toggle');
		if (btn) btn.hidden = !on;
	}

	// Reflect the live theme onto the nav toggle button (label + pressed state).
	function syncToggle(effective) {
		var btn = document.getElementById('nav-theme-toggle');
		if (!btn) return;
		var isLight = effective === 'light';
		btn.setAttribute('aria-pressed', isLight ? 'true' : 'false');
		btn.setAttribute('aria-label', isLight ? 'Switch to dark theme' : 'Switch to light theme');
	}

	// Apply the resolved theme, honouring page capability. Islands are pinned
	// dark with the toggle hidden; capable pages flip and show the toggle.
	function applyResolved() {
		var capable = pageSupportsLight();
		var effective = capable ? resolve() : 'dark';
		document.documentElement.setAttribute('data-theme', effective);
		setToggleVisible(capable);
		syncToggle(effective);
		window.dispatchEvent(
			new CustomEvent('themechange', {
				detail: { mode: getMode(), effective: effective, capable: capable },
			}),
		);
	}

	// Persist + apply a mode. 'dark'/'light' are explicit; 'auto' follows the OS.
	function setMode(mode) {
		var next = mode === 'light' || mode === 'auto' ? mode : 'dark';
		try {
			localStorage.setItem(STORAGE_KEY, next);
		} catch (e) {
			/* persistence unavailable — still apply for this session */
		}
		applyResolved();
		return next;
	}

	// The nav button is a simple binary flip between the two visible themes,
	// writing an explicit choice (never 'auto'); the tri-state lives in settings.
	// It is only reachable on capable pages (hidden elsewhere).
	function toggle() {
		var nextEffective = resolve() === 'light' ? 'dark' : 'light';
		return setMode(nextEffective);
	}

	window.threeTheme = {
		STORAGE_KEY: STORAGE_KEY,
		get: getMode,
		resolve: resolve,
		set: setMode,
		toggle: toggle,
		supportsLight: pageSupportsLight,
	};

	// Apply immediately (gates this page right away, correcting the boot script's
	// pre-paint guess on islands before the page is interactive).
	applyResolved();

	// Re-run the capability probe whenever a stylesheet lands, and re-apply if the
	// page turned out to support light after all. nav.js injects its <link>
	// asynchronously and nav.css @imports tokens.css, so the sheet that carries
	// the light palette can arrive well after the first probe, and on a slow
	// load, after window.load too. A page that is a genuine island stays dark
	// from first paint (no flash); one that merely lost the race to its token
	// sheet flips to the theme the user actually chose. The watch stops the
	// moment the page reads as capable, and gives up a few seconds after load so
	// nothing observes the document forever.
	function reprobeCapability() {
		var wasCapable = islandCache === false;
		islandCache = null;
		islandSettled = false;
		var capable = pageSupportsLight();
		if (capable !== wasCapable) applyResolved();
		return capable;
	}

	if (!pageSupportsLight()) {
		var sheetWatch = null;
		var giveUp = 0;
		var stopWatching = function () {
			if (sheetWatch) { sheetWatch.disconnect(); sheetWatch = null; }
			if (giveUp) { clearTimeout(giveUp); giveUp = 0; }
			islandSettled = true;
			setToggleVisible(islandCache === false);
		};
		var onSheet = function () {
			if (reprobeCapability()) stopWatching();
		};
		var watchLink = function (node) {
			if (!node || node.tagName !== 'LINK' || node.rel !== 'stylesheet') return;
			node.addEventListener('load', onSheet);
		};
		for (var i = 0; i < document.styleSheets.length; i++) onSheet();
		var links = document.querySelectorAll('link[rel="stylesheet"]');
		for (var j = 0; j < links.length; j++) watchLink(links[j]);
		if (window.MutationObserver && islandCache !== false) {
			sheetWatch = new MutationObserver(function (records) {
				for (var r = 0; r < records.length; r++) {
					var added = records[r].addedNodes;
					for (var n = 0; n < added.length; n++) watchLink(added[n]);
				}
				onSheet();
			});
			sheetWatch.observe(document.documentElement, { childList: true, subtree: true });
		}
		window.addEventListener('load', function () {
			if (islandCache === false) return;
			// One last look a beat after load, then settle: an @import resolves
			// after its own link's load event, and nav.js may inject even later.
			giveUp = setTimeout(function () {
				if (!reprobeCapability()) stopWatching();
				else stopWatching();
			}, 3000);
		});
	}

	// Delegated click — independent of when the async-injected nav button mounts.
	document.addEventListener('click', function (e) {
		var t = e.target && e.target.closest && e.target.closest('#nav-theme-toggle');
		if (t) {
			e.preventDefault();
			toggle();
		}
	});

	// When the OS scheme changes, follow it only if the user is in 'auto'.
	if (prefersLight) {
		var onScheme = function () {
			if (getMode() === 'auto') applyResolved();
		};
		if (prefersLight.addEventListener) prefersLight.addEventListener('change', onScheme);
		else if (prefersLight.addListener) prefersLight.addListener(onScheme);
	}

	// Mirror changes made in other tabs/windows.
	window.addEventListener('storage', function (e) {
		if (e.key === STORAGE_KEY) applyResolved();
	});

	// The nav header is injected asynchronously by nav.js; once the toggle
	// button appears, set its visibility + state, then stop observing.
	function bindToggle() {
		if (!document.getElementById('nav-theme-toggle')) return false;
		setToggleVisible(pageSupportsLight());
		syncToggle(document.documentElement.getAttribute('data-theme') || 'dark');
		return true;
	}
	if (!bindToggle() && window.MutationObserver) {
		var obs = new MutationObserver(function () {
			if (bindToggle()) obs.disconnect();
		});
		obs.observe(document.documentElement, { childList: true, subtree: true });
	}
})();
