// dashboard-next — topbar (breadcrumb + search + notifications + user menu).
//
// The search button is the click-handle for the command palette (⌘K).
// The drawer toggle controls the right-hand activity rail.
// The notification bell shows unread count and opens a dropdown.
// The user chip opens a popover with wallet address, email, quick links.

import { currentRoute } from '../nav.js';
import { esc, getMe, initialsOf } from '../api.js';

const DRAWER_KEY = 'dn:drawer:open';

export function renderTopbar(pathname) {
	const here = currentRoute(pathname);
	const crumb = here?.label || 'Dashboard';
	return `
		<header class="dn-topbar" data-component="topbar">
			<div class="dn-topbar-crumb">
				<span>Dashboard</span>
				<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M4 2l4 4-4 4"/></svg>
				<strong>${esc(crumb)}</strong>
			</div>
			<div class="dn-topbar-spacer"></div>
			<button type="button" class="dn-topbar-search" data-action="open-palette" aria-label="Open command palette">
				<span style="display:inline-flex;align-items:center;gap:8px">
					<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="4.5"/><path d="M13 13l-2.6-2.6"/></svg>
					Search or jump to…
				</span>
				<kbd>⌘K</kbd>
			</button>
			<button type="button" class="dn-topbar-btn" data-action="toggle-notifs" aria-label="Notifications" style="position:relative">
				<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2a6 6 0 016 6v3l1.5 2.5H2.5L4 11V8a6 6 0 016-6z"/><path d="M8 17a2 2 0 004 0"/></svg>
				<span data-slot="notif-badge" style="
					display:none;position:absolute;top:2px;right:2px;
					min-width:16px;height:16px;border-radius:8px;padding:0 4px;
					background:var(--nxt-danger,#e55);color:#fff;
					font-size:10px;font-weight:700;line-height:16px;text-align:center;
				"></span>
			</button>
			<button type="button" class="dn-topbar-btn" data-action="toggle-drawer" aria-label="Toggle activity drawer" aria-pressed="false">
				<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="3"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.2 3.2l1.4 1.4M11.4 11.4l1.4 1.4M3.2 12.8l1.4-1.4M11.4 4.6l1.4-1.4"/></svg>
			</button>
			<button type="button" class="dn-topbar-btn" data-action="back-to-classic" aria-label="Return to classic dashboard" title="Return to classic dashboard" style="font-size:11px;font-weight:600;opacity:0.7">
				↶ Classic
			</button>
			<div class="dn-topbar-user" data-action="toggle-user-menu" data-component="topbar-user" aria-haspopup="true">
				<div class="dn-topbar-user-avatar" data-slot="initials">··</div>
				<span data-slot="label">Loading…</span>
				<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2 4l4 4 4-4"/></svg>
			</div>
		</header>`;
}

/** Wire drawer toggle, palette opener, notifications, and user menu. */
export function mountTopbarBehavior(shellEl) {
	const drawerOpen = (() => {
		try { return localStorage.getItem(DRAWER_KEY) === '1'; }
		catch { return false; }
	})();
	setDrawerOpen(shellEl, drawerOpen);

	shellEl.addEventListener('click', (e) => {
		if (e.target.closest?.('[data-action="open-palette"]')) {
			window.dispatchEvent(new CustomEvent('dn:palette:open'));
			return;
		}
		if (e.target.closest?.('[data-action="toggle-drawer"]')) {
			const next = shellEl.getAttribute('data-drawer-open') !== 'true';
			setDrawerOpen(shellEl, next);
			try { localStorage.setItem(DRAWER_KEY, next ? '1' : '0'); }
			catch { /* private mode */ }
			return;
		}
		if (e.target.closest?.('[data-action="back-to-classic"]')) {
			localStorage.removeItem('dashboard-version');
			const path = location.pathname.replace(/^\/dashboard/, '/dashboard-classic');
			location.href = path || '/dashboard-classic';
			return;
		}
		if (e.target.closest?.('[data-action="toggle-notifs"]')) {
			const btn = e.target.closest('[data-action="toggle-notifs"]');
			toggleNotifsDropdown(btn);
			return;
		}
		if (e.target.closest?.('[data-action="toggle-user-menu"]')) {
			const chip = e.target.closest('[data-action="toggle-user-menu"]');
			toggleUserMenu(chip);
			return;
		}
	});

	window.addEventListener('keydown', (e) => {
		if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
			e.preventDefault();
			window.dispatchEvent(new CustomEvent('dn:palette:open'));
		}
	});

	// Fill the user chip and load notification count from /api/auth/me.
	getMe().then((me) => {
		const chip = shellEl.querySelector('[data-component="topbar-user"]');
		if (!chip) return;
		if (!me) {
			chip.querySelector('[data-slot="label"]').textContent = 'Sign in';
			chip.querySelector('[data-slot="initials"]').textContent = '?';
			chip.dataset.action = 'sign-in';
			chip.onclick = () => {
				const ret = encodeURIComponent(location.pathname + location.search);
				location.href = `/login?return=${ret}`;
			};
			return;
		}
		chip.querySelector('[data-slot="initials"]').textContent = initialsOf(me);
		const label = me.display_name || me.handle || me.email || 'Account';
		chip.querySelector('[data-slot="label"]').textContent = String(label).slice(0, 18);
		chip.dataset.me = JSON.stringify({
			display_name: me.display_name,
			handle: me.handle,
			email: me.email,
			wallet: me.wallet_address || me.solana_address || '',
			plan: me.plan || 'free',
		});
	}).catch(() => { /* network blip — chip stays "Loading…" */ });

	// Load unread notification count in background.
	fetch('/api/notifications?limit=1', { credentials: 'include' })
		.then((r) => r.ok ? r.json() : null)
		.then((data) => {
			const unread = data?.unread ?? 0;
			const badge = shellEl.querySelector('[data-slot="notif-badge"]');
			if (!badge) return;
			if (unread > 0) {
				badge.style.display = 'block';
				badge.textContent = unread > 9 ? '9+' : String(unread);
			}
		})
		.catch(() => { /* notifications unavailable */ });
}

function setDrawerOpen(shellEl, open) {
	shellEl.setAttribute('data-drawer-open', open ? 'true' : 'false');
	const btn = shellEl.querySelector('[data-action="toggle-drawer"]');
	if (btn) btn.setAttribute('aria-pressed', open ? 'true' : 'false');
	window.dispatchEvent(new CustomEvent('dn:drawer:toggled', { detail: { open } }));
}

// ── Notifications dropdown ─────────────────────────────────────────────────

function toggleNotifsDropdown(btn) {
	const existing = document.querySelector('[data-topbar-notifs]');
	if (existing) { existing.remove(); return; }

	const rect = btn.getBoundingClientRect();
	const drop = document.createElement('div');
	drop.setAttribute('data-topbar-notifs', '');
	drop.style.cssText = `
		position:fixed;top:${rect.bottom + 8}px;right:${window.innerWidth - rect.right}px;
		width:320px;max-height:420px;overflow-y:auto;
		background:rgba(18,20,28,0.97);border:1px solid var(--nxt-stroke-strong);
		border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,0.6);
		backdrop-filter:blur(20px);z-index:2000;
	`;
	drop.innerHTML = `
		<div style="padding:12px 16px;border-bottom:1px solid var(--nxt-stroke);display:flex;align-items:center;justify-content:space-between">
			<span style="font-size:13.5px;font-weight:600">Notifications</span>
			<a href="/dashboard/settings" style="font-size:12px;color:var(--nxt-accent)">Settings →</a>
		</div>
		<div data-slot="notif-items" style="padding:8px 0">
			<div style="padding:14px 16px;color:var(--nxt-ink-dim);font-size:13px">Loading…</div>
		</div>
	`;
	document.body.appendChild(drop);

	const closeOnOutside = (e) => {
		if (!drop.contains(e.target) && e.target !== btn) {
			drop.remove();
			document.removeEventListener('click', closeOnOutside, true);
		}
	};
	setTimeout(() => document.addEventListener('click', closeOnOutside, true), 0);

	fetch('/api/notifications?limit=10', { credentials: 'include' })
		.then((r) => r.ok ? r.json() : null)
		.then((data) => {
			const items = data?.notifications || [];
			const host = drop.querySelector('[data-slot="notif-items"]');
			if (!items.length) {
				host.innerHTML = `<div style="padding:24px 16px;text-align:center;color:var(--nxt-ink-dim);font-size:13px">No notifications</div>`;
				return;
			}
			host.innerHTML = items.map((n) => `
				<div style="padding:10px 16px;border-bottom:1px solid var(--nxt-stroke);opacity:${n.read_at ? '0.6' : '1'}">
					<div style="font-size:13px;font-weight:${n.read_at ? '400' : '500'};color:var(--nxt-ink)">${esc(n.title || n.message || 'Notification')}</div>
					${n.body ? `<div style="font-size:12px;color:var(--nxt-ink-dim);margin-top:2px">${esc(n.body.slice(0, 100))}</div>` : ''}
					<div style="font-size:11.5px;color:var(--nxt-ink-fade);margin-top:3px">${n.created_at ? timeAgo(n.created_at) : ''}</div>
				</div>
			`).join('');
		})
		.catch(() => {
			const host = drop.querySelector('[data-slot="notif-items"]');
			host.innerHTML = `<div style="padding:14px 16px;color:var(--nxt-ink-dim);font-size:13px">Couldn't load notifications.</div>`;
		});
}

// ── User menu popover ──────────────────────────────────────────────────────

function toggleUserMenu(chip) {
	const existing = document.querySelector('[data-topbar-user-menu]');
	if (existing) { existing.remove(); return; }

	const rect = chip.getBoundingClientRect();
	const rawMe = chip.dataset.me ? JSON.parse(chip.dataset.me) : {};

	const menu = document.createElement('div');
	menu.setAttribute('data-topbar-user-menu', '');
	menu.style.cssText = `
		position:fixed;top:${rect.bottom + 8}px;right:${window.innerWidth - rect.right}px;
		min-width:240px;
		background:rgba(18,20,28,0.97);border:1px solid var(--nxt-stroke-strong);
		border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,0.6);
		backdrop-filter:blur(20px);z-index:2000;overflow:hidden;
	`;

	const wallet = rawMe.wallet || '';
	const email = rawMe.email || '';
	const name = rawMe.display_name || rawMe.handle || email || 'Account';
	const plan = rawMe.plan || 'free';

	menu.innerHTML = `
		<div style="padding:14px 16px;border-bottom:1px solid var(--nxt-stroke)">
			<div style="font-size:14px;font-weight:600;color:var(--nxt-ink);margin-bottom:2px">${esc(name)}</div>
			${email ? `<div style="font-size:12px;color:var(--nxt-ink-dim)">${esc(email)}</div>` : ''}
			${wallet ? `<div style="font-family:'JetBrains Mono',monospace;font-size:11.5px;color:var(--nxt-ink-fade);margin-top:3px">${esc(wallet.slice(0, 8))}…${esc(wallet.slice(-6))}</div>` : ''}
			<div style="margin-top:6px"><span class="dn-tag" style="font-size:11px;text-transform:capitalize">${esc(plan)}</span></div>
		</div>
		<div style="padding:6px 0">
			<a href="/dashboard/portfolio" class="dn-user-menu-item">Portfolio & NFTs</a>
			<a href="/dashboard/account" class="dn-user-menu-item">Account</a>
			<a href="/dashboard/settings" class="dn-user-menu-item">Settings</a>
			${wallet ? `<button class="dn-user-menu-item" data-action="copy-wallet" style="width:100%;text-align:left;background:none;border:none;cursor:pointer;color:inherit">Copy wallet address</button>` : ''}
			${email ? `<button class="dn-user-menu-item" data-action="copy-email" style="width:100%;text-align:left;background:none;border:none;cursor:pointer;color:inherit">Copy email</button>` : ''}
		</div>
		<div style="padding:6px 0;border-top:1px solid var(--nxt-stroke)">
			<button class="dn-user-menu-item danger" data-action="sign-out" style="width:100%;text-align:left;background:none;border:none;cursor:pointer">Sign out</button>
		</div>
	`;

	injectMenuStyles();
	document.body.appendChild(menu);

	menu.querySelector('[data-action="copy-wallet"]')?.addEventListener('click', async () => {
		try { await navigator.clipboard.writeText(wallet); } catch { /* ignore */ }
		menu.remove();
	});
	menu.querySelector('[data-action="copy-email"]')?.addEventListener('click', async () => {
		try { await navigator.clipboard.writeText(email); } catch { /* ignore */ }
		menu.remove();
	});
	menu.querySelector('[data-action="sign-out"]')?.addEventListener('click', async () => {
		menu.remove();
		try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }); }
		catch { /* best effort */ }
		location.href = '/';
	});

	const closeOnOutside = (e) => {
		if (!menu.contains(e.target) && !chip.contains(e.target)) {
			menu.remove();
			document.removeEventListener('click', closeOnOutside, true);
		}
	};
	setTimeout(() => document.addEventListener('click', closeOnOutside, true), 0);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function timeAgo(iso) {
	const diff = Date.now() - new Date(iso).getTime();
	const m = Math.floor(diff / 60_000);
	if (m < 1) return 'just now';
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	return `${Math.floor(h / 24)}d ago`;
}

let _menuStylesInjected = false;
function injectMenuStyles() {
	if (_menuStylesInjected) return;
	_menuStylesInjected = true;
	const style = document.createElement('style');
	style.textContent = `
		.dn-user-menu-item {
			display:block;padding:9px 16px;font-size:13px;color:var(--nxt-ink);
			text-decoration:none;transition:background 0.12s;font-family:inherit;
		}
		.dn-user-menu-item:hover { background:rgba(255,255,255,0.06); }
		.dn-user-menu-item.danger { color:var(--nxt-danger,#e55); }
	`;
	document.head.appendChild(style);
}
