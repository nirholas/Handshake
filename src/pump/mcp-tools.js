// Shared, runtime-agnostic MCP tool definitions for the pump.fun MCP server.
// Imported by both the Vercel handler (api/pump-fun-mcp.js) and the
// Cloudflare Workers mirror (workers/pump-fun-mcp/worker.js).
// No imports — pure data and pure helpers only.

// ── MCP ToolAnnotations (spec: readOnlyHint/destructiveHint/idempotentHint/
// openWorldHint). Every tool on this surface is read-only — nothing signs or
// sends a transaction. destructiveHint defaults to TRUE in the spec when
// omitted, so it is set explicitly everywhere.
//
//  LIVE_READ           live-market / on-chain read: same call can return new
//                      data, talks to external systems.
//  DETERMINISTIC_READ  external read whose answer is stable for the same args
//                      (name-service lookups).
//  LOCAL_DETERMINISTIC pure in-process computation, stable output (lexicon
//                      sentiment scoring).
//  LOCAL_GENERATIVE    pure in-process computation, fresh output each call
//                      (vanity keypair grind).
const LIVE_READ = Object.freeze({
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: false,
	openWorldHint: true,
});
const DETERMINISTIC_READ = Object.freeze({
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: true,
});
const LOCAL_DETERMINISTIC = Object.freeze({
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
});
const LOCAL_GENERATIVE = Object.freeze({
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: false,
	openWorldHint: false,
});

// Canonical (snake_case) tool name ← legacy (camelCase) alias. tools/list only
// ever advertises the canonical names; tools/call accepts BOTH forever. This
// map is the single source of truth for that aliasing — the Vercel handler,
// the Cloudflare Worker, and the npm bridge all resolve through it (the bridge
// ships a vendored copy in packages/pumpfun-mcp/src/tools.js).
export const TOOL_NAME_ALIASES = Object.freeze({
	searchTokens: 'search_tokens',
	getTokenDetails: 'get_token_details',
	getBondingCurve: 'get_bonding_curve',
	getTokenTrades: 'get_token_trades',
	getTrendingTokens: 'get_trending_tokens',
	getNewTokens: 'get_new_tokens',
	getGraduatedTokens: 'get_graduated_tokens',
	getKingOfTheHill: 'get_king_of_the_hill',
	getCreatorProfile: 'get_creator_profile',
	getTokenHolders: 'get_token_holders',
});

// Resolve a tools/call name to its canonical form. Unknown names pass through
// unchanged so the dispatcher's own unknown-tool error still fires. hasOwn
// guard: "__proto__"/"constructor" must not resolve an inherited member.
export function resolveToolName(name) {
	if (typeof name === 'string' && Object.hasOwn(TOOL_NAME_ALIASES, name)) {
		return TOOL_NAME_ALIASES[name];
	}
	return name;
}

// name → { title, ...ToolAnnotations }. Applied onto TOOLS below; exported so
// runtimes (and the npm bridge) can overlay the same map on older tool lists.
// Keys are the canonical snake_case names — overlay callers resolve legacy
// names through TOOL_NAME_ALIASES first.
export const TOOL_ANNOTATIONS = Object.freeze({
	search_tokens: { title: 'Search Tokens', ...LIVE_READ },
	get_token_details: { title: 'Token Details', ...LIVE_READ },
	get_bonding_curve: { title: 'Bonding Curve', ...LIVE_READ },
	get_token_trades: { title: 'Token Trades', ...LIVE_READ },
	get_trending_tokens: { title: 'Trending Tokens', ...LIVE_READ },
	get_new_tokens: { title: 'New Tokens', ...LIVE_READ },
	get_graduated_tokens: { title: 'Graduated Tokens', ...LIVE_READ },
	get_king_of_the_hill: { title: 'King of the Hill', ...LIVE_READ },
	get_creator_profile: { title: 'Creator Profile', ...LIVE_READ },
	get_token_holders: { title: 'Token Holders', ...LIVE_READ },
	pumpfun_vanity_mint: { title: 'Vanity Mint Keypair', ...LOCAL_GENERATIVE },
	pumpfun_watch_whales: { title: 'Watch Whale Trades', ...LIVE_READ },
	pumpfun_list_claims: { title: 'List Creator Fee Claims', ...LIVE_READ },
	pumpfun_watch_claims: { title: 'Watch Creator Fee Claims', ...LIVE_READ },
	pumpfun_first_claims: { title: 'First Creator Fee Claims', ...LIVE_READ },
	sns_resolve: { title: 'Resolve .sol Domain', ...DETERMINISTIC_READ },
	sns_reverseLookup: { title: 'Reverse .sol Lookup', ...DETERMINISTIC_READ },
	social_cashtag_sentiment: { title: 'Cashtag Sentiment', ...LOCAL_DETERMINISTIC },
	kol_leaderboard: { title: 'KOL Leaderboard', ...LIVE_READ },
	get_coin_intel: { title: 'Coin Intel', ...LIVE_READ },
	get_oracle_conviction: { title: 'Oracle Conviction', ...LIVE_READ },
	pumpfun_quote_swap: { title: 'Swap Quote (Read-Only)', ...LIVE_READ },
	social_x_post_impact: { title: 'X Post Price Impact', ...LIVE_READ },
	pumpfun_upload_metadata: {
		title: 'Upload Coin Metadata',
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	pumpfun_bot_status: { title: 'Indexer Status', ...LIVE_READ },
});

// outputSchema policy: only tools whose response shape is code-controlled and
// genuinely stable advertise one (sns_resolve, sns_reverseLookup,
// social_cashtag_sentiment, pumpfun_vanity_mint, pumpfun_quote_swap,
// get_bonding_curve). Indexer/upstream-shaped passthroughs (search_tokens,
// get_token_details, get_token_trades, get_trending_tokens, get_new_tokens,
// get_graduated_tokens, get_king_of_the_hill, get_creator_profile,
// get_token_holders, kol_*, pumpfun_*_claims, pumpfun_watch_whales,
// social_x_post_impact) deliberately ship NO outputSchema — their payloads
// mirror upstream feeds / multi-source on-chain decoders that can evolve, and
// a wrong schema is worse than none.
export const TOOLS = [
	{
		name: 'search_tokens',
		description: 'Search pump.fun tokens by name, symbol, or mint address.',
		inputSchema: {
			type: 'object',
			properties: {
				query: { type: 'string' },
				limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
			},
			required: ['query'],
		},
	},
	{
		name: 'get_token_details',
		description: 'Full details for a specific pump.fun token by mint address.',
		inputSchema: {
			type: 'object',
			properties: { mint: { type: 'string' } },
			required: ['mint'],
		},
	},
	{
		name: 'get_bonding_curve',
		description:
			'Bonding curve analysis: real reserves, virtual reserves, and graduation progress (on-chain).',
		inputSchema: {
			type: 'object',
			properties: {
				mint: { type: 'string' },
				network: { type: 'string', enum: ['mainnet', 'devnet'], default: 'mainnet' },
			},
			required: ['mint'],
		},
		outputSchema: {
			type: 'object',
			properties: {
				mint: { type: 'string' },
				network: { type: 'string' },
				complete: { type: 'boolean', description: 'true once the curve has graduated' },
				graduationPercent: { type: 'number', description: '0–100 graduation progress' },
				solReserves: { type: 'string', description: 'Real SOL reserves in SOL (4-decimal string)' },
				tokenReserves: { type: 'string', description: 'Real token reserves (raw base units)' },
				virtualSolReserves: { type: 'string', description: 'Virtual SOL reserves (lamports)' },
				virtualTokenReserves: { type: 'string', description: 'Virtual token reserves (raw base units)' },
			},
			required: [
				'mint',
				'network',
				'complete',
				'graduationPercent',
				'solReserves',
				'tokenReserves',
				'virtualSolReserves',
				'virtualTokenReserves',
			],
			additionalProperties: true,
		},
	},
	{
		name: 'get_token_trades',
		description: 'Recent buy/sell history for a token.',
		inputSchema: {
			type: 'object',
			properties: {
				mint: { type: 'string' },
				limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
			},
			required: ['mint'],
		},
	},
	{
		name: 'get_trending_tokens',
		description: 'Top pump.fun tokens by market cap.',
		inputSchema: {
			type: 'object',
			properties: { limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 } },
		},
	},
	{
		name: 'get_new_tokens',
		description: 'Most recently launched pump.fun tokens.',
		inputSchema: {
			type: 'object',
			properties: { limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 } },
		},
	},
	{
		name: 'get_graduated_tokens',
		description: 'Tokens that graduated from the bonding curve to Raydium AMM.',
		inputSchema: {
			type: 'object',
			properties: { limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 } },
		},
	},
	{
		name: 'get_king_of_the_hill',
		description: 'Highest-market-cap token still on the bonding curve.',
		inputSchema: { type: 'object', properties: {} },
	},
	{
		name: 'get_creator_profile',
		description: 'All tokens by a creator wallet, with rug-pull risk flags.',
		inputSchema: {
			type: 'object',
			properties: { creator: { type: 'string' } },
			required: ['creator'],
		},
	},
	{
		name: 'get_token_holders',
		description: 'Top holders of a token with concentration analysis (on-chain).',
		inputSchema: {
			type: 'object',
			properties: {
				mint: { type: 'string' },
				limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 },
				network: { type: 'string', enum: ['mainnet', 'devnet'], default: 'mainnet' },
			},
			required: ['mint'],
		},
	},
	{
		name: 'pumpfun_vanity_mint',
		description:
			'Generate a Solana keypair whose address ends/starts with a vanity pattern. Returns publicKey + secretKey (base58). Caller must save the secret key immediately — it is never stored. Hard timeout: 60 s.',
		inputSchema: {
			type: 'object',
			properties: {
				suffix: { type: 'string', description: 'Desired address suffix (case-insensitive by default)' },
				prefix: { type: 'string', description: 'Desired address prefix (case-insensitive by default)' },
				caseSensitive: { type: 'boolean', default: false },
				maxAttempts: { type: 'integer', default: 5000000 },
			},
		},
		outputSchema: {
			type: 'object',
			properties: {
				publicKey: { type: 'string', description: 'Matched Solana address (base58)' },
				secretKey: { type: 'string', description: 'Secret key (base58) — caller is sole custodian' },
				attempts: { type: 'integer', description: 'Keypairs ground before the match' },
				ms: { type: 'number', description: 'Wall-clock grind time in milliseconds' },
			},
			required: ['publicKey', 'secretKey', 'attempts', 'ms'],
			additionalProperties: true,
		},
	},
	{
		name: 'pumpfun_watch_whales',
		description:
			'Collect whale trades on a pump.fun token for a short window (max 10 s). Returns all trades whose USD value meets minUsd.',
		inputSchema: {
			type: 'object',
			properties: {
				mint: { type: 'string', description: 'SPL mint pubkey (base58)' },
				minUsd: { type: 'number', description: 'Minimum trade value in USD (default 5000)' },
				durationMs: {
					type: 'number',
					description: 'Collection window in ms (default 5000, max 10000)',
				},
			},
			required: ['mint'],
		},
	},
	{
		name: 'pumpfun_list_claims',
		description:
			'List recent pump.fun fee-claim events for a creator wallet (on-chain, no indexer needed). Returns signature, mint, lamports, and Unix timestamp for each claim.',
		inputSchema: {
			type: 'object',
			properties: {
				creator: { type: 'string', description: 'Creator wallet address (base58)' },
				limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
				network: { type: 'string', enum: ['mainnet', 'devnet'], default: 'mainnet' },
			},
			required: ['creator'],
		},
	},
	{
		name: 'pumpfun_watch_claims',
		description:
			'Return all pump.fun fee-claim events for a creator wallet within a look-back window (durationMs). Useful for batch collection after a delay.',
		inputSchema: {
			type: 'object',
			properties: {
				creator: { type: 'string', description: 'Creator wallet address (base58)' },
				durationMs: {
					type: 'number',
					description: 'Look-back window in ms (default 300000 = 5 min, max 1800000)',
				},
				network: { type: 'string', enum: ['mainnet', 'devnet'], default: 'mainnet' },
			},
			required: ['creator'],
		},
	},
	{
		name: 'pumpfun_first_claims',
		description:
			'First-ever pump.fun creator fee claims in a time window — a cash-out signal. Returns creators who have never claimed before, with creator wallet, mint, lamports, and timestamp.',
		inputSchema: {
			type: 'object',
			properties: {
				sinceMinutes: {
					type: 'integer',
					minimum: 1,
					maximum: 1440,
					default: 60,
					description: 'How far back to look for new claimers (minutes)',
				},
				limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
			},
		},
	},
	{
		name: 'sns_resolve',
		description: 'Resolve a .sol Solana Name Service domain to its owner wallet address.',
		inputSchema: {
			type: 'object',
			properties: {
				name: { type: 'string', description: '.sol domain name, e.g. "bonfida.sol"' },
			},
			required: ['name'],
		},
		outputSchema: {
			type: 'object',
			properties: {
				name: { type: 'string', description: 'The .sol domain that was resolved' },
				address: { type: 'string', description: 'Owner wallet address (base58)' },
			},
			required: ['name', 'address'],
			additionalProperties: true,
		},
	},
	{
		name: 'sns_reverseLookup',
		description: 'Reverse-lookup a Solana wallet address to its primary .sol domain name.',
		inputSchema: {
			type: 'object',
			properties: {
				address: { type: 'string', description: 'Base58 Solana wallet address' },
			},
			required: ['address'],
		},
		outputSchema: {
			type: 'object',
			properties: {
				address: { type: 'string', description: 'The wallet address that was looked up' },
				name: { type: 'string', description: 'Primary .sol domain for the address' },
			},
			required: ['address', 'name'],
			additionalProperties: true,
		},
	},
	{
		name: 'social_cashtag_sentiment',
		description:
			'Score social-post sentiment for a cashtag using a deterministic lexicon. Returns score (-1..1), positive/negative/neutral percentages, and example posts.',
		inputSchema: {
			type: 'object',
			properties: {
				posts: {
					type: 'array',
					description: 'Array of post objects. Each must have a text field; id, ts, and author are optional.',
					items: {
						type: 'object',
						properties: {
							id: { type: 'string' },
							ts: { type: 'string' },
							text: { type: 'string' },
							author: { type: 'string' },
						},
						required: ['text'],
					},
				},
			},
			required: ['posts'],
		},
		outputSchema: {
			type: 'object',
			properties: {
				score: { type: 'number', description: 'Net sentiment, -1 (bearish) to 1 (bullish)' },
				posPct: { type: 'number', description: 'Percentage of positive posts (0–100)' },
				negPct: { type: 'number', description: 'Percentage of negative posts (0–100)' },
				neuPct: { type: 'number', description: 'Percentage of neutral posts (0–100)' },
				count: { type: 'integer', description: 'Number of posts scored' },
				examples: {
					type: 'object',
					properties: {
						pos: { type: 'array', items: { type: 'string' } },
						neg: { type: 'array', items: { type: 'string' } },
					},
					required: ['pos', 'neg'],
					additionalProperties: true,
				},
			},
			required: ['score', 'posPct', 'negPct', 'neuPct', 'count', 'examples'],
			additionalProperties: true,
		},
	},
	{
		name: 'kol_leaderboard',
		description:
			'Top KOL traders ranked by P&L for a given time window. Returns wallet, pnlUsd, winRate, trades, rank.',
		inputSchema: {
			type: 'object',
			properties: {
				window: { type: 'string', enum: ['24h', '7d', '30d'], default: '7d' },
				limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
			},
		},
	},
	{
		name: 'pumpfun_quote_swap',
		description:
			'Read-only price quote for a pump.fun AMM (PumpSwap) swap. No signing or tx sending. One of inputMint/outputMint must be wSOL (So11111111111111111111111111111111111111112). Only GRADUATED coins have an AMM pool; for a coin still on its bonding curve use get_bonding_curve instead. Pricing runs on the pool effective quote reserves (quote vault balance + pool.virtual_quote_reserves); the base side is the raw base vault balance. Returns amountOut, priceImpactBps, route, expiresAtMs, plus the reserves the quote was computed from so the number can be reproduced.',
		inputSchema: {
			type: 'object',
			properties: {
				inputMint: { type: 'string', description: 'Input token mint (base58).' },
				outputMint: { type: 'string', description: 'Output token mint (base58).' },
				amountIn: { type: 'number', description: 'Input amount in raw base units (lamports for SOL).' },
				slippageBps: { type: 'number', description: 'Slippage tolerance in basis points (default 100 = 1%).' },
				network: { type: 'string', enum: ['mainnet', 'devnet'], default: 'mainnet' },
			},
			required: ['inputMint', 'outputMint', 'amountIn'],
		},
		outputSchema: {
			type: 'object',
			properties: {
				amountOut: { type: 'string', description: 'Expected output amount in raw base units' },
				priceImpactBps: { type: 'number', description: 'Price impact in basis points' },
				route: { type: 'string', description: 'AMM pool address the quote routes through (base58)' },
				expiresAtMs: { type: 'number', description: 'Epoch ms after which the quote is stale' },
				base_reserve: {
					type: 'string',
					description: 'Raw base vault balance. Unchanged by the virtual-reserve rollout.',
				},
				quote_reserve: {
					type: 'string',
					description: 'Raw quote vault balance, before virtual reserves are added.',
				},
				virtual_quote_reserves: {
					type: 'string',
					description:
						'Pool.virtual_quote_reserves. Quote-side liquidity the pool carries outside its vault. 0 on non-launchpad pools.',
				},
				effective_quote_reserve: {
					type: 'string',
					description:
						'quote_reserve + virtual_quote_reserves. This is what the quote is priced against.',
				},
			},
			required: ['amountOut', 'priceImpactBps', 'route', 'expiresAtMs'],
			additionalProperties: true,
		},
	},
	{
		name: 'social_x_post_impact',
		description:
			'Correlate an X (Twitter) post to a memecoin price impact. Fetches post metadata via oEmbed (no API key) and computes price delta from the pump.fun bonding curve in a ±windowMin window around the post.',
		inputSchema: {
			type: 'object',
			properties: {
				postUrl: { type: 'string', description: 'X post URL (e.g. https://x.com/user/status/123)' },
				mint: { type: 'string', description: 'Solana token mint address (base58)' },
				windowMin: {
					type: 'integer',
					default: 30,
					description: '±window in minutes around the post time',
				},
				network: { type: 'string', enum: ['mainnet', 'devnet'], default: 'mainnet' },
			},
			required: ['postUrl', 'mint'],
		},
	},
	{
		name: 'get_coin_intel',
		description:
			'Full Coin Intelligence snapshot for a pump.fun mint. Returns every signal the engine recorded during the observation window: bundle vs organic verdict, bubblemaps-style cluster connectivity, smart-money presence (with wallet labels and win-rates), dev behaviour, category/classification, news-meme detection with the matching headline, risk flags, and a 0–100 quality score. Also returns the outcome if the coin is old enough to be labeled (graduated/rugged/ATH multiple). This is the single highest-signal read for a trade decision — call this before entering any position.',
		inputSchema: {
			type: 'object',
			properties: {
				mint: { type: 'string', description: 'Solana mint address (base58).' },
				network: { type: 'string', enum: ['mainnet', 'devnet'], default: 'mainnet' },
			},
			required: ['mint'],
		},
		outputSchema: {
			type: 'object',
			properties: {
				found: { type: 'boolean' },
				mint: { type: 'string' },
				symbol: { type: 'string' },
				name: { type: 'string' },
				quality_score: { type: 'number', description: '0–100 composite quality.' },
				verdict: {
					type: 'object',
					properties: {
						key: { type: 'string', enum: ['strong', 'watch', 'caution', 'avoid'] },
						label: { type: 'string' },
						tone: { type: 'string' },
					},
				},
				risk_flags: { type: 'array', items: { type: 'string' } },
				category: { type: 'string' },
				is_news_meme: { type: 'boolean' },
				news_headline: { type: 'string', nullable: true },
				organic_score: { type: 'number', description: '0–1, organic-demand likelihood.' },
				bundle_score: { type: 'number', description: '0–1, coordinated-launch likelihood.' },
				bubblemap_connectivity: { type: 'number', nullable: true, description: '0–1 wallet-cluster share. null = enrichment not yet run.' },
				smart_money_count: { type: 'integer', description: 'Proven wallets (score≥65) in this coin.' },
				smart_money_score: { type: 'number', nullable: true },
				smart_money_notable: { type: 'array', items: { type: 'object' } },
				dev_buy_sol: { type: 'number', nullable: true },
				dev_sold: { type: 'boolean' },
				unique_buyers: { type: 'integer' },
				outcome: { type: 'object', nullable: true, description: 'Labeled outcome if available (graduated, ath_multiple, etc).' },
				oracle: {
					type: 'object',
					nullable: true,
					description: 'Fused Oracle conviction score (null if the Oracle engine has not yet scored this coin). Call get_oracle_conviction for the full read including who\'s-in roster and narrative.',
					properties: {
						score: { type: 'number', description: '0–100 fused Oracle score.' },
						tier: { type: 'string', enum: ['prime', 'strong', 'lean', 'watch', 'avoid'] },
						pillars: { type: 'object', description: 'Per-pillar scores: pedigree, structure, narrative, momentum (each 0–100).' },
						badges: { type: 'array', items: { type: 'string' } },
						reasons: { type: 'array', items: { type: 'string' }, description: 'Natural-language explanation of the score.' },
					},
				},
				oracle_url: { type: 'string', description: 'Oracle deep-link for the coin — opens the Oracle war-room drawer directly.' },
			},
			required: ['found'],
			additionalProperties: true,
		},
	},
	{
		name: 'get_oracle_conviction',
		description:
			'Oracle conviction score for a pump.fun mint — the fused 0–100 score the Oracle engine produces by combining four intelligence pillars: pedigree (who bought it), structure (organic vs bundle, holder concentration, bubblemaps connectivity), narrative (category, meme virality, news hook), and momentum (timing, velocity). Returns the tier (prime ≥86 / strong ≥72 / lean ≥54 / watch ≥36 / avoid), the per-pillar breakdown, the natural-language reasons that drove the score, the full "who\'s in" trader roster with reputation labels and win-rates, and the narrative read (category, virality, tags). Call this when you need the highest-confidence trade signal — it synthesises everything get_coin_intel exposes into one actionable score. Pairs with get_coin_intel for raw signals.',
		inputSchema: {
			type: 'object',
			properties: {
				mint: { type: 'string', description: 'Solana mint address (base58).' },
				network: { type: 'string', enum: ['mainnet', 'devnet'], default: 'mainnet' },
			},
			required: ['mint'],
		},
		outputSchema: {
			type: 'object',
			properties: {
				found: { type: 'boolean' },
				mint: { type: 'string' },
				symbol: { type: 'string' },
				name: { type: 'string' },
				conviction: {
					type: 'object',
					nullable: true,
					description: 'Fused conviction verdict. null if the Oracle has not yet scored this coin.',
					properties: {
						score: { type: 'number', description: '0–100 fused Oracle score.' },
						tier: { type: 'string', enum: ['prime', 'strong', 'lean', 'watch', 'avoid'], description: 'prime ≥86, strong ≥72, lean ≥54, watch ≥36, avoid <36.' },
						pillars: {
							type: 'object',
							properties: {
								pedigree: { type: 'number', description: 'Smart-money pedigree pillar score (0–100, weight 34%).' },
								structure: { type: 'number', description: 'Structure pillar score: organic/bundle/concentration/connectivity (0–100, weight 30%).' },
								narrative: { type: 'number', description: 'Narrative pillar score: category fit, meme virality, news hook (0–100, weight 18%).' },
								momentum: { type: 'number', description: 'Momentum pillar score: velocity, buy/sell ratio, timing entropy (0–100, weight 18%).' },
							},
						},
						structure_cap: { type: 'boolean', description: 'true when structural flags capped the score below raw pillar math.' },
						badges: { type: 'array', items: { type: 'string' }, description: 'Short human-readable badges attached to this coin, e.g. "Smart money: 3 wallets".' },
						reasons: { type: 'array', items: { type: 'string' }, description: 'Natural-language sentences explaining every signal that drove the score.' },
						scored_at: { type: 'string', description: 'ISO timestamp when the conviction was last computed.' },
					},
				},
				narrative: {
					type: 'object',
					nullable: true,
					description: 'Narrative classification for the coin.',
					properties: {
						category: { type: 'string', description: 'E.g. meme, ai, tech, culture, news, defi.' },
						narrative: { type: 'string', description: 'One-sentence description of the coin\'s story or hook.' },
						virality: { type: 'number', nullable: true, description: '0–1 estimated virality of the narrative.' },
						confidence: { type: 'number', nullable: true },
						tags: { type: 'array', items: { type: 'string' } },
						source: { type: 'string', description: 'Classifier that produced the narrative read.' },
					},
				},
				whos_in: {
					type: 'array',
					description: 'Classified trader roster — every wallet that touched this coin, annotated with their reputation.',
					items: {
						type: 'object',
						properties: {
							wallet: { type: 'string' },
							label: { type: 'string', description: 'Trader archetype: smart_money, kol, sniper, whale, early_degen, recycler, dca_buyer, dca_seller, bot, unproven.' },
							score: { type: 'number', nullable: true, description: 'Brain reputation score (0–100).' },
							win_rate: { type: 'number', nullable: true, description: 'Historical win-rate (0–1).' },
							early_win_rate: { type: 'number', nullable: true, description: 'Win-rate on early entries specifically.' },
							source: { type: 'string', nullable: true, description: '"brain" (trained) or "gmgn" (seed corpus).' },
							tag: { type: 'string', nullable: true, description: 'Social handle when known (from seed corpus).' },
							buy_sol: { type: 'number', description: 'Total SOL bought.' },
							sell_sol: { type: 'number', description: 'Total SOL sold.' },
							is_creator: { type: 'boolean' },
							funder: { type: 'string', nullable: true, description: 'The wallet that funded this one (if identified).' },
						},
					},
				},
				outcome: {
					type: 'object',
					nullable: true,
					description: 'Labeled outcome if available.',
					properties: {
						outcome: { type: 'string' },
						graduated: { type: 'boolean' },
						rugged: { type: 'boolean' },
						ath_market_cap_usd: { type: 'number', nullable: true },
						ath_multiple: { type: 'number', nullable: true },
					},
				},
				url: { type: 'string', description: 'Oracle deep-link URL for this coin.' },
			},
			required: ['found'],
			additionalProperties: true,
		},
	},
	{
		name: 'pumpfun_upload_metadata',
		description:
			'Upload coin metadata (name, symbol, description, image) to IPFS and get back a pump.fun-ready metadata URI. Call this before launching a coin — pass the returned uri to the launch-agent endpoint or the studio launch flow. Requires a valid bearer token (API key). Image may be a public HTTPS URL or a base64 data URI (max 10 MB). The returned uri is a permanent ipfs:// link; the call is idempotent for the same content.',
		inputSchema: {
			type: 'object',
			properties: {
				name: { type: 'string', description: 'Coin name (1–32 chars).' },
				symbol: { type: 'string', description: 'Ticker symbol (1–10 chars, no $).' },
				description: { type: 'string', description: 'Coin description (max 500 chars).' },
				image_url: {
					type: 'string',
					description:
						'Image for the coin icon. Public HTTPS URL or base64 data URI (data:image/png;base64,…). Square image, at least 400×400 px, under 5 MB.',
				},
				twitter: { type: 'string', description: 'Twitter/X handle or URL (optional).' },
				telegram: { type: 'string', description: 'Telegram URL (optional).' },
				website: { type: 'string', description: 'Website URL (optional).' },
			},
			required: ['name', 'symbol', 'description', 'image_url'],
		},
		outputSchema: {
			type: 'object',
			properties: {
				uri: { type: 'string', description: 'ipfs:// URI ready for the pump.fun launch-agent `uri` field.' },
				cid: { type: 'string', description: 'IPFS CID of the metadata JSON.' },
				image_cid: { type: 'string', description: 'IPFS CID of the uploaded image.' },
				provider: { type: 'string', description: 'IPFS provider used.' },
			},
			required: ['uri', 'cid'],
			additionalProperties: false,
		},
	},
	{
		name: 'pumpfun_bot_status',
		description:
			'Returns the configuration and health status of the pump.fun indexer backend. Always available — does not require PUMPFUN_BOT_URL.',
		inputSchema: { type: 'object', properties: {}, required: [] },
		outputSchema: {
			type: 'object',
			properties: {
				configured: {
					type: 'boolean',
					description: 'true when PUMPFUN_BOT_URL is set on the server',
				},
				healthy: {
					type: 'boolean',
					description: 'true when the indexer answered the health ping',
				},
				latencyMs: {
					type: 'number',
					description: 'Round-trip ms of the health ping (configured backends only)',
				},
				error: {
					type: 'string',
					description: 'Failure reason when healthy is false',
				},
				message: {
					type: 'string',
					description: 'Human-readable note when the indexer is unconfigured',
				},
			},
			required: ['configured', 'healthy'],
			additionalProperties: true,
		},
	},
];

// Stamp title + annotations onto every tool from the map above. A tool added
// to TOOLS without a TOOL_ANNOTATIONS entry would ship un-annotated — the
// parity tests assert full coverage so that can't land silently.
for (const tool of TOOLS) {
	const annotations = TOOL_ANNOTATIONS[tool.name];
	if (annotations) {
		tool.title = annotations.title;
		tool.annotations = annotations;
	}
}

export function rpcError(code, message) {
	const err = new Error(message);
	err.rpcCode = code;
	return err;
}

export function rpcEnvelope(id, result, errObj) {
	if (errObj) {
		return { jsonrpc: '2.0', id: id ?? null, error: errObj };
	}
	return { jsonrpc: '2.0', id: id ?? null, result };
}
