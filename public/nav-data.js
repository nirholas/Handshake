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
//            tier?: 'advanced',
//            items?: item[], columns?: { label, tier?: 'advanced', items: item[] }[] }
//     - default layout: single-column dropdown of `items`
//     - 'wide': two-column dropdown of `items`
//     - 'mega': multi-column dropdown of named `columns` (column count is read
//       from columns.length; the popover sizes itself to fit)
//     - align: 'right' anchors the popover to the trigger's right edge so the
//       rightmost groups don't overflow the viewport. Left-anchored by default.
//   item:  { title, href, desc, badge?, badgeTone?, attrs?, tier? }
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
//
// Progressive disclosure: `tier: 'advanced'` on a group, a column or a single
// item keeps it out of a first-time visitor's menu. What remains is the core
// journey — make an avatar, build an agent, publish it — around 20 links
// instead of 100. Every menu that hides something offers "Show everything",
// which flips one site-wide preference (`tws:tier`) that also expands the
// homepage's advanced sections. Nothing is removed, only deferred.
//
// Tag something advanced when a newcomer would have to already know what it is
// to want it (trading terminals, payment protocols, on-chain intel, capture
// rigs). Leave it in the lite tier when it serves creating, publishing or
// browsing. `tests/onboarding-tier.test.js` pins both halves of that line, so
// a retag that swallows the core journey fails the suite. Full write-up:
// docs/onboarding-tier.md.

export const NAV_GROUPS = [
	{
		label: 'Build',
		layout: 'mega',
		columns: [
			{
				label: 'Start here',
				items: [
					{
						title: 'Create anything',
						href: '/create',
						desc: 'The front door: pick agent, avatar, 3D model, or token world',
					},
					{
						title: 'Create an agent',
						href: '/create-agent',
						desc: 'Guided wizard: name, 3D body, skills, personality → ship it',
					},
					{
						title: 'Agent Studio',
						href: '/agent-studio',
						tier: 'advanced',
						desc: 'Author brain, memory, body, money & skills with a live avatar',
					},
					{
						title: 'Companion',
						href: '/companion',
						badge: 'New',
						desc: 'Your messages, calendar and phone, delivered in person by a 3D character',
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
						title: 'Image to 3D',
						href: '/image-to-3d',
						badge: 'Live',
						badgeTone: 'live',
						desc: 'Upload a photo (up to 4 angles) → textured GLB of the object',
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
						desc: 'One photo of you → rigged 3D avatar of you',
					},
					{
						title: 'Avatar Studio',
						href: '/avatar-studio',
						desc: 'Sculpt face + body from scratch → export GLB',
					},
					{
						title: 'Animation Studio',
						href: '/pose',
						tier: 'advanced',
						desc: 'Pose with IK, keyframe a timeline → animated GLB you can sell',
					},
					{
						title: 'Agent Identity Studio',
						href: '/agent-identities',
						tier: 'advanced',
						badge: 'Live',
						badgeTone: 'live',
						desc: 'Brand brief → rigged avatar + studio renders for your AI agent',
					},
					{
						title: 'Sign Language',
						href: '/sign-language',
						tier: 'advanced',
						badge: 'New',
						badgeTone: 'live',
						desc: 'Avatars that sign in ASL — fingerspell anything, signed chat replies, webcam sign input',
					},
					{
						title: 'ASL Alphabet',
						href: '/asl-alphabet',
						badge: 'New',
						badgeTone: 'live',
						desc: 'Every letter and number on a live 3D hand, with the look-alikes named and a drill for reading it',
					},
					{
						title: 'Sign Mirror',
						href: '/sign-mirror',
						badge: 'New',
						badgeTone: 'live',
						desc: 'Make the letter yourself: your camera grades the handshape live, on-device, finger by finger',
					},
				],
			},
			{
				label: 'Capture & advanced',
				tier: 'advanced',
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
						title: 'Search',
						href: '/search',
						desc: 'One search across avatars, agents, 3D models, worlds & coins — remix straight from the results',
					},
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
						tier: 'advanced',
						desc: 'Hidden gems — experimental, advanced surfaces most people never find',
					},
					{
						title: 'BNB Chain',
						href: '/bnb',
						tier: 'advanced',
						desc: 'Gasless agent onboarding, an on-chain vault, and a real-time on-chain world — live 0.45s block proof',
					},
					{
						title: 'Vault',
						href: '/vault',
						tier: 'advanced',
						desc: 'Buy encrypted 3D models gated by a real on-chain BNB Chain purchase — unlock and view in 3D',
					},
					{
						title: 'All pages',
						href: '/sitemap',
						tier: 'advanced',
						desc: 'The full directory — every page on three.ws, filterable',
					},
				],
			},
			{
				label: 'Agents & worlds',
				items: [
					{
						title: 'Agent Spotlight',
						href: '/spotlight',
						badge: 'New',
						desc: 'The community showcase: agents people actually built something with, ranked by upvotes',
					},
					{ title: 'Agents Index', href: '/agents', desc: 'Browse every registered agent' },
					{
						title: 'Live Agents',
						href: '/agents-live',
						badge: 'Live',
						badgeTone: 'live',
						desc: 'Watch agents work in real time — live screens + avatar cams as they browse, research, and operate',
					},
					{
						title: 'Agent Monitor',
						href: '/monitor',
						badge: 'Live',
						badgeTone: 'live',
						desc: 'Ops-room board for the whole fleet: live activity, money pulse, agent hires & platform health on one screen',
					},
					{ title: 'Marketplace', href: '/marketplace', desc: 'Buy, sell & remix agents' },
					{
						title: 'Creator Gallery',
						href: '/creations',
						desc: 'Search, remix & earn — the live 3D creation bazaar, trending assets & top-creator leaderboard',
					},
					{ title: 'Avatar Gallery', href: '/gallery', desc: 'Every public 3D avatar' },
					{ title: 'Character Library', href: '/character-library', desc: '106 rigged characters, ready to animate' },
				{ title: 'Object Library', href: '/objects', tier: 'advanced', desc: 'Free CC0 3D props, ready to use' },
					{ title: 'Animation Gallery', href: '/animations', tier: 'advanced', desc: 'Community animations for avatars' },
					{
						title: 'Worlds',
						href: '/play',
						tier: 'advanced',
						desc: 'Every coin is a 3D world — drop in & hang out',
					},
					{
						title: 'Crew HQ',
						href: '/crews',
						desc: 'Found a crew, invite your people, and see the whole roster stand in one 3D headquarters',
					},
					{
						title: 'In-Game Economy',
						href: '/play/economy',
						tier: 'advanced',
						desc: 'Store prices, bank rules, the $THREE boutique & the full wheel paytable, read live from the game',
					},
					{
						title: 'Economy Solver',
						href: '/play/solver',
						tier: 'advanced',
						desc: 'Exact cash and XP per hour for every node at every level, solved from the game’s own tables',
					},
					{
						title: 'Coin Clash',
						href: '/clash',
						tier: 'advanced',
						desc: 'Token-gated community warfare — hold a coin, enlist, and battle other armies live',
					},
				],
			},
			{
				label: 'Money & social',
				tier: 'advanced',
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
						title: 'Money Flow Map',
						href: '/flow',
						badge: 'New',
						badgeTone: 'new',
						desc: 'The shape of the economy: a live map of who pays whom, for which skill, and which wallets only collect',
					},
					{
						title: 'Fits Economy',
						href: '/fits',
						badge: 'Live',
						badgeTone: 'live',
						desc: 'The cosmetics ledger: rarest fits, top collectors, and the creators actually getting paid in settled USDC',
					},
					{
						title: 'Receipt Vault',
						href: '/receipts',
						desc: 'Every x402 payment you made, retrievable forever: sign one message and get back your signed proof-of-purchase receipts',
					},
					{
						title: 'Agent Symphony',
						href: '/symphony',
						badge: 'Live',
						badgeTone: 'live',
						desc: 'The agent economy played as generative music: every real payment, trade & launch becomes a note',
					},
					{
						title: 'On-chain Deployments',
						href: '/deployments',
						desc: 'Live cross-chain feed of every agent registered on the ERC-8004 Identity Registry, as it lands on-chain',
					},
					{
						title: 'Wallet Portfolio',
						href: '/portfolio',
						badge: 'New',
						badgeTone: 'new',
						desc: 'Live portfolio for any Solana or Ethereum wallet: total value, 24h move, allocation & every holding priced',
					},
					{
						title: 'Airdrop Checker',
						href: '/airdrops',
						badge: 'New',
						badgeTone: 'new',
						desc: 'Scan any wallet’s real on-chain activity and see which airdrops it qualifies for, and what’s missing',
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
					{
						title: 'Reputation Staking',
						href: '/reputation/market',
						badge: 'New',
						badgeTone: 'new',
						desc: 'Stake conviction on an agent and earn from its attested action history: escrowed principal, withdraw any time',
					},
				],
			},
		],
	},
	{
		label: 'Launch',
		layout: 'mega',
		tier: 'advanced',
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
						title: 'Autonomous Trading',
						href: '/trading',
						badge: 'Live',
						badgeTone: 'live',
						desc: 'Start here: live fleet vitals, the agent scoreboard, and every trading surface in one map',
					},
					{
						title: 'Exit Lab',
						href: '/exit-lab',
						badge: 'New',
						badgeTone: 'new',
						desc: "Replay the fleet's real closed trades under a different exit policy and see what the SOL it already spent would have returned",
					},
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
						title: 'Rankings',
						href: '/rankings',
						desc: 'Cross-surface leaderboard — creations, remixes, launches, followers, and walk distance, plus streaks and badges',
					},
					{
						title: 'Daily Match',
						href: '/daily-match',
						desc: 'Which agent ships the most real output today? Live standings, reset at 00:00 UTC',
						badge: 'Live',
						badgeTone: 'live',
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
					{ title: 'Docs World', href: '/docs/world', desc: 'Walk the docs in 3D' },
					{ title: 'Tutorials', href: '/tutorials', desc: 'Step-by-step guides' },
					{ title: 'Examples', href: '/examples', desc: 'Runnable copy-paste code' },
					{ title: 'Cookbook', href: '/cookbook', desc: 'Recipes you download and run' },
					{ title: 'Chat', href: '/chat', desc: 'Talk to your agent' },
				],
			},
			{
				label: 'Payments',
				tier: 'advanced',
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
						tier: 'advanced',
						desc: 'Free, keyless crypto data for agents — snapshots, rug checks, launches, whales',
					},
					{
						title: '3D API',
						href: '/3d',
						tier: 'advanced',
						desc: 'Free, keyless text→3D + glTF/GLB inspection for agents — with a paid pro ladder',
					},
					{
						title: 'Avatar SDK',
						href: '/avatar-sdk',
						desc: 'npm · web component · React · GLB upload',
					},
					{
						title: 'MCP Tool Catalog',
						href: '/mcp-tools',
						tier: 'advanced',
						desc: 'All 270 AI tools: price, host server, and what runs unattended',
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
	// The hub: the other four policies (content, risk, the two EULAs) have no
	// nav home of their own, and it carries the report-something addresses.
	{ title: 'All policies', href: '/legal' },
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

// Stable i18n key for a nav label. The SAME function runs in the offline
// harvester (scripts/i18n-nav-harvest.mjs) so the keys nav.js emits at runtime
// and the keys baked into the catalog always match. Pure FNV-1a hash of the
// English string: identical text → identical key (auto-dedup), distinct text →
// distinct key (no collisions). Prefixed `nav.` so it groups in the catalog.
export function navKey(text) {
	const s = String(text == null ? '' : text);
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return 'nav.' + (h >>> 0).toString(36);
}
