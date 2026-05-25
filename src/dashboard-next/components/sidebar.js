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
				return `
					<a href="${esc(r.path)}" class="dn-rail-item"${active} data-route="${esc(r.path)}">
						<span class="dn-rail-item-icon" aria-hidden="true">${icon}</span>
						<span class="dn-rail-item-text">${esc(r.label)}</span>
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
