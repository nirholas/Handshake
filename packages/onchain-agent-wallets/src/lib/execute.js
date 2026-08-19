// One gate for everything that moves value.
//
// Order is deliberate and identical for every tool:
//
//   1. Show the deal. Amount, asset, destination, chain, cost. If confirmation
//      is required and the caller did not pass confirm:true, nothing is built
//      and nothing is signed. The caller gets the table and stops.
//   2. Sign it, if this process is holding the relevant key.
//   3. Otherwise hand back an unsigned transaction for a real wallet to sign.
//
// Step 3 is why an owner never has to paste a secret key anywhere to use this
// server: the whole custody lane works through Phantom, Solflare, Backpack, or
// a Ledger.

import { REQUIRE_CONFIRM, OWNER_SECRET, NETWORK } from '../config.js';
import { keypairFrom, toPublicKey, accountLink } from './solana.js';
import { sendWithSigners, prepareForWallet } from './tx.js';

/** The owner's keypair if this process was given one, else null. */
export function ownerKeypair(secret) {
	const material = secret !== undefined && String(secret).trim() !== '' ? secret : OWNER_SECRET;
	return material ? keypairFrom(material, 'owner key') : null;
}

/**
 * Resolve who the owner is: an explicit address, the configured key, or fail
 * with an actionable message rather than a null dereference.
 */
export function resolveOwner({ owner, secret }) {
	if (owner) return toPublicKey(owner, 'owner').toBase58();
	const kp = ownerKeypair(secret);
	if (kp) return kp.publicKey.toBase58();
	throw Object.assign(
		new Error(
			'No owner given. Pass `owner` with your wallet address (the non-custodial path: you sign in Phantom), ' +
				'or set OWNER_SECRET_KEY to let this server sign for you.',
		),
		{ code: 'no_owner' },
	);
}

/**
 * Execute an owner-authorized action, or prepare it for a browser wallet.
 *
 * @param {object} input
 * @param {object} input.summary  the confirmation table: what is about to happen
 */
export async function ownerAction({
	connection,
	owner,
	instructions,
	confirm = false,
	secret,
	summary,
	network = NETWORK,
	note,
}) {
	if (REQUIRE_CONFIRM && !confirm) {
		return {
			ok: false,
			action: 'confirm_required',
			summary,
			message: 'Nothing has been signed or broadcast. Review the summary above, then re-issue with confirm:true.',
		};
	}

	const kp = ownerKeypair(secret);
	if (kp) {
		if (kp.publicKey.toBase58() !== String(owner)) {
			throw Object.assign(
				new Error(
					`the configured owner key is ${kp.publicKey.toBase58()} but this call targets ${owner}. ` +
						'Pass the matching `secret`, or drop `owner` to use the configured key.',
				),
				{ code: 'owner_mismatch' },
			);
		}
		const sent = await sendWithSigners({ connection, payer: kp.publicKey, instructions, signers: [kp], network });
		return { ok: true, action: 'sent', signed_by: 'owner_key', summary, ...sent };
	}

	const prepared = await prepareForWallet({ connection, payer: owner, instructions, network, note });
	return { ok: true, action: 'prepared_for_wallet', signed_by: 'your_wallet', summary, ...prepared };
}

/** Execute an agent-authorized action. The agent always holds its own key. */
export async function agentAction({ connection, keypair, instructions, network = NETWORK }) {
	return sendWithSigners({ connection, payer: keypair.publicKey, instructions, signers: [keypair], network });
}

/** Uniform confirmation table. Every value-moving tool renders one of these. */
export function summarize({ action, amount, asset, from, to, network = NETWORK, extra = {} }) {
	return {
		action,
		...(amount !== undefined ? { amount: `${amount} ${asset || ''}`.trim() } : {}),
		...(from ? { from, from_link: accountLink(from, network) } : {}),
		...(to ? { to, to_link: accountLink(to, network) } : {}),
		network: network === 'devnet' ? 'Solana devnet' : 'Solana mainnet',
		...extra,
	};
}
