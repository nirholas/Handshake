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
	{ path: '/dashboard',             label: 'Overview',        icon: 'home',      group: 'Create',     tags: ['home', 'dashboard', 'start'] },
	{ path: '/dashboard/avatars',     label: 'Avatars',         icon: 'avatar',    group: 'Create',     tags: ['models', 'glb', 'creations', 'selfie', 'upload'] },
	{ path: '/dashboard/agents',      label: 'Agents',          icon: 'agent',     group: 'Create',     tags: ['bot', 'ai', 'identity', 'erc-8004', 'persona', 'reputation'] },
	{ path: '/dashboard/library',     label: 'Library',         icon: 'library',   group: 'Create',     tags: ['animations', 'memory', 'voice', 'strategy', 'clips', 'strategy-lab'] },
	{ path: '/voice',                 label: 'Voice Lab',       icon: 'voice',     group: 'Create',     tags: ['clone', 'tts', 'speech', 'recording', 'elevenlabs'], external: true },

	// ── Distribute ──────────────────────────────────────────────────────
	{ path: '/dashboard/widgets',     label: 'Widgets',         icon: 'widget',    group: 'Distribute', tags: ['embed', 'iframe', '<threews-avatar>', 'transcripts', 'knowledge'] },
	{ path: '/dashboard/api',         label: 'API & Embed',     icon: 'code',      group: 'Distribute', tags: ['keys', 'token', 'mcp', 'snippets', 'embed-policy'] },

	// ── Monetize ────────────────────────────────────────────────────────
	{ path: '/dashboard/monetize',    label: 'Monetize',        icon: 'coin',      group: 'Monetize',   tags: ['revenue', 'payments', 'subscriptions', 'withdrawals', 'earnings', 'plan', 'billing'] },
	{ path: '/dashboard/tokens',      label: 'Tokens',          icon: 'token',     group: 'Monetize',   tags: ['pump.fun', 'launch', 'bonding curve', 'royalties', 'trade'] },
	{ path: '/dashboard/portfolio',   label: 'Portfolio & NFTs', icon: 'portfolio', group: 'Monetize',  tags: ['nft', 'holdings', 'balances', 'wallet', 'collection'] },

	// ── Account ─────────────────────────────────────────────────────────
	{ path: '/dashboard/account',     label: 'Account',         icon: 'user',      group: 'Account',    tags: ['wallets', 'sns', 'delegation', 'profile', 'action log', 'provider keys'] },
	{ path: '/dashboard/settings',    label: 'Settings',        icon: 'settings',  group: 'Account',    tags: ['sessions', 'notifications', 'preferences', 'storage', 'llm usage', 'vanity'] },
	{ path: '/onchain',                    label: 'On-chain (ERC-8004)', icon: 'chain', group: 'Account',    tags: ['erc8004', 'registry', 'onchain', 'identity'], external: true },
	{ path: '/discover',                   label: 'Discover on-chain',   icon: 'globe', group: 'Account',    tags: ['explore', 'discover', 'directory'], external: true },
];

export const GROUPS = ['Create', 'Distribute', 'Monetize', 'Account'];

/** Inline-SVG icon strings keyed by the `icon` field above. */
export const ICONS = {
	home:      '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l7-6 7 6v8a1 1 0 01-1 1h-4v-6H8v6H4a1 1 0 01-1-1V9z"/></svg>',
	avatar:    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="7" r="3.2"/><path d="M3.5 17c1.1-3.4 3.8-5 6.5-5s5.4 1.6 6.5 5"/></svg>',
	agent:     '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="10" height="10" rx="2"/><circle cx="8" cy="6.5" r="1"/><circle cx="12" cy="6.5" r="1"/><path d="M8 9h4M3 14l2-2h10l2 2v3a1 1 0 01-1 1H4a1 1 0 01-1-1v-3z"/></svg>',
	library:   '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h4v12H4zM12 4h4v12h-4z"/><path d="M6 7h0M14 7h0"/></svg>',
	widget:    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="6" height="6" rx="1.2"/><rect x="11" y="3" width="6" height="6" rx="1.2"/><rect x="3" y="11" width="6" height="6" rx="1.2"/><rect x="11" y="11" width="6" height="6" rx="1.2"/></svg>',
	code:      '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 5l-4 5 4 5M13 5l4 5-4 5"/></svg>',
	coin:      '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="6.5"/><path d="M10 6v8M7.5 8h4a1.5 1.5 0 010 3H8.5a1.5 1.5 0 000 3h4"/></svg>',
	token:     '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2l2.5 5 5.5.8-4 3.9.9 5.5L10 14.7l-4.9 2.5.9-5.5L2 7.8l5.5-.8L10 2z"/></svg>',
	portfolio: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="16" height="11" rx="1.5"/><path d="M6 7V5a4 4 0 018 0v2"/><path d="M2 11h16"/></svg>',
	user:      '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="7" r="3.2"/><path d="M4 17a6 6 0 0112 0"/></svg>',
	settings:  '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="2.5"/><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.2 4.2l1.4 1.4M14.4 14.4l1.4 1.4M4.2 15.8l1.4-1.4M14.4 5.6l1.4-1.4"/></svg>',
	chain:     '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 12a4 4 0 005.7 0l2-2a4 4 0 00-5.7-5.7l-1 1"/><path d="M12 8a4 4 0 00-5.7 0l-2 2a4 4 0 005.7 5.7l1-1"/></svg>',
	globe:     '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="7.5"/><path d="M10 2.5c-2 2.5-2 12.5 0 15M10 2.5c2 2.5 2 12.5 0 15M2.5 10h15"/></svg>',
	voice:     '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2" width="6" height="10" rx="3"/><path d="M4 10a6 6 0 0012 0"/><path d="M10 16v2"/></svg>',
};

/** Resolve the route for the current pathname (exact match wins; falls back to startsWith). */
export function currentRoute(pathname = location.pathname) {
	const exact = NAV.find((r) => r.path === pathname);
	if (exact) return exact;
	return NAV.find((r) => r.path !== '/dashboard' && pathname.startsWith(r.path)) ||
		NAV.find((r) => r.path === '/dashboard');
}
