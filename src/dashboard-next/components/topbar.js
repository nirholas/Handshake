// dashboard-next — topbar (breadcrumb + search + drawer toggle + user).
//
// The search button is the click-handle for the command palette (⌘K).
// The drawer toggle controls the right-hand activity rail.

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
			<button type="button" class="dn-topbar-btn" data-action="toggle-drawer" aria-label="Toggle activity drawer" aria-pressed="false">
				<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="3"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.2 3.2l1.4 1.4M11.4 11.4l1.4 1.4M3.2 12.8l1.4-1.4M11.4 4.6l1.4-1.4"/></svg>
			</button>
			<div class="dn-topbar-user" data-action="open-user-menu" data-component="topbar-user" aria-haspopup="true">
				<div class="dn-topbar-user-avatar" data-slot="initials">··</div>
				<span data-slot="label">Loading…</span>
			</div>
		</header>`;
}

/** Wire drawer toggle, palette opener, and fill the user chip. */
export function mountTopbarBehavior(shellEl) {
	// Restore drawer state. Default closed on first visit to avoid a heavy
	// first-paint while the activity feed mounts.
	const drawerOpen = (() => {
		try { return localStorage.getItem(DRAWER_KEY) === '1'; }
		catch { return false; }
	})();
	setDrawerOpen(shellEl, drawerOpen);

	shellEl.addEventListener('click', (e) => {
		const palette = e.target.closest?.('[data-action="open-palette"]');
		if (palette) {
			window.dispatchEvent(new CustomEvent('dn:palette:open'));
			return;
		}
		const drawer = e.target.closest?.('[data-action="toggle-drawer"]');
		if (drawer) {
			const next = shellEl.getAttribute('data-drawer-open') !== 'true';
			setDrawerOpen(shellEl, next);
			try { localStorage.setItem(DRAWER_KEY, next ? '1' : '0'); }
			catch { /* private mode — ignore */ }
			return;
		}
		const user = e.target.closest?.('[data-action="open-user-menu"]');
		if (user) {
			// Minimal: jump to account page. Could be a popover later.
			location.href = '/dashboard-next/account';
		}
	});

	// Keyboard: ⌘K / Ctrl+K opens palette globally.
	window.addEventListener('keydown', (e) => {
		if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
			e.preventDefault();
			window.dispatchEvent(new CustomEvent('dn:palette:open'));
		}
	});

	// Fill the user chip from /api/auth/me.
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
	}).catch(() => {
		/* network blip — chip stays "Loading…" rather than ever showing wrong identity */
	});
}

function setDrawerOpen(shellEl, open) {
	shellEl.setAttribute('data-drawer-open', open ? 'true' : 'false');
	const btn = shellEl.querySelector('[data-action="toggle-drawer"]');
	if (btn) btn.setAttribute('aria-pressed', open ? 'true' : 'false');
	window.dispatchEvent(new CustomEvent('dn:drawer:toggled', { detail: { open } }));
}
