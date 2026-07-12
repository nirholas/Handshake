// three.ws site navigation — the single source of truth for every menu.
//
// Consumed by:
//   - public/nav.js                    renders the desktop dropdowns and the
//                                      mobile drawer from this data at runtime
//   - chat/src/three-ui/TopNav.svelte  chat header's main-site links
//
// Edit menus HERE and only here. Never hand-write menu markup in nav.html or
// a page header — that is exactly the drift this module exists to kill.
//
// Shapes:
//   group: { label, badge?, note?, layout?: 'wide' | 'mega', align?: 'right',
//            items?: item[], columns?: { label, items: item[] }[] }
//     - default layout: single-column dropdown of `items`
//     - 'wide': two-column dropdown of `items`
//     - 'mega': multi-column dropdown of named `columns` (column count is read
//       from columns.length; the popover sizes itself to fit)
//     - align: 'right' anchors the popover to the trigger's right edge so the
//       rightmost groups don't overflow the viewport. Left-anchored by default.
//   item:  { title, href, desc, badge?, badgeTone?, attrs? }
//     - badgeTone: 'live' tints the badge green with a pulse dot (running now)
//     - attrs: extra HTML attributes, e.g. { 'data-glossary-open': '' }
//   top-level link: { label, href, highlight? }
//     - highlight: renders as the iridescent "hot" pill (one per nav, max)
//
// Information architecture: every group is a categorized `mega` menu. With 60+
// destinations, a flat list per group was a wall of links nobody could scan —
// so each group is split into intent-named columns (e.g. Launch → Launch /
// Terminal & trade / Intelligence / Compete & earn). The only badge that
// survives is the green "Live" status (data/feature is running right now);
// "New" was on nearly every item, so it signalled nothing and was removed.

export const NAV_GROUPS = [
	{
		label: 'Build',
		layout: 'mega',
		columns: [
			{
				label: 'Start here',
				items: [
					{
						title: 'Create an avatar',
						href: '/create-agent',
						desc: 'Guided wizard: name, 3D body, skills, personality → ship it',
					},
					{
						title: 'Agent Studio',
						href: '/agent-studio',
						desc: 'Author brain, memory, body, money & skills with a live avatar',
					},
				],
			},
			{
				label: '3D & avatars',
				items: [
					{
						title: 'Text to 3D',
						href: '/forge',
						badge: 'Live',
						badgeTone: 'live',
						desc: 'Describe an object → textured GLB, usually in seconds',
					},
					{
						title: 'Describe it to 3D',
						href: '/create/prompt',
						badge: 'Live',
						badgeTone: 'live',
						desc: 'Type a description → rigged 3D avatar in about a minute',
					},
					{
						title: 'Selfie to avatar',
						href: '/create/selfie',
						desc: 'One photo → rigged 3D avatar',
					},
					{
						title: 'Avatar Studio',
						href: '/avatar-studio',
						desc: 'Sculpt face + body from scratch → export GLB',
					},
					{
						title: 'Animation Studio',
						href: '/pose',
						desc: 'Pose with IK, keyframe a timeline → animated GLB you can sell',
					},
					{
						title: 'Agent Identity Studio',
						href: '/agent-identities',
						badge: 'Live',
						badgeTone: 'live',
						desc: 'Brand brief → rigged avatar + studio renders for your AI agent',
					},
				],
			},
			{
				label: 'Capture & advanced',
				items: [
					{
						title: 'Splat Viewer',
						href: '/splat',
						desc: 'Render photoreal Gaussian-splat avatars in the browser — load a .ply / .splat by URL or upload',
					},
					{
						title: 'Scene Capture',
						href: '/capture',
						desc: 'Video → 3D scene — reconstruct any space into an explorable point cloud, rendered live in the browser',
					},
					{
						title: 'Avatar Engines Atlas',
						href: '/avatar-engines',
						desc: 'Every engine for high-quality & photoreal 3D avatars — technique, license & how three.ws uses each',
					},
					{
						title: 'CA → x402',
						href: '/ca2x402',
						desc: 'Paste any token contract address → a live, agent-payable x402 endpoint for its market intel',
					},
				],
			},
		],
	},
	{
		label: 'Discover',
		layout: 'mega',
		columns: [
			{
				label: 'Start here',
				items: [
					{
						title: 'Trending',
						href: '/trending',
						desc: 'Top agents by real activity + top Oracle conviction coins',
					},
					{
						title: 'What is three.ws?',
						href: '/what-is',
						desc: 'Plain-English intro + real use-cases — start here',
					},
					{
						title: 'Take the guided tour',
						href: '/tour',
						desc: 'A 3D guide walks you through every feature, live',
					},
					{
						title: 'Labs',
						href: '/labs',
						desc: 'Hidden gems — experimental, advanced surfaces most people never find',
					},
					{
						title: 'BNB Chain',
						href: '/bnb',
						desc: 'Gasless agent onboarding, an on-chain vault, and a real-time on-chain world — live 0.45s block proof',
					},
					{
						title: 'Vault',
						href: '/vault',
						desc: 'Buy encrypted 3D models gated by a real on-chain BNB Chain purchase — unlock and view in 3D',
					},
					{
						title: 'All pages',
						href: '/sitemap',
						desc: 'The full directory — every page on three.ws, filterable',
					},
				],
			},
			{
				label: 'Agents & worlds',
				items: [
					{ title: 'Agents Index', href: '/agents', desc: 'Browse every registered agent' },
					{
						title: 'Live Agents',
						href: '/agents-live',
						badge: 'Live',
						badgeTone: 'live',
						desc: 'Watch agents work in real time — live screens + avatar cams as they browse, research, and operate',
					},
					{ title: 'Marketplace', href: '/marketplace', desc: 'Buy, sell & remix agents' },
					{
						title: 'Creator Gallery',
						href: '/creations',
						desc: 'Search, remix & earn — the live 3D creation bazaar, trending assets & top-creator leaderboard',
					},
					{ title: 'Avatar Gallery', href: '/gallery', desc: 'Every public 3D avatar' },
					{ title: 'Animation Gallery', href: '/animations', desc: 'Community animations for avatars' },
					{
						title: 'Worlds',
						href: '/play',
						desc: 'Every coin is a 3D world — drop in & hang out',
					},
					{
						title: 'Coin Clash',
						href: '/clash',
						desc: 'Token-gated community warfare — hold a coin, enlist, and battle other armies live',
					},
				],
			},
			{
				label: 'Money & social',
				items: [
					{
						title: '$THREE Token',
						href: '/three-token',
						desc: 'Live price, bonding-curve chart, streaming trades & one-click buy',
					},
					{
						title: 'Agent Economy Volume',
						href: '/agent-economy-volume',
						badge: 'Live',
						badgeTone: 'live',
						desc: 'Total real USDC settled between agents hiring each other over x402 — top earners, spenders & a 90-day volume chart',
					},
					{
						title: 'Money Pulse',
						href: '/pulse',
						desc: 'Live, platform-wide feed of real agent wallet activity — tips, launches, trades & payments',
					},
					{
						title: 'On-chain Deployments',
						href: '/deployments',
						desc: 'Live cross-chain feed of every agent registered on the ERC-8004 Identity Registry, as it lands on-chain',
					},
					{
						title: 'Minted 3D Assets',
						href: '/minted',
						desc: 'Every generated avatar minted as a Solana NFT — live viewer, baked provenance, and enforced creator royalties',
					},
					{
						title: 'Copy Trading',
						href: '/mirror',
						desc: 'Follow a proven agent by its honest on-chain track record — your agent mirrors its trades within your spend policy',
					},
					{
						title: 'Strategy Objects',
						href: '/strategies',
						desc: 'Equip an ownable, forkable trade strategy on your agent — ranked by real on-chain results, run inside your spend policy',
					},
					{
						title: 'Trading Swarms',
						href: '/swarms',
						desc: 'Pool capital with other agents into one auditable treasury — it trades on reputation-weighted consensus and pays profit back pro-rata on-chain',
					},
				],
			},
		],
	},
	{
		label: 'Launch',
		layout: 'mega',
		columns: [
			{
				label: 'Launch',
				items: [
					{
						title: 'Launch a Coin',
						href: '/launch',
						desc: 'Mint a coin for your agent on pump.fun',
					},
					{
						title: 'Memetic Launcher',
						href: '/launcher',
						badge: 'Live',
						badgeTone: 'live',
						desc: 'Your autonomous launcher — ride live narratives and preview what your agents would mint',
					},
					{
						title: 'Launchpad Studio',
						href: '/launchpad',
						desc: 'Build a white-label hosted launchpad page in minutes',
					},
					{
						title: 'All Launches',
						href: '/launches',
						desc: 'Every agent-launched coin — full history',
					},
					{
						title: 'Token in 3D',
						href: '/coin3d',
						desc: 'View any token as a cinematic 3D scene',
					},
					{
						title: '3D Visualizer',
						href: '/pump-visualizer',
						desc: 'Trending tokens in 3D',
					},
				],
			},
			{
				label: 'Terminal & trade',
				items: [
					{
						title: 'Mission Control',
						href: '/terminal',
						badge: 'Live',
						badgeTone: 'live',
						desc: 'Real-time trading terminal — live launches, intel, firewall, smart-money & your positions on one keyboard-driven screen',
					},
					{
						title: 'Oracle',
						href: '/oracle',
						badge: 'Live',
						badgeTone: 'live',
						desc: 'One fused conviction score per launch — and arm your agent to act on it',
					},
					{
						title: 'Arm your agent',
						href: '/oracle/arm',
						desc: 'Set the rules and let your 3D agent trade Oracle conviction — simulate first, then go live',
					},
					{
						title: 'Strategy Lab',
						href: '/strategy-lab',
						desc: 'Backtest Oracle conviction filters and deploy your agent strategy in one click',
					},
					{
						title: 'Watchlist',
						href: '/watchlist',
						desc: 'Your tracked coins — live market caps and graduation status',
					},
					{
						title: 'Alpha Co-pilot',
						href: '/alpha-copilot',
						badge: 'Live',
						badgeTone: 'live',
						desc: 'Your agent reads a real launch in character, speaks its verdict aloud & acts within your spend limits',
					},
				],
			},
			{
				label: 'Intelligence',
				items: [
					{
						title: 'Markets Hub',
						href: '/markets',
						desc: 'Global stats, the top 100 coins, live news, and every market tool in one place',
					},
					{
						title: 'Robinhood Chain',
						href: '/markets/robinhood',
						desc: 'Live Stock Token NAV vs DEX premium, a memecoin screener, and a real buy flow',
					},
					{
						title: 'Crypto News',
						href: '/markets/news',
						desc: 'Live headlines from 37 publisher feeds with a rich reader for every story',
					},
					{
						title: 'News Digest',
						href: '/markets/digest',
						desc: 'The day in stories, not headlines — coverage clustered into what actually moved',
					},
					{
						title: 'News Archive',
						href: '/markets/archive',
						desc: '662k articles back to 2017 — search a decade of crypto history',
					},
					{
						title: 'Coins',
						href: '/coins',
						desc: 'Live global market data — top coins, prices, and a rich detail page for every asset',
					},
					{
						title: 'Heatmap',
						href: '/heatmap',
						desc: 'The whole market in one view — tiles sized by market cap, colored by price move',
					},
					{
						title: 'Fear & Greed',
						href: '/fear-greed',
						desc: 'Live market sentiment from Extreme Fear to Extreme Greed, with full history',
					},
					{
						title: 'Gas Tracker',
						href: '/gas',
						desc: 'Live Ethereum gas fees in gwei with USD cost estimates for common actions',
					},
					{
						title: 'Compare',
						href: '/compare',
						desc: 'Put up to four coins head to head — overlay performance and line up the stats',
					},
					{
						title: 'Screener',
						href: '/screener',
						desc: 'Filter the top 250 coins by market cap, volume, and 24h move — find movers fast',
					},
					{
						title: 'Categories',
						href: '/categories',
						desc: 'Every crypto sector ranked by market cap — smart contracts, AI, memes, and more',
					},
					{
						title: 'Exchanges',
						href: '/exchanges',
						desc: 'Top crypto exchanges ranked by trust score and 24h volume',
					},
					{
						title: 'Derivatives',
						href: '/derivatives',
						desc: 'Live perpetual futures — funding rates, open interest, and volume by market',
					},
					{
						title: 'Converter',
						href: '/converter',
						desc: 'Convert between any crypto and major fiat currencies at live rates',
					},
					{
						title: 'DeFi TVL',
						href: '/defi',
						desc: 'Total value locked across DeFi — top protocols by TVL, live from DeFiLlama',
					},
					{
						title: 'Chains',
						href: '/chains',
						desc: 'Blockchain TVL leaderboard — value locked per chain with dominance share',
					},
					{
						title: 'Stablecoins',
						href: '/stablecoins',
						desc: 'Stablecoin market caps and peg health across every major issuer',
					},
					{
						title: 'DeFi Yields',
						href: '/yields',
						desc: 'Explore ~15k live yield pools — APY, TVL, and per-pool history from DeFiLlama',
					},
					{
						title: 'Protocol Fees',
						href: '/fees',
						desc: 'Fees paid and revenue kept across DeFi protocols, ranked and charted',
					},
					{
						title: 'DEX Volumes',
						href: '/dex-volumes',
						desc: 'Decentralized-exchange volume leaderboard with 24h/7d totals and share',
					},
					{
						title: 'Hacks Database',
						href: '/hacks',
						desc: 'Every major DeFi exploit — amount stolen, technique, chain, and source',
					},
					{
						title: 'Trending',
						href: '/markets/trending',
						desc: 'The most-searched coins, categories, and NFTs on CoinGecko right now',
					},
					{
						title: 'Coin Intelligence',
						href: '/coin-intel',
						badge: 'Live',
						badgeTone: 'live',
						desc: 'Every launch classified — organic vs bundle, the wallets, a learning score',
					},
					{
						title: 'Coin Radar',
						href: '/radar',
						badge: 'Live',
						badgeTone: 'live',
						desc: 'Live pump.fun launch intelligence — bundle vs organic, scored',
					},
					{
						title: 'Smart Money Radar',
						href: '/smart-money',
						desc: 'Which wallets actually win — and what the proven money is buying now',
					},
					{
						title: 'Live Stream',
						href: '/pump-live',
						badge: 'Live',
						badgeTone: 'live',
						desc: 'Real-time new launches',
					},
					{
						title: 'Live Trade Feed',
						href: '/trades',
						badge: 'Live',
						badgeTone: 'live',
						desc: 'Every notable pump.fun exit — PnL, hold time, and one-click copy',
					},
					{
						title: 'Agent Activity',
						href: '/activity',
						desc: 'Every agent trade in real time — entries, outcomes, and who to copy',
					},
					{
						title: 'Recording Pipeline',
						href: '/pipeline',
						desc: 'Live health of the data loop: recorder, intel, outcomes, Oracle, learning, trading',
					},
				],
			},
			{
				label: 'Compete & earn',
				items: [
					{
						title: 'Trader Leaderboard',
						href: '/leaderboard',
						desc: 'Top traders ranked by a provable track record',
					},
					{
						title: 'The Arena',
						href: '/arena',
						desc: 'PvP trading tournaments — verified P&L, on-chain results, $THREE prizes',
					},
					{
						title: 'Sniper Arena',
						href: '/play/arena',
						desc: 'Watch AI agents trade pump.fun live',
					},
					{
						title: 'Back-an-Agent Vaults',
						href: '/vaults',
						badge: 'Live',
						badgeTone: 'live',
						desc: 'Stake behind a verified trader you can watch — real custody, shared P&L, drawdown-protected',
					},
					{
						title: 'Labor Market',
						href: '/labor-market',
						badge: 'Live',
						badgeTone: 'live',
						desc: 'Agents hire, pay & verify each other — a live $THREE machine economy',
					},
					{
						title: 'Claim Your Wallet',
						href: '/claim-wallet',
						desc: 'See your verified pump.fun track record and publish it as a Trader Card',
					},
				],
			},
		],
	},
	{
		label: 'Learn',
		layout: 'mega',
		columns: [
			{
				label: 'Learn',
				items: [
					{ title: 'Docs', href: '/docs', desc: 'SDKs + API reference' },
					{ title: 'Tutorials', href: '/tutorials', desc: 'Step-by-step guides' },
					{ title: 'Chat', href: '/chat', desc: 'Talk to your agent' },
				],
			},
			{
				label: 'Payments',
				items: [
					{ title: 'Pay', href: '/pay', desc: 'Agent payments — x402 + USDC' },
					{ title: 'Payment Sessions', href: '/payments', desc: 'Governed agent spend budgets — no private key needed' },
					{ title: 'Credits', href: '/credits', desc: 'Top up & spend — SOL or $THREE' },
				],
			},
			{
				label: 'Developers',
				items: [
					{
						title: 'Crypto Data API',
						href: '/crypto',
						desc: 'Free, keyless crypto data for agents — snapshots, rug checks, launches, whales',
					},
					{
						title: '3D API',
						href: '/3d',
						desc: 'Free, keyless text→3D + glTF/GLB inspection for agents — with a paid pro ladder',
					},
					{
						title: 'Avatar SDK',
						href: '/avatar-sdk',
						desc: 'npm · web component · React · GLB upload',
					},
				],
			},
		],
	},
];

// Top-level links rendered after the dropdown groups (no submenu).
export const NAV_LINKS = [
	{ label: 'Text → 3D', href: '/forge', highlight: true },
];

// Footer-of-drawer links that have no desktop dropdown home.
export const DRAWER_LEGAL = [
	{ title: 'Privacy Policy', href: '/legal/privacy' },
	{ title: 'Terms of Use', href: '/legal/tos' },
];

// The chat SPA header shows a compact subset of main-site destinations.
// Kept here so chat and the main nav can never disagree on labels or hrefs.
export const CHAT_SITE_LINKS = [
	{ label: 'Text → 3D', href: '/forge', highlight: true },
	{ label: 'Marketplace', href: '/marketplace' },
	{ label: 'Pay', href: '/pay' },
	{ label: 'Features', href: '/features' },
	{ label: 'Docs', href: '/docs' },
];
