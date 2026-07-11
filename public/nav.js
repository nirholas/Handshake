// three.ws shared site navigation loader.
//
// Injects the global header (public/nav.html) into any page that includes a
// `<div id="nav-container"></div>` and `<script src="/nav.js">`, renders every
// menu (desktop dropdowns + mobile drawer) from public/nav-data.js — the
// single source of truth for menu items — then wires the behavior:
// hover/click dropdowns, the mobile drawer, the Walk Companion toggle,
// auth-aware CTAs, and active-page highlighting. The homepage
// (pages/home.html) consumes this same loader, so every page reads as the
// same site by construction.

// Load the site-wide glossary tooltip system (public/glossary.js) on every
// page. Self-mounting + idempotent; honours <html data-glossary="off">.
function loadGlossary() {
	if (document.documentElement.getAttribute('data-glossary') === 'off') return;
	if (document.querySelector('script[src="/glossary.js"]')) return;
	const s = document.createElement('script');
	s.src = '/glossary.js';
	s.defer = true;
	document.head.appendChild(s);
}

// Load the site-wide Cmd-K command palette (public/search.js) on every page.
// Self-mounting + idempotent; honours <html data-search="off">.
function loadSearch() {
	if (document.documentElement.getAttribute('data-search') === 'off') return;
	if (document.querySelector('script[src="/search.js"]')) return;
	const s = document.createElement('script');
	s.src = '/search.js';
	s.defer = true;
	document.head.appendChild(s);
}

// Load the shared corner-stack (public/corner-stack.js) BEFORE any widget that
// uses it, so window.twsCornerStack exists when they mount. It is also
// order-independent (adopts orphans), but loading it first avoids the adopt
// round-trip. Self-mounting + idempotent.
function loadCornerStack() {
	if (window.twsCornerStack) return;
	if (document.querySelector('script[src="/corner-stack.js"]')) return;
	const s = document.createElement('script');
	s.src = '/corner-stack.js';
	s.defer = true;
	document.head.appendChild(s);
}

// Load the site-wide "Getting started" first-run guide (public/getting-started.js):
// a one-time welcome for new visitors plus a resumable progress checklist. Self-
// mounting + idempotent; honours <html data-getting-started="off">.
function loadGettingStarted() {
	if (document.documentElement.getAttribute('data-getting-started') === 'off') return;
	if (document.querySelector('script[src="/getting-started.js"]')) return;
	const s = document.createElement('script');
	s.src = '/getting-started.js';
	s.defer = true;
	document.head.appendChild(s);
}

// Load the per-user notifications inbox. Must run after nav HTML is injected
// because the module mounts onto #nav-notifications-btn which lives in nav.html.
function loadNotificationsInbox() {
	if (document.querySelector('script[src="/notifications.js"]')) return;
	const s = document.createElement('script');
	s.type = 'module';
	s.src = '/notifications.js';
	document.head.appendChild(s);
}

// Load the $THREE holder tier chip. Must run after nav HTML is injected because
// the module mounts onto #nav-tier-badge in nav.html. Self-hides for anonymous
// visitors and non-holders, so it's safe to load unconditionally.
function loadHolderBadge() {
	if (document.querySelector('script[src="/nav-tier-badge.js"]')) return;
	const s = document.createElement('script');
	s.type = 'module';
	s.src = '/nav-tier-badge.js';
	document.head.appendChild(s);
}

// Load the site-wide feature-discovery layer (public/feature-discovery.js):
// "New" badges, "have you tried…" prompts and contextual cross-links. Loaded
// after the glossary so it can reuse that tooltip primitive. Self-mounting +
// idempotent; honours <html data-discovery="off">.
function loadDiscovery() {
	if (document.documentElement.getAttribute('data-discovery') === 'off') return;
	if (document.querySelector('script[src="/feature-discovery.js"]')) return;
	const s = document.createElement('script');
	s.src = '/feature-discovery.js';
	s.defer = true;
	document.head.appendChild(s);
}

// Load the site-wide theme switcher (public/theme-switcher.js): owns the
// dark ⇄ light toggle wired to the nav button, persistence and cross-tab sync.
// Self-mounting + idempotent. The inline boot script already applied the theme
// before paint; this binds the toggle button and keeps it in sync.
function loadThemeSwitcher() {
	if (document.querySelector('script[src="/theme-switcher.js"]')) return;
	const s = document.createElement('script');
	s.src = '/theme-switcher.js';
	s.defer = true;
	document.head.appendChild(s);
}

// The site-wide Guided Tour engine (src/feature-tour.js → /feature-tour.js) is
// no longer booted here. Its load gate now lives in a Vite transformIndexHtml
// plugin (vite.config.js → 'feature-tour-boot') so it's injected on EVERY page,
// including the bespoke full-screen routes the tour visits that skip nav.js
// (e.g. /create/selfie, /scan, /club). Keeping the gate only in nav.js stranded
// the tour the moment it navigated onto a nav-less page.

// Resolves once /nav.css is loaded so the nav markup is never injected
// unstyled (the flash-of-unstyled-content seen on hard refresh). A JS-inserted
// stylesheet loads asynchronously and does not block paint, so the injected
// innerHTML must wait on the link's load event before it is written.
function ensureNavStylesheet() {
	const href = '/nav.css';
	let link = document.querySelector(`link[href="${href}"]`);
	if (link) {
		// Already on the page; resolve immediately if the sheet is parsed.
		if (link.sheet) return Promise.resolve();
		return new Promise((resolve) => {
			link.addEventListener('load', resolve, { once: true });
			link.addEventListener('error', resolve, { once: true });
		});
	}
	return new Promise((resolve) => {
		link = document.createElement('link');
		link.rel = 'stylesheet';
		link.href = href;
		link.addEventListener('load', resolve, { once: true });
		link.addEventListener('error', resolve, { once: true });
		document.head.appendChild(link);
	});
}

// Inject the "Skip to content" link as the first focusable element on the page.
// Keyboard and screen-reader users otherwise have to tab through the entire
// header (search, walk, theme, notifications, auth + every dropdown trigger) on
// every one of the 170 pages before reaching the page body. Visually hidden
// until focused (see .nav-skip in nav.css). Resolves the main landmark at click
// time so it works whether the page tagged it `#main-content`, a bare <main>,
// or `[role="main"]`, and makes the target programmatically focusable on demand.
function ensureSkipLink() {
	if (!document.body || document.querySelector('.nav-skip')) return;
	const link = document.createElement('a');
	link.className = 'nav-skip';
	link.href = '#main-content';
	link.textContent = 'Skip to content';
	link.addEventListener('click', (e) => {
		const target =
			document.getElementById('main-content') || document.querySelector('main, [role="main"]');
		if (!target) return; // fall back to the native anchor jump
		e.preventDefault();
		if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
		target.focus({ preventScroll: true });
		target.scrollIntoView({ block: 'start' });
	});
	document.body.insertBefore(link, document.body.firstChild);
}

// Load the Living-Agents bus on any page when the operator opts in with
// ?agentbus=1, so the debug overlay (a dev tool, not product UI) can mount and
// log live bus events anywhere. The bus module self-mounts the overlay from the
// query flag; off by default, it costs nothing.
function loadAgentBusDebug() {
	let on = false;
	try {
		const flag = new URLSearchParams(location.search).get('agentbus');
		on = flag === '1' || flag === 'true';
	} catch (_) {
		on = false;
	}
	if (!on) return;
	if (document.querySelector('script[src="/agent-bus.js"]')) return;
	const s = document.createElement('script');
	s.type = 'module';
	s.src = '/agent-bus.js';
	document.head.appendChild(s);
}

function boot() {
	ensureSkipLink();
	loadCornerStack();
	loadGlossary();
	loadSearch();
	loadAgentBusDebug();
	loadDiscovery();
	loadGettingStarted();
	loadThemeSwitcher();
	initCompanionAutoStart();
	const navContainer = document.getElementById('nav-container');
	if (!navContainer) return;
	Promise.all([
		fetch('/nav.html').then((response) => response.text()),
		import('/nav-data.js'),
		ensureNavStylesheet(),
	])
		.then(([html, navData]) => {
			navContainer.innerHTML = html;
			renderMenus(navContainer, navData);
			initNav(navContainer);
			loadNotificationsInbox();
			loadHolderBadge();
		})
		.catch((err) => console.error('nav: failed to load shared navigation', err));
}

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', boot);
} else {
	boot();
}

function initNav(root) {
	initDropdowns(root);
	initDrawer(root);
	initWalkToggle(root);
	initAuthHint(root);
	initActivePage(root);
}

// ── Menu rendering ──────────────────────────────────────────────────────────
// The desktop dropdowns and the mobile drawer are both rendered from
// nav-data.js so a menu item can only ever exist in one place.
function escHtml(s) {
	return String(s == null ? '' : s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function attrString(attrs) {
	if (!attrs) return '';
	return Object.keys(attrs)
		.map((key) => ` ${key}="${escHtml(attrs[key])}"`)
		.join('');
}

function renderMenuItem(item) {
	const tone = item.badgeTone === 'live' ? ' nav-pill-live' : '';
	const badge = item.badge ? ` <span class="nav-pill-sm${tone}">${escHtml(item.badge)}</span>` : '';
	return (
		`<a class="nav-mi" href="${escHtml(item.href)}" role="menuitem"${attrString(item.attrs)}>` +
		`<span class="nav-mi-t">${escHtml(item.title)}${badge}</span>` +
		`<span class="nav-mi-d">${escHtml(item.desc)}</span></a>`
	);
}

function renderGroup(group) {
	const badge = group.badge
		? `<span class="nav-pill-sm" aria-hidden="true">${escHtml(group.badge)}</span>`
		: '';
	let popClass = 'nav-pop';
	if (group.layout === 'mega') {
		popClass += ' mega';
		if (group.columns) popClass += ` cols-${group.columns.length}`;
		if (group.align === 'right') popClass += ' anchor-right';
	} else if (group.layout === 'wide') {
		popClass += ' wide';
	}
	const note = group.note ? `<div class="nav-pop-note">${escHtml(group.note)}</div>` : '';
	const body = group.columns
		? group.columns
				.map(
					(col) =>
						`<div class="nav-col" role="group" aria-label="${escHtml(col.label)}">` +
						`<div class="nav-col-h">${escHtml(col.label)}</div>` +
						col.items.map(renderMenuItem).join('') +
						`</div>`,
				)
				.join('')
		: (group.items || []).map(renderMenuItem).join('');
	return (
		`<div class="nav-grp">` +
		`<button type="button" class="nav-trigger" aria-haspopup="true" aria-expanded="false">` +
		`${escHtml(group.label)}${badge}<span class="nav-caret" aria-hidden="true">▾</span></button>` +
		`<div class="${popClass}" role="menu" aria-label="${escHtml(group.label)}">${note}${body}</div>` +
		`</div>`
	);
}

function renderTopLink(link) {
	if (link.highlight) {
		return (
			`<a class="nav-hot" href="${escHtml(link.href)}">` +
			`<span class="nav-hot-dot" aria-hidden="true"></span>` +
			`<span class="nav-hot-label">${escHtml(link.label)}</span></a>`
		);
	}
	const badge = link.badge ? ` <span class="nav-pill-sm">${escHtml(link.badge)}</span>` : '';
	return `<a href="${escHtml(link.href)}">${escHtml(link.label)}${badge}</a>`;
}

function renderDrawerLink(item) {
	return `<a href="${escHtml(item.href)}"${attrString(item.attrs)}>${escHtml(item.title)}</a>`;
}

function renderDrawer(navData) {
	let html = '';
	// Walk Companion toggle — the desktop nav exposes it in `.nav-end`, which is
	// hidden on the mobile breakpoint, so without this row touch visitors have no
	// way to summon the walking avatar. Lead the drawer with it as a switch row;
	// initWalkToggle wires it (and keeps it in sync with the desktop button).
	html +=
		`<button type="button" class="dr-walk" id="home-nav-drawer-walk" aria-pressed="false">` +
		`<span class="nav-walk-ico" aria-hidden="true">🚶</span>` +
		`<span class="dr-walk-label">Walk with me</span>` +
		`<span class="dr-walk-state" aria-hidden="true">Off</span></button>`;
	// Highlighted top-level links lead the drawer as featured rows — burying
	// the one link the nav spotlights under "More" defeats the spotlight.
	navData.NAV_LINKS.filter((l) => l.highlight).forEach((link) => {
		html +=
			`<a class="dr-hot" href="${escHtml(link.href)}">` +
			`<span class="nav-hot-dot" aria-hidden="true"></span>` +
			`<span>${escHtml(link.label)}</span>` +
			`<span class="dr-hot-arrow" aria-hidden="true">→</span></a>`;
	});
	navData.NAV_GROUPS.forEach((group) => {
		if (group.columns) {
			group.columns.forEach((col) => {
				html += `<div class="dr-h">${escHtml(group.label)} · ${escHtml(col.label)}</div>`;
				html += col.items.map(renderDrawerLink).join('');
			});
		} else {
			html += `<div class="dr-h">${escHtml(group.label)}</div>`;
			html += (group.items || []).map(renderDrawerLink).join('');
		}
	});
	html += `<div class="dr-h">Legal</div>`;
	html += navData.DRAWER_LEGAL.map(renderDrawerLink).join('');
	html += `<div class="dr-h">More</div>`;
	html += navData.NAV_LINKS.filter((l) => !l.highlight).map(renderTopLink).join('');
	html += `<a href="/dashboard" id="home-nav-drawer-dashboard" data-auth="in" hidden>Dashboard</a>`;
	html += `<a href="/guardian" id="home-nav-drawer-guardian" data-auth="in" hidden>Guardian console</a>`;
	html += `<div class="sep"></div>`;
	html += `<a href="/login" id="home-nav-drawer-cta" data-auth="out">Sign in</a>`;
	html += `<a class="btn primary btn--primary" href="/dashboard">Console →</a>`;
	return html;
}

function renderMenus(root, navData) {
	const main = root.querySelector('.nav-main');
	if (main) {
		main.innerHTML =
			navData.NAV_GROUPS.map(renderGroup).join('') + navData.NAV_LINKS.map(renderTopLink).join('');
	}
	const drawer = root.querySelector('#nav-drawer');
	if (drawer) drawer.innerHTML = renderDrawer(navData);
}

// ── Desktop dropdowns ──────────────────────────────────────────────────────
// Hover to open on pointer devices; click/keyboard for touch + accessibility.
function initDropdowns(root) {
	const groups = Array.prototype.slice.call(root.querySelectorAll('.nav-main .nav-grp'));
	if (!groups.length) return;
	const hoverCapable = window.matchMedia('(hover: hover)').matches;

	// Keep a left-anchored popover inside the viewport. The wide mega menus
	// (Launch is four columns) can extend past the right edge on smaller
	// desktops; nudge them left by the overflow so the last column stays
	// clickable. Right-anchored menus already hug the right edge — leave them.
	function clampPopover(pop, on) {
		pop.style.marginLeft = '';
		if (!on || pop.classList.contains('anchor-right')) return;
		const overflow = pop.getBoundingClientRect().right - (window.innerWidth - 12);
		if (overflow > 0) pop.style.marginLeft = `-${Math.ceil(overflow)}px`;
	}

	function setOpen(grp, on) {
		grp.classList.toggle('open', on);
		const t = grp.querySelector('.nav-trigger');
		if (t) t.setAttribute('aria-expanded', on ? 'true' : 'false');
		const pop = grp.querySelector('.nav-pop');
		if (pop) clampPopover(pop, on);
	}
	function closeAll(except) {
		groups.forEach((g) => {
			if (g !== except) setOpen(g, false);
		});
	}

	groups.forEach((grp) => {
		const trigger = grp.querySelector('.nav-trigger');
		if (!trigger) return;
		let closeTimer;

		trigger.addEventListener('click', (e) => {
			e.stopPropagation();
			// Keyboard-activated clicks (Enter/Space) report detail === 0; real
			// pointer clicks report >= 1. On hover devices a mouse click just pins
			// the already-open menu, but a keyboard activation must also move focus
			// into the menu — otherwise the dropdown opens with focus stranded on
			// the trigger and the arrow-key navigation below never engages.
			const keyboard = e.detail === 0;
			if (hoverCapable && !keyboard) {
				closeAll(grp);
				setOpen(grp, true);
				return;
			}
			const willOpen = !grp.classList.contains('open');
			closeAll(grp);
			setOpen(grp, willOpen);
			if (keyboard && willOpen) {
				trigger.nextElementSibling?.querySelector('a')?.focus({ preventScroll: true });
			}
		});

		// WAI-ARIA menu-button pattern: ArrowDown/ArrowUp on the trigger open the
		// menu and land focus on the first / last item, so a keyboard user can dive
		// straight into the dropdown without first activating then re-reaching it.
		trigger.addEventListener('keydown', (e) => {
			if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
			const items = Array.prototype.slice.call(
				(trigger.nextElementSibling || grp).querySelectorAll('a'),
			);
			if (!items.length) return;
			e.preventDefault();
			closeAll(grp);
			setOpen(grp, true);
			(e.key === 'ArrowDown' ? items[0] : items[items.length - 1])?.focus({
				preventScroll: true,
			});
		});

		if (hoverCapable) {
			grp.addEventListener('mouseenter', () => {
				clearTimeout(closeTimer);
				closeAll(grp);
				setOpen(grp, true);
			});
			grp.addEventListener('mouseleave', () => {
				closeTimer = setTimeout(() => setOpen(grp, false), 120);
			});
		}

		// Keyboard navigation within the open menu.
		const menu = trigger.nextElementSibling;
		if (menu) {
			menu.addEventListener('keydown', (e) => {
				const items = Array.prototype.slice.call(menu.querySelectorAll('a'));
				const idx = items.indexOf(document.activeElement);
				if (e.key === 'ArrowDown') {
					e.preventDefault();
					(items[(idx + 1) % items.length] || items[0])?.focus({ preventScroll: true });
				} else if (e.key === 'ArrowUp') {
					e.preventDefault();
					(items[(idx - 1 + items.length) % items.length] || items[0])?.focus({
						preventScroll: true,
					});
				} else if (e.key === 'Home') {
					e.preventDefault();
					items[0]?.focus({ preventScroll: true });
				} else if (e.key === 'End') {
					e.preventDefault();
					items[items.length - 1]?.focus({ preventScroll: true });
				} else if (e.key === 'Escape') {
					setOpen(grp, false);
					trigger.focus({ preventScroll: true });
				}
			});
		}

		grp.querySelectorAll('.nav-mi').forEach((a) => {
			a.addEventListener('click', () => setOpen(grp, false));
		});
	});

	document.addEventListener('click', (e) => {
		// e.target can be a non-Element (text node, document) — closest() only
		// exists on Elements, so resolve the nearest Element before calling it.
		const t = e.target;
		const el = t && t.nodeType === 1 ? t : (t && t.parentElement) || null;
		if (!el || !el.closest('.nav-main .nav-grp')) closeAll(null);
	});
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape') {
			const openGrp = root.querySelector('.nav-main .nav-grp.open');
			if (openGrp) {
				setOpen(openGrp, false);
				const t = openGrp.querySelector('.nav-trigger');
				if (t) t.focus({ preventScroll: true });
			}
		}
	});
}

// ── Mobile drawer ──────────────────────────────────────────────────────────
function initDrawer(root) {
	const toggle = root.querySelector('#nav-toggle');
	const drawer = root.querySelector('#nav-drawer');
	if (!toggle || !drawer) return;

	const isOpen = () => drawer.classList.contains('open');
	const focusables = () =>
		[...drawer.querySelectorAll('a[href], button:not([disabled]), input:not([disabled])')].filter(
			(el) => el.offsetParent !== null && !el.closest('[hidden]'),
		);
	// Start closed: `inert` keeps the drawer's links out of the tab order and
	// hidden from assistive tech, and blurs any descendant that holds focus —
	// which is what aria-hidden alone cannot do (it only warns).
	drawer.inert = true;
	function setOpen(open) {
		toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
		drawer.setAttribute('aria-hidden', open ? 'false' : 'true');
		drawer.inert = !open;
		document.body.style.overflow = open ? 'hidden' : '';
		drawer.classList.toggle('open', open);
		// Move focus into the drawer on open so keyboard/SR users land on the
		// menu, not stranded on the toggle behind the overlay. The 0ms defer
		// lets `inert` clear first (a still-inert element rejects focus).
		if (open) setTimeout(() => focusables()[0]?.focus({ preventScroll: true }), 0);
	}
	toggle.addEventListener('click', () => setOpen(!isOpen()));
	drawer.addEventListener('click', (e) => {
		// Links navigate; the Walk toggle stays put but the drawer still closes so
		// the summoned avatar isn't hidden behind the overlay.
		if (e.target.closest('a, #home-nav-drawer-walk')) setOpen(false);
	});
	document.addEventListener('keydown', (e) => {
		if (!isOpen()) return;
		if (e.key === 'Escape') {
			setOpen(false);
			toggle.focus();
			return;
		}
		// Focus trap: keep Tab cycling inside the open drawer. The page behind
		// is visually covered, so focus must not escape to it.
		if (e.key === 'Tab') {
			const items = focusables();
			if (!items.length) return;
			const first = items[0];
			const last = items[items.length - 1];
			const active = document.activeElement;
			if (e.shiftKey && (active === first || !drawer.contains(active))) {
				e.preventDefault();
				last.focus({ preventScroll: true });
			} else if (!e.shiftKey && (active === last || !drawer.contains(active))) {
				e.preventDefault();
				first.focus({ preventScroll: true });
			}
		}
	});
	window.addEventListener('resize', () => {
		if (window.innerWidth > 880 && isOpen()) setOpen(false);
	});
}

// ── Active page highlighting ────────────────────────────────────────────────
function initActivePage(root) {
	const path = location.pathname.replace(/\/$/, '') || '/';
	root.querySelectorAll('a[href]').forEach((a) => {
		const raw = a.getAttribute('href');
		if (!raw || !raw.startsWith('/')) return;
		const href = raw.split('#')[0].replace(/\/$/, '') || '/';
		if (href === path || (href !== '/' && path.startsWith(href + '/'))) {
			a.setAttribute('aria-current', 'page');
		}
	});
}

// ── Auth-aware CTAs ──────────────────────────────────────────────────────────
// Swap "Sign in" for the dashboard entry points when the visitor is
// authenticated. The behavior lives in the shared /nav-auth.js module — see that
// file for the hint-then-reconcile-against-/api/auth/me strategy and its
// data-auth markup contract. Loaded on demand and called once the nav markup is
// injected.
function initAuthHint(root) {
	if (typeof window.initNavAuth === 'function') {
		window.initNavAuth(root);
		return;
	}
	if (!document.querySelector('script[src="/nav-auth.js"]')) {
		const s = document.createElement('script');
		s.src = '/nav-auth.js';
		s.addEventListener('load', () => {
			if (typeof window.initNavAuth === 'function') window.initNavAuth(root);
		});
		document.head.appendChild(s);
	} else {
		// Script tag exists but hasn't finished loading yet — run once it does.
		const existing = document.querySelector('script[src="/nav-auth.js"]');
		existing.addEventListener('load', () => {
			if (typeof window.initNavAuth === 'function') window.initNavAuth(root);
		});
	}
}

// ── Walk Companion toggle ─────────────────────────────────────────────────────
// Loads the stable, unhashed /walk-companion.js module (built from
// src/walk-companion.js — see vite.config.js) only when enabled, so pages pay
// no Three.js cost when it's off. State lives in localStorage and the
// ?walk=1 / ?walk=0 query param, both also honored by the module itself.
const WALK_ENABLED_KEY = 'walk:companion:enabled';

function walkIsEnabled() {
	try {
		return localStorage.getItem(WALK_ENABLED_KEY) === '1';
	} catch (_) {
		return false;
	}
}

function ensureWalkCompanion() {
	if (document.querySelector('script[src="/walk-companion.js"]')) return;
	const s = document.createElement('script');
	s.type = 'module';
	s.src = '/walk-companion.js';
	document.head.appendChild(s);
}

// ── First-visit companion auto-start ─────────────────────────────────────────
// Every visitor gets their agent in the first few seconds: if they have never
// decided about the companion (the enabled key is absent — '0' means they
// closed it, '1' means it's already on), summon it once, deferred to idle so
// it costs the first paint nothing. The companion module mints the guest
// identity (name + body) and introduces itself; see
// src/walk-companion-identity.js.
const WALK_AUTO_KEY = 'walk:companion:auto';

// Routes that own their own full-screen 3D or camera experience — summoning a
// second WebGL avatar there hurts more than it helps. (walk-sdk keeps its own
// exclusion list too; this is the conservative outer gate.)
const WALK_AUTO_SKIP = /^\/(play|walk|club|tour|world|scan|arena|pose|splat|capture)(\/|$)|^\/create\/selfie/;

function initCompanionAutoStart() {
	// Every check lives inside the deferred callback: boot() can run while this
	// script is still evaluating (late injection), and the WALK_ENABLED_KEY
	// const below would be in its temporal dead zone if read synchronously here.
	const summon = () => {
		try {
			if (localStorage.getItem(WALK_ENABLED_KEY) !== null) return; // visitor already chose (on or off)
		} catch (_) {
			return; // no storage → the greeting/claim loop can't work either
		}
		if (WALK_AUTO_SKIP.test(location.pathname)) return;
		if (document.documentElement.getAttribute('data-walk-auto') === 'off') return;
		if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
		if (navigator.connection && navigator.connection.saveData) return;
		try {
			localStorage.setItem(WALK_ENABLED_KEY, '1');
			localStorage.setItem(WALK_AUTO_KEY, '1');
		} catch (_) {
			return;
		}
		ensureWalkCompanion();
		window.dispatchEvent(new CustomEvent('walk-companion:change'));
	};
	const idle = () =>
		'requestIdleCallback' in window ? requestIdleCallback(summon, { timeout: 4000 }) : setTimeout(summon, 1500);
	if (document.readyState === 'complete') setTimeout(idle, 2000);
	else window.addEventListener('load', () => setTimeout(idle, 2000), { once: true });
}

function initWalkToggle(root) {
	// Desktop button (`.nav-end`) + mobile drawer row — both toggle the same
	// companion and stay mirrored, so the avatar is reachable at every breakpoint.
	const btns = [...root.querySelectorAll('#home-nav-walk, #home-nav-drawer-walk')];
	if (!btns.length) return;

	const params = new URLSearchParams(location.search);
	const override = params.get('walk');

	function sync() {
		const on = walkIsEnabled();
		btns.forEach((btn) => {
			btn.setAttribute('aria-pressed', on ? 'true' : 'false');
			btn.classList.toggle('is-on', on);
			const state = btn.querySelector('.dr-walk-state');
			if (state) state.textContent = on ? 'On' : 'Off';
		});
	}

	// An explicit ?walk= override decides the initial state; otherwise restore.
	if (override === '1' || override === '0') {
		try {
			localStorage.setItem(WALK_ENABLED_KEY, override);
		} catch (_) {}
	}
	sync();

	// Whether we just dived through a link into the page playground on the
	// previous page — the companion module reads + clears this to drop the
	// character back in from the top.
	let pendingDropIn = false;
	try {
		pendingDropIn = sessionStorage.getItem('walk:playground:resume') === '1';
	} catch (_) {}

	// Load the module if the companion should be active on this page. The module
	// is self-mounting; ensureWalkCompanion is idempotent. `?walk=play` deep-links
	// straight into the playground; a pending drop-in resumes it after a dive.
	if (
		override === '1' ||
		override === 'play' ||
		pendingDropIn ||
		(override !== '0' && walkIsEnabled())
	) {
		ensureWalkCompanion();
	}

	btns.forEach((btn) => {
		btn.addEventListener('click', () => {
			if (window.__walkCompanion) {
				window.__walkCompanion.toggle();
			} else {
				try {
					localStorage.setItem(WALK_ENABLED_KEY, '1');
				} catch (_) {}
				ensureWalkCompanion();
			}
			sync();
		});
	});

	window.addEventListener('walk-companion:change', sync);
}
