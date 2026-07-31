/**
 * Master wallet client: the browser-side layer over /api/user/wallet/*.
 *
 * Every call is real. There is no fixture path and no sample balance here: the
 * numbers this module returns are what the Solana and Base RPC reads returned
 * for the signed-in user's own custodial wallet, and the signatures are real
 * mainnet transactions.
 *
 * Every function resolves to a designed result and never throws, so the page
 * can render an error state instead of dying on an unhandled rejection:
 *
 *   { ok: true,  status, data }
 *   { ok: false, status, code, message }
 *
 * `code` is the machine-readable `error` the API returns (`insufficient_balance`,
 * `invalid_destination`, ...), which the page maps to human copy. Shape mirrors
 * agent-economy-hub.js so both wallet surfaces handle failure identically.
 *
 * Endpoints, all session-authed, all documented in docs/user-wallet.md:
 *   fetchWallet   → GET  /api/user/wallet              addresses + live balances
 *   createWallet  → POST /api/user/wallet              provision the keypairs
 *   fetchHistory  → GET  /api/user/wallet/history      on-chain signature history
 *   previewSend   → POST /api/user/wallet/send         {simulate:true}, signs nothing
 *   send          → POST /api/user/wallet/send         signs and broadcasts
 *   fetchMyAgents → GET  /api/agents                   funding destinations
 *   fundAgent     → POST /api/user/wallet/fund-agent   pay an agent you own
 */

import { consumeCsrfToken } from './api.js';

async function call(url, { method = 'GET', body = null } = {}) {
	try {
		const opts = { method, credentials: 'include', headers: {} };
		if (body != null) {
			opts.headers['content-type'] = 'application/json';
			opts.body = JSON.stringify(body);
		}
		// Writes carry a single-use CSRF token; reads do not need one.
		if (method !== 'GET') {
			const token = await consumeCsrfToken();
			if (token) opts.headers['x-csrf-token'] = token;
		}
		const r = await fetch(url, opts);
		let j = null;
		try {
			j = await r.json();
		} catch {
			/* empty or non-JSON body */
		}
		if (!r.ok) {
			return {
				ok: false,
				status: r.status,
				code: j?.error || 'error',
				message: j?.error_description || j?.message || `request failed (${r.status})`,
			};
		}
		return { ok: true, status: r.status, data: j };
	} catch (err) {
		return {
			ok: false,
			status: 0,
			code: 'network_error',
			message: err?.message || 'network error',
		};
	}
}

/**
 * The wallet plus live balances. `data.wallet` is null when the account has
 * never provisioned one, which is a success, not an error: the page turns it
 * into the create-wallet invitation rather than a failure state.
 */
export function fetchWallet() {
	return call('/api/user/wallet');
}

/** Provision the Solana + EVM keypair. Idempotent server-side. */
export function createWallet() {
	return call('/api/user/wallet', { method: 'POST' });
}

/** On-chain signature history for the master wallet's Solana address. */
export function fetchHistory(limit = 20) {
	const n = Math.min(Math.max(Number(limit) || 20, 1), 50);
	return call(`/api/user/wallet/history?limit=${n}`);
}

/**
 * Price a send without signing anything. The server runs the identical
 * validation, balance, rent and fee checks as a real send and returns
 * `{ simulation: { asset, destination, human_amount, usd_value, network } }`,
 * so the confirmation step shows numbers the chain actually produced rather
 * than numbers the browser guessed.
 */
export function previewSend({ destination, asset, amount }) {
	return call('/api/user/wallet/send', {
		method: 'POST',
		body: { destination, asset, amount, simulate: true },
	});
}

/** Sign and broadcast. Only ever called after the user confirms the preview. */
export function send({ destination, asset, amount }) {
	return call('/api/user/wallet/send', {
		method: 'POST',
		body: { destination, asset, amount },
	});
}

/** The signed-in user's agents, the only destinations fund-agent will accept. */
export function fetchMyAgents() {
	return call('/api/agents');
}

/**
 * Price an agent top-up without signing anything. Same ownership, balance, rent
 * and fee checks as the real call, and it never decrypts the wallet key. Returns
 * `{ simulation: { asset, agent_id, agent_wallet, human_amount, usd_value,
 * creates_token_account, token_account_rent_sol, network } }`.
 *
 * Two of those the browser genuinely cannot work out on its own: what `"max"`
 * resolves to, and whether this transfer also pays rent to open a token account
 * for the agent. Both are shown before the user confirms.
 */
export function previewFundAgent({ agentId, asset, amount }) {
	return call('/api/user/wallet/fund-agent', {
		method: 'POST',
		body: { agent_id: agentId, asset, amount, simulate: true },
	});
}

/** Top up an agent you own, in SOL or USDC. Only after the preview is confirmed. */
export function fundAgent({ agentId, asset, amount }) {
	return call('/api/user/wallet/fund-agent', {
		method: 'POST',
		body: { agent_id: agentId, asset, amount },
	});
}
