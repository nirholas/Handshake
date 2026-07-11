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
	{ path: '/start',                 label: 'Get started',     icon: 'sparkle',   group: 'Create',     tags: ['new', 'wizard', 'onboarding', 'create agent', 'setup'], external: true },
	{ path: '/dashboard',             label: 'Overview',        icon: 'home',      group: 'Create',     tags: ['home', 'dashboard', 'start'] },
	{ path: '/dashboard/avatars',     label: 'Avatars',         icon: 'avatar',    group: 'Create',     tags: ['models', 'glb', 'creations', 'selfie', 'upload'] },
	{ path: '/dashboard/agents',      label: 'Agents',          icon: 'agent',     group: 'Create',     tags: ['bot', 'ai', 'identity', 'erc-8004', 'persona', 'reputation'] },
	{ path: '/dashboard/library',     label: 'Library',         icon: 'library',   group: 'Create',     tags: ['animations', 'memory', 'voice', 'strategy', 'clips', 'strategy-lab'] },
	{ path: '/voice',                 label: 'Voice Lab',       icon: 'voice',     group: 'Create',     tags: ['clone', 'tts', 'speech', 'recording', 'elevenlabs'], external: true },
	{ path: '/dashboard/brain',       label: 'Brain',           icon: 'brain',     group: 'Create',     tags: ['persona', 'playground', 'compare', 'models', 'test', 'llm', 'ai'] },

	// ── Distribute ──────────────────────────────────────────────────────
	{ path: '/dashboard/widgets',     label: 'Widgets',         icon: 'widget',    group: 'Distribute', tags: ['embed', 'iframe', '<threews-avatar>', 'transcripts', 'knowledge'] },
	{ path: '/dashboard/walk',        label: 'Walk Companion',  icon: 'walk',      group: 'Distribute', tags: ['walk', 'companion', 'mascot', 'avatar', 'sdk', '@three-ws/walk', 'playground', 'greeting', 'picker', 'embed'] },
	{ path: '/dashboard/api',         label: 'API & Embed',     icon: 'code',      group: 'Distribute', tags: ['keys', 'token', 'mcp', 'snippets', 'embed-policy'] },
	{ path: '/dashboard/developers',  label: 'Developer Hub',   icon: 'devhub',   group: 'Distribute', tags: ['render', 'webhooks', 'sdk', 'unity', 'unreal', 'integration', 'api', 'partner'] },
	{ path: '/dashboard/data-api',    label: 'Data API',        icon: 'database',  group: 'Distribute', tags: ['premium', 'pass', 'news', 'archive', 'api key', 'x402', 'usage', '$three', 'subscription', 'crypto news', 'data'] },
	{ path: '/marketplace',           label: 'Marketplace',     icon: 'market',    group: 'Distribute', tags: ['browse', 'buy', 'sell', 'agents', 'avatars', 'directory'], external: true },
	{ path: '/skills',                label: 'Skills',          icon: 'skills',    group: 'Distribute', tags: ['tool', 'pack', 'capability', 'install', 'browse', 'skill'], external: true },

	// ── Monetize ────────────────────────────────────────────────────────
	{ path: '/dashboard/three-token', label: '$THREE',          icon: 'three',     group: 'Monetize',   tags: ['token', 'utility', 'burn', 'revenue share', 'protocol', '$three', 'economy', 'holders'] },
	{ path: '/dashboard/holders',     label: 'Holders',         icon: 'three',     group: 'Monetize',   tags: ['leaderboard', 'holders', 'rank', 'badge', '$three', 'whale', 'top holders', 'standing'] },
	{ path: '/dashboard/analytics',   label: 'Analytics',       icon: 'chart',     group: 'Monetize',   tags: ['revenue', 'charts', 'metrics', 'funnel', 'performance', 'views', 'engagement'] },
	{ path: '/dashboard/creator',     label: 'Creator Studio',  icon: 'creator',   group: 'Monetize',   tags: ['creator', 'earnings', 'pricing', 'price', 'payout', 'royalties', 'skill analytics', 'sell', 'income', 'make money', '$three discount'] },
	{ path: '/dashboard/monetize',    label: 'Monetize',        icon: 'coin',      group: 'Monetize',   tags: ['revenue', 'payments', 'subscriptions', 'withdrawals', 'earnings', 'plan', 'billing'] },
	{ path: '/payments',              label: 'Payment Sessions', icon: 'paysess',   group: 'Monetize',   tags: ['x402', 'agent pay', 'session', 'budget', 'usdc', 'autonomous', 'mcp', 'spend', 'governed'], external: true },
	{ path: '/dashboard/transactions',label: 'Transactions',    icon: 'receipt',   group: 'Monetize',   tags: ['history', 'purchases', 'sales', 'receipts', 'ledger', 'orders', 'spent', 'earned', 'invoice', 'transaction history', 'buys', 'csv'] },
	{ path: '/dashboard/tokens',      label: 'Tokens',          icon: 'token',     group: 'Monetize',   tags: ['pump.fun', 'launch', 'bonding curve', 'royalties', 'trade'] },
	{ path: '/dashboard/copy',        label: 'Copy Trading',    icon: 'live',      group: 'Monetize',   tags: ['copy', 'copy-trade', 'mirror', 'leader', 'follow', 'traders', 'intents', 'pump.fun', 'sniper'] },
	{ path: '/dashboard/sniper',      label: 'Sniper Strategies', icon: 'live',    group: 'Monetize',   tags: ['sniper', 'autonomous', 'strategy', 'pump.fun', 'auto-trade', 'budget', 'positions', 'pnl', 'kill-switch'] },
	{ path: '/dashboard/fleet',       label: 'Fleet Command',   icon: 'pulse',     group: 'Monetize',   tags: ['fleet', 'swarm', 'command', 'sniper', 'agents', 'bulk', 'arm all', 'kill switch', 'emergency stop', 'pooled', 'roster', 'live trades', 'mission control'] },
	{ path: '/dashboard/capabilities', label: 'Capabilities',   icon: 'live',      group: 'Monetize',   tags: ['alpha hunt', 'launcher', 'coin launcher', 'auto-claim', 'creator fees', 'market maker', 'jito', 'autonomous', 'capabilities'] },
	{ path: '/launcher',              label: 'Memetic Launcher', icon: 'sparkle',  group: 'Monetize',   tags: ['memetic', 'launcher', 'coin launcher', 'autonomous', 'narrative', 'meme', 'preview', 'rotation', 'cadence', 'pump.fun'] },
	{ path: '/dashboard/prelaunch-radar', label: 'Pre-Launch Radar', icon: 'live', group: 'Monetize',   tags: ['radar', 'pre-launch', 'precursor', 'block-zero', 'snipe', 'creator', 'smart-money', 'pump.fun', 'pre-cog', 'watchlist'] },
	{ path: '/oracle',                label: 'Oracle',          icon: 'oracle',    group: 'Monetize',   tags: ['conviction', 'score', 'tier', 'pump.fun', 'signal', 'ai', 'trade intelligence', 'wins', 'proof', 'leaderboard'], external: true },
	{ path: '/dashboard/portfolio',   label: 'Portfolio',        icon: 'portfolio', group: 'Monetize',  tags: ['nft', 'holdings', 'balances', 'wallet', 'collection', 'crypto', 'tokens', 'chart', 'send'] },
	{ path: '/dashboard/landscape',   label: 'Landscape',       icon: 'landscape', group: 'Monetize',   tags: ['competitors', 'market', 'competitive', 'intelligence', 'positioning', 'tam', 'investor'] },
	{ path: '/reputation',            label: 'Reputation',      icon: 'star',      group: 'Monetize',   tags: ['reviews', 'attestations', 'onchain', 'trust', 'score'], external: true },

	// ── Explore ─────────────────────────────────────────────────────────
	{ path: '/dashboard/irl-placements', label: 'IRL Placements', icon: 'pin', group: 'Explore', tags: ['irl', 'ar', 'gps', 'pin', 'place', 'avatar', 'location', 'anchor', 'real world'] },
	{ path: '/go',                    label: 'GO · Bounties',   icon: 'bounty',    group: 'Explore',    tags: ['bounty', 'earn', 'submit', 'proof', 'challenge', 'reward', 'go'], external: true },
	{ path: '/dashboard/community-avatars', label: 'Community Avatars', icon: 'gallery', group: 'Explore', tags: ['browse', 'public', 'models', 'community', 'gallery', 'discover', 'remix', 'explore avatars'] },
	{ path: '/gallery-picker',        label: 'Gallery',         icon: 'gallery',   group: 'Explore',    tags: ['browse', 'avatars', 'public', 'models', 'pick'], external: true },
	{ path: '/discover',              label: 'Discover',        icon: 'globe',     group: 'Explore',    tags: ['explore', 'directory', 'onchain', 'agents'], external: true },
	{ path: '/community',             label: 'Community',       icon: 'community', group: 'Explore',    tags: ['social', 'forum', 'connect', 'members'], external: true },
	{ path: '/demos',                 label: 'Demos',           icon: 'play',      group: 'Explore',    tags: ['examples', 'showcase', 'interactive', 'try'], external: true },
	{ path: '/pump-live',             label: 'Pump.fun Live',   icon: 'live',      group: 'Explore',    tags: ['feed', 'trending', 'tokens', 'trade', 'realtime'], external: true },
	{ path: '/radar',                 label: 'Coin Radar',      icon: 'live',      group: 'Explore',    tags: ['intelligence', 'bundle', 'organic', 'rug', 'risk', 'score', 'pump.fun', 'launch', 'snipe', 'concentration'], external: true },

	// ── Account ─────────────────────────────────────────────────────────
	{ path: '/dashboard/systems',     label: 'Systems',         icon: 'pulse',     group: 'Account',    tags: ['health', 'status', 'monitoring', 'workers', 'crons', 'x402', 'pump', 'agents', 'seeding', 'all systems'] },
	{ path: '/dashboard/spend',       label: 'GCP Spend',       icon: 'chart',     group: 'Account',    tags: ['gcp', 'credits', 'burn', 'cost', 'vertex', 'claude', 'imagen', 'forge', 'gpu', 'budget', 'runway', 'billing', 'cloud', 'spend', 'observability'] },
	{ path: '/dashboard/account',     label: 'Account',         icon: 'user',      group: 'Account',    tags: ['wallets', 'sns', 'delegation', 'profile', 'action log', 'provider keys'] },
	{ path: '/dashboard/referrals',   label: 'Referrals',       icon: 'gift',      group: 'Account',    tags: ['referral', 'invite', 'membership', 'card', 'refer a friend', 'share', 'rewards', 'position', 'score'] },
	{ path: '/dashboard/wallet-grinder', label: 'Wallet Grinder', icon: 'sparkle',  group: 'Account',    tags: ['vanity', 'grind', 'keypair', 'wallet', 'solana', 'evm', 'ethereum', 'base', 'polygon', 'address', 'prefix', 'suffix'] },
	{ path: '/dashboard/billing',     label: 'Billing & Passes', icon: 'receipt',  group: 'Account',    tags: ['billing', 'premium', 'pass', 'subscription', 'payments', 'invoices', 'paid services', 'renew', 'api keys'] },
	{ path: '/dashboard/settings',    label: 'Settings',        icon: 'settings',  group: 'Account',    tags: ['sessions', 'notifications', 'preferences', 'storage', 'llm usage', 'vanity'] },
	{ path: '/onchain',               label: 'On-chain (ERC-8004)', icon: 'chain', group: 'Account',    tags: ['erc8004', 'registry', 'onchain', 'identity'], external: true },
];

export const GROUPS = ['Create', 'Distribute', 'Monetize', 'Explore', 'Account'];

/** Inline-SVG icon strings keyed by the `icon` field above. */
export const ICONS = {
	sparkle:   '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.93 4.93l1.41 1.41M13.66 13.66l1.41 1.41M4.93 15.07l1.41-1.41M13.66 6.34l1.41-1.41M10 7a3 3 0 100 6 3 3 0 000-6z"/></svg>',
	home:      '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l7-6 7 6v8a1 1 0 01-1 1h-4v-6H8v6H4a1 1 0 01-1-1V9z"/></svg>',
	avatar:    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="7" r="3.2"/><path d="M3.5 17c1.1-3.4 3.8-5 6.5-5s5.4 1.6 6.5 5"/></svg>',
	agent:     '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="10" height="10" rx="2"/><circle cx="8" cy="6.5" r="1"/><circle cx="12" cy="6.5" r="1"/><path d="M8 9h4M3 14l2-2h10l2 2v3a1 1 0 01-1 1H4a1 1 0 01-1-1v-3z"/></svg>',
	library:   '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h4v12H4zM12 4h4v12h-4z"/><path d="M6 7h0M14 7h0"/></svg>',
	widget:    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="6" height="6" rx="1.2"/><rect x="11" y="3" width="6" height="6" rx="1.2"/><rect x="3" y="11" width="6" height="6" rx="1.2"/><rect x="11" y="11" width="6" height="6" rx="1.2"/></svg>',
	walk:      '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="3.6" r="1.6"/><path d="M11 6.2l-2.6 2 .9 3.3M11 6.2l2.2 1.4.6 2.6M9.3 11.5L7 17M12 10.2l1.4 2L15 16"/></svg>',
	code:      '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 5l-4 5 4 5M13 5l4 5-4 5"/></svg>',
	coin:      '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="6.5"/><path d="M10 6v8M7.5 8h4a1.5 1.5 0 010 3H8.5a1.5 1.5 0 000 3h4"/></svg>',
	creator:   '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 16l2.5-7 3 4 2.5-6 3 9"/><path d="M3 16h13"/><circle cx="15.5" cy="5" r="2"/></svg>',
	token:     '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2l2.5 5 5.5.8-4 3.9.9 5.5L10 14.7l-4.9 2.5.9-5.5L2 7.8l5.5-.8L10 2z"/></svg>',
	portfolio: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="16" height="11" rx="1.5"/><path d="M6 7V5a4 4 0 018 0v2"/><path d="M2 11h16"/></svg>',
	user:      '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="7" r="3.2"/><path d="M4 17a6 6 0 0112 0"/></svg>',
	settings:  '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="2.5"/><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.2 4.2l1.4 1.4M14.4 14.4l1.4 1.4M4.2 15.8l1.4-1.4M14.4 5.6l1.4-1.4"/></svg>',
	chain:     '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 12a4 4 0 005.7 0l2-2a4 4 0 00-5.7-5.7l-1 1"/><path d="M12 8a4 4 0 00-5.7 0l-2 2a4 4 0 005.7 5.7l1-1"/></svg>',
	globe:     '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="7.5"/><path d="M10 2.5c-2 2.5-2 12.5 0 15M10 2.5c2 2.5 2 12.5 0 15M2.5 10h15"/></svg>',
	voice:     '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2" width="6" height="10" rx="3"/><path d="M4 10a6 6 0 0012 0"/><path d="M10 16v2"/></svg>',
	brain:     '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3C7.5 3 5 5 5 8c0 1.5.5 2.5 1.2 3.3.5.5.8 1.2.8 2V15h6v-1.7c0-.8.3-1.5.8-2C14.5 10.5 15 9.5 15 8c0-3-2.5-5-5-5z"/><path d="M8 15v1a2 2 0 004 0v-1"/><path d="M8.5 8h3M8.5 10.5h3"/></svg>',
	market:    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7l1.5-4h11L17 7"/><path d="M3 7h14v10H3V7z"/><path d="M8 12h4v5H8v-5z"/><path d="M3 7c0 1.1.9 2 2 2s2-.9 2-2M7 7c0 1.1.9 2 2 2s2-.9 2-2M11 7c0 1.1.9 2 2 2s2-.9 2-2M15 7c0 1.1.9 2 2 2"/></svg>',
	star:      '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3l2 4.5 5 .7-3.6 3.5.9 5L10 14.5 5.7 16.7l.9-5L3 8.2l5-.7L10 3z"/></svg>',
	gallery:   '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="16" height="14" rx="2"/><circle cx="7" cy="8" r="1.5"/><path d="M2 14l4-4 3 3 4-5 5 6"/></svg>',
	community: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="2.5"/><circle cx="14" cy="7" r="2"/><path d="M2 16c.8-2.8 2.8-4.2 5-4.2s4.2 1.4 5 4.2"/><path d="M13.5 11.8c1.5 0 3 1.2 3.5 3.2"/></svg>',
	play:      '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="16" height="14" rx="2"/><path d="M8 7.5v5l4.5-2.5z"/></svg>',
	live:      '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="2"/><path d="M6 6a5.5 5.5 0 000 8"/><path d="M14 6a5.5 5.5 0 010 8"/><path d="M3.5 3.5a9 9 0 000 13"/><path d="M16.5 3.5a9 9 0 010 13"/></svg>',
	three:     '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="7.5"/><path d="M7.5 6.5h5L10 10h2.5a2.5 2.5 0 01 0 5H7.5"/></svg>',
	chart:     '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17V7l4 3 3-6 4 4 3-3v12H3z"/><path d="M3 17h14"/></svg>',
	skills:    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="14" height="14" rx="3"/><path d="M7 7h6M7 10h4M7 13h5"/></svg>',
	devhub:    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="16" height="12" rx="2"/><path d="M6 7l-2 2.5L6 12M14 7l2 2.5L14 12M9 13l2-8"/></svg>',
	database:  '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="10" cy="4.5" rx="6.5" ry="2.5"/><path d="M3.5 4.5v11c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5v-11"/><path d="M3.5 10c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5"/></svg>',
	landscape: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="8" r="2"/><circle cx="14" cy="6" r="2"/><circle cx="10" cy="14" r="2"/><path d="M8 8l2 5M12 7l-2 6"/><path d="M3 3h14v14H3z" stroke-dasharray="2 2" opacity="0.3"/></svg>',
	oracle:    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="9" r="5.5"/><path d="M6.5 9a3.5 3.5 0 007 0"/><circle cx="10" cy="9" r="1.2" fill="currentColor" stroke="none"/><path d="M10 14.5v2.5M7 16.5h6"/></svg>',
	bounty:    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="7.5"/><path d="M10 6v8M7 8l3-2 3 2M7 12l3 2 3-2"/></svg>',
	gift:      '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="8" width="14" height="9" rx="1.5"/><path d="M3 11h14M10 8v9"/><path d="M10 8S8.5 4.5 6.5 4.5a2 2 0 000 4H10zM10 8s1.5-3.5 3.5-3.5a2 2 0 010 4H10z"/></svg>',
	pin:       '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2a5 5 0 015 5c0 3.5-5 11-5 11S5 10.5 5 7a5 5 0 015-5z"/><circle cx="10" cy="7" r="1.8"/></svg>',
	receipt:   '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 2.5h10v15l-2-1.2-2 1.2-2-1.2-2 1.2-2-1.2V2.5z"/><path d="M8 6.5h4M8 9.5h4M8 12.5h2.5"/></svg>',
	paysess:   '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="16" height="10" rx="2"/><path d="M2 8.5h16"/><circle cx="6" cy="12" r="1.2" fill="currentColor" stroke="none"/><path d="M9.5 12h5"/></svg>',
	pulse:     '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 10h3l2-5 3 10 2-7 2 2h4"/></svg>',
};

/** Resolve the route for the current pathname (exact match wins; falls back to startsWith). */
export function currentRoute(pathname = location.pathname) {
	const exact = NAV.find((r) => r.path === pathname);
	if (exact) return exact;
	return NAV.find((r) => r.path !== '/dashboard' && pathname.startsWith(r.path)) ||
		NAV.find((r) => r.path === '/dashboard');
}
