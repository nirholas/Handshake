// Every address an agent can legitimately be paid at.
//
// A settlement recorded against an agent (an IRL pay, an x402 receipt) is only
// meaningful if the money actually reached that agent, which means knowing where
// "that agent" gets paid. Three sources, all real and all owner-controlled:
//
//   • the payout addresses on its published paid services (agent_paid_services),
//     which is where an x402 settlement for one of its skills actually lands,
//   • its custodial EVM wallet (agent_identities.wallet_address), and
//   • its custodial Solana wallet (meta.solana_address).
//
// An agent with none of these has no verifiable destination: callers decide what
// that means for them rather than getting a silent pass here.

import { sql } from './db.js';

export async function agentPayoutWallets(agentId) {
	if (!agentId) return [];
	const [identity] = await sql`
		SELECT wallet_address, meta FROM agent_identities
		WHERE id = ${agentId} AND deleted_at IS NULL LIMIT 1
	`.catch(() => []);
	const services = await sql`
		SELECT DISTINCT payout_address FROM agent_paid_services
		WHERE agent_id = ${agentId} AND archived_at IS NULL AND payout_address IS NOT NULL
	`.catch(() => []);

	const wallets = [
		identity?.meta?.solana_address,
		identity?.wallet_address,
		...services.map((r) => r.payout_address),
	];
	return [...new Set(wallets.filter((w) => typeof w === 'string' && w))];
}
