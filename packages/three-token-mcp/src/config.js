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

// Base URL of the three.ws API that serves /api/token/config and /api/token/price.
export const THREE_WS_BASE = env('THREE_WS_BASE', 'https://three.ws');

// Solana RPC. Bring your own (Helius / QuickNode / Triton) for production.
export const SOLANA_RPC_URL = env('SOLANA_RPC_URL', 'https://api.mainnet-beta.solana.com');

// Optional default signer (base58 secret key). Tools that burn accept a
// per-call `secret` argument that overrides this.
export const SOLANA_DEFAULT_SECRET = env('SOLANA_SECRET_KEY') || env('FUNDER_SECRET') || '';

// The Solana Memo program — every burn tx carries a memo so the transfer is
// attributable on-chain to this MCP.
export const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
