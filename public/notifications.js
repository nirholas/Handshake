// three.ws notifications / activity center — the per-user inbox behind the nav
// bell. Self-mounting: nav.js loads this after the shared nav is injected, so the
// bell button (#nav-notifications-btn) and its CSS (.notif-* in nav.css) already
// exist. This module owns the unread badge, the popover panel, read/unread state,
// mark-all-read and deep links.
//
// It reads the SAME per-user events the rest of the platform already produces
// into the user_notifications table (see api/_lib/feed.js publishUserEvent +
// USER_EVENT_TYPES) — payments earned, sales, purchases, referrals, withdrawals.
// Real events only; nothing is fabricated here. The site-wide FOMO ticker
// (public/feed.js) is a separate, public surface and is left untouched.
//
// Endpoints (cookie session, credentials required):
//   GET  /api/notifications?limit=20   → { notifications:[{id,type,payload,read_at,created_at}], unread_count }
//   POST /api/notifications/read-all    → mark every unread read
//   POST /api/notifications/:id/read    → mark one read

(function () {
	'use strict';

	if (window.__twsNotif) return; // idempotent — never double-mount
	if (typeof document === 'undefined') return;

	var btn = document.getElementById('nav-notifications-btn');
	var badge = btn && btn.querySelector('.nav-notif-badge');
	if (!btn || !badge) return; // nav variant without a bell — nothing to do

	var LIST_API = '/api/notifications?limit=20';
	// Notifications are less time-sensitive than the live ticker; a minute of
	// staleness is invisible and keeps the per-page poll cheap.
	var POLL_MS = 60000;

	// ── State ──────────────────────────────────────────────────────────────────
	var items = [];            // [{ id, type, payload, read_at, created_at }]
	var unread = 0;
	var open = false;
	var loaded = false;        // a successful fetch has populated `items`
	var errored = false;
	var signedOut = false;     // server returned 401 — show the sign-in prompt
	var pollTimer = null;
	var panel = null, body = null, markAllBtn = null;

	// The nav exposes a lightweight auth hint so we can avoid firing an
	// authenticated request (and a guaranteed 401) for visibly-anonymous users.
	function authHint() {
		try {
			var raw = localStorage.getItem('3dagent:auth-hint');
			if (!raw) return false;
			return !!JSON.parse(raw).authed;
		} catch (_) { return false; }
	}

	// ── Small DOM + formatting helpers (mirrors public/feed.js conventions) ─────
	function el(tag, cls, text) {
		var n = document.createElement(tag);
		if (cls) n.className = cls;
		if (text != null) n.textContent = text;
		return n;
	}
	function bold(t) {
		var b = document.createElement('b');
		b.textContent = t == null ? '' : String(t);
		return b;
	}
	function fillText(target, parts) {
		for (var i = 0; i < parts.length; i++) {
			var p = parts[i];
			if (p == null || p === '') continue;
			target.appendChild(typeof p === 'string' ? document.createTextNode(p) : p);
		}
	}
	function relTime(iso) {
		var t = typeof iso === 'number' ? iso : Date.parse(iso);
		if (!isFinite(t)) return '';
		var s = Math.max(0, Math.floor((Date.now() - t) / 1000));
		if (s < 10) return 'just now';
		if (s < 60) return s + 's ago';
		var m = Math.floor(s / 60);
		if (m < 60) return m + 'm ago';
		var h = Math.floor(m / 60);
		if (h < 24) return h + 'h ago';
		var d = Math.floor(h / 24);
		if (d < 7) return d + 'd ago';
		var w = Math.floor(d / 7);
		return w + 'w ago';
	}

	// Known payment mints → human label + decimals. We only ever NAME $three,
	// USDC and SOL; any other mint is rendered as a bare amount with no token
	// name (the platform never surfaces other tokens). Amounts arrive as atomic
	// (integer) strings.
	var MINTS = {
		'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump': { dec: 6, label: '$three' },
		'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': { dec: 6, label: 'USDC' },
		'So11111111111111111111111111111111111111112':  { dec: 9, label: 'SOL' },
	};
	function fmtAmount(atomic, mint) {
		if (atomic == null) return '';
		var n = Number(atomic);
		if (!isFinite(n) || n <= 0) return '';
		var meta = MINTS[mint];
		if (!meta) return ''; // unknown decimals → don't print a misleading number
		var v = n / Math.pow(10, meta.dec);
		var s = v >= 1 ? parseFloat(v.toFixed(2)).toString()
			: parseFloat(v.toFixed(4)).toString();
		return s + ' ' + meta.label;
	}

	function explorerFor(chain, sig) {
		if (!sig) return null;
		var c = String(chain || '').toLowerCase();
		if (c.indexOf('base') >= 0) return 'https://basescan.org/tx/' + sig;
		if (c.indexOf('polygon') >= 0) return 'https://polygonscan.com/tx/' + sig;
		return 'https://solscan.io/tx/' + sig; // default: Solana
	}

	function titleCase(s) {
		return String(s || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
	}

	// ── Per-type presentation. Returns { icon, parts, href }. parts is an array
	// of strings / <b> nodes built with textContent only (XSS-safe). ─────────────
	function describe(n) {
		var p = n.payload || {};
		var agentHref = p.agent_id ? '/agents/' + encodeURIComponent(p.agent_id) : '/dashboard';

		switch (n.type) {
			case 'payment_received': {
				var amt = fmtAmount(p.net_amount, p.currency_mint);
				return {
					icon: '$',
					href: p.link || agentHref,
					parts: [bold(p.agent_name || 'Your agent'), ' earned ', amt ? bold(amt) : 'a payment',
						p.skill ? ' for ' + p.skill : ''],
				};
			}
			case 'payment-earned': {
				var a2 = fmtAmount(p.amount, p.currency_mint);
				return {
					icon: '$',
					href: p.link || agentHref,
					parts: ['You earned ', a2 ? bold(a2) : 'a payment', p.actor ? [' from ', bold(p.actor)] : ''].flat(),
				};
			}
			case 'skill_purchased': {
				var net = fmtAmount(p.net_amount, p.currency_mint);
				return {
					icon: '$',
					href: p.link || agentHref,
					parts: ['Someone bought ', bold(p.skill || 'a skill'), net ? [' — you earned ', bold(net)] : ''].flat(),
				};
			}
			case 'skill_purchase_confirmed':
				return {
					icon: '✓',
					href: p.link || agentHref,
					parts: ['Your purchase of ', bold(p.skill || 'a skill'), ' is confirmed'],
				};
			case 'referral_earned': {
				var r = fmtAmount(p.amount, p.currency_mint);
				return {
					icon: '✦',
					href: p.link || '/dashboard',
					parts: ['You earned a referral reward', r ? [' of ', bold(r)] : ''].flat(),
				};
			}
			case 'asset_purchased': {
				var s = fmtAmount(p.amount, p.currency_mint);
				return {
					icon: '◆',
					href: p.link || '/marketplace',
					parts: ['Your ', p.item_type || 'item', ' sold', s ? [' for ', bold(s)] : ''].flat(),
				};
			}
			case 'asset_purchase_confirmed':
				return {
					icon: '✓',
					href: p.link || '/marketplace',
					parts: ['Your ', p.item_type || 'item', ' purchase is confirmed'],
				};
			case 'withdrawal_completed': {
				var w = fmtAmount(p.amount, p.currency_mint);
				return {
					icon: '↑',
					href: explorerFor(p.chain, p.tx_signature) || p.link || '/dashboard',
					parts: ['Withdrawal', w ? [' of ', bold(w)] : '', ' completed'].flat(),
				};
			}
			case 'withdrawal_failed':
				return {
					icon: '!',
					href: p.link || '/dashboard',
					parts: ['A withdrawal failed — your funds were returned'],
				};
			case 'skill_payment_mismatch':
			case 'asset_payment_mismatch':
				return {
					icon: '!',
					href: p.link || '/dashboard',
					parts: ['Payment amount mismatch on a sale — please review'],
				};
			case 'sale':
				return { icon: '$', href: p.link || '/dashboard', parts: ['You made a sale'] };
			case 'embed':
				return { icon: '⧉', href: p.link || agentHref, parts: ['Someone embedded your agent'] };
			case 'remix':
				return { icon: '↻', href: p.link || '/dashboard', parts: ['Someone remixed your creation'] };
			case 'reply':
				return { icon: '“', href: p.link || agentHref, parts: ['You have a new reply'] };
			case 'follow':
				return {
					icon: '+',
					href: p.link || (p.follower_username ? '/u/' + encodeURIComponent(p.follower_username) : '/feed'),
					parts: [bold(p.actor || 'Someone'), ' followed you'],
				};
			case 'agent_review': {
				var stars = p.rating ? ' ' + '★'.repeat(Math.max(1, Math.min(5, p.rating))) : '';
				return {
					icon: '★',
					href: p.link || agentHref,
					parts: [bold(p.actor || 'Someone'), ' reviewed ', bold(p.agent_name || 'your agent'), stars],
				};
			}
			default:
				return { icon: '•', href: p.link || '/dashboard', parts: [titleCase(n.type) || 'New notification'] };
		}
	}

	// ── Badge ────────────────────────────────────────────────────────────────
	function updateBadge() {
		if (unread > 0) {
			badge.hidden = false;
			badge.textContent = unread > 99 ? '99+' : String(unread);
			btn.setAttribute('aria-label', 'Notifications — ' + unread + ' unread');
		} else {
			badge.hidden = true;
			btn.setAttribute('aria-label', 'Notifications');
		}
	}

	// ── Panel build + open/close ───────────────────────────────────────────────
	function buildPanel() {
		panel = el('div', 'notif-panel');
		panel.setAttribute('role', 'dialog');
		panel.setAttribute('aria-label', 'Notifications');
		panel.hidden = true;

		var head = el('div', 'notif-panel-head');
		head.appendChild(el('span', 'notif-panel-title', 'Notifications'));
		markAllBtn = el('button', 'notif-mark-all', 'Mark all read');
		markAllBtn.type = 'button';
		markAllBtn.addEventListener('click', markAllRead);
		head.appendChild(markAllBtn);

		body = el('div', 'notif-panel-body');

		panel.appendChild(head);
		panel.appendChild(body);
		document.body.appendChild(panel);
	}

	function position() {
		if (!panel || panel.hidden) return;
		var r = btn.getBoundingClientRect();
		panel.style.top = Math.round(r.bottom + 8) + 'px';
		panel.style.right = Math.max(8, Math.round(window.innerWidth - r.right)) + 'px';
	}

	function openPanel() {
		if (!panel) buildPanel();
		open = true;
		panel.hidden = false;
		btn.setAttribute('aria-expanded', 'true');
		position();
		render();
		// Pull fresh data every time it's opened so the list is current.
		fetchList();
		document.addEventListener('keydown', onKeydown, true);
		document.addEventListener('click', onOutside, true);
		window.addEventListener('resize', position);
		window.addEventListener('scroll', position, true);
	}

	function closePanel() {
		open = false;
		if (panel) panel.hidden = true;
		btn.setAttribute('aria-expanded', 'false');
		document.removeEventListener('keydown', onKeydown, true);
		document.removeEventListener('click', onOutside, true);
		window.removeEventListener('resize', position);
		window.removeEventListener('scroll', position, true);
	}

	function toggle() { open ? closePanel() : openPanel(); }

	function onKeydown(e) {
		if (e.key === 'Escape') { closePanel(); btn.focus(); }
	}
	function onOutside(e) {
		if (!panel) return;
		if (panel.contains(e.target) || btn.contains(e.target)) return;
		closePanel();
	}

	// ── Render the panel body for the current state ────────────────────────────
	function render() {
		if (!body) return;
		body.textContent = '';
		markAllBtn.disabled = unread === 0;

		if (signedOut) {
			body.appendChild(stateBlock('✦', 'Sign in to see your activity',
				'Track payments, sales, and agent events in one place.',
				{ label: 'Sign in', href: '/login' }));
			return;
		}
		if (!loaded && !errored) { renderSkeleton(); return; }
		if (errored && !items.length) {
			// Refetches in place, a control, not a destination, so it's a button.
			var retry = el('button', 'notif-signin-btn', 'Try again');
			retry.type = 'button';
			retry.addEventListener('click', function () { fetchList(); });
			var blk = stateBlock('!', "Couldn't load notifications", 'Check your connection and try again.');
			blk.appendChild(retry);
			body.appendChild(blk);
			return;
		}
		if (!items.length) {
			body.appendChild(stateBlock('✓', "You're all caught up",
				'New activity — payments, sales, and agent events — shows up here.'));
			return;
		}
		for (var i = 0; i < items.length; i++) {
			var row = buildRow(items[i]);
			if (row) body.appendChild(row);
		}
	}

	function renderSkeleton() {
		for (var i = 0; i < 4; i++) {
			var li = el('div', 'notif-row');
			li.style.cursor = 'default';
			li.appendChild(el('span', 'notif-type-icon', '•'));
			var col = el('div', 'notif-row-body');
			var a = el('div', 'notif-row-msg'); a.style.opacity = '0.25';
			a.textContent = '————————';
			var b = el('div', 'notif-row-time'); b.style.opacity = '0.25';
			b.textContent = '———';
			col.appendChild(a); col.appendChild(b);
			li.appendChild(col);
			body.appendChild(li);
		}
	}

	function stateBlock(icon, title, sub, action) {
		var wrap = el('div', 'notif-empty');
		wrap.appendChild(el('div', 'notif-empty-icon', icon));
		wrap.appendChild(el('div', 'notif-empty-title', title));
		if (sub) wrap.appendChild(el('div', 'notif-empty-sub', sub));
		if (action) {
			var a = el('a', 'notif-signin-btn', action.label);
			a.href = action.href;
			wrap.appendChild(a);
		}
		return wrap;
	}

	function buildRow(n) {
		var d = describe(n);
		var isUnread = !n.read_at;
		var row = el('a', 'notif-row' + (isUnread ? ' is-unread' : ''));
		var external = /^https?:\/\//i.test(d.href || '');
		row.href = d.href || '#';
		if (external) { row.target = '_blank'; row.rel = 'noopener noreferrer'; }
		row.setAttribute('role', 'listitem');

		var ico = el('span', 'notif-type-icon');
		ico.setAttribute('aria-hidden', 'true');
		ico.textContent = d.icon;

		var col = el('div', 'notif-row-body');
		var msg = el('div', 'notif-row-msg');
		fillText(msg, d.parts);
		var time = el('div', 'notif-row-time', relTime(n.created_at));
		col.appendChild(msg);
		col.appendChild(time);

		row.appendChild(ico);
		row.appendChild(col);
		if (isUnread) row.appendChild(el('span', 'notif-unread-dot'));

		row.addEventListener('click', function () {
			// Mark read optimistically; keepalive lets the POST finish through the
			// navigation that follows for internal links.
			markOneRead(n);
		});
		return row;
	}

	// ── Data ───────────────────────────────────────────────────────────────────
	function applyData(data) {
		errored = false;
		signedOut = false;
		loaded = true;
		items = Array.isArray(data.notifications) ? data.notifications : [];
		unread = Number(data.unread_count) || 0;
		updateBadge();
		if (open) render();
		if (!pollTimer) startPolling(); // confirmed signed-in — keep the badge fresh
	}

	function fetchList() {
		fetch(LIST_API, { headers: { accept: 'application/json' }, credentials: 'include' })
			.then(function (r) {
				if (r.status === 401) { signedOut = true; loaded = true; unread = 0; updateBadge(); if (open) render(); stopPolling(); return null; }
				if (!r.ok) throw new Error('http ' + r.status);
				return r.json();
			})
			.then(function (data) { if (data) applyData(data); })
			.catch(function () {
				errored = true;
				if (!loaded && open) render();
			});
	}

	// Cookie-session mutations need the double-submit CSRF token: fetch a
	// single-use token from /api/csrf-token and echo it in x-csrf-token.
	// (Kept inline so this file stays a self-contained nav-injected script.)
	function csrfToken() {
		return fetch('/api/csrf-token', { credentials: 'include' })
			.then(function (r) { return r.ok ? r.json() : null; })
			.then(function (j) { return (j && j.data && j.data.token) || ''; })
			.catch(function () { return ''; });
	}

	function markOneRead(n) {
		if (n.read_at) return;
		n.read_at = new Date().toISOString();
		unread = Math.max(0, unread - 1);
		updateBadge();
		if (open) render();
		csrfToken().then(function (token) {
			return fetch('/api/notifications/' + encodeURIComponent(n.id) + '/read', {
				method: 'POST', credentials: 'include', keepalive: true,
				headers: { 'x-csrf-token': token },
			});
		}).catch(function () {});
	}

	function markAllRead() {
		if (!unread) return;
		for (var i = 0; i < items.length; i++) if (!items[i].read_at) items[i].read_at = new Date().toISOString();
		unread = 0;
		updateBadge();
		render();
		csrfToken().then(function (token) {
			return fetch('/api/notifications/read-all', {
				method: 'POST', credentials: 'include', keepalive: true,
				headers: { 'x-csrf-token': token },
			});
		}).catch(function () {});
	}

	// ── Polling (badge upkeep while signed in) ─────────────────────────────────
	function startPolling() {
		stopPolling();
		pollTimer = setInterval(function () { if (!document.hidden) fetchList(); }, POLL_MS);
	}
	function stopPolling() {
		if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
	}

	// ── Boot ───────────────────────────────────────────────────────────────────
	btn.addEventListener('click', toggle);
	document.addEventListener('visibilitychange', function () {
		if (!document.hidden && !signedOut) fetchList();
	});

	window.__twsNotif = {
		open: openPanel,
		close: closePanel,
		refresh: fetchList,
		unread: function () { return unread; },
	};

	// The cookie session is the source of truth: one fetch confirms it. On
	// success applyData() starts the badge poll; a 401 drops to the signed-out
	// state and leaves polling off.
	//
	// Without a hint the session still has to be verified (the hint goes missing
	// for real sessions after a storage clear), but asking the inbox directly
	// spends a request every anonymous visitor is guaranteed to lose, and the
	// browser logs the 401 in their console on every page of the site before any
	// handler here can run. /api/auth/me answers 200 with { user: null } for an
	// anonymous caller, so it settles the same question without the failure:
	// only a confirmed session goes on to load the inbox.
	if (authHint()) {
		fetchList();
	} else {
		signedOut = true;
		loaded = true;
		updateBadge();
		fetch('/api/auth/me', { headers: { accept: 'application/json' }, credentials: 'include' })
			.then(function (r) { return r.ok ? r.json() : null; })
			.then(function (data) { if (data && data.user) fetchList(); })
			.catch(function () {});
	}
})();
