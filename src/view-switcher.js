/**
 * Shared "view switcher" — a navigate-based segmented control that lets a user
 * flip a single agent/avatar between its available presentation surfaces:
 * the 3D detail page, live chat, AR, and the embeddable widget.
 *
 * Navigate-based by design: each view is its own shareable URL. The active
 * view renders as a non-interactive current item (aria-current="page"); every
 * other view is a plain anchor, so the control works without JS and degrades
 * gracefully if a controller fails to boot. Capability flags hide views that
 * don't apply to a given entity (e.g. agents without a 3D body get no AR).
 *
 * Usage:
 *   import { mountViewSwitcher } from './view-switcher.js';
 *   mountViewSwitcher(document.getElementById('view-switch-slot'), {
 *     kind: 'avatar', id: avatarId, active: '3d',
 *   });
 */

const ICONS = {
	'3d': '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
	chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
	ar: '<path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>',
	embed: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
	detail: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="3.5" cy="6" r="0.8"/><circle cx="3.5" cy="12" r="0.8"/><circle cx="3.5" cy="18" r="0.8"/>',
};

function icon(key) {
	return `<svg class="view-switch-ico" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[key] || ''}</svg>`;
}

// Views for a standalone avatar (the 3D body). Avatars always have a GLB, so
// every surface applies.
function avatarViews(id) {
	const e = encodeURIComponent(id);
	return [
		{ key: '3d', label: '3D', href: `/avatars/${e}`, title: '3D body & details' },
		{ key: 'chat', label: 'Chat', href: `/avatars/${e}?view=chat`, title: 'Talk to this avatar' },
		{ key: 'ar', label: 'AR', href: `/avatars/${e}/ar`, title: 'View in your space (AR)' },
		{ key: 'embed', label: 'Embed', href: `/avatars/${e}?view=embed`, title: 'Embed this avatar anywhere' },
	];
}

// Views for an agent. /agents/:id is the studio (the same template an avatar
// gets), so 3D and Chat are first-class URLs here too. AR needs a body, and the
// long-form profile (capabilities, economy, activity, trust, developer tools)
// lives one level deeper at /agents/:id/profile.
function agentViews(id, { hasBody = true } = {}) {
	const e = encodeURIComponent(id);
	const views = [
		{ key: '3d', label: '3D', href: `/agents/${e}`, title: '3D body & details' },
		{ key: 'chat', label: 'Chat', href: `/agents/${e}?view=chat`, title: 'Talk to this agent' },
	];
	if (hasBody) views.push({ key: 'ar', label: 'AR', href: `/agents/${e}/ar`, title: 'View in your space (AR)' });
	views.push({ key: 'embed', label: 'Embed', href: `/agents/${e}?view=embed`, title: 'Embed this agent anywhere' });
	views.push({ key: 'detail', label: 'Profile', href: `/agents/${e}/profile`, title: 'Capabilities, economy, activity & trust' });
	return views;
}

function injectStyles() {
	if (document.getElementById('view-switch-css')) return;
	const style = document.createElement('style');
	style.id = 'view-switch-css';
	style.textContent = `
		.view-switch {
			display: inline-flex;
			align-items: center;
			gap: 2px;
			padding: 3px;
			border-radius: 999px;
			background: rgba(255, 255, 255, 0.05);
			border: 1px solid rgba(255, 255, 255, 0.1);
			backdrop-filter: blur(8px);
		}
		.view-switch-item {
			display: inline-flex;
			align-items: center;
			gap: 6px;
			padding: 7px 14px;
			border-radius: 999px;
			font: 600 13px/1 Inter, system-ui, sans-serif;
			color: rgba(255, 255, 255, 0.62);
			text-decoration: none;
			white-space: nowrap;
			cursor: pointer;
			transition: color 0.15s ease, background 0.15s ease;
			-webkit-tap-highlight-color: transparent;
		}
		.view-switch-item .view-switch-ico { opacity: 0.85; }
		a.view-switch-item:hover { color: #fff; background: rgba(255, 255, 255, 0.08); }
		a.view-switch-item:focus-visible {
			outline: 2px solid rgba(255, 255, 255, 0.7);
			outline-offset: 2px;
		}
		.view-switch-item.is-active {
			color: #0a0a0a;
			background: #fff;
			cursor: default;
		}
		.view-switch-item.is-active .view-switch-ico { opacity: 1; }
		@media (max-width: 640px) {
			.view-switch-item span { display: none; }
			.view-switch-item { padding: 8px; }
			.view-switch-item.is-active span { display: inline; }
		}
	`;
	document.head.appendChild(style);
}

/**
 * Mount the switcher into `slot`. Returns the created <nav>, or null if no slot.
 * @param {Element|null} slot
 * @param {{ kind: 'avatar'|'agent', id: string, active: string, hasBody?: boolean }} opts
 */
export function mountViewSwitcher(slot, opts) {
	if (!slot || !opts?.id) return null;
	injectStyles();
	const views = opts.kind === 'agent' ? agentViews(opts.id, opts) : avatarViews(opts.id);
	const nav = document.createElement('nav');
	nav.className = 'view-switch';
	nav.setAttribute('aria-label', 'Switch view');
	nav.innerHTML = views
		.map((v) => {
			const inner = `${icon(v.key)}<span>${v.label}</span>`;
			if (v.key === opts.active) {
				return `<span class="view-switch-item is-active" aria-current="page" title="${v.title}">${inner}</span>`;
			}
			return `<a class="view-switch-item" href="${v.href}" title="${v.title}">${inner}</a>`;
		})
		.join('');
	slot.replaceChildren(nav);
	return nav;
}
