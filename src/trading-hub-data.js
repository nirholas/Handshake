// The surface and doc directory rendered on /trading.
//
// This exists because the autonomous trading system grew to roughly twenty
// pages with no front door: each surface was reachable only if you already knew
// its URL. Keeping the directory as data (rather than inline markup) means the
// set is enumerable, so a test can assert every href resolves to a real route
// and the map cannot silently rot when a page is renamed.
//
// Every `href` below must be a live three.ws path. tests/trading-hub.test.js
// enforces that against data/pages.json and the docs directory.

/** @typedef {{kicker: string, title: string, body: string, href: string}} DirectoryItem */

/** Product surfaces: where to watch, tune, and act on the fleet. @type {DirectoryItem[]} */
export const SURFACES = [
	{
		kicker: 'Watch',
		title: 'Sniper Arena',
		body: 'The live floor. Every agent, every open position, and every entry and exit as it lands.',
		href: '/play/arena',
	},
	{
		kicker: 'Replay',
		title: 'Exit Lab',
		body: 'Re-run every real closed trade under different exit rules and see what the SOL already spent would have returned.',
		href: '/exit-lab',
	},
	{
		kicker: 'Compare',
		title: 'Sniper Experiments',
		body: 'Rule shields against oracle gates against language-model judgment, scored on the same market.',
		href: '/sniper/experiments',
	},
	{
		kicker: 'Rank',
		title: 'Trader Leaderboard',
		body: 'Realized profit and loss per agent with win rate, profit factor, and drawdown.',
		href: '/leaderboard',
	},
	{
		kicker: 'Read',
		title: 'Live Trade Feed',
		body: 'Notable exits as they close, with hold time, exit multiple, and a link to the transaction.',
		href: '/trades',
	},
	{
		kicker: 'Follow',
		title: 'Smart Money Radar',
		body: 'The wallets that consistently win, and what they are buying right now.',
		href: '/smart-money',
	},
	{
		kicker: 'Scan',
		title: 'Coin Radar',
		body: 'Launches as they cross the feed, filtered by the same signals the fleet scores on.',
		href: '/radar',
	},
	{
		kicker: 'Mirror',
		title: 'Copy Trading',
		body: 'Point your own wallet at an agent and follow its entries and exits automatically.',
		href: '/mirror',
	},
	{
		kicker: 'Build',
		title: 'Strategy Lab',
		body: 'Compose entry and exit rules into a strategy object, then backtest it before arming.',
		href: '/strategy-lab',
	},
	{
		kicker: 'Automate',
		title: 'Coin Autopilot',
		body: 'Hands-off buyback, burn, and holder payouts for a coin you launched.',
		href: '/autopilot',
	},
	{
		kicker: 'Back',
		title: 'Agent Vaults',
		body: 'Stake behind an agent you believe in and share what its strategy earns.',
		href: '/vaults',
	},
	{
		kicker: 'Research',
		title: 'Coin Intelligence',
		body: 'Holder concentration, bundle and sniper detection, and creator history for any mint.',
		href: '/coin-intel',
	},
	{
		kicker: 'Claim',
		title: 'Trader Card',
		body: 'Verify your own wallet and publish a provable track record.',
		href: '/claim-wallet',
	},
];

/** Documentation and tutorials. @type {DirectoryItem[]} */
export const LEARN = [
	{
		kicker: 'Start here',
		title: 'Agent Sniper',
		body: 'What the autonomous trader is, what it can and cannot do, and how it is wired.',
		href: '/docs/agent-sniper',
	},
	{
		kicker: 'Tutorial',
		title: 'Arm your first agent',
		body: 'Step by step, from an empty wallet to an armed strategy with conservative caps.',
		href: '/tutorials/arm-an-agent-sniper',
	},
	{
		kicker: 'Tutorial',
		title: 'Find a better exit policy',
		body: 'Why tightening an exit is measurable, loosening one is only a hypothesis, and how to tell a real finding from two lucky coins.',
		href: '/tutorials/find-a-better-exit-policy',
	},
	{
		kicker: 'Method',
		title: 'The 10 SOL experiment',
		body: 'The full risk policy: entry band, position sizing, taking initials, and the moon bag.',
		href: '/docs/trading-experiment',
	},
	{
		kicker: 'Policy',
		title: 'Risk acknowledgment',
		body: 'What can go wrong, stated plainly. Read this before arming anything with real funds.',
		href: '/docs/risk-acknowledgment',
	},
	{
		kicker: 'Trust',
		title: 'Custody model',
		body: 'How an agent holds its own keys, and what the platform can and cannot do with them.',
		href: '/docs/custody',
	},
	{
		kicker: 'Autonomy',
		title: 'Earned autonomy',
		body: 'How much freedom an agent gets, and what it has to prove to earn more.',
		href: '/docs/sniper-autonomy',
	},
	{
		kicker: 'Market making',
		title: 'Trading Copilot',
		body: 'The rules-based, non-manipulative market maker behind a fair launch.',
		href: '/docs/trading-copilot',
	},
	{
		kicker: 'Reference',
		title: 'Strategy Objects',
		body: 'The composable schema every armed strategy compiles down to.',
		href: '/docs/strategy-objects',
	},
];
