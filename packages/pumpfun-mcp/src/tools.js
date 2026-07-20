// Static fallback copy of the pump.fun / Solana MCP tool surface.
//
// At runtime the server fetches the authoritative list from the canonical
// backend (tools/list). This vendored copy is only used when the backend is
// unreachable at startup, so a freshly-installed client still advertises a
// correct tool surface offline. Keep in sync with src/pump/mcp-tools.js in the
// three.ws repo — that file is the source of truth.
//
// ── Pricing surfaces (what the descriptions below must keep straight) ────────
// This bridge performs no pricing of its own: every number is computed by the
// backend from live on-chain state. What lives here is the contract the model
// reads, so the two pump.fun pricing regimes must never be blurred together:
//
//   Pre-graduation  · pump program BondingCurve account. Spot price is
//     virtual_quote_reserves / virtual_token_reserves (both u64). Those
//     quote-side fields were renamed from virtual_sol_reserves /
//     real_sol_reserves when a non-SOL quote asset became possible; same u64s,
//     same offsets, new names, and the curve gained a quote_mint (the SOL
//     default on every coin created to date). Surfaced by get_bonding_curve and
//     social_x_post_impact.
//
//   Post-graduation · PumpSwap (pump_amm) Pool account. Quotes price against the
//     EFFECTIVE quote reserve, pool_quote_token_account.amount +
//     pool.virtual_quote_reserves, a field appended to Pool that carries a
//     non-zero value on boost pools from 2026-07-20. It is an i128, so it is
//     signed and effective depth can fall below the raw vault balance. The base
//     side is unchanged: still the raw pool_base_token_account.amount. Surfaced
//     by pumpfun_quote_swap.
//
// The two virtual_quote_reserves are DIFFERENT fields, on DIFFERENT accounts,
// with DIFFERENT widths, that happen to share a name. A coin has one or the
// other, never both.

// ── MCP ToolAnnotations (readOnlyHint/destructiveHint/idempotentHint/
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

// Canonical (snake_case) tool name ← legacy (camelCase) alias. The backend's
// tools/list only advertises canonical names; tools/call accepts BOTH forever.
// Vendored copy of TOOL_NAME_ALIASES from src/pump/mcp-tools.js in the
// three.ws repo — that file is the single source of truth.
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

const CANONICAL_TO_LEGACY = Object.freeze(
	Object.fromEntries(
		Object.entries(TOOL_NAME_ALIASES).map(([legacy, canonical]) => [canonical, legacy]),
	),
);

// Resolve a tool name to its canonical (snake_case) form. Unknown names pass
// through unchanged. hasOwn guard: "__proto__"/"constructor" must not resolve
// an inherited member.
export function resolveToolName(name) {
	if (typeof name === 'string' && Object.hasOwn(TOOL_NAME_ALIASES, name)) {
		return TOOL_NAME_ALIASES[name];
	}
	return name;
}

// The other spelling of an aliased tool name (canonical → legacy, legacy →
// canonical), or null when the name has no alias. Used by the bridge to retry
// a tools/call once against an older or newer deployed backend that only
// understands one spelling.
export function alternateToolName(name) {
	if (typeof name !== 'string') return null;
	if (Object.hasOwn(TOOL_NAME_ALIASES, name)) return TOOL_NAME_ALIASES[name];
	if (Object.hasOwn(CANONICAL_TO_LEGACY, name)) return CANONICAL_TO_LEGACY[name];
	return null;
}

// name → { title, ...ToolAnnotations }. Stamped onto FALLBACK_TOOLS below and
// overlaid by src/index.js onto whatever tool list loads from the backend, so
// annotations render even against an older deployed backend. Keys are the
// canonical snake_case names — overlay callers resolve legacy names through
// resolveToolName first.
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
	pumpfun_quote_swap: { title: 'Swap Quote (Read-Only)', ...LIVE_READ },
	social_x_post_impact: { title: 'X Post Price Impact', ...LIVE_READ },
	pumpfun_bot_status: { title: 'Indexer Status', ...LIVE_READ },
});

// outputSchema policy (mirrors src/pump/mcp-tools.js): only tools whose
// response shape is code-controlled and genuinely stable advertise one.
// Upstream-shaped passthrough feeds deliberately ship NO outputSchema — a
// wrong schema is worse than none.
export const FALLBACK_TOOLS = [
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
			'Bonding curve analysis: real reserves, virtual reserves, and graduation progress (on-chain). ' +
			'Pre-graduation only: the reserves come from the pump program bonding-curve account, not from a ' +
			'PumpSwap pool. Pump renamed the quote-side fields (real_sol_reserves → real_quote_reserves, ' +
			'virtual_sol_reserves → virtual_quote_reserves) when a non-SOL quote asset became possible; the ' +
			'response keys below keep their original names and are still denominated in SOL, because the curve ' +
			'quote_mint is the SOL default on every coin created to date. Once complete=true the curve is ' +
			'retired and pricing moves to the PumpSwap pool, so use pumpfun_quote_swap from that point on.',
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
				solReserves: {
					type: 'string',
					description:
						'Real quote reserves in SOL (4-decimal string). On-chain field: real_quote_reserves.',
				},
				tokenReserves: {
					type: 'string',
					description: 'Real token reserves (raw base units)',
				},
				virtualSolReserves: {
					type: 'string',
					description:
						'Virtual quote reserves in lamports. On-chain field: virtual_quote_reserves. ' +
						'Spot price = virtual_quote_reserves / virtual_token_reserves. Distinct from the ' +
						'identically-named PumpSwap Pool.virtual_quote_reserves, which applies only after graduation.',
				},
				virtualTokenReserves: {
					type: 'string',
					description: 'Virtual token reserves (raw base units)',
				},
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
				suffix: {
					type: 'string',
					description: 'Desired address suffix (case-insensitive by default)',
				},
				prefix: {
					type: 'string',
					description: 'Desired address prefix (case-insensitive by default)',
				},
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
				minUsd: {
					type: 'number',
					description: 'Minimum trade value in USD (default 5000)',
				},
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
					description:
						'Array of post objects. Each must have a text field; id, ts, and author are optional.',
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
			'Read-only price quote for a pump.fun (PumpSwap) AMM swap on a GRADUATED coin. No signing or tx ' +
			'sending. One of inputMint/outputMint must be wSOL (So11111111111111111111111111111111111111112). ' +
			'Returns amountOut, priceImpactBps, route, expiresAtMs. Pricing follows PumpSwap exactly: the ' +
			'quote side is the EFFECTIVE reserve, pool_quote_token_account.amount + pool.virtual_quote_reserves ' +
			'(non-zero on launchpad coins since 2026-07-20), while the base side is the raw ' +
			'pool_base_token_account.amount, unchanged. Coins still on the bonding curve have no pool, so use ' +
			'get_bonding_curve instead. The quote is a snapshot: honour expiresAtMs and re-quote after it.',
		inputSchema: {
			type: 'object',
			properties: {
				inputMint: { type: 'string', description: 'Input token mint (base58).' },
				outputMint: { type: 'string', description: 'Output token mint (base58).' },
				amountIn: {
					type: 'number',
					description: 'Input amount in raw base units (lamports for SOL).',
				},
				slippageBps: {
					type: 'number',
					description: 'Slippage tolerance in basis points (default 100 = 1%).',
				},
				network: { type: 'string', enum: ['mainnet', 'devnet'], default: 'mainnet' },
			},
			required: ['inputMint', 'outputMint', 'amountIn'],
		},
		outputSchema: {
			type: 'object',
			properties: {
				amountOut: {
					type: 'string',
					description:
						'Expected output in raw base units (lamports when the output is wSOL), fee-inclusive.',
				},
				priceImpactBps: {
					type: 'number',
					description:
						'Execution price vs. the pool spot price, in basis points. Spot is measured against the ' +
						'effective quote reserve (vault + virtual), so virtual liquidity correctly reads as depth ' +
						'rather than as impact.',
				},
				route: {
					type: 'string',
					description: 'PumpSwap pool address the quote was priced on.',
				},
				expiresAtMs: {
					type: 'number',
					description:
						'Unix ms after which this quote is stale and must be re-requested.',
				},
				// Reserve provenance, so the quote above can be reproduced rather
				// than taken on trust.
				base_reserve: {
					type: 'string',
					description:
						'Raw base vault balance (pool_base_token_account.amount). Unaffected by virtual reserves.',
				},
				quote_reserve: {
					type: 'string',
					description:
						'Raw quote vault balance (pool_quote_token_account.amount), before virtual reserves.',
				},
				virtual_quote_reserves: {
					type: 'string',
					description:
						'Pool.virtual_quote_reserves, an i128. Quote-side liquidity held outside the vault. 0 on non-boost pools. SIGNED: may be negative, so do not parse it unsigned.',
				},
				effective_quote_reserve: {
					type: 'string',
					description:
						'quote_reserve + virtual_quote_reserves. The reserve the quote is actually priced against.',
				},
			},
			required: ['amountOut', 'priceImpactBps', 'route', 'expiresAtMs'],
			// Stays open so the backend can add fields without a release here.
			additionalProperties: true,
		},
	},
	{
		name: 'social_x_post_impact',
		description:
			'Correlate an X (Twitter) post to a memecoin price impact. Fetches post metadata via oEmbed (no API key) and computes price delta from the pump.fun bonding curve in a ±windowMin window around the post. Bonding-curve pricing (virtual_quote_reserves / virtual_token_reserves), so it applies to coins that have not graduated; a graduated coin has no curve and the call fails rather than returning a zero price.',
		inputSchema: {
			type: 'object',
			properties: {
				postUrl: {
					type: 'string',
					description: 'X post URL (e.g. https://x.com/user/status/123)',
				},
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
				error: { type: 'string', description: 'Failure reason when healthy is false' },
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

// Stamp title + annotations onto every fallback tool from the map above. The
// package test asserts full coverage so a new tool can't ship un-annotated.
for (const tool of FALLBACK_TOOLS) {
	const annotations = TOOL_ANNOTATIONS[tool.name];
	if (annotations) {
		tool.title = annotations.title;
		tool.annotations = annotations;
	}
}
