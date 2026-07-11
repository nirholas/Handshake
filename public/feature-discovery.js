// three.ws in-product feature discovery — the layer that helps existing users
// find features they haven't met yet. Self-mounting: nav.js loads this on every
// page (like feed.js / glossary.js). It does four things, all over already-built
// features (it never changes the tools themselves):
//
//   1. "New" badges on links to genuinely-new features. The source of truth is
//      the nav's own `.nav-pill-sm` "New" markers — no second list to drift, no
//      invented ship dates. A badge auto-retires once the user visits that route
//      (recorded in localStorage) — so it is honestly "new to you", never permanent.
//   2. A dismissible "Have you tried…" prompt surfacing one under-used feature the
//      user hasn't visited. Dismissal persists per-feature; a dismissed prompt
//      never returns.
//   3. Contextual cross-links at natural moments: pages dispatch a
//      `tws:feature-done` event (e.g. after Forge finishes) and this renders a
//      "what's next?" card with the adjacent features ("embed it", "drop it in a
//      world") — every target a confirmed live route.
//   4. Plain-language tooltips, reusing C03's glossary popover primitive
//      (window.twsGlossary.attachTip) — no second tooltip primitive. Any element
//      with `data-tip="…"` gets one.
//
// State persists under the `threews:fd:*` localStorage namespace (matches the
// site convention: threews:checklist, threews:selfie-handoff, threews:tour:done).
// Opt out per page with <html data-discovery="off">.

(function () {
	'use strict';

	if (window.__twsDiscovery) return; // idempotent — never double-mount
	if (typeof document === 'undefined') return;
	if (document.documentElement.getAttribute('data-discovery') === 'off') return;

	// Pull in the shared corner-stack so the card flows with the other
	// bottom-right widgets instead of overlapping them. Idempotent; the stack
	// adopts our tagged orphan if it loads after us.
	function ensureCornerStack() {
		if (window.twsCornerStack) return;
		if (document.querySelector('script[src="/corner-stack.js"]')) return;
		var s = document.createElement('script');
		s.src = '/corner-stack.js';
		s.defer = true;
		(document.head || document.documentElement).appendChild(s);
	}

	// ── localStorage keys (threews:fd:* namespace) ─────────────────────────────
	var K_VISITED = 'threews:fd:visited';     // routes the user has opened (array)
	var K_TRIED   = 'threews:fd:tried';       // dismissed "have you tried" prompts (map)
	var REVEAL_DELAY_MS = 6500;               // let the page settle before suggesting

	// ── Feature catalog — friendly labels + plain-language copy (aligns C02). ──
	// Routes are confirmed live (vercel.json). This is descriptive metadata only;
	// it makes no "new" claim — that comes from the nav markers at runtime.
	var FEATURES = {
		'/forge':          { label: 'Forge',          desc: 'Turn a text prompt into a textured 3D model.' },
		'/create/prompt':  { label: 'Describe it to 3D', desc: 'Type a description → a rigged 3D avatar.' },
		'/scan':           { label: 'Scan',           desc: 'Turn a selfie into a rigged 3D avatar.' },
		'/studio':         { label: 'Studio',         desc: 'Customize your avatar and grab an embed for any site.' },
		'/scene':          { label: 'Scene Studio',   desc: 'Import GLBs, compose full 3D scenes, and export.' },
		'/play':           { label: 'Worlds',         desc: 'Drop into a live 3D world and hang out.' },
		'/walk':           { label: 'Walk',           desc: 'Walk your avatar across any page on the site.' },
		'/voice':          { label: 'Voice Lab',      desc: 'Clone a voice and give your agent speech.' },
		'/lipsync':        { label: 'Lipsync',        desc: "Sync spoken audio to your avatar's mouth." },
		'/agent-exchange': { label: 'Agent Exchange', desc: 'Watch agents pay each other for services on-chain.' },
		'/shopper':        { label: 'Shopper',        desc: 'Let an agent chain paid APIs to finish a task.' },
		'/club':           { label: 'Pole Club',      desc: 'Send performers tiny on-chain micro-tips.' },
		'/arbitrage':      { label: 'API Arbitrage',  desc: 'Spot price gaps across competing paid APIs.' },
		'/gmgn':           { label: 'GMGN Smart Money', desc: 'Track what smart-money wallets are buying.' },
		'/skills':         { label: 'Skills',         desc: 'Browse tool packs your agents can equip.' },
		'/brain':          { label: 'Brain',          desc: 'Compare one prompt across Claude, GPT and more.' },
		'/embed':          { label: 'Embed',          desc: 'Put your live agent on any website.' },
		'/embed.html':     { label: 'Embed Editor',   desc: 'Tune mode, size, and position — then copy the snippet.' },
		'/docs':           { label: 'Docs',            desc: 'SDKs, API reference, and integration guides.' },
		'/launchpad':      { label: 'Deploy Onchain',  desc: 'Build a white-label 3D token launchpad and go live onchain.' },
		'/marketplace':    { label: 'Marketplace',    desc: 'Buy, sell, and remix agents built by the community.' },
	};

	// Under-used "hidden gems" — the pool the passive prompt draws from first.
	var HIDDEN_GEMS = ['/forge', '/create/prompt', '/studio', '/embed.html', '/docs', '/launchpad', '/marketplace', '/lipsync', '/voice', '/brain', '/skills'];

	// Cross-links shown when a feature finishes (`tws:feature-done`). Every target
	// is a confirmed live route; the adjacent action is the natural next step.
	// When the dispatching page includes the finished model in the event detail
	// ({ model: { glbUrl, label }, avatarId }), each link deep-links it into the
	// destination so the session genuinely continues instead of starting blank:
	//   modelParam — query key the destination reads as a direct GLB URL
	//   nameParam  — query key for the model's display name (where supported)
	//   idParam    — query key the destination reads as a three.ws avatar id;
	//                wins over modelParam when an avatarId is present (a
	//                registered avatar carries name + thumbnail; a bare URL doesn't)
	// A link with none of these stays a plain route.
	var CROSSLINKS = {
		forge: { kicker: 'Nice model — what now?', links: [
			{ route: '/scene',    label: 'Open in Scene Studio', primary: true, modelParam: 'model', nameParam: 'name' },
			{ route: '/embed.html', label: 'Embed editor', modelParam: 'avatar' },
			{ route: '/launchpad', label: 'Deploy onchain', modelParam: 'avatar' },
			{ route: '/play',     label: 'Drop it in a world', modelParam: 'avatar' },
		] },
		segment: { kicker: 'Parts split — what now?', links: [
			{ route: '/scene',    label: 'Open in Scene Studio', primary: true, modelParam: 'model', nameParam: 'name' },
			{ route: '/forge',    label: 'Forge another model' },
			{ route: '/play',     label: 'Drop it in a world', modelParam: 'avatar' },
			{ route: '/docs',     label: 'Read the docs' },
		] },
		prompt: { kicker: 'Avatar ready — what now?', links: [
			{ route: '/studio',   label: 'Open Studio', primary: true, idParam: 'avatar', modelParam: 'model' },
			{ route: '/create-agent', label: 'Make it an agent' },
			{ route: '/walk',     label: 'Walk your avatar', idParam: 'avatar', modelParam: 'avatarUrl' },
			{ route: '/embed.html', label: 'Embed editor', idParam: 'avatar', modelParam: 'avatar' },
		] },
		scan: { kicker: 'Avatar ready — what now?', links: [
			{ route: '/studio',   label: 'Open Studio', primary: true, idParam: 'avatar', modelParam: 'model' },
			{ route: '/walk',     label: 'Walk your avatar', idParam: 'avatar', modelParam: 'avatarUrl' },
			{ route: '/embed.html', label: 'Embed editor', idParam: 'avatar', modelParam: 'avatar' },
			{ route: '/docs',     label: 'Read the docs' },
		] },
		studio: { kicker: 'Widget ready — share it?', links: [
			{ route: '/embed.html', label: 'Embed editor', primary: true },
			{ route: '/launchpad',  label: 'Deploy onchain' },
			{ route: '/docs',       label: 'Integration guide' },
		] },
		embed: { kicker: 'Embedded — what else?', links: [
			{ route: '/launchpad',  label: 'Deploy onchain', primary: true },
			{ route: '/marketplace', label: 'List on marketplace' },
			{ route: '/docs',       label: 'API reference' },
		] },
	};

	// "Explore more" destination: E01's Labs / hidden-gems hub (a confirmed live
	// route — vercel.json + pages/labs.html). This is the one place we hand the
	// user off to discover everything else.
	var EXPLORE_MORE = '/labs';

	// ── localStorage helpers (defensive: private mode / quota) ─────────────────
	function read(key, fallback) {
		try {
			var raw = localStorage.getItem(key);
			return raw == null ? fallback : JSON.parse(raw);
		} catch (_) { return fallback; }
	}
	function write(key, val) {
		try { localStorage.setItem(key, JSON.stringify(val)); } catch (_) {}
	}

	function normPath(href) {
		var p = String(href == null ? '' : href).split('#')[0].split('?')[0];
		if (p.indexOf('/') !== 0) return null; // external / relative — ignore
		p = p.replace(/\.html$/, '').replace(/\/+$/, '');
		return p || '/';
	}

	var CURRENT = normPath(location.pathname);

	function visitedSet() {
		var arr = read(K_VISITED, []);
		var set = Object.create(null);
		if (Array.isArray(arr)) for (var i = 0; i < arr.length; i++) set[arr[i]] = true;
		return set;
	}
	function recordVisit(route) {
		if (!route) return;
		var arr = read(K_VISITED, []);
		if (!Array.isArray(arr)) arr = [];
		if (arr.indexOf(route) === -1) {
			arr.push(route);
			if (arr.length > 200) arr = arr.slice(-200);
			write(K_VISITED, arr);
		}
	}
	function isTriedDismissed(route) {
		var m = read(K_TRIED, {});
		return !!(m && m[route]);
	}
	function markTriedDismissed(route) {
		var m = read(K_TRIED, {});
		if (!m || typeof m !== 'object') m = {};
		m[route] = true;
		write(K_TRIED, m);
	}

	// ── New-feature set — derived from the nav's own "New" pills ────────────────
	function navNewRoutes() {
		var set = Object.create(null);
		var nav = document.getElementById('nav-container');
		if (!nav) return null; // nav not present/loaded
		var anchors = nav.querySelectorAll('a[href]');
		if (!anchors.length) return null; // injected but empty — not ready yet
		for (var i = 0; i < anchors.length; i++) {
			var pill = anchors[i].querySelector('.nav-pill-sm');
			if (pill && /new/i.test(pill.textContent || '')) {
				var r = normPath(anchors[i].getAttribute('href'));
				if (r) set[r] = true;
			}
		}
		return set;
	}

	// ── "New" badges on in-page links to new features ──────────────────────────
	// Not every page loads style.css (home, create, launches… carry their own
	// inline design systems), so this layer loads its own stylesheet for the
	// badge + card. The <link> is PREPENDED to <head> so style.css — which
	// carries an identical copy of these rules — and page styles win the cascade.
	function ensureStyles() {
		if (document.getElementById('tws-disc-css')) return;
		var l = document.createElement('link');
		l.id = 'tws-disc-css';
		l.rel = 'stylesheet';
		l.href = '/feature-discovery.css';
		document.head.insertBefore(l, document.head.firstChild);
	}

	function decorateNewBadges(newSet) {
		ensureStyles();
		var visited = visitedSet();
		var anchors = document.querySelectorAll('a[href]');
		for (var i = 0; i < anchors.length; i++) {
			var a = anchors[i];
			if (a.closest('#nav-container')) continue;            // nav owns its own pills
			if (a.querySelector('.tws-disc-new')) continue;        // already badged
			if (a.querySelector('.nav-pill-sm, .pill--new')) continue; // existing badge
			var route = normPath(a.getAttribute('href'));
			if (!route || !newSet[route]) continue;                // only genuinely-new
			if (route === CURRENT) continue;                       // don't badge self
			if (visited[route]) continue;                          // auto-retire: seen
			var badge = document.createElement('span');
			badge.className = 'tws-disc-new';
			badge.textContent = 'New';
			a.appendChild(badge);
		}
	}

	// Plain-language tooltips on genuinely cryptic, under-used controls that live
	// in the shared nav, reusing C03's popover. Idempotent (attachTip guards).
	var NAV_CONTROL_TIPS = [
		['#home-nav-walk', 'Walk Companion', 'Drop a 3D avatar onto the page and walk it around the whole site.'],
	];
	function decorateNavControlTips() {
		if (!window.twsGlossary || !window.twsGlossary.attachTip) return;
		for (var i = 0; i < NAV_CONTROL_TIPS.length; i++) {
			var sel = NAV_CONTROL_TIPS[i][0];
			var label = NAV_CONTROL_TIPS[i][1];
			var text = NAV_CONTROL_TIPS[i][2];
			var ctrl = document.querySelector(sel);
			if (ctrl) window.twsGlossary.attachTip(ctrl, text, { label: label, plain: true });
		}
	}

	// ── Discovery card (shared by passive prompt + contextual cross-links) ─────
	var _card = null;

	function el(tag, cls, text) {
		var n = document.createElement(tag);
		if (cls) n.className = cls;
		if (text != null) n.textContent = text;
		return n;
	}

	var _escHandler = null;

	function dismissCard() {
		if (!_card) return;
		if (_escHandler) { document.removeEventListener('keydown', _escHandler); _escHandler = null; }
		var c = _card;
		if (c._fdKill) { clearTimeout(c._fdKill); c._fdKill = null; }
		_card = null;
		c.classList.remove('is-in');
		var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		var done = function () { if (c.parentNode) c.parentNode.removeChild(c); };
		if (reduced) { done(); } else { setTimeout(done, 240); }
	}

	// spec: { kicker, title, desc, links:[{href,label,primary}], onDismiss }
	function renderCard(spec) {
		ensureStyles();
		dismissCard();
		var card = el('div', 'tws-disc-card');
		card.setAttribute('role', 'status');
		card.setAttribute('aria-live', 'polite');

		var dismiss = function () { if (spec.onDismiss) spec.onDismiss(); dismissCard(); };

		var close = el('button', 'tws-disc-x');
		close.type = 'button';
		close.setAttribute('aria-label', 'Dismiss suggestion');
		close.innerHTML = '&#x2715;';
		close.addEventListener('click', dismiss);
		card.appendChild(close);

		card.appendChild(el('div', 'tws-disc-kicker', spec.kicker));
		if (spec.title) card.appendChild(el('div', 'tws-disc-title', spec.title));
		if (spec.desc) card.appendChild(el('div', 'tws-disc-desc', spec.desc));

		var actions = el('div', 'tws-disc-actions');
		(spec.links || []).forEach(function (lnk) {
			var a = el('a', 'tws-disc-cta' + (lnk.primary ? ' tws-disc-cta--primary' : ''), lnk.label);
			a.href = lnk.href;
			actions.appendChild(a);
		});
		card.appendChild(actions);

		// Escape dismisses the card from anywhere on the page (not only when focus
		// is already inside it), so a keyboard user can clear it immediately.
		_escHandler = function (e) { if (e.key === 'Escape') dismiss(); };
		document.addEventListener('keydown', _escHandler);

		// Flow into the shared corner-stack so the prompt stacks above the other
		// bottom-right cards instead of landing on the same pixel. Falls back to a
		// plain body mount; the data-corner-priority tag lets it be adopted later.
		ensureCornerStack();
		card.setAttribute('data-corner-priority', '10');
		if (window.twsCornerStack) window.twsCornerStack.mount(card);
		else document.body.appendChild(card);
		_card = card;
		// Reveal on next frame so the CSS transition runs.
		requestAnimationFrame(function () { requestAnimationFrame(function () { card.classList.add('is-in'); }); });

		// Auto-retract: a passive suggestion shouldn't sit pinned over the page's
		// content until manually closed (on mobile it's a full-width bottom bar).
		// After a reveal window it gracefully dismisses itself — paused while the
		// pointer is over it or keyboard focus is inside, so it never vanishes
		// mid-read or mid-interaction. Contextual cards omit autoDismissMs and stay.
		if (spec.autoDismissMs) {
			var arm = function () {
				clearTimeout(card._fdKill);
				card._fdKill = setTimeout(function () { if (_card === card) dismissCard(); }, spec.autoDismissMs);
			};
			var disarm = function () { clearTimeout(card._fdKill); card._fdKill = null; };
			card.addEventListener('pointerenter', disarm);
			card.addEventListener('pointerleave', arm);
			card.addEventListener('focusin', disarm);
			card.addEventListener('focusout', function () {
				setTimeout(function () { if (_card === card && !card.contains(document.activeElement)) arm(); }, 0);
			});
			arm();
		}
		return card;
	}

	// ── Passive "Have you tried…" prompt ───────────────────────────────────────
	function pickSuggestion() {
		var visited = visitedSet();
		for (var i = 0; i < HIDDEN_GEMS.length; i++) {
			var r = HIDDEN_GEMS[i];
			if (r === CURRENT) continue;
			if (visited[r]) continue;
			if (isTriedDismissed(r)) continue;
			if (!FEATURES[r]) continue;
			return r;
		}
		return null;
	}

	// One passive suggestion per browser session — discoverable without nagging
	// on every page load. Per-feature dismissal (threews:fd:tried) is the durable,
	// cross-session signal; this is the within-session throttle.
	var SESSION_PROMPTED = 'threews:fd:prompted';
	function alreadyPromptedThisSession() {
		try { return sessionStorage.getItem(SESSION_PROMPTED) === '1'; } catch (_) { return false; }
	}
	function markPromptedThisSession() {
		try { sessionStorage.setItem(SESSION_PROMPTED, '1'); } catch (_) {}
	}

	function showPassivePrompt() {
		if (_card) return; // a contextual card already took the slot
		if (alreadyPromptedThisSession()) return;
		// When the companion agent is live it owns ambient discovery (it greets,
		// narrates, and reacts to ⌘K commands) — don't stack a competing toast in
		// the same corner. Contextual after-action cross-links still show.
		try { if (localStorage.getItem('walk:companion:enabled') === '1') return; } catch (_) {}
		var route = pickSuggestion();
		if (!route) return;
		var f = FEATURES[route];
		markPromptedThisSession();
		renderCard({
			kicker: 'Have you tried…',
			title: f.label,
			desc: f.desc,
			links: [{ href: route, label: 'Try it', primary: true }],
			onDismiss: function () { markTriedDismissed(route); },
			// Retract after a reveal window so it never lingers over content. A
			// timeout is not a rejection, so it does NOT mark the feature tried —
			// the session throttle already prevents re-prompting until next visit.
			autoDismissMs: 13000,
		});
	}

	// ── Contextual cross-links after a feature completes ───────────────────────
	// detail (optional): the tws:feature-done event detail — { model: { glbUrl,
	// label }, avatarId }. Each link's idParam/modelParam/nameParam (see the
	// CROSSLINKS comment) turns it into a deep link that opens the destination
	// with this exact model already loaded.
	function showCrossLinks(feature, detail) {
		var cfg = CROSSLINKS[feature];
		if (!cfg) return;
		var model = detail && detail.model;
		var glbUrl = model && typeof model.glbUrl === 'string' ? model.glbUrl : '';
		var avatarId = detail && detail.avatarId ? String(detail.avatarId) : '';
		var carried = false;
		var links = cfg.links
			.filter(function (l) { return FEATURES[l.route]; })
			.map(function (l) {
				var href = l.route;
				if (l.idParam && avatarId) {
					href += '?' + l.idParam + '=' + encodeURIComponent(avatarId);
					carried = true;
				} else if (l.modelParam && glbUrl) {
					href += '?' + l.modelParam + '=' + encodeURIComponent(glbUrl);
					if (l.nameParam && model.label) {
						href += '&' + l.nameParam + '=' + encodeURIComponent(String(model.label).slice(0, 120));
					}
					carried = true;
				}
				return { href: href, label: l.label, primary: l.primary };
			});
		links.push({ href: EXPLORE_MORE, label: 'Explore more' });
		renderCard({
			kicker: cfg.kicker,
			desc: carried ? 'Each tool opens with this model already loaded.' : null,
			links: links,
		});
	}

	// ── Declarative tooltips: any [data-tip] element (reuses C03 popover) ───────
	function wireDataTips() {
		if (!window.twsGlossary || !window.twsGlossary.attachTip) return;
		var els = document.querySelectorAll('[data-tip]');
		for (var i = 0; i < els.length; i++) {
			window.twsGlossary.attachTip(els[i], els[i].getAttribute('data-tip'), {
				label: els[i].getAttribute('data-tip-label') || '',
			});
		}
	}

	// ── Init ───────────────────────────────────────────────────────────────────
	var _revealTimer = null;
	var _navDone = false;

	function onNavReady(newSet) {
		if (_navDone) return;
		_navDone = true;
		decorateNewBadges(newSet);
		decorateNavControlTips();
	}

	function runBadgePass() {
		if (_navDone) return;
		var nav = navNewRoutes();
		if (nav !== null) { onNavReady(nav); return; }

		// Nav not ready yet — observe #nav-container until it populates, else
		// fall back to hidden-gems as the "new" set so badges still work.
		var container = document.getElementById('nav-container');
		if (container && window.MutationObserver) {
			var obs = new MutationObserver(function () {
				var ready = navNewRoutes();
				if (ready !== null) { obs.disconnect(); onNavReady(ready); }
			});
			obs.observe(container, { childList: true, subtree: true });
			return;
		}
		var fallback = Object.create(null);
		HIDDEN_GEMS.forEach(function (r) { fallback[r] = true; });
		onNavReady(fallback);
	}

	function init() {
		recordVisit(CURRENT);
		wireDataTips();
		runBadgePass();

		// A completing feature pre-empts the passive prompt with a contextual one.
		document.addEventListener('tws:feature-done', function (e) {
			var feature = e && e.detail && e.detail.feature;
			if (!feature) return;
			if (_revealTimer) { clearTimeout(_revealTimer); _revealTimer = null; }
			showCrossLinks(feature, e.detail);
		});

		_revealTimer = setTimeout(showPassivePrompt, REVEAL_DELAY_MS);
	}

	// ── Public API ─────────────────────────────────────────────────────────────
	// crossLink(feature, detail?) lets a page trigger the "what's next" card
	// directly, equivalent to dispatching tws:feature-done — detail may carry
	// { model: { glbUrl, label }, avatarId } to deep-link the model into targets.
	window.twsDiscovery = {
		crossLink: showCrossLinks,
		dismiss: dismissCard,
		recordVisit: recordVisit,
	};
	window.__twsDiscovery = true;

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}
})();
