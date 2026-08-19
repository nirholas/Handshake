// Centralized env for the onchain-agent-wallets MCP.
//
// Custody model: the OWNER's wallet holds the money. An agent is a separate
// keypair that is granted a capped SPL Token delegation over a dedicated vault
// account the owner owns. The token program enforces the ceiling; this server
// enforces the finer guardrails (per-tx, daily, allowlists, expiry) before it
// ever signs. No key is ever baked in, and the owner lane can run entirely
// through Phantom / Solflare with no secret on this machine at all.

import { homedir } from 'node:os';
import { join } from 'node:path';

export function env(key, fallback) {
	const v = typeof process !== 'undefined' && process.env ? process.env[key] : undefined;
	return v !== undefined && String(v).trim() !== '' ? String(v).trim() : fallback;
}

// Default cluster for every tool. Any tool can override per-call with `network`.
export const NETWORK = (() => {
	const raw = env('OAW_NETWORK', env('SOLANA_NETWORK', 'mainnet')).toLowerCase();
	if (raw === 'devnet') return 'devnet';
	if (raw === 'mainnet' || raw === 'mainnet-beta') return 'mainnet';
	throw Object.assign(new Error(`OAW_NETWORK must be "mainnet" or "devnet" (got "${raw}")`), {
		code: 'bad_network_config',
	});
})();

export const DEFAULT_RPC = {
	mainnet: 'https://api.mainnet-beta.solana.com',
	devnet: 'https://api.devnet.solana.com',
};

// Transactions are signed and broadcast over this URL, so plaintext http
// outside localhost is a MITM risk on funds. Refuse it at load.
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

export const SOLANA_RPC_URL = validateRpcUrl(env('SOLANA_RPC_URL', DEFAULT_RPC[NETWORK]));

/** Resolve the RPC endpoint for a per-call network override. */
export function rpcFor(network) {
	const net = network === 'devnet' ? 'devnet' : 'mainnet';
	return net === NETWORK ? SOLANA_RPC_URL : DEFAULT_RPC[net];
}

// The owner's key. Optional: every owner action can instead be built unsigned
// and handed to Phantom / Solflare / Ledger through prepare_owner_transaction.
export const OWNER_SECRET = env('OWNER_SECRET_KEY', env('SOLANA_SECRET_KEY', ''));

// Where agent keypairs, policies, and the spend ledger live. One JSON file,
// written 0600. Override to relocate (a mounted volume, a per-project dir).
export const STATE_DIR = env('OAW_STATE_DIR', join(homedir(), '.onchain-agent-wallets'));
export const STATE_FILE = join(STATE_DIR, `state-${NETWORK}.json`);

// Anything that moves value requires an explicit confirm:true unless opted out.
export const REQUIRE_CONFIRM = (() => {
	const raw = env('REQUIRE_CONFIRM');
	if (raw === undefined) return true;
	return !['0', 'false', 'no', 'off'].includes(String(raw).toLowerCase());
})();

// Per-request timeout (ms) for off-chain fetches (x402 resources, registries).
export const HTTP_TIMEOUT_MS = (() => {
	const raw = env('OAW_TIMEOUT_MS');
	if (raw === undefined) return 30000;
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) {
		throw Object.assign(new Error(`OAW_TIMEOUT_MS must be a positive number (got "${raw}")`), { code: 'bad_config' });
	}
	return n;
})();

// three.ws API host: the cross-chain agent deployment feed.
export const THREE_WS_BASE = env('THREE_WS_BASE', 'https://three.ws').replace(/\/+$/, '');

export const USER_AGENT = '@three-ws/onchain-agent-wallets';
