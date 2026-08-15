// Centralized env access. The MCP server is user-keyed: every Solana
// signing operation requires the user to supply a keypair via env or via
// tool arguments. We never sign on behalf of someone with a baked-in key.

export function env(key, fallback) {
	const v = process.env[key];
	return v !== undefined && String(v).trim() !== '' ? String(v).trim() : fallback;
}

// Validate the Solana RPC endpoint at load time. We sign and broadcast real
// mainnet transactions over this URL, so a plaintext-http endpoint (outside of
// localhost) is a credential/MITM risk — reject it. http://localhost and
// http://127.0.0.1 are allowed for local validators in dev.
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

export const SOLANA_RPC_URL = validateRpcUrl(
	env('SOLANA_RPC_URL', 'https://api.mainnet-beta.solana.com'),
);
export const ETH_RPC_URL = env('ETH_RPC_URL') || env('MAINNET_RPC_URL') || null;

// Budget for one leg of `ens_sns_resolve`. Both lanes are multi-round-trip
// (ENS: registry → resolver → addr; SNS: two account reads on a derived PDA),
// and the free public endpoints both lanes fall back to are throttled, so a
// tight budget reports "timed out" for names that resolve fine. Raise it when
// you are pointing at a slow self-hosted RPC.
export const NAME_RESOLVE_TIMEOUT_MS = (() => {
	const raw = env('NAME_RESOLVE_TIMEOUT_MS');
	if (raw === undefined) return 15000;
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) {
		throw Object.assign(
			new Error(`NAME_RESOLVE_TIMEOUT_MS must be a positive number (got "${raw}")`),
			{ code: 'bad_policy_config' },
		);
	}
	return n;
})();
export const HELIUS_API_KEY = env('HELIUS_API_KEY', '');
export const OPENAI_API_KEY = env('OPENAI_API_KEY', '');
// NVIDIA NIM key (build.nvidia.com, nvapi-…) — powers the FREE Magpie TTS
// lane that leads the speak tool's provider chain; OpenAI is the paid backstop.
export const NVIDIA_API_KEY = env('NVIDIA_API_KEY', '');
export const REPLICATE_API_TOKEN = env('REPLICATE_API_TOKEN', '');
export const REPLICATE_TEXT_TO_AVATAR_MODEL = env('REPLICATE_TEXT_TO_AVATAR_MODEL', '');

// Optional default signer for Solana ops. Tools that sign accept a `secret`
// argument that overrides this on a per-call basis.
export const SOLANA_DEFAULT_SECRET = env('SOLANA_SECRET_KEY') || env('FUNDER_SECRET') || '';

// $three is the official three.ws token on pump.fun and the ONLY coin this
// server references by name. The `target:"three"` shortcut in pump_buy resolves
// to this CA. Operators may override THREE_MINT only to track an updated
// canonical $three contract — never to point the alias at a different coin.
export const THREE_MINT = env(
	'THREE_MINT',
	'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
);

export const VIEWER_BASE = env('VIEWER_BASE', 'https://three.ws/viewer');
export const THREE_WS_BASE = env('THREE_WS_BASE', 'https://three.ws');
