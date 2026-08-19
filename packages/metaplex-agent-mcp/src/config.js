// Centralized env for the Metaplex Agent Registry MCP.
//
// This server is user-keyed: mints are signed by a Solana keypair the operator
// supplies (SOLANA_SECRET_KEY) or a per-call `secret` overrides. We never bake
// in a key. The read tools and the prepare/send wallet flow (Phantom, Solflare,
// any Solana wallet) work with no key at all.

export function env(key, fallback) {
	const v = typeof process !== 'undefined' && process.env ? process.env[key] : undefined;
	return v !== undefined && String(v).trim() !== '' ? String(v).trim() : fallback;
}

// Default cluster for every tool. Any tool can override per-call with `network`.
export const NETWORK = (() => {
	const raw = env('METAPLEX_AGENT_NETWORK', env('SOLANA_NETWORK', 'mainnet')).toLowerCase();
	if (raw === 'devnet') return 'devnet';
	if (raw === 'mainnet' || raw === 'mainnet-beta') return 'mainnet';
	throw Object.assign(
		new Error(`METAPLEX_AGENT_NETWORK must be "mainnet" or "devnet" (got "${raw}")`),
		{ code: 'bad_network_config' },
	);
})();

export const DEFAULT_RPC = {
	mainnet: 'https://api.mainnet-beta.solana.com',
	devnet: 'https://api.devnet.solana.com',
};

// Validate the Solana RPC endpoint at load. Mint transactions are signed and
// broadcast over this URL, so a plaintext-http endpoint (outside localhost) is
// a MITM risk.
function validateRpcUrl(raw) {
	let u;
	try {
		u = new URL(raw);
	} catch {
		throw Object.assign(new Error(`SOLANA_RPC_URL is not a valid URL: "${raw}"`), { code: 'bad_rpc_url' });
	}
	if (u.protocol === 'https:') return raw;
	const isLocal = ['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(u.hostname);
	if (u.protocol === 'http:' && isLocal) return raw;
	throw Object.assign(
		new Error(
			`SOLANA_RPC_URL must be https (got "${u.protocol}//${u.hostname}"). Only http://localhost is allowed for local dev.`,
		),
		{ code: 'insecure_rpc_url' },
	);
}

// RPC for the configured NETWORK. Bring your own (Helius / Quicknode / Triton)
// for production traffic; the public endpoints rate-limit hard.
export const SOLANA_RPC_URL = validateRpcUrl(env('SOLANA_RPC_URL', DEFAULT_RPC[NETWORK]));

/** Resolve the RPC endpoint for a per-call network override. */
export function rpcFor(network) {
	const net = network === 'devnet' ? 'devnet' : 'mainnet';
	return net === NETWORK ? SOLANA_RPC_URL : DEFAULT_RPC[net];
}

// Optional default signer (base58 secret key, or a JSON byte array). The mint
// and register tools accept a per-call `secret` that overrides this.
export const SOLANA_DEFAULT_SECRET = env('SOLANA_SECRET_KEY', env('FUNDER_SECRET', ''));

// three.ws API host: serves the /api/deployments cross-chain registration feed.
export const THREE_WS_BASE = env('THREE_WS_BASE', 'https://three.ws').replace(/\/+$/, '');

// Broadcasting a mint requires an explicit confirm:true unless opted out.
export const REQUIRE_CONFIRM = (() => {
	const raw = env('REQUIRE_CONFIRM');
	if (raw === undefined) return true;
	return !['0', 'false', 'no', 'off'].includes(String(raw).toLowerCase());
})();

// Per-request timeout (ms) for off-chain fetches (registration docs, the feed).
export const HTTP_TIMEOUT_MS = (() => {
	const raw = env('THREE_WS_TIMEOUT_MS');
	if (raw === undefined) return 30000;
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) {
		throw Object.assign(new Error(`THREE_WS_TIMEOUT_MS must be a positive number (got "${raw}")`), {
			code: 'bad_config',
		});
	}
	return n;
})();

// ── $THREE: the deploy fee and the holder waiver ──────────────────────────
//
// Every MAINNET deploy through this server carries a flat protocol fee, paid in
// SOL, in the SAME transaction that creates the asset (so a failed mint pays
// nothing). The fee lands in the wallet the three.ws $THREE buyback lane signs
// from, which turns platform revenue into on-chain $THREE buys
// (https://three.ws/api/three-token/stats is the public ledger).
//
// Holding $THREE is what makes it cheaper or free. The balance is read live from
// the paying wallet at build time; nothing is escrowed, staked, or spent.
// Devnet is always free, so a full rehearsal still costs nothing.

// $THREE is the only coin this server references, and the ONLY reason to
// override THREE_MINT is to track an updated canonical contract. Never point it
// at a different coin.
export const THREE_MINT = env('THREE_MINT', 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump');
export const THREE_DECIMALS = 6;

// Where the fee goes: the three.ws economy/buyback signer. Override only when
// self-hosting a fork whose fees should fund something else.
export const DEPLOY_FEE_WALLET = env('DEPLOY_FEE_WALLET', 'WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW');

function positiveNumber(key, fallback) {
	const raw = env(key);
	if (raw === undefined) return fallback;
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 0) {
		throw Object.assign(new Error(`${key} must be a non-negative number (got "${raw}")`), { code: 'bad_config' });
	}
	return n;
}

export const DEPLOY_FEE_SOL = positiveNumber('DEPLOY_FEE_SOL', 0.02);

export const DEPLOY_FEE_ENABLED = (() => {
	const raw = env('DEPLOY_FEE_ENABLED');
	if (raw === undefined) return true;
	return !['0', 'false', 'no', 'off'].includes(String(raw).toLowerCase());
})();

// Holder thresholds, in whole $THREE tokens, read from the paying wallet.
export const THREE_HALF_PRICE_AT = positiveNumber('THREE_HALF_PRICE_AT', 50_000);
export const THREE_FREE_AT = positiveNumber('THREE_FREE_AT', 250_000);

export const USER_AGENT = '@three-ws/metaplex-agent-mcp';
