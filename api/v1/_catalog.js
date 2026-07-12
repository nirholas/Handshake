// Single source of truth for the unified three.ws API (/api/v1).
//
// Every versioned endpoint is registered here once. The discovery document
// (GET /api/v1) renders from this list, so the catalog and the live surface can
// never drift: adding a route means adding its entry here AND its handler file.
//
// Each entry:
//   id      stable usage/billing identifier (matches the handler's `name`)
//   method  HTTP method(s)
//   path    public path under the API base
//   auth    'public' | 'optional' | 'required'
//   scope   OAuth scope enforced for key/OAuth callers (when auth ≠ public)
//   summary one line, holder/developer readable
//   params  documented inputs (query for GET, body for POST)

export const API_META = {
	name: 'three.ws API',
	version: 'v1',
	base_url: '/api/v1',
	description:
		'One API for the three.ws platform: 3D generation, market & narrative intelligence, ' +
		'sentiment, and on-chain agent capabilities — one key, one rate-limit budget, one usage ledger.',
	auth: {
		scheme: 'Bearer',
		description:
			'Send a three.ws API key as `Authorization: Bearer sk_live_…`, an OAuth access token, ' +
			'or call from a signed-in browser session. Create and manage keys at /dashboard/developers.',
		scopes: [
			'avatars:read',
			'avatars:write',
			'avatars:delete',
			'profile',
			'memory:read',
			'memory:write',
			'agents:read',
			'agents:write',
		],
	},
	rate_limit: {
		window: '1m',
		limit: 120,
		keyed_by: 'api_key › user › ip',
		headers: ['RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'Retry-After'],
	},
	envelope: {
		success: '{ "data": … }',
		error: '{ "error": <code>, "error_description": <message> }',
	},
};

export const CATALOG = [
	{
		id: 'v1.ai.text_to_3d',
		method: 'POST',
		path: '/api/v1/ai/text-to-3d',
		auth: 'public',
		summary:
			'Free text→3D — the only text-to-mesh lane in the agent-payments ecosystem; textured GLB ' +
			'from a prompt, no key, no wallet. Draft tier runs on the NVIDIA NIM TRELLIS lane; free ' +
			'per-IP quota of 10/day, then 429 pointing at the paid /api/x402/forge tiers.',
		params: { prompt: 'string — describe a single object or character (3–1000 chars, required)' },
	},
	{
		id: 'v1.ai.image',
		method: 'POST',
		path: '/api/v1/ai/image',
		auth: 'public',
		summary:
			'Text→image for agents over x402 — 5 free images/day per IP, then $0.02 USDC/image, ' +
			'no API key. Runs on NVIDIA NIM / Google Vertex lanes; returns a durable image URL.',
		params: {
			prompt: 'string — image description (required, 3–2000 chars)',
			aspect_ratio: 'string — 1:1 | 16:9 | 9:16 | 4:3 | 3:4 | 3:2 | 2:3 (default 1:1)',
			seed: 'number — optional deterministic seed (honored on NIM/Replicate lanes)',
		},
	},
	{
		id: 'v1.sentiment',
		method: 'POST',
		path: '/api/v1/sentiment',
		auth: 'public',
		summary: 'Classify text sentiment (Positive / Negative / Neutral) with a deterministic score.',
		params: { text: 'string — the text to score (required)' },
	},
	{
		id: 'v1.market.intel',
		method: 'GET',
		path: '/api/v1/market/intel',
		auth: 'optional',
		scope: 'agents:read',
		summary: 'Recent narrative / market intelligence items, momentum-ranked.',
		params: {
			limit: 'number 1–50 (default 20)',
			category: 'string — filter by category (optional)',
			chain: 'string — filter by chain (optional)',
		},
	},
	{
		id: 'v1.market.projects',
		method: 'GET',
		path: '/api/v1/market/projects',
		auth: 'optional',
		scope: 'agents:read',
		summary: 'Momentum-ranked crypto projects with narrative scores.',
		params: {
			limit: 'number 1–50 (default 20)',
			page: 'number (default 1)',
			names: 'string — comma-separated project names to filter (optional)',
			chain: 'string — filter by chain (optional)',
		},
	},
	{
		id: 'v1.agents.resolve',
		method: 'GET',
		path: '/api/v1/agents/{caip}',
		auth: 'public',
		summary:
			'Resolve + verify an ERC-8004 / three.ws Card v1 agent by CAIP ref ' +
			'(eip155:<chainId>:<registry>/<tokenId>, URL-encoded).',
		params: { caip: 'path — URL-encoded CAIP agent ref (required)' },
	},
	{
		id: 'v1.ai.tts',
		method: 'POST',
		path: '/api/v1/ai/tts',
		auth: 'public',
		summary:
			'Text-to-speech (neural Magpie voices) — 10 free calls/day per IP (≤500 chars), ' +
			'then $0.005 USDC/call via x402. GET ?voices=1 lists voices. Returns base64 WAV/PCM.',
		params: {
			text: 'string — text to synthesize (required, ≤4096 chars; free tier ≤500)',
			voice: 'string — voice id (optional, default nova)',
			format: 'string — "wav" | "pcm" (optional, default wav)',
			language: 'string — BCP-47 tag (optional, default en-US)',
		},
	},
	{
		id: 'v1.ai.asr',
		method: 'POST',
		path: '/api/v1/ai/asr',
		auth: 'public',
		summary:
			'Speech-to-text (NVIDIA Riva) — 5 free clips/day per IP (≤60s), then $0.01 USDC/clip ' +
			'via x402. Accepts base64 JSON or raw audio/* bytes; returns transcript + confidence.',
		params: {
			audio: 'string — base64 audio in a JSON body, or raw bytes with an audio/* Content-Type (required)',
			format: 'string — wav | pcm | flac | ogg (optional)',
			language: 'string — BCP-47 tag (optional, default en-US)',
			words: 'string — "1" for word-level timestamps (optional)',
		},
	},
	{
		id: 'v1.token.security',
		method: 'GET',
		path: '/api/v1/token/security',
		auth: 'public',
		summary:
			'Rug-check any Solana token in one free call: authority status, holder concentration, ' +
			'liquidity depth — on-chain facts, no invented scores. Composes getAccountInfo + ' +
			'getTokenLargestAccounts + DexScreener into a report agents weigh themselves; 20/min per IP.',
		params: {
			address: 'string — base58 Solana mint address (required; EVM 0x… returns 400)',
		},
	},
	{
		id: 'v1.resolve',
		method: 'GET',
		path: '/api/v1/resolve',
		auth: 'public',
		summary:
			'Free name resolution — a high-frequency agent primitive. Resolve a .eth name to its ' +
			'Ethereum address via ENS, or a .sol name to its Solana owner via SNS; reverse-resolve an ' +
			'address back to its primary name in either direction. No key, no wallet; 30/min per IP.',
		params: {
			name: 'string — a name ending in .eth (ENS) or .sol (SNS) to resolve (required unless address is passed)',
			address: 'string — 0x… Ethereum or base58 Solana address to reverse-resolve (required unless name is passed)',
			chain: 'string — "ethereum" | "solana", optional hint validated against address (auto-detected from format when omitted)',
		},
	},
	{
		id: 'v1.robinhood.chain',
		method: 'GET',
		path: '/api/v1/robinhood/chain',
		auth: 'public',
		summary:
			'Robinhood Chain (4663) stats: block height, gas, tx/address counts, and chain TVL ' +
			'(now + 90-day history). Free, keyless, real data from Blockscout + DefiLlama; 60/min per IP.',
		params: {},
	},
	{
		id: 'v1.robinhood.stocks',
		method: 'GET',
		path: '/api/v1/robinhood/stocks',
		auth: 'public',
		summary:
			'The 24/7 Robinhood Chain tokenized-equity board: live Chainlink NAV vs. deepest Uniswap ' +
			'DEX price, premium/discount, uiMultiplier, 24h volume, and liquidity for every Stock ' +
			'Token — one on-chain multicall, never 95 RPC calls. Free, keyless; 60/min per IP.',
		params: {
			q: 'string — filter by symbol or name substring (optional)',
			sort: 'string — "symbol" | "volume" | "premium" | "liquidity" (default symbol)',
			dir: 'string — "asc" | "desc" (default desc, ignored for symbol)',
		},
	},
	{
		id: 'v1.robinhood.stocks-detail',
		method: 'GET',
		path: '/api/v1/robinhood/stocks-detail',
		auth: 'public',
		summary:
			'One Robinhood Chain Stock Token in depth: Chainlink NAV + recent round history, every ' +
			'DEX pair, premium/discount, holders, recent transfers, and contract links. Display-only ' +
			'— carries the US-persons eligibility disclosure. Free, keyless; 60/min per IP.',
		params: { symbol: 'string — Stock Token ticker, e.g. "AAPL" (required)' },
	},
	{
		id: 'v1.robinhood.coins',
		method: 'GET',
		path: '/api/v1/robinhood/coins',
		auth: 'public',
		summary:
			'Robinhood Chain memecoin screener (NOXA + The Odyssey launchpads) via CoinGecko ' +
			'categories: price, market cap, 24h/7d change, 7d sparkline. Free, keyless; 60/min per IP.',
		params: {
			category: 'string — "meme" | "stocks-ecosystem" | "ecosystem" (default meme)',
			sort: 'string — "market_cap" | "volume" | "gainers" | "losers" (default market_cap)',
		},
	},
	{
		id: 'v1.robinhood.coins-detail',
		method: 'GET',
		path: '/api/v1/robinhood/coins-detail',
		auth: 'public',
		summary:
			'One Robinhood Chain coin in depth: DexScreener market data (price, mcap, FDV, ' +
			'liquidity, volume, pools) + Blockscout holders/transfers/contract links. Non-security ' +
			'token, no eligibility gate. Free, keyless; 60/min per IP.',
		params: { address: 'string — 0x… token contract address (required)' },
	},
	{
		id: 'v1.robinhood.launches',
		method: 'GET',
		path: '/api/v1/robinhood/launches',
		auth: 'public',
		summary:
			'Recent Robinhood Chain launchpad activity (NOXA instant + The Odyssey bonding-curve), ' +
			'read from on-chain logs and enriched with DexScreener market data, newest first. ' +
			'Free, keyless; 60/min per IP.',
		params: { limit: 'number 1–60 (default 40)' },
	},
	{
		id: 'v1.pump.search',
		method: 'GET',
		path: '/api/v1/pump/search',
		auth: 'public',
		summary:
			'Free text search over Solana pump.fun / meme tokens by name, symbol, or mint (Birdeye-first, ' +
			'pump.fun-fallback). Pairs with trending/curve/launches/whales below to round out the free ' +
			'pump.fun family under /api/v1. No key; 60/min per IP.',
		params: {
			q: 'string — token name, symbol, or mint to search for (required)',
			limit: 'number 1–20 (default 8)',
		},
	},
	{
		id: 'v1.pump.trending',
		method: 'GET',
		path: '/api/v1/pump/trending',
		auth: 'public',
		summary:
			'Free, momentum-ranked "what\'s hot right now" feed for Solana tokens — fuses windowed volume, ' +
			'buy pressure, a volume-spike signal, and price change across pump.fun, DexScreener, and ' +
			'(best-effort) GMGN smart money into one 0–100 score. Same engine as GET /api/crypto/trending, ' +
			'capped slimmer for this door. No key; 60/min per IP.',
		params: {
			window: 'string — "5m" | "1h" | "24h" (default "1h") — trade window the score measures',
			limit: 'number 1–25 (default 20)',
			source: 'string — "pumpfun" | "all" (default "all") — "pumpfun" restricts to the pump.fun board',
		},
	},
	{
		id: 'v1.pump.curve',
		method: 'GET',
		path: '/api/v1/pump/curve',
		auth: 'public',
		summary:
			'Free bonding-curve / graduation status for a pump.fun mint — % to graduation, SOL in the ' +
			'curve, tokens remaining, market cap, and whether it has migrated to an AMM (Raydium / ' +
			'PumpSwap). Same engine as GET /api/crypto/bonding. No key; 60/min per IP.',
		params: {
			mint: 'string — base58 Solana pump.fun mint address (required), e.g. FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump ($THREE)',
		},
	},
	{
		id: 'v1.pump.launches',
		method: 'GET',
		path: '/api/v1/pump/launches',
		auth: 'public',
		summary:
			'Free, paginated feed of every coin launched THROUGH three.ws (not a generic pump.fun-wide ' +
			'feed — the platform\'s own launch directory), joined with the launching agent. Same query as ' +
			'the /launches page. No key; 60/min per IP.',
		params: {
			limit: 'number 1–100 (default 24)',
			offset: 'number (default 0)',
			network: 'string — "mainnet" | "devnet" (default "mainnet")',
			agent_id: 'string — uuid, restrict to one launching agent (optional)',
			min_tier: 'string — "prime" | "strong" | "lean" | "watch" | "avoid", oracle conviction floor (optional)',
		},
	},
	{
		id: 'v1.tokenized.launches',
		method: 'GET',
		path: '/api/v1/tokenized/launches',
		auth: 'public',
		summary:
			'Free, paginated feed of every generated 3D asset minted as a Metaplex Core NFT THROUGH ' +
			'three.ws — the NFT analogue of GET /api/v1/pump/launches. Each entry carries baked ' +
			'provenance, royalty terms, remix lineage (parent_mint), and — for a remix — the real ' +
			'royalty settlement routed to the source creator. No key; 60/min per IP.',
		params: {
			limit: 'number 1–100 (default 24)',
			offset: 'number (default 0)',
			network: 'string — "mainnet" | "devnet" (default "mainnet")',
			agent_id: 'string — uuid, restrict to one creating agent (optional)',
		},
	},
	{
		id: 'v1.robinhood.chain',
		method: 'GET',
		path: '/api/v1/robinhood/chain',
		auth: 'public',
		summary:
			'Robinhood Chain (4663) stats — live block height + gas price, ETH price, and TVL now + ' +
			'90-day history (DefiLlama). Free, keyless.',
		params: {},
	},
	{
		id: 'v1.robinhood.stocks',
		method: 'GET',
		path: '/api/v1/robinhood/stocks',
		auth: 'public',
		summary:
			'The 24/7 tokenized-equity board: Chainlink NAV price, deepest DEX price, premium/discount, ' +
			'uiMultiplier, and 24h DEX volume/liquidity for every Robinhood Chain Stock Token. Free, ' +
			'keyless, display-only (Stock Tokens are tokenized securities — see the disclosure field).',
		params: {
			q: 'string — filter by symbol/name substring (optional)',
			sort: 'string — "symbol" | "price" | "volume" | "liquidity" | "premium" (default "symbol")',
			dir: 'string — "asc" | "desc" (default depends on sort)',
		},
	},
	{
		id: 'v1.robinhood.stocks_detail',
		method: 'GET',
		path: '/api/v1/robinhood/stocks-detail',
		auth: 'public',
		summary:
			'One Stock Token in depth: Chainlink NAV + recent round history, every DEX pair, holders, ' +
			'recent transfers, and contract links. Free, keyless, display-only.',
		params: { symbol: 'string — ticker, e.g. "AAPL" (required)' },
	},
	{
		id: 'v1.robinhood.coins',
		method: 'GET',
		path: '/api/v1/robinhood/coins',
		auth: 'public',
		summary:
			'Robinhood Chain memecoin screener (CoinGecko "Robinhood Chain Meme" / "Stocks Ecosystem" ' +
			'categories) — price, market cap, 24h/7d change, 7-day sparkline. Free, keyless, non-security.',
		params: {
			category: 'string — "meme" | "stocks-ecosystem" | "ecosystem" (default "meme")',
			sort: 'string — "market_cap" | "volume" | "gainers" | "losers" (default "market_cap")',
		},
	},
	{
		id: 'v1.robinhood.coins_detail',
		method: 'GET',
		path: '/api/v1/robinhood/coins-detail',
		auth: 'public',
		summary:
			'One Robinhood Chain coin in depth (DexScreener + Blockscout): price, market cap, FDV, ' +
			'liquidity, every pool, holders, recent transfers. Free, keyless, non-security.',
		params: { address: 'string — 0x… token contract address (required)' },
	},
	{
		id: 'v1.robinhood.launches',
		method: 'GET',
		path: '/api/v1/robinhood/launches',
		auth: 'public',
		summary:
			'Recent token launches on NOXA (instant Uniswap v3) and The Odyssey (bonding curve), newest ' +
			'first, enriched with live market data where a pool exists. Free, keyless.',
		params: { limit: 'number 1–60 (default 40)' },
	},
	{
		id: 'v1.pump.whales',
		method: 'GET',
		path: '/api/v1/pump/whales',
		auth: 'public',
		summary:
			'Free whale / large-buy detection across pump.fun — facts only (which wallets moved how much ' +
			'SOL, and when), no invented bullish/bearish signal. The read version of the whale-activity ' +
			'oracle behind the paid /api/x402/pump-agent-audit; same scan engine as GET /api/crypto/whales. ' +
			'No key; 60/min per IP.',
		params: {
			mint: 'string — base58 Solana mint; omit for market-wide top whale wallets, or scope to one token (optional)',
			limit: 'number 1–25 (default 5)',
			minSol: 'number — single-buy SOL threshold to qualify as a whale (default 5)',
		},
	},
];
