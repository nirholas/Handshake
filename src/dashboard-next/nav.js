// dashboard-next — route registry.
//
// Single source of truth for the sidebar AND the command palette.
// Each route declares:
//   path     — absolute URL the link navigates to
//   label    — visible text
//   icon     — short SVG keyword (rendered by sidebar.js)
//   group    — sidebar section ('Create' | 'Distribute' | 'Monetize' | 'Account')
//   tags     — extra keywords the command palette can match on
//   external — if true, opens outside the dashboard (escape hatch to legacy)
//
// Adding a new dashboard page = add one entry here. The sidebar and
// palette pick it up automatically; the per-page HTML and JS still need
// to be created under pages/dashboard-next/ and src/dashboard-next/pages/.

export const NAV = [
	// ── Create ──────────────────────────────────────────────────────────
	{ path: '/dashboard-next',           label: 'Overview',    icon: 'home',      group: 'Create',   tags: ['home', 'dashboard', 'start'] },
	{ path: '/dashboard-next/avatars',   label: 'Avatars',     icon: 'avatar',    group: 'Create',   tags: ['models', 'glb', 'creations'] },
	{ path: '/dashboard-next/library',   label: 'Library',     icon: 'library',   group: 'Create',   tags: ['animations', 'memory', 'voice', 'strategy', 'clips'] },

	// ── Distribute ──────────────────────────────────────────────────────
	{ path: '/dashboard-next/widgets',   label: 'Widgets',     icon: 'widget',    group: 'Distribute', tags: ['embed', 'iframe', '<threews-avatar>'] },
	{ path: '/dashboard-next/api',       label: 'API & Embed', icon: 'code',      group: 'Distribute', tags: ['keys', 'token', 'mcp', 'snippets', 'embed-policy'] },

	// ── Monetize ────────────────────────────────────────────────────────
	{ path: '/dashboard-next/monetize',  label: 'Monetize',    icon: 'coin',      group: 'Monetize',   tags: ['revenue', 'payments', 'subscriptions', 'withdrawals', 'earnings', 'tokens', 'plan', 'billing'] },

	// ── Account ─────────────────────────────────────────────────────────
	{ path: '/dashboard-next/account',   label: 'Account',     icon: 'user',      group: 'Account',    tags: ['wallets', 'sns', 'delegation', 'profile', 'action log'] },
];

export const GROUPS = ['Create', 'Distribute', 'Monetize', 'Account'];

/** Inline-SVG icon strings keyed by the `icon` field above. */
export const ICONS = {
	home:    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l7-6 7 6v8a1 1 0 01-1 1h-4v-6H8v6H4a1 1 0 01-1-1V9z"/></svg>',
	avatar:  '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="7" r="3.2"/><path d="M3.5 17c1.1-3.4 3.8-5 6.5-5s5.4 1.6 6.5 5"/></svg>',
	library: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h4v12H4zM12 4h4v12h-4z"/><path d="M6 7h0M14 7h0"/></svg>',
	widget:  '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="6" height="6" rx="1.2"/><rect x="11" y="3" width="6" height="6" rx="1.2"/><rect x="3" y="11" width="6" height="6" rx="1.2"/><rect x="11" y="11" width="6" height="6" rx="1.2"/></svg>',
	code:    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 5l-4 5 4 5M13 5l4 5-4 5"/></svg>',
	coin:    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="6.5"/><path d="M10 6v8M7.5 8h4a1.5 1.5 0 010 3H8.5a1.5 1.5 0 000 3h4"/></svg>',
	user:    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="7" r="3.2"/><path d="M4 17a6 6 0 0112 0"/></svg>',
};

/** Resolve the route for the current pathname (exact match wins; falls back to startsWith). */
export function currentRoute(pathname = location.pathname) {
	const exact = NAV.find((r) => r.path === pathname);
	if (exact) return exact;
	return NAV.find((r) => r.path !== '/dashboard-next' && pathname.startsWith(r.path)) ||
		NAV.find((r) => r.path === '/dashboard-next');
}
