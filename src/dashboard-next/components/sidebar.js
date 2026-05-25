// dashboard-next — sidebar rail (groups + items + collapse toggle).
//
// Reads the route registry from nav.js and renders one section per
// group. Marks the current route via aria-current="page". Persists
// collapse state to localStorage so it survives page transitions.

import { NAV, GROUPS, ICONS, currentRoute } from '../nav.js';
import { esc } from '../api.js';

const STORAGE_KEY = 'dn:rail:collapsed';

/** Build the sidebar HTML for the current pathname. */
export function renderSidebar(pathname) {
	const here = currentRoute(pathname)?.path;
	const groups = GROUPS.map((group) => {
		const items = NAV.filter((r) => r.group === group);
		if (!items.length) return '';
		const links = items
			.map((r) => {
				const active = r.path === here ? ' aria-current="page"' : '';
				const icon = ICONS[r.icon] || '';
				const extAttrs = r.external ? ' target="_blank" rel="noopener"' : '';
				const extBadge = r.external
					? `<span class="dn-rail-item-ext" aria-hidden="true"><svg viewBox="0 0 10 10" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2H2v6h6V6M6 2h2v2M5 5l3-3"/></svg></span>`
					: '';
				return `
					<a href="${esc(r.path)}" class="dn-rail-item"${active} data-route="${esc(r.path)}"${extAttrs}>
						<span class="dn-rail-item-icon" aria-hidden="true">${icon}</span>
						<span class="dn-rail-item-text">${esc(r.label)}${extBadge}</span>
					</a>`;
			})
			.join('');
		return `
			<div class="dn-rail-group">
				<div class="dn-rail-group-label">${esc(group)}</div>
				${links}
			</div>`;
	}).join('');

	return `
		<aside class="dn-rail" data-component="rail">
			<div class="dn-rail-head">
				<a href="/dashboard-next" aria-label="Dashboard home">
					<img class="dn-rail-full" src="/three.svg" alt="three.ws" />
					<img class="dn-rail-mark" src="/favicon.ico" alt="three.ws" style="width:22px;height:22px;border-radius:5px" />
				</a>
			</div>
			<nav class="dn-rail-scroll" aria-label="Dashboard sections">
				${groups}
			</nav>
			<div class="dn-rail-foot">
				<button type="button" class="dn-rail-item" data-action="rail-collapse" title="Collapse sidebar">
					<span class="dn-rail-item-icon" aria-hidden="true">
						<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5l-5 5 5 5"/></svg>
					</span>
					<span class="dn-rail-item-text">Collapse</span>
				</button>
				<a href="/dashboard" class="dn-rail-foot-back">&larr; Production dashboard</a>
			</div>
		</aside>`;
}

/** Wire the collapse toggle + restore persisted state. */
export function mountSidebarBehavior(shellEl) {
	const collapsed = (() => {
		try { return localStorage.getItem(STORAGE_KEY) === '1'; }
		catch { return false; }
	})();
	if (collapsed) shellEl.setAttribute('data-rail-collapsed', 'true');

	shellEl.addEventListener('click', (e) => {
		const btn = e.target.closest?.('[data-action="rail-collapse"]');
		if (!btn) return;
		const next = shellEl.getAttribute('data-rail-collapsed') !== 'true';
		shellEl.setAttribute('data-rail-collapsed', next ? 'true' : 'false');
		try { localStorage.setItem(STORAGE_KEY, next ? '1' : '0'); }
		catch { /* private mode — ignore */ }
	});
}

const MOBILE_NAV_ROUTES = [
	'/dashboard-next',
	'/dashboard-next/avatars',
	'/dashboard-next/widgets',
	'/dashboard-next/monetize',
];
const SHEET_ROUTES = NAV.filter((r) => !MOBILE_NAV_ROUTES.includes(r.path));

const MORE_ICON = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="4" cy="10" r="1.2" fill="currentColor" stroke="none"/><circle cx="10" cy="10" r="1.2" fill="currentColor" stroke="none"/><circle cx="16" cy="10" r="1.2" fill="currentColor" stroke="none"/></svg>';
const SETTINGS_ICON = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="2.5"/><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.2 4.2l1.4 1.4M14.4 14.4l1.4 1.4M4.2 15.8l1.4-1.4M14.4 5.6l1.4-1.4"/></svg>';
const PALETTE_ICON = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="8.5" cy="8.5" r="5"/><path d="M15 15l2.5 2.5"/></svg>';

export function renderMobileNav(pathname) {
	const here = currentRoute(pathname)?.path;
	const slots = MOBILE_NAV_ROUTES.map((path) => {
		const r = NAV.find((n) => n.path === path);
		if (!r) return '';
		const active = r.path === here ? ' aria-current="page"' : '';
		return `<a href="${esc(r.path)}" class="dn-rail-mobile-slot"${active}>
			<span aria-hidden="true">${ICONS[r.icon] || ''}</span>
			<span class="dn-rail-mobile-label">${esc(r.label)}</span>
		</a>`;
	}).join('');
	const moreActive = SHEET_ROUTES.some((r) => r.path === here) ? ' active' : '';
	const moreBtn = `<button type="button" class="dn-rail-mobile-slot${moreActive}" data-action="mobile-more" aria-haspopup="true">
		<span aria-hidden="true">${MORE_ICON}</span>
		<span class="dn-rail-mobile-label">More</span>
	</button>`;
	return `<div class="dn-rail-scroll" role="tablist" aria-label="Main navigation">${slots}${moreBtn}</div>`;
}

export function mountMobileNavBehavior(shellEl, pathname) {
	if (window.innerWidth > 880) return;
	const rail = shellEl.querySelector('.dn-rail');
	if (!rail) return;
	rail.innerHTML = `
		<div class="dn-rail-head" style="display:none"></div>
		${renderMobileNav(pathname)}
		<div class="dn-rail-foot" style="display:none"></div>
	`;
	rail.querySelector('[data-action="mobile-more"]')?.addEventListener('click', openSheet);
}

function openSheet() {
	const here = currentRoute(location.pathname)?.path;
	const backdrop = document.createElement('div');
	backdrop.className = 'dn-mobile-sheet-backdrop';
	const sheet = document.createElement('div');
	sheet.className = 'dn-mobile-sheet';
	sheet.innerHTML = `
		<div class="dn-mobile-sheet-handle" aria-hidden="true"></div>
		${SHEET_ROUTES.map((r) => `<a href="${esc(r.path)}" class="dn-mobile-sheet-item"${r.path === here ? ' aria-current="page"' : ''}>
			<span aria-hidden="true">${ICONS[r.icon] || ''}</span>
			<span>${esc(r.label)}</span>
		</a>`).join('')}
		<div class="dn-mobile-sheet-divider"></div>
		<a href="/settings" class="dn-mobile-sheet-item">
			<span aria-hidden="true">${SETTINGS_ICON}</span>
			<span>Settings</span>
		</a>
		<button type="button" class="dn-mobile-sheet-item" data-action="mobile-palette">
			<span aria-hidden="true">${PALETTE_ICON}</span>
			<span>Command palette  ⌘K</span>
		</button>
	`;
	document.body.appendChild(backdrop);
	document.body.appendChild(sheet);
	requestAnimationFrame(() => sheet.classList.add('open'));

	let closed = false;
	const onKey = (e) => { if (e.key === 'Escape') close(); };
	const close = () => {
		if (closed) return;
		closed = true;
		sheet.classList.remove('open');
		backdrop.style.opacity = '0';
		window.removeEventListener('keydown', onKey);
		setTimeout(() => { sheet.remove(); backdrop.remove(); }, 260);
	};

	backdrop.addEventListener('click', close);
	window.addEventListener('keydown', onKey);
	sheet.querySelector('[data-action="mobile-palette"]')?.addEventListener('click', () => {
		close();
		window.dispatchEvent(new CustomEvent('dn:palette:open'));
	});

	let startY = 0, currentY = 0, dragging = false;
	sheet.addEventListener('touchstart', (e) => {
		startY = e.touches[0].clientY;
		currentY = startY;
		dragging = true;
	}, { passive: true });
	sheet.addEventListener('touchmove', (e) => {
		if (!dragging) return;
		currentY = e.touches[0].clientY;
		const dy = currentY - startY;
		if (dy > 0) sheet.style.transform = `translateY(${dy}px)`;
	}, { passive: true });
	sheet.addEventListener('touchend', () => {
		const dy = currentY - startY;
		if (dy >= 60) {
			close();
		} else {
			sheet.style.transform = '';
		}
		startY = 0; currentY = 0; dragging = false;
	});
}
