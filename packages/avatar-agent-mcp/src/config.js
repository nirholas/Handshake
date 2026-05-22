// Centralized env access. The MCP server is user-keyed: every Solana
// signing operation requires the user to supply a keypair via env or via
// tool arguments. We never sign on behalf of someone with a baked-in key.

export function env(key, fallback) {
	const v = process.env[key];
	return v !== undefined && String(v).trim() !== '' ? String(v).trim() : fallback;
}

export const SOLANA_RPC_URL = env('SOLANA_RPC_URL', 'https://api.mainnet-beta.solana.com');
export const ETH_RPC_URL = env('ETH_RPC_URL') || env('MAINNET_RPC_URL') || null;
export const HELIUS_API_KEY = env('HELIUS_API_KEY', '');
export const OPENAI_API_KEY = env('OPENAI_API_KEY', '');
export const REPLICATE_API_TOKEN = env('REPLICATE_API_TOKEN', '');
export const REPLICATE_TEXT_TO_AVATAR_MODEL = env('REPLICATE_TEXT_TO_AVATAR_MODEL', '');

// Optional default signer for Solana ops. Tools that sign accept a `secret`
// argument that overrides this on a per-call basis.
export const SOLANA_DEFAULT_SECRET = env('SOLANA_SECRET_KEY') || env('FUNDER_SECRET') || '';

// $three is the official three.ws token on pump.fun. Used as the canonical
// example mint in tool examples and README demos.
export const THREE_MINT = env(
	'THREE_MINT',
	// Placeholder until the user pins their real $three CA. Override via
	// the THREE_MINT env var when running the MCP.
	'',
);

export const VIEWER_BASE = env('VIEWER_BASE', 'https://three.ws/viewer');
export const THREE_WS_BASE = env('THREE_WS_BASE', 'https://three.ws');
