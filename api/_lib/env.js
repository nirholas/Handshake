// Centralized env access. Lazy by design: missing env vars fail at first use,
// not at module import, so unrelated endpoints (e.g. OAuth discovery) still
// respond when the deployment is partially configured.

function req(name) {
	const v = process.env[name];
	if (!v) throw new Error(`Missing required env var: ${name}`);
	return v;
}

function opt(name, fallback = undefined) {
	return process.env[name] ?? fallback;
}

function trimSlash(s) {
	return s ? s.replace(/\/$/, '') : s;
}

export const env = {
	get APP_ORIGIN() {
		return trimSlash(opt('PUBLIC_APP_ORIGIN', 'https://three.ws/'));
	},

	get DATABASE_URL() {
		return req('DATABASE_URL');
	},

	get S3_ENDPOINT() {
		return trimSlash(req('S3_ENDPOINT'));
	},
	get S3_ACCESS_KEY_ID() {
		return req('S3_ACCESS_KEY_ID');
	},
	get S3_SECRET_ACCESS_KEY() {
		return req('S3_SECRET_ACCESS_KEY');
	},
	get S3_BUCKET() {
		return req('S3_BUCKET');
	},
	get S3_PUBLIC_DOMAIN() {
		return trimSlash(req('S3_PUBLIC_DOMAIN'));
	},

	get UPSTASH_REDIS_REST_URL() {
		return opt('UPSTASH_REDIS_REST_URL');
	},
	get UPSTASH_REDIS_REST_TOKEN() {
		return opt('UPSTASH_REDIS_REST_TOKEN');
	},

	get JWT_SECRET() {
		return req('JWT_SECRET');
	},
	get JWT_KID() {
		return opt('JWT_KID', 'k1');
	},

	get PASSWORD_ROUNDS() {
		return parseInt(opt('PASSWORD_ROUNDS', '11'), 10);
	},

	get ISSUER() {
		return this.APP_ORIGIN;
	},
	get MCP_RESOURCE() {
		return `${this.APP_ORIGIN}/api/mcp`;
	},

	// Avaturn — photo-to-avatar pipeline. Only read when /api/onboarding/avaturn-session
	// is hit; keeping these optional so unrelated endpoints still respond when unset.
	get AVATURN_API_KEY() {
		return opt('AVATURN_API_KEY');
	},
	get AVATURN_API_URL() {
		return trimSlash(opt('AVATURN_API_URL', 'https://api.avaturn.me'));
	},

	// Anthropic API key — required by persona / memory-seeding endpoints
	// and used by the we-pay LLM proxy (/api/llm/anthropic) when an agent
	// selects a Claude model. Free OpenRouter/Groq models routed through
	// the same proxy use OPENROUTER_API_KEY / GROQ_API_KEY instead.
	get ANTHROPIC_API_KEY() {
		return req('ANTHROPIC_API_KEY');
	},

	// Etherscan V2 — unified multichain explorer API (one key, all chains).
	// Used by api/cron/erc8004-crawl.js to index ERC-8004 Registered events.
	get ETHERSCAN_API_KEY() {
		return opt('ETHERSCAN_API_KEY');
	},

	// Secret for Vercel Cron Authorization header (crons call with `Bearer $CRON_SECRET`).
	get CRON_SECRET() {
		return opt('CRON_SECRET');
	},

	// Mainnet RPC URL for ENS resolution. Falls back to ethers public default provider.
	// Recommended: set to an Alchemy / Infura URL for reliability.
	get MAINNET_RPC_URL() {
		return opt('MAINNET_RPC_URL');
	},

	// Base mainnet RPC URL — used by the SIWX server-side verifier (see
	// api/_lib/siwx-server.js) to validate EIP-1271 / EIP-6492 smart-contract
	// wallet signatures via viem's publicClient.verifyMessage. Without this,
	// SIWX falls back to EOA-only verification (still works for MetaMask /
	// Phantom EOAs; rejects Coinbase Smart Wallet, Safe, etc.). Defaults to
	// the same RPC the club-payouts cron uses so a single env var works.
	get BASE_RPC_URL() {
		return opt('BASE_RPC_URL', opt('CLUB_BASE_RPC_URL'));
	},

	// ── ERC-7710 Delegation Relayer ──────────────────────────────────────────
	// Private key of the server-held EOA that pays gas for redeemDelegations.
	// NEVER log this value. Rotate via Vercel env; derive AGENT_RELAYER_ADDRESS
	// from the key using: node -e "require('ethers').Wallet.createRandom().address"
	get AGENT_RELAYER_KEY() {
		return req('AGENT_RELAYER_KEY');
	},

	// Derived: checksummed address of the relayer EOA. Fund with testnet ETH.
	// Optional — can be computed from AGENT_RELAYER_KEY; provided here for ops convenience.
	get AGENT_RELAYER_ADDRESS() {
		return opt('AGENT_RELAYER_ADDRESS');
	},

	// Comma-separated wallet addresses (EVM or Solana) that have admin access.
	// Bootstrap: set to your own wallet address. Can also be promoted via DB is_admin flag.
	get ADMIN_ADDRESSES() {
		const raw = opt('ADMIN_ADDRESSES', '');
		return new Set(
			raw
				.split(',')
				.map((a) => a.trim().toLowerCase())
				.filter(Boolean),
		);
	},

	// Feature flag. Set to "true" to enable POST /api/permissions/redeem.
	// Defaults to false so the endpoint is opt-in per environment.
	get PERMISSIONS_RELAYER_ENABLED() {
		return opt('PERMISSIONS_RELAYER_ENABLED', 'false') === 'true';
	},

	// IPFS pinning provider credentials. Optional — when unset, pin endpoints
	// fall back to a content-hash stub so the rest of the flow still works in
	// dev. Set PINATA_JWT in production for real pins.
	get PINATA_JWT() {
		return opt('PINATA_JWT');
	},

	// Per-chain RPC URLs for on-chain delegation calls.
	// Pattern: RPC_URL_<CHAINID> e.g. RPC_URL_84532 for Base Sepolia.
	// Falls back to public RPC nodes when unset; set Alchemy/Infura URLs for production.
	// ── x402 (HTTP 402 micropayments) ───────────────────────────────────────
	// Per-network payTo wallets that receive USDC for paid /api/mcp calls.
	get X402_PAY_TO_SOLANA() {
		return opt(
			'X402_PAY_TO_SOLANA',
			opt('X402_PAY_TO', 'wwwPqsM4N7T9J69tB82nLyzxqsH159j4orftLTQfUGV'),
		);
	},
	get X402_PAY_TO_BASE() {
		return opt('X402_PAY_TO_BASE', '0x4022de2d36c334e73c7a108805cea11c0564f402');
	},
	// USDC asset addresses per network.
	get X402_ASSET_MINT_SOLANA() {
		return opt(
			'X402_ASSET_MINT_SOLANA',
			opt('X402_ASSET_MINT', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
		);
	},
	get X402_ASSET_ADDRESS_BASE() {
		return opt('X402_ASSET_ADDRESS_BASE', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
	},
	// Price per /api/mcp call, in the asset's base units (USDC = 6 decimals; "1000" = 0.001 USDC).
	get X402_MAX_AMOUNT_REQUIRED() {
		return opt('X402_MAX_AMOUNT_REQUIRED', '1000');
	},
	// USE-15 — TTL (seconds) for the payment-identifier idempotency cache.
	// Keyed by ${route}|${paymentId}; a second hit with the same id within the
	// window replays the cached response without re-charging. 1h default matches
	// the x402 docs' "long TTL" guidance for infrequently changing resources.
	// Per-route override via paidEndpoint({ paymentIdentifier: { ttlSeconds } }).
	get X402_IDEMPOTENCY_TTL_SECONDS() {
		return opt('X402_IDEMPOTENCY_TTL_SECONDS', '3600');
	},
	// Per-network facilitators. PayAI supports both Solana and Base mainnet;
	// x402.org's reference facilitator only supports base-sepolia, so it cannot
	// be the default for Base mainnet payments.
	get X402_FACILITATOR_URL_SOLANA() {
		return trimSlash(
			opt(
				'X402_FACILITATOR_URL_SOLANA',
				opt('X402_FACILITATOR_URL', 'https://facilitator.payai.network'),
			),
		);
	},
	get X402_FACILITATOR_URL_BASE() {
		return trimSlash(
			opt(
				'X402_FACILITATOR_URL_BASE',
				opt('X402_FACILITATOR_URL', 'https://facilitator.payai.network'),
			),
		);
	},
	get X402_FACILITATOR_TOKEN_SOLANA() {
		return opt('X402_FACILITATOR_TOKEN_SOLANA', opt('X402_FACILITATOR_TOKEN'));
	},
	get X402_FACILITATOR_TOKEN_BASE() {
		return opt('X402_FACILITATOR_TOKEN_BASE', opt('X402_FACILITATOR_TOKEN'));
	},
	// Coinbase Developer Platform x402 facilitator. When both keys are set,
	// Base-mainnet payments route through CDP (required for CDP Bazaar /
	// agentic.market listing — only endpoints whose first verify+settle is
	// processed by CDP get cataloged). Solana keeps routing to PayAI.
	get CDP_API_KEY_ID() {
		return opt('CDP_API_KEY_ID');
	},
	get CDP_API_KEY_SECRET() {
		return opt('CDP_API_KEY_SECRET');
	},
	get X402_CDP_FACILITATOR_URL() {
		return trimSlash(
			opt('X402_CDP_FACILITATOR_URL', 'https://api.cdp.coinbase.com/platform/v2/x402'),
		);
	},
	// Solana fee payer advertised in the 402 challenge's `extra.feePayer`.
	// Clients build the SPL transfer with this account paying SOL fees; the
	// facilitator co-signs on /settle. Must match whatever facilitator.payai.network
	// returns at /supported for `network:"solana"`.
	get X402_FEE_PAYER_SOLANA() {
		return opt('X402_FEE_PAYER_SOLANA', '2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4');
	},

	// ERC-8021 builder-code app identifier. When set, every 402 challenge
	// advertises the `builder-code` extension declaring this as `info.a`,
	// every paid request must echo it (anti-tamper), and the facilitator
	// appends a CBOR suffix to settlement-tx calldata so off-chain parsers
	// can attribute payment volume to this app. Pattern: `^[a-z0-9_]{1,32}$`.
	// Leave unset to disable on-chain attribution.
	get X402_BUILDER_CODE_APP() {
		return opt('X402_BUILDER_CODE_APP');
	},
	// Wallet builder code our outbound buyer clients self-attribute with.
	// Populates PaymentPayload.extensions["builder-code"].w so settlement
	// CBOR records the wallet that paid alongside the app that exposed.
	get X402_BUILDER_CODE_WALLET() {
		return opt('X402_BUILDER_CODE_WALLET');
	},

	// Spending caps for buyer clients (USE-22). Atomic micro-USD; leave
	// unset to disable that cap. Read by x402-spending-cap.js when callers
	// don't pass an explicit per-route override.
	get X402_MAX_PER_CALL_ATOMIC() {
		return opt('X402_MAX_PER_CALL_ATOMIC');
	},
	get X402_MAX_PER_HOUR_ATOMIC() {
		return opt('X402_MAX_PER_HOUR_ATOMIC');
	},
	get X402_MAX_PER_DAY_ATOMIC() {
		return opt('X402_MAX_PER_DAY_ATOMIC');
	},

	// USE-23: shared secret that lets internal Vercel functions skip the 402
	// challenge on our own paid endpoints by sending X-API-Key: <this value>.
	// Compared with constant-time equality in api/_lib/x402/access-control.js.
	// Generate with: openssl rand -base64 32
	get INTERNAL_API_KEY() {
		return opt('INTERNAL_API_KEY');
	},

	// EVM mainnet chains accepted by /api/x402/* paid endpoints — defaults to
	// Base + Arbitrum because those are the two CDP-Bazaar-supported networks
	// the seller wizard currently exposes. Comma-separated CAIP-2 IDs.
	get X402_EVM_NETWORKS() {
		return opt('X402_EVM_NETWORKS', 'eip155:8453,eip155:42161')
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
	},
	// Native (non-bridged) USDC on Arbitrum One mainnet.
	get X402_ASSET_ADDRESS_ARBITRUM() {
		return opt('X402_ASSET_ADDRESS_ARBITRUM', '0xaf88d065e77c8cC2239327C5EDb3A432268e5831');
	},
	// Binance-Peg USD Coin (USDC) on BSC mainnet. Standard ERC-20; does NOT
	// implement EIP-3009 transferWithAuthorization, which is why BSC x402
	// payments use the contract-mediated "direct" scheme (see x402-bsc-direct.js).
	get X402_ASSET_ADDRESS_BSC() {
		return opt('X402_ASSET_ADDRESS_BSC', '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d');
	},
	// ThreeWSPayments x402 receiver contract on BSC. Client calls
	// pay(bytes32 ref) after approving USDC; the contract pulls pricePerCall
	// (1000 base units = $0.001) and emits Payment(payer, amount, ref).
	// Source + deploy tx: contracts/DEPLOYMENTS.md
	get X402_PAY_TO_BSC() {
		return opt('X402_PAY_TO_BSC', '0x00000000381f09742a30a5a49975514AeC1B72Cc');
	},
	// Optional operator EOA private key for scripts/erc8004-mint-bsc.mjs.
	// Used to register marketplace agents on the BSC IdentityRegistry. Never
	// referenced by request handlers — keep it out of the serverless surface.
	get BSC_OPERATOR_KEY() {
		return opt('BSC_OPERATOR_KEY');
	},

	// ── x402 Offer & Receipt extension (USE-17) ─────────────────────────────
	// DEDICATED signing key for the offer-receipt extension. MUST NOT be any
	// X402_PAY_TO_* key — those receive funds; this one only signs commitments.
	// Generate with: node -e "console.log(require('viem/accounts').generatePrivateKey())"
	// When unset, the extension is silently disabled (no signed offers/receipts
	// are emitted; 402/200 bodies stay protocol-compatible without them).
	get OFFER_RECEIPT_SIGNING_PRIVATE_KEY() {
		return opt('OFFER_RECEIPT_SIGNING_PRIVATE_KEY');
	},
	// "eip712" (default — uses the dedicated EOA above as a did:pkh signer) or
	// "jws" (uses a JWK private key from OFFER_RECEIPT_JWK to sign Ed25519 /
	// ES256K with a did:web kid resolved at /.well-known/did.json).
	get OFFER_RECEIPT_FORMAT() {
		return opt('OFFER_RECEIPT_FORMAT', 'eip712');
	},
	// JWK private key (JSON string) used when OFFER_RECEIPT_FORMAT=jws. The
	// public components are published in /.well-known/did.json so verifiers can
	// resolve the kid back to a key. Generate with `jose newkey -s 256 -t OKP -c EdDSA`.
	get OFFER_RECEIPT_JWK() {
		return opt('OFFER_RECEIPT_JWK');
	},
	// JWS algorithm (default EdDSA — Ed25519). Other supported: ES256K (secp256k1).
	get OFFER_RECEIPT_JWS_ALG() {
		return opt('OFFER_RECEIPT_JWS_ALG', 'EdDSA');
	},
	// Bare hostname for did:web identifiers (omit scheme + path). Used to build
	// kid = `did:web:<SERVER_DOMAIN>#key-1` and the matching `id` field in
	// /.well-known/did.json. Defaults to the host parsed from APP_ORIGIN.
	get SERVER_DOMAIN() {
		const explicit = opt('SERVER_DOMAIN');
		if (explicit) return explicit;
		try {
			return new URL(this.APP_ORIGIN).host;
		} catch {
			return 'three.ws';
		}
	},

	// zauthx402 SDK — optional telemetry for x402 endpoints. When unset,
	// the SDK is not initialized and request monitoring is skipped.
	get ZAUTH_API_KEY() {
		return opt('ZAUTH_API_KEY');
	},

	// Set to "1" to enable verbose [zauthSDK:*] logs in Vercel.
	get ZAUTH_DEBUG() {
		return opt('ZAUTH_DEBUG');
	},

	// Solana RPC URL used for SNS reads/writes and NFT minting. Falls back to public mainnet RPC.
	get SOLANA_RPC_URL() {
		return opt('SOLANA_RPC_URL', 'https://api.mainnet-beta.solana.com');
	},

	// ── Lottery + Reflection coin (api/_lib/coin/*) ───────────────────────
	// Treasury keypair (base64-encoded 64-byte secret). Fee payer for every
	// lottery winner transfer + reflection batch transfer. Holds the SOL that
	// was claimed from the pump.fun creator vault.
	get COIN_TREASURY_SECRET_KEY_B64() {
		return opt('COIN_TREASURY_SECRET_KEY_B64');
	},
	// Per-mint pump.fun creator keypair, indexed by mint pubkey:
	//   COIN_CREATOR_SECRET_KEY_B64_<MINT_PUBKEY>=<base64-64-byte-secret>
	// Loaded lazily by api/_lib/coin/treasury.js#loadCoinCreatorFromCoin().
	// Alternative: store the base64 in coin_launches.metadata.creator_secret_b64
	// at register time (less secure than env; v2 should move to a KMS).

	// ── Pole Club tip sweep (api/_lib/club/*) ─────────────────────────────
	// Solana treasury keypair (base64-encoded 64-byte secret) that holds the
	// USDC received from /api/x402/dance-tip on Solana. Used by the
	// club-payouts cron to send accumulated tips to each dancer's wallet.
	get CLUB_SOLANA_TREASURY_SECRET_KEY_B64() {
		return opt('CLUB_SOLANA_TREASURY_SECRET_KEY_B64');
	},
	// EVM (Base mainnet) treasury private key (0x-prefixed hex). Holds the
	// USDC received from /api/x402/dance-tip on Base. Used by the club-payouts
	// cron to send accumulated tips to each dancer's EVM wallet.
	get CLUB_EVM_TREASURY_PRIVATE_KEY() {
		return opt('CLUB_EVM_TREASURY_PRIVATE_KEY');
	},
	// Base mainnet RPC URL. Falls back to the public node, but rate limits
	// will bite at >5 sweeps/minute — set this in production.
	get CLUB_BASE_RPC_URL() {
		return opt('CLUB_BASE_RPC_URL', 'https://mainnet.base.org');
	},

	// NFT.Storage API token — required for MintScene tool (uploads GLB + thumbnail + metadata to IPFS).
	// Obtain at https://nft.storage. When unset, /api/nft/mint-scene returns 503 not_configured.
	get NFT_STORAGE_TOKEN() {
		return opt('NFT_STORAGE_TOKEN');
	},

	// Metaplex Bubblegum compressed-NFT tree config — optional. When both are set, MintScene
	// uses the cNFT path (Bubblegum); otherwise falls back to a regular MPL Core NFT.
	get BUBBLEGUM_MERKLE_TREE() {
		return opt('BUBBLEGUM_MERKLE_TREE');
	},
	get BUBBLEGUM_TREE_AUTHORITY() {
		return opt('BUBBLEGUM_TREE_AUTHORITY');
	},

	// GitHub OAuth — social memory seeding. When unset, /api/auth/github/connect returns 501.
	get GITHUB_OAUTH_CLIENT_ID() {
		return opt('GITHUB_OAUTH_CLIENT_ID');
	},
	get GITHUB_OAUTH_CLIENT_SECRET() {
		return opt('GITHUB_OAUTH_CLIENT_SECRET');
	},

	// Admin key for three.ws chat brand config endpoint. Optional — when unset
	// the POST /api/chat/config endpoint returns 503.
	get CHAT_ADMIN_KEY() {
		return opt('CHAT_ADMIN_KEY');
	},

	// OpenRouter API key used by the server-side chat proxy (/api/chat/proxy).
	// Free-tier models are forwarded without exposing this key to the browser.
	get OPENROUTER_API_KEY() {
		return opt('OPENROUTER_API_KEY');
	},

	// Alibaba Cloud DashScope (international) — direct Qwen access. Used by
	// /api/brain/chat when the user selects a Qwen provider. Falls back to
	// OPENROUTER_API_KEY when unset.
	get DASHSCOPE_API_KEY() {
		return opt('DASHSCOPE_API_KEY');
	},

	// ModelScope inference token — for Qwen3-Coder-480B on ModelScope's
	// OpenAI-compatible endpoint. Optional companion to DASHSCOPE_API_KEY.
	get MODELSCOPE_API_KEY() {
		return opt('MODELSCOPE_API_KEY');
	},

	// Rider payment gate — Solana wallet that receives $THREE, and Helius webhook secret.
	get RIDER_VAULT_ADDRESS() {
		return opt('RIDER_VAULT_ADDRESS');
	},
	get RIDER_HELIUS_WEBHOOK_SECRET() {
		return opt('RIDER_HELIUS_WEBHOOK_SECRET');
	},

	// Neynar API key — used by POST /api/agents/:id/memory/seed/farcaster.
	// When unset, the endpoint returns 501 not_configured.
	get NEYNAR_API_KEY() {
		return opt('NEYNAR_API_KEY');
	},

	// OpenAI API key — used by TTS proxy (/api/tts/speak) and chat endpoints.
	// Never sent to the browser.
	get OPENAI_API_KEY() {
		return opt('OPENAI_API_KEY');
	},

	// ElevenLabs API key — used by TTS proxy and voice cloning endpoints.
	// Never sent to the browser.
	get ELEVENLABS_API_KEY() {
		return opt('ELEVENLABS_API_KEY');
	},

	// VoyageAI API key — used by /api/agents/:id/embed for text embeddings (voyage-3-lite).
	get VOYAGE_API_KEY() {
		return req('VOYAGE_API_KEY');
	},

	// X (Twitter) OAuth 2.0 PKCE — required for /api/auth/x/* and memory seeding.
	// Create an app at https://developer.twitter.com with Read permissions + OAuth 2.0 enabled.
	// When unset, /api/auth/x/connect returns 501 not_configured.
	get X_OAUTH_CLIENT_ID() {
		return opt('X_OAUTH_CLIENT_ID');
	},
	get X_OAUTH_CLIENT_SECRET() {
		return opt('X_OAUTH_CLIENT_SECRET');
	},

	// Livepeer AI Gateway — optional. When set, /api/inference/livepeer routes
	// to https://livepeer.studio/api/generate/llm with bearer auth (higher quota).
	// When unset, the demo falls back to the public dream gateway at
	// https://dream-gateway.livepeer.cloud/llm (no key, rate-limited).
	get LIVEPEER_API_KEY() {
		return opt('LIVEPEER_API_KEY');
	},

	// Dev.to syndication — required for the news admin's "Publish to Dev.to"
	// hook to do anything. Generate at https://dev.to/settings/extensions
	// (look for "Generate API Key"). When unset, syndication is skipped
	// silently and the admin shows "skipped: DEV_TO_API_KEY not set".
	get DEV_TO_API_KEY() {
		return opt('DEV_TO_API_KEY');
	},

	// Medium syndication — generate an integration token at
	// https://medium.com/me/settings/security (note: Medium's API is
	// deprecated for new accounts as of 2024 but still functions for
	// accounts that had API access enabled). MEDIUM_AUTHOR_ID is optional;
	// the syndicator auto-discovers it via /v1/me and caches in-memory.
	get MEDIUM_INTEGRATION_TOKEN() {
		return opt('MEDIUM_INTEGRATION_TOKEN');
	},
	get MEDIUM_AUTHOR_ID() {
		return opt('MEDIUM_AUTHOR_ID');
	},

	// Override URL for the @sparticuz/chromium-min binary pack. The "-min"
	// build excludes the chromium tarball from the npm package to keep the
	// function bundle small; this URL is downloaded once per warm container
	// and cached in /tmp. Default in render-glb.js tracks the version pinned
	// in package.json — set this only when upgrading chromium-min and the
	// upstream Sparticuz release tag drifts.
	get CHROMIUM_PACK_URL() {
		return opt('CHROMIUM_PACK_URL');
	},

	getRpcUrl(chainId) {
		return (
			opt(`RPC_URL_${chainId}`) ||
			(chainId === 84532 ? opt('BASE_SEPOLIA_RPC_URL') : null) ||
			(chainId === 11155111 ? opt('SEPOLIA_RPC_URL') : null) ||
			null
		);
	},
};
