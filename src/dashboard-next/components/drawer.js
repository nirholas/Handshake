// dashboard-next — activity drawer slot (foundation skeleton).
//
// This file ships the markup + open/close plumbing only. Prompt #9 replaces
// the empty body with a live activity feed (server events / polling, real
// data). Until then the drawer renders a "Coming soon" placeholder so the
// shell layout is testable end-to-end.

import { esc } from '../api.js';

export function renderDrawer() {
	return `
		<aside class="dn-drawer" data-component="drawer" aria-label="Activity">
			<div style="padding:18px 18px 12px;border-bottom:1px solid var(--nxt-stroke);display:flex;align-items:center;justify-content:space-between">
				<div>
					<div style="font-size:13px;font-weight:600;color:var(--nxt-ink)">Activity</div>
					<div style="font-size:12px;color:var(--nxt-ink-dim);margin-top:2px">Recent events across your account</div>
				</div>
				<button type="button" class="dn-btn ghost" data-action="toggle-drawer" aria-label="Close activity drawer" style="padding:5px 8px">
					<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 3l8 8M11 3l-8 8"/></svg>
				</button>
			</div>
			<div data-slot="drawer-body" style="padding:14px 16px">
				${esc('')}
				<div class="dn-empty" style="padding:36px 12px">
					<h3>Activity is on the way</h3>
					<p>Webhooks for widget views, transcript turns, and payments will flow in here as they arrive.</p>
				</div>
			</div>
		</aside>`;
}

export function mountDrawerBehavior(/* shellEl */) {
	/* No additional wiring at foundation level — topbar toggle drives open/close. */
}
