// Static fallback copy of the pump.fun / Solana MCP tool surface.
//
// At runtime the server fetches the authoritative list from the canonical
// backend (tools/list). This vendored copy is only used when the backend is
// unreachable at startup, so a freshly-installed client still advertises a
// correct tool surface offline. Keep in sync with src/pump/mcp-tools.js in the
// three.ws repo — that file is the source of truth.

export const FALLBACK_TOOLS = [
	{
		name: 'searchTokens',
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
		name: 'getTokenDetails',
		description: 'Full details for a specific pump.fun token by mint address.',
		inputSchema: {
			type: 'object',
			properties: { mint: { type: 'string' } },
			required: ['mint'],
		},
	},
	{
		name: 'getBondingCurve',
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
	},
	{
		name: 'getTokenTrades',
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
		name: 'getTrendingTokens',
		description: 'Top pump.fun tokens by market cap.',
		inputSchema: {
			type: 'object',
			properties: { limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 } },
		},
	},
	{
		name: 'getNewTokens',
		description: 'Most recently launched pump.fun tokens.',
		inputSchema: {
			type: 'object',
			properties: { limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 } },
		},
	},
	{
		name: 'getGraduatedTokens',
		description: 'Tokens that graduated from the bonding curve to Raydium AMM.',
		inputSchema: {
			type: 'object',
			properties: { limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 } },
		},
	},
	{
		name: 'getKingOfTheHill',
		description: 'Highest-market-cap token still on the bonding curve.',
		inputSchema: { type: 'object', properties: {} },
	},
	{
		name: 'kol_radar',
		description:
			'gmgn radar signals: early-detection patterns filtered by category, sorted by score desc.',
		inputSchema: {
			type: 'object',
			properties: {
				category: {
					type: 'string',
					enum: ['pump-fun', 'new-mints', 'volume-spike'],
					default: 'pump-fun',
				},
				limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
			},
		},
	},
	{
		name: 'getCreatorProfile',
		description: 'All tokens by a creator wallet, with rug-pull risk flags.',
		inputSchema: {
			type: 'object',
			properties: { creator: { type: 'string' } },
			required: ['creator'],
		},
	},
	{
		name: 'getTokenHolders',
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
			'Read-only price quote for a pump.fun AMM swap. No signing or tx sending. One of inputMint/outputMint must be wSOL (So11111111111111111111111111111111111111112). Returns amountOut, priceImpactBps, route, expiresAtMs.',
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
];
