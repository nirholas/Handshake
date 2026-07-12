// three.ws "Getting started" guide — the first-5-minutes guided path.
//
// Self-mounting, like the activity feed: nav.js loads this on every page that
// carries the shared nav, and the bespoke pages that skip nav.js (home, create,
// app, dashboard…) include it directly. It does two things:
//
//   1. First run — for a brand-new / signed-out visitor landing on the homepage,
//      a one-time welcome modal states the value in a line and routes them to
//      "create your first avatar". Always skippable; shown at most once.
//   2. Always — a low-key launcher pill (bottom-right) that opens a resumable
//      checklist: the free core path (create → give it a brain → embed) plus
//      clearly-optional add-ons (own it on-chain, monetize). Progress persists
//      across pages in localStorage and fills in as the user reaches each stage.
//
// The free core never asks for a wallet. Optional steps are tagged "Optional".
//
// Opt out per page with <html data-getting-started="off"> or
// window.__twsGuideOff = true. Other code can mark a step complete precisely via
// window.__twsGuide.complete('create') or a `three-ws:guide` CustomEvent
// ({ detail: { step: 'create' } }).

(function () {
	'use strict';

	if (window.__twsGuide) return; // idempotent — never double-mount
	if (typeof document === 'undefined') return;
	if (window.self !== window.top) return; // never inside an embedded iframe
	if (document.documentElement.getAttribute('data-getting-started') === 'off') return;
	if (window.__twsGuideOff) return;

	// ── Storage keys ───────────────────────────────────────────────────────────
	var PROGRESS_KEY = 'tws-guide:progress'; // { stepId: completedAtMs }
	var WELCOME_KEY = 'tws-guide:welcome-seen'; // '1' once the modal has been shown
	var OPEN_KEY = 'tws-guide:open'; // panel collapsed/expanded across pages
	var HIDDEN_KEY = 'tws-guide:hidden'; // '1' if the user opted out entirely
	var AUTH_HINT_KEY = '3dagent:auth-hint'; // written by the account layer

	// ── Step definitions ────────────────────────────────────────────────────────
	// `core` steps form the free path the welcome flow promises. `optional` steps
	// are bonus and visibly tagged. `done(path, params)` is a passive milestone
	// test run on every page; precise completion can also arrive via the public
	// complete() API / `three-ws:guide` event.
	var STEPS = [
		{
			id: 'create', core: true, glyph: '🧍',
			title: 'Create your first avatar',
			desc: 'Selfie, text prompt, or upload — your 3D agent in a couple of minutes.',
			href: '/create',
			done: function (p, q) {
				return (p.indexOf('/app') === 0 && q.has('agent')) ||
					p.indexOf('/avatars/') === 0 ||
					p.indexOf('/create/next') === 0 ||
					(p.indexOf('/dashboard') === 0 && q.get('welcome') === '1');
			},
		},
		{
			id: 'brain', core: true, glyph: '🧠',
			title: 'Give it a brain',
			desc: 'Add a name, personality, and voice so it can talk back.',
			href: '/brain',
			done: function (p) { return p === '/brain' || p.indexOf('/brain/') === 0; },
		},
		{
			id: 'embed', core: true, glyph: '🔗',
			title: 'Embed it anywhere',
			desc: 'Drop one line of HTML onto any site — it loads and animates itself.',
			href: '/studio',
			done: function (p) {
				return p.indexOf('/studio') === 0 || p === '/embed' ||
					p.indexOf('/dashboard/widgets') === 0 || p.indexOf('/dashboard/api') === 0;
			},
		},
		{
			id: 'onchain', core: false, glyph: '⛓',
			title: 'Own it on-chain',
			desc: 'Register your agent on-chain so its identity is verifiable.',
			href: '/deploy',
			done: function (p) {
				return p.indexOf('/deploy') === 0 || p.indexOf('/onchain') === 0 || p.indexOf('/showcase') === 0;
			},
		},
		{
			id: 'monetize', core: false, glyph: '◎',
			title: 'Monetize it',
			desc: 'Charge for skills and collect creator fees from the agent economy.',
			href: '/dashboard/monetize',
			done: function (p) { return p.indexOf('/dashboard/monetize') === 0; },
		},
	];

	var CORE = STEPS.filter(function (s) { return s.core; });

	// Immersive / embed surfaces where a floating launcher would intrude. The
	// guide stays silent here but still records any milestone reached.
	var EXCLUDED = [
		'/play', '/walk', '/walk-embed', '/club', '/city', '/xr', '/ar',
		'/pose', '/mocap-studio', '/avatar-studio', '/avatar-embed',
		'/agent-embed', '/a-embed',
	];

	// ── Storage helpers (non-fatal in private mode) ──────────────────────────────
	function lsGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
	function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }

	function loadProgress() {
		try { return JSON.parse(lsGet(PROGRESS_KEY) || '{}') || {}; } catch (_) { return {}; }
	}
	var progress = loadProgress();

	function isDone(id) { return !!progress[id]; }
	function coreDoneCount() {
		return CORE.reduce(function (n, s) { return n + (isDone(s.id) ? 1 : 0); }, 0);
	}
	function allCoreDone() { return coreDoneCount() >= CORE.length; }

	function isAuthed() {
		try {
			var raw = lsGet(AUTH_HINT_KEY);
			return !!(raw && JSON.parse(raw).authed);
		} catch (_) { return false; }
	}

	function currentPath() { return location.pathname.replace(/\/+$/, '') || '/'; }
	function isExcludedRoute() {
		var p = currentPath();
		return EXCLUDED.some(function (x) { return p === x || p.indexOf(x + '/') === 0; });
	}

	// ── DOM utilities ────────────────────────────────────────────────────────────
	function el(tag, cls, text) {
		var n = document.createElement(tag);
		if (cls) n.className = cls;
		if (text != null) n.textContent = text;
		return n;
	}
	function ensureCss() {
		if (document.querySelector('link[href="/getting-started.css"]')) return;
		var link = document.createElement('link');
		link.rel = 'stylesheet';
		link.href = '/getting-started.css';
		document.head.appendChild(link);
	}

	// ── State ─────────────────────────────────────────────────────────────────────
	var root, pill, pillRing, pillCount, panel, list, barFill, panelSub;
	var open = lsGet(OPEN_KEY) === '1';
	var hidden = lsGet(HIDDEN_KEY) === '1';

	// ── Completion ────────────────────────────────────────────────────────────────
	function complete(id, opts) {
		if (!STEPS.some(function (s) { return s.id === id; })) return;
		if (progress[id]) return;
		progress[id] = Date.now();
		lsSet(PROGRESS_KEY, JSON.stringify(progress));
		if (root) {
			renderSteps();
			updatePill();
			// A freshly-reached milestone is worth a gentle nudge open, but never
			// while the user is mid-task on an immersive page.
			if (!open && !hidden && !isExcludedRoute() && !(opts && opts.silent)) flashPill();
		}
	}

	function flashPill() {
		if (!pill) return;
		pill.animate(
			[{ transform: 'scale(1)' }, { transform: 'scale(1.08)' }, { transform: 'scale(1)' }],
			{ duration: 420, easing: 'cubic-bezier(0.16,1,0.3,1)' }
		);
	}

	// Detect milestones for the page we loaded on.
	function detectMilestones() {
		var p = currentPath();
		var q = new URLSearchParams(location.search);
		STEPS.forEach(function (s) {
			if (!isDone(s.id) && s.done(p, q)) complete(s.id, { silent: true });
		});
	}

	// ── Pill ───────────────────────────────────────────────────────────────────────
	function buildPill() {
		pill = el('button', 'twg-pill');
		pill.type = 'button';
		pillRing = el('span', 'twg-pill-ring');
		var glyph = el('span', 'twg-pill-glyph', '✦');
		glyph.setAttribute('aria-hidden', 'true');
		pillRing.appendChild(glyph);
		pill.appendChild(pillRing);
		pill.appendChild(el('span', 'twg-pill-label', 'Getting started'));
		pillCount = el('span', 'twg-pill-count');
		pill.appendChild(pillCount);
		pill.addEventListener('click', expand);
		return pill;
	}

	function updatePill() {
		if (!pill) return;
		var done = coreDoneCount();
		var total = CORE.length;
		var pct = Math.round((done / total) * 100);
		pillRing.style.setProperty('--twg-pct', String(pct));
		var complete = done >= total;
		pill.classList.toggle('is-complete', complete);
		pillCount.textContent = complete ? '✓ Done' : done + '/' + total;
		pill.setAttribute(
			'aria-label',
			complete
				? 'Getting started — all core steps complete. Open checklist.'
				: 'Getting started — ' + done + ' of ' + total + ' steps done. Open checklist.'
		);
	}

	// ── Panel ────────────────────────────────────────────────────────────────────────
	function buildPanel() {
		panel = el('div', 'twg-panel');
		panel.hidden = true;
		panel.setAttribute('role', 'region');
		panel.setAttribute('aria-label', 'Getting started checklist');

		var head = el('div', 'twg-head');
		var headText = el('div', 'twg-head-text');
		headText.appendChild(el('h2', 'twg-title', 'Getting started'));
		panelSub = el('p', 'twg-sub');
		headText.appendChild(panelSub);
		head.appendChild(headText);
		var close = el('button', 'twg-close', '×');
		close.type = 'button';
		close.setAttribute('aria-label', 'Collapse checklist');
		close.addEventListener('click', collapse);
		head.appendChild(close);
		panel.appendChild(head);

		var bar = el('div', 'twg-bar');
		barFill = el('div', 'twg-bar-fill');
		bar.appendChild(barFill);
		panel.appendChild(bar);

		list = el('ul', 'twg-list');
		panel.appendChild(list);

		var foot = el('div', 'twg-foot');
		foot.appendChild(el('span', 'twg-foot-note', '~5 min · no wallet needed'));
		var replay = el('button', 'twg-link', '🎬 Replay guided tour');
		replay.type = 'button';
		replay.title = 'Walk avatar → world → markets → profile again, with a 3D guide';
		replay.addEventListener('click', replayOnboardingTour);
		foot.appendChild(replay);
		var dismiss = el('button', 'twg-link', 'Hide this');
		dismiss.type = 'button';
		dismiss.addEventListener('click', hideForever);
		foot.appendChild(dismiss);
		panel.appendChild(foot);

		return panel;
	}

	function stepRow(s) {
		var done = isDone(s.id);
		var row = el('a', 'twg-step' + (done ? ' is-done' : ''));
		row.href = s.href;
		row.setAttribute('role', 'listitem');

		var mark = el('span', 'twg-step-mark');
		mark.setAttribute('aria-hidden', 'true');
		mark.textContent = done ? '✓' : String(s.glyph);
		row.appendChild(mark);

		var body = el('div', 'twg-step-body');
		var title = el('div', 'twg-step-title');
		title.appendChild(document.createTextNode(s.title));
		if (!s.core) title.appendChild(el('span', 'twg-tag', 'Optional'));
		body.appendChild(title);
		body.appendChild(el('div', 'twg-step-desc', s.desc));
		row.appendChild(body);

		var arrow = el('span', 'twg-step-arrow');
		arrow.setAttribute('aria-hidden', 'true');
		arrow.textContent = '→';
		row.appendChild(arrow);

		// Navigating to the step's surface is itself the milestone; mark it so the
		// checklist reflects intent immediately even before the page loads.
		row.addEventListener('click', function () { complete(s.id, { silent: true }); });
		return row;
	}

	function renderSteps() {
		if (!list) return;
		list.textContent = '';
		var doneN = coreDoneCount();
		var totalN = CORE.length;

		panel.classList.toggle('is-complete', doneN >= totalN);
		panelSub.textContent = doneN >= totalN
			? "Core path done — you've got an embeddable avatar. Bonus steps below."
			: doneN + ' of ' + totalN + ' core steps complete';
		barFill.style.width = Math.round((doneN / totalN) * 100) + '%';

		list.appendChild(sectionLabel('Free · the core path'));
		CORE.forEach(function (s) { list.appendChild(stepRow(s)); });

		var optional = STEPS.filter(function (s) { return !s.core; });
		if (optional.length) {
			list.appendChild(sectionLabel('Optional add-ons'));
			optional.forEach(function (s) { list.appendChild(stepRow(s)); });
		}
	}

	function sectionLabel(text) {
		var li = el('li', 'twg-section-label', text);
		li.setAttribute('role', 'presentation');
		return li;
	}

	// ── Open/close ────────────────────────────────────────────────────────────────
	function expand() {
		open = true;
		lsSet(OPEN_KEY, '1');
		renderSteps();
		panel.hidden = false;
		pill.hidden = true;
	}
	function collapse() {
		open = false;
		lsSet(OPEN_KEY, '0');
		panel.hidden = true;
		pill.hidden = false;
		updatePill();
		pill.focus({ preventScroll: true });
	}
	function hideForever() {
		hidden = true;
		lsSet(HIDDEN_KEY, '1');
		if (root) root.hidden = true;
	}

	// ── Welcome modal ──────────────────────────────────────────────────────────────
	// Shown once, only to a signed-out visitor with no progress, on the homepage.
	function shouldShowWelcome() {
		if (hidden) return false;
		if (lsGet(WELCOME_KEY) === '1') return false;
		if (isAuthed()) return false;
		if (coreDoneCount() > 0) return false;
		var p = currentPath();
		return p === '/' || p === '/home' || p.indexOf('/home/') === 0;
	}

	function showWelcome() {
		lsSet(WELCOME_KEY, '1');
		var overlay = el('div', 'twg-modal-overlay');
		overlay.setAttribute('role', 'dialog');
		overlay.setAttribute('aria-modal', 'true');
		overlay.setAttribute('aria-labelledby', 'twg-modal-title');

		var modal = el('div', 'twg-modal');

		var art = el('div', 'twg-modal-art');
		var artGlyph = el('div', 'twg-modal-art-glyph', '🤖');
		artGlyph.setAttribute('aria-hidden', 'true');
		art.appendChild(artGlyph);
		modal.appendChild(art);

		var body = el('div', 'twg-modal-body');
		body.appendChild(el('p', 'twg-modal-eyebrow', 'Welcome to three.ws'));
		var title = el('h1', 'twg-modal-title', 'Give your AI a body — in about five minutes');
		title.id = 'twg-modal-title';
		body.appendChild(title);
		body.appendChild(el('p', 'twg-modal-lede',
			'Create a 3D AI avatar, give it a personality, and embed it on any site. The core path is free and needs no wallet.'));

		var steps = el('ul', 'twg-modal-steps');
		[['🧍', 'Create'], ['🧠', 'Add a brain'], ['🔗', 'Embed it']].forEach(function (pair) {
			var li = el('li');
			var ic = el('span', null, pair[0]);
			ic.setAttribute('aria-hidden', 'true');
			li.appendChild(ic);
			li.appendChild(document.createTextNode(pair[1]));
			steps.appendChild(li);
		});
		body.appendChild(steps);

		var actions = el('div', 'twg-modal-actions');
		var primary = el('a', 'twg-btn twg-btn-primary');
		primary.href = '/create';
		primary.appendChild(document.createTextNode('Create your first avatar'));
		var arrow = el('span', null, '→');
		arrow.setAttribute('aria-hidden', 'true');
		primary.appendChild(arrow);
		primary.addEventListener('click', function () { close(); });
		var ghost = el('button', 'twg-btn twg-btn-ghost', 'Maybe later');
		ghost.type = 'button';
		ghost.addEventListener('click', close);
		actions.appendChild(primary);
		actions.appendChild(ghost);
		body.appendChild(actions);

		body.appendChild(el('p', 'twg-modal-fineprint', 'You can reopen this anytime from “Getting started”, bottom-right.'));
		modal.appendChild(body);
		overlay.appendChild(modal);
		document.body.appendChild(overlay);

		// Focus management + restore.
		var prevFocus = document.activeElement;
		var focusable = modal.querySelectorAll('a[href], button');
		(focusable[0] || modal).focus({ preventScroll: true });

		function close() {
			document.removeEventListener('keydown', onKey, true);
			overlay.remove();
			if (prevFocus && prevFocus.focus) prevFocus.focus({ preventScroll: true });
		}
		function onKey(e) {
			if (e.key === 'Escape') { e.preventDefault(); close(); return; }
			if (e.key === 'Tab' && focusable.length) {
				var first = focusable[0];
				var lastEl = focusable[focusable.length - 1];
				if (e.shiftKey && document.activeElement === first) { e.preventDefault(); lastEl.focus(); }
				else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); first.focus(); }
			}
		}
		document.addEventListener('keydown', onKey, true);
		overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
	}

	// ── Onboarding guided tour (src/feature-tour/*, section: "onboarding") ──────
	// A short, self-driving 3D-guide walkthrough chaining avatar → world →
	// markets → profile, distinct from this checklist. Auto-offered once to a
	// genuinely new, signed-in account (zero creations, server-confirmed via
	// GET /api/me `show_onboarding_tour`) landing on a top-level entry route;
	// always reachable afterward via the "Replay guided tour" link above.
	var ONBOARDING_TOUR_ROUTES = ['/', '/home', '/dashboard', '/start'];
	var ONBOARDING_TOUR_URL = '/start?tour=start&track=onboarding';

	function isTourAlreadyActive() {
		try {
			var raw = sessionStorage.getItem('tws:tour:state');
			return !!(raw && JSON.parse(raw).active === true);
		} catch (_) { return false; }
	}

	function isOnboardingEligibleRoute() {
		var p = currentPath();
		for (var i = 0; i < ONBOARDING_TOUR_ROUTES.length; i++) {
			if (p === ONBOARDING_TOUR_ROUTES[i]) return true;
		}
		return false;
	}

	function replayOnboardingTour() {
		location.href = ONBOARDING_TOUR_URL;
	}

	// Best-effort, silent on any failure (signed out → 401, offline, etc.) —
	// this must never block or error the page it runs on.
	function maybeOfferOnboardingTour() {
		if (hidden || !isAuthed() || isTourAlreadyActive() || !isOnboardingEligibleRoute()) return;
		if (new URLSearchParams(location.search).get('tour')) return; // a tour deep-link is already in flight
		fetch('/api/me', { credentials: 'include' })
			.then(function (res) { return res.ok ? res.json() : null; })
			.then(function (data) {
				if (data && data.user && data.user.show_onboarding_tour) {
					location.href = ONBOARDING_TOUR_URL;
				}
			})
			.catch(function () {});
	}

	// Pull in the shared corner-stack wherever this widget runs — some pages
	// include us directly without nav.js (which normally loads it). The stack
	// adopts our tagged orphan when it initialises, so order doesn't matter.
	function ensureCornerStack() {
		if (window.twsCornerStack) return;
		if (document.querySelector('script[src="/corner-stack.js"]')) return;
		var s = document.createElement('script');
		s.src = '/corner-stack.js';
		s.defer = true;
		(document.head || document.documentElement).appendChild(s);
	}

	// ── Mount ─────────────────────────────────────────────────────────────────────
	function mount() {
		ensureCss();
		ensureCornerStack();
		root = el('div', 'twg-root');
		root.appendChild(buildPanel());
		root.appendChild(buildPill());
		// Flow into the shared corner-stack so it never overlaps the other
		// bottom-right cards. The launcher pill owns the corner itself (highest
		// priority). Falls back to a plain body mount if the stack isn't ready;
		// the data-corner-priority tag lets it be adopted once the stack arrives.
		root.setAttribute('data-corner-priority', '30');
		if (window.twsCornerStack) window.twsCornerStack.mount(root);
		else document.body.appendChild(root);

		updatePill();
		if (open) expand();

		// Hide while any element is fullscreen (immersive 3D etc.).
		document.addEventListener('fullscreenchange', function () {
			if (root) root.hidden = hidden || !!document.fullscreenElement;
		});
		document.addEventListener('keydown', function (e) {
			if (e.key === 'Escape' && open) collapse();
		});
	}

	// ── Public surface ─────────────────────────────────────────────────────────────
	window.__twsGuide = {
		complete: complete,
		open: function () { if (hidden) { hidden = false; lsSet(HIDDEN_KEY, '0'); if (root) root.hidden = false; } expand(); },
		close: collapse,
		progress: function () { return Object.assign({}, progress); },
		isComplete: allCoreDone,
		replayOnboardingTour: replayOnboardingTour,
	};

	// React to precise completion signals fired by other modules.
	document.addEventListener('three-ws:guide', function (e) {
		var step = e && e.detail && e.detail.step;
		if (step) complete(step);
	});

	function boot() {
		// Record progress regardless of where we are (cross-page resume).
		detectMilestones();
		// But only render the floating UI on non-immersive pages, when not opted out.
		if (!hidden && !isExcludedRoute()) {
			mount();
		}
		maybeOfferOnboardingTour();
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', boot);
	} else {
		boot();
	}
})();
