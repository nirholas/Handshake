// `enlist_faction` — prove you hold a faction's coin and get a war pass. Write.
//
// Runs the full enlist proof: requests a wallet-bound challenge, signs it
// locally with the soldier's Solana key, and submits the signature so the
// backend can verify it and confirm a live on-chain holding of the faction coin
// (api/clash enlist → enlist-verify). On success it returns a `warPass` — the
// credential rally_faction spends. Idempotent: re-enlisting the same wallet for
// the same faction just mints a fresh, equivalent pass; nothing accumulates and
// no funds move.

import { z } from 'zod';

import { enlist } from '../lib/clash.js';

export const def = {
	name: 'enlist_faction',
	title: 'Enlist in a Coin Clash faction',
	// Write, but non-destructive and idempotent: it proves a holding and issues a
	// pass; no value moves and re-running mints an equivalent pass.
	annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
	description:
		'Enlist the signer\'s wallet as a soldier in a Coin Clash faction and return a war pass. Requires the wallet to hold the faction coin: the tool requests a challenge, signs it with the wallet\'s Solana key (from the `secret` arg, or SOLANA_SECRET_KEY env), and the backend verifies the signature then checks a live on-chain holding. Returns `{ eligible, wallet, faction, amount, usd, warPass, reason, challengeExpiresAt }`. If `eligible` is false the wallet does not currently hold the coin (`reason: "not_a_holder"`) and `warPass` is null — buy/hold the coin and retry. Keep the `warPass`: pass it to rally_faction to spend taps as battle power. No funds move; the pass expires after ~30 minutes.',
	inputSchema: {
		token: z
			.string()
			.min(1)
			.describe('The faction coin mint to enlist for — must be a faction in get_clash_state.'),
		secret: z
			.string()
			.optional()
			.describe('Base58 Solana secret of the enlisting wallet. Falls back to SOLANA_SECRET_KEY env. The wallet must hold the faction coin.'),
	},
	// Failures (no signer, bad secret, upstream rejection) propagate to the
	// server wrapper, which formats them and marks the result isError - the same
	// error channel the read tools use. An ineligible wallet is NOT an error:
	// the proof ran and answered, so it returns ok:true with eligible:false.
	async handler(args) {
		const result = await enlist({ token: args?.token, secret: args?.secret });
		return { ok: true, ...result };
	},
};
