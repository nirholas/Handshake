// Centralized env access for the $THREE token MCP.
//
// This server is user-keyed: the on-chain burn is signed by a Solana keypair
// the operator supplies (SOLANA_SECRET_KEY) or that a tool call overrides with
// a per-call `secret`. We never bake in a key. Destination addresses (burn +
// treasury), token decimals, and live USD pricing all come from the PUBLIC
// three.ws token endpoints at runtime — nothing about the money split is
// hardcoded here, so it always tracks the canonical on-chain config.

export function env(key, fallback) {
	const v = process.env[key];
	return v !== undefined && String(v).trim() !== '' ? String(v).trim() : fallback;
}

// The ONLY coin this server may ever burn. The HTTP token config is fetched at
// runtime, but it is UNTRUSTED for the mint: token.js asserts the resolved mint
// equals this canonical $THREE CA before signing any burn. Hardcoding it here is
// the security control — a compromised/misconfigured endpoint cannot redirect a
// burn to a different token.
export const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

// The canonical Solana incinerator (unspendable). The burn leg must route here.
// An operator who runs a non-default burn sink pins it via THREE_BURN_ADDRESS,
// mirroring api/_lib/env.js. Absent that, only the incinerator is accepted.
export const INCINERATOR_ADDRESS = '1nc1nerator11111111111111111111111111111111';
export const EXPECTED_BURN_ADDRESS = env('THREE_BURN_ADDRESS', INCINERATOR_ADDRESS);

// Base URL of the three.ws API that serves /api/token/config and /api/token/price.
export const THREE_WS_BASE = env('THREE_WS_BASE', 'https://three.ws');

// Validate the Solana RPC endpoint at load time. Burns are signed and broadcast
// over this URL, so a plaintext-http endpoint (outside of localhost) is a
// MITM/credential risk — reject it. http://localhost is allowed for dev.
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
			`SOLANA_RPC_URL must be https (got "${u.protocol}//${u.hostname}"). ` +
				'Only http://localhost is allowed for local dev validators.',
		),
		{ code: 'insecure_rpc_url' },
	);
}

// Solana RPC. Bring your own (Helius / Quicknode / Triton) for production.
export const SOLANA_RPC_URL = validateRpcUrl(env('SOLANA_RPC_URL', 'https://api.mainnet-beta.solana.com'));

// Max USD value of $THREE a single burn may destroy. Default 100 — bounds a
// runaway/injected burn. Raise MAX_BURN_USD to allow larger burns.
export const MAX_BURN_USD = (() => {
	const raw = env('MAX_BURN_USD');
	if (raw === undefined) return 100;
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) {
		throw Object.assign(new Error(`MAX_BURN_USD must be a positive number (got "${raw}")`), { code: 'bad_policy_config' });
	}
	return n;
})();

// Irreversible burn requires an explicit confirm:true unless opted out.
export const REQUIRE_CONFIRM = (() => {
	const raw = env('REQUIRE_CONFIRM');
	if (raw === undefined) return true;
	return !['0', 'false', 'no', 'off'].includes(String(raw).toLowerCase());
})();

// Optional default signer (base58 secret key). Tools that burn accept a
// per-call `secret` argument that overrides this.
export const SOLANA_DEFAULT_SECRET = env('SOLANA_SECRET_KEY') || env('FUNDER_SECRET') || '';

// The Solana Memo program — every burn tx carries a memo so the transfer is
// attributable on-chain to this MCP.
export const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
