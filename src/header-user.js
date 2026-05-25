// Shared avatar + dropdown for the authenticated header.
//
// Replaces the long "wallet-0x…@wallet.local" pill with a compact avatar
// button. Clicking it opens a menu with the user's identity and quick
// actions (View profile, Settings, Sign out).
//
// Usage:
//   <div id="header-user-slot"></div>
//   <script type="module">
//     import { mountHeaderUser } from '/src/header-user.js';
//     mountHeaderUser({ slot: '#header-user-slot' }).then(({ user }) => { ... });
//   </script>
//
// If a `user` object is already available, pass it in to skip the fetch:
//   mountHeaderUser({ slot: '#header-user-slot', user });

import { resetIdentity } from './analytics.js';

let stylesInjected = false;

function injectStyles() {
	if (stylesInjected) return;
	stylesInjected = true;
	const css = `
.hu-root { position: relative; display: inline-flex; }
.hu-avatar {
	width: 32px; height: 32px; border-radius: 50%;
	background: linear-gradient(135deg, #6a5cff 0%, #9a8cff 100%);
	color: #fff; font-size: 13px; font-weight: 600; letter-spacing: 0.02em;
	border: 1px solid rgba(255,255,255,0.08);
	display: inline-flex; align-items: center; justify-content: center;
	cursor: pointer; padding: 0; line-height: 1;
	transition: transform 0.12s ease, box-shadow 0.15s ease;
	font-family: inherit;
}
.hu-avatar:hover { box-shadow: 0 0 0 3px rgba(106,92,255,0.18); }
.hu-avatar:focus-visible { outline: 2px solid #9a8cff; outline-offset: 2px; }
.hu-avatar[aria-expanded="true"] { box-shadow: 0 0 0 3px rgba(106,92,255,0.28); }
.hu-avatar svg { width: 16px; height: 16px; display: block; }

.hu-menu {
	position: absolute; top: calc(100% + 8px); right: 0;
	min-width: 260px;
	background: #14141d;
	border: 1px solid #2a2a36;
	border-radius: 12px;
	box-shadow: 0 12px 32px rgba(0,0,0,0.5);
	padding: 8px;
	z-index: 1000;
	opacity: 0; transform: translateY(-4px); pointer-events: none;
	transition: opacity 0.12s ease, transform 0.12s ease;
}
.hu-menu[data-open="true"] { opacity: 1; transform: translateY(0); pointer-events: auto; }

.hu-identity {
	display: flex; align-items: center; gap: 10px;
	padding: 10px 10px 12px;
	border-bottom: 1px solid #23232f;
	margin-bottom: 6px;
}
.hu-identity-avatar {
	width: 36px; height: 36px; border-radius: 50%;
	background: linear-gradient(135deg, #6a5cff 0%, #9a8cff 100%);
	color: #fff; font-size: 14px; font-weight: 600;
	display: inline-flex; align-items: center; justify-content: center;
	flex-shrink: 0;
}
.hu-identity-text { min-width: 0; flex: 1; }
.hu-identity-name {
	color: #eee; font-size: 13px; font-weight: 600;
	white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.hu-identity-sub {
	color: #888; font-size: 12px; margin-top: 2px;
	white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
	font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.hu-item {
	display: flex; align-items: center; gap: 10px;
	padding: 9px 10px;
	color: #ccc; font-size: 13px;
	border-radius: 8px;
	text-decoration: none; cursor: pointer;
	background: transparent; border: 0; width: 100%; text-align: left;
	font-family: inherit;
}
.hu-item:hover { background: rgba(255,255,255,0.04); color: #fff; }
.hu-item svg { width: 15px; height: 15px; flex-shrink: 0; opacity: 0.75; }
.hu-item.danger { color: #ff9c9c; }
.hu-item.danger:hover { background: rgba(255,80,80,0.08); color: #ffb3b3; }

.hu-divider { height: 1px; background: #23232f; margin: 6px 4px; }
.hu-copy-flash { color: #9a8cff !important; }
`;
	const style = document.createElement('style');
	style.setAttribute('data-header-user', '');
	style.textContent = css;
	document.head.appendChild(style);
}

function isWalletEmail(email) {
	return typeof email === 'string' && /^wallet-0x[0-9a-f]{40}@wallet\.local$/i.test(email);
}

function shortAddr(addr) {
	if (!addr || typeof addr !== 'string') return '';
	if (addr.length <= 12) return addr;
	return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function deriveIdentity(user) {
	const walletAddr = user?.wallet_address || (isWalletEmail(user?.email) ? user.email.slice(7, 49) : null);
	const displayName = user?.display_name || user?.username || null;
	const hasRealEmail = user?.email && !isWalletEmail(user.email);

	let primary;
	if (displayName) primary = displayName;
	else if (hasRealEmail) primary = user.email;
	else if (walletAddr) primary = shortAddr(walletAddr);
	else primary = 'Account';

	let secondary = '';
	if (walletAddr) secondary = shortAddr(walletAddr);
	else if (hasRealEmail && displayName) secondary = user.email;

	const initial = (displayName || (hasRealEmail ? user.email : '') || 'A').trim().charAt(0).toUpperCase();
	return { primary, secondary, initial, walletAddr, hasRealEmail };
}

const WALLET_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/><circle cx="16.5" cy="14.5" r="1.2" fill="currentColor" stroke="none"/></svg>';
const USER_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
const SETTINGS_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
const WALLETS_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12V7a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h16v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7"/><circle cx="17" cy="13" r="1" fill="currentColor" stroke="none"/></svg>';
const PORTFOLIO_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l5-5 4 4 8-8"/><polyline points="14 8 20 8 20 14"/></svg>';
const COPY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const DASHBOARD_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/></svg>';
const SIGNOUT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>';

async function fetchUser() {
	const res = await fetch('/api/auth/me', { credentials: 'include' });
	if (!res.ok) return null;
	const data = await res.json();
	return data?.user || null;
}

async function performSignOut() {
	try {
		await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
	} finally {
		try { localStorage.removeItem('3dagent:auth-hint'); } catch {}
		resetIdentity();
		location.href = '/';
	}
}

function buildMenu(user, identity, options) {
	const profileSlug = user.username || user.address || identity.walletAddr;
	const profileHref = profileSlug ? `/u/${profileSlug}` : null;

	const items = [];
	if (profileHref) {
		items.push(`<a class="hu-item" href="${profileHref}">${USER_ICON}<span>View profile</span></a>`);
	}
	if (options.activePath !== '/dashboard') {
		items.push(`<a class="hu-item" href="/dashboard">${DASHBOARD_ICON}<span>Dashboard</span></a>`);
	}
	if (options.activePath !== '/settings') {
		items.push(`<a class="hu-item" href="/settings">${SETTINGS_ICON}<span>Settings</span></a>`);
	}
	items.push(`<a class="hu-item" href="/dashboard/portfolio">${PORTFOLIO_ICON}<span>Portfolio</span></a>`);
	items.push(`<a class="hu-item" href="/dashboard/wallets">${WALLETS_ICON}<span>Linked wallets</span></a>`);

	const copyTarget = identity.walletAddr || (identity.hasRealEmail ? user.email : '');
	if (copyTarget) {
		const label = identity.walletAddr ? 'Copy wallet address' : 'Copy email';
		items.push(`<button type="button" class="hu-item" data-copy="${copyTarget}">${COPY_ICON}<span>${label}</span></button>`);
	}

	items.push('<div class="hu-divider"></div>');
	items.push(`<button type="button" class="hu-item danger" data-action="signout">${SIGNOUT_ICON}<span>Sign out</span></button>`);

	const identityAvatar = identity.walletAddr
		? `<span class="hu-identity-avatar">${WALLET_ICON}</span>`
		: `<span class="hu-identity-avatar">${identity.initial}</span>`;

	return `
		<div class="hu-identity">
			${identityAvatar}
			<div class="hu-identity-text">
				<div class="hu-identity-name">${escapeHtml(identity.primary)}</div>
				${identity.secondary ? `<div class="hu-identity-sub">${escapeHtml(identity.secondary)}</div>` : ''}
			</div>
		</div>
		${items.join('')}
	`;
}

function escapeHtml(s) {
	return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function renderHeaderUser(container, user, options = {}) {
	injectStyles();
	if (!user) return null;
	const identity = deriveIdentity(user);
	const activePath = options.activePath || location.pathname;
	const opts = { ...options, activePath };

	const avatarLabel = identity.walletAddr
		? `Account menu — wallet ${shortAddr(identity.walletAddr)}`
		: `Account menu — ${identity.primary}`;
	const avatarInner = identity.walletAddr ? WALLET_ICON : identity.initial;

	container.classList.add('hu-root');
	container.innerHTML = `
		<button type="button" class="hu-avatar" aria-haspopup="menu" aria-expanded="false" aria-label="${escapeHtml(avatarLabel)}" title="${escapeHtml(identity.primary)}">${avatarInner}</button>
		<div class="hu-menu" role="menu" data-open="false">${buildMenu(user, identity, opts)}</div>
	`;

	const btn = container.querySelector('.hu-avatar');
	const menu = container.querySelector('.hu-menu');

	function open() {
		menu.dataset.open = 'true';
		btn.setAttribute('aria-expanded', 'true');
		document.addEventListener('mousedown', onDocClick, true);
		document.addEventListener('keydown', onKey);
	}
	function close() {
		menu.dataset.open = 'false';
		btn.setAttribute('aria-expanded', 'false');
		document.removeEventListener('mousedown', onDocClick, true);
		document.removeEventListener('keydown', onKey);
	}
	function toggle() {
		menu.dataset.open === 'true' ? close() : open();
	}
	function onDocClick(e) {
		if (!container.contains(e.target)) close();
	}
	function onKey(e) {
		if (e.key === 'Escape') { close(); btn.focus(); }
	}

	btn.addEventListener('click', toggle);

	menu.addEventListener('click', async (e) => {
		const copyBtn = e.target.closest('[data-copy]');
		if (copyBtn) {
			const value = copyBtn.getAttribute('data-copy');
			try { await navigator.clipboard.writeText(value); } catch {}
			const span = copyBtn.querySelector('span');
			if (span) {
				const orig = span.textContent;
				span.textContent = 'Copied';
				copyBtn.classList.add('hu-copy-flash');
				setTimeout(() => { span.textContent = orig; copyBtn.classList.remove('hu-copy-flash'); close(); }, 900);
			}
			return;
		}
		const actionBtn = e.target.closest('[data-action="signout"]');
		if (actionBtn) {
			actionBtn.disabled = true;
			performSignOut();
		}
	});

	return { close, open, element: container };
}

export async function mountHeaderUser(options = {}) {
	const slot = typeof options.slot === 'string' ? document.querySelector(options.slot) : options.slot;
	if (!slot) return { user: null };
	const user = options.user || (await fetchUser());
	if (!user) return { user: null };
	const controller = renderHeaderUser(slot, user, options);
	return { user, controller };
}
