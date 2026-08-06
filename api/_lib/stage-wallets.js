// Where a stage host can legitimately be paid.
//
// The tip UI is handed the host agent's Solana address as the transfer target
// (api/stage/index.js readHostWallet), so that address is the destination a real
// tip credits. The agent's EVM wallet rides along because the platform's pay path
// also accepts USDC on Base, and a settlement there lands on the EVM side.
//
// One place, so the endpoint that TELLS a tipper where to send and the endpoint
// that VERIFIES where it went can never disagree about which wallets count.

import { sql } from './db.js';

export async function hostPayoutWallets(agentId) {
	if (!agentId) return [];
	const [row] = await sql`
		SELECT wallet_address, meta FROM agent_identities
		WHERE id = ${agentId} AND deleted_at IS NULL LIMIT 1
	`;
	if (!row) return [];
	const wallets = [row.meta?.solana_address, row.wallet_address];
	return [...new Set(wallets.filter((w) => typeof w === 'string' && w))];
}
