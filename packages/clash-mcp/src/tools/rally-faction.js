// `rally_faction` — spend taps as battle power for your faction. Write.
//
// Wraps POST /api/clash/rally. A war pass authorizes the rally; taps convert to
// power for the pass's faction this round (folded with the faction's live
// momentum, clamped per call, capped per wallet per round). Provide a `pass`
// from enlist_faction, or a `token` (+ optional `secret`) to auto-enlist and
// rally in one call.

import { z } from 'zod';

import { apiRequest } from '../lib/api.js';
import { enlist } from '../lib/clash.js';

export const def = {
	name: 'rally_faction',
	title: 'Rally power for a Coin Clash faction',
	// Write and NOT idempotent: every call appends power to the round. Not
	// destructive — no funds move and power can't be removed, it's a contribution.
	annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
	description:
		'Rally for a Coin Clash faction by spending taps as battle power for the current round. Authorize with either a `pass` (war pass from enlist_faction) or a `token` (+ optional `secret`) to auto-enlist first. `taps` (1–50 per call) convert to power, multiplied by the faction\'s live momentum and capped per wallet per round. Returns `{ epoch, mint, added, momentum, walletPower, walletCap, capped, factionPower, msLeft }` — `added` is the power this call contributed, `factionPower` the army\'s new round total, `capped` true once the wallet hits `walletCap`. Each call adds power (not idempotent); call repeatedly to keep rallying while the round clock (`msLeft`) runs.',
	inputSchema: {
		taps: z
			.number()
			.int()
			.min(1)
			.max(50)
			.describe('Taps to spend this call (1–50). Each tap is one base power point before momentum.'),
		pass: z
			.string()
			.optional()
			.describe('A war pass from enlist_faction. Provide this OR `token` to auto-enlist.'),
		token: z
			.string()
			.optional()
			.describe('Faction mint to auto-enlist for when no `pass` is given (uses `secret`/SOLANA_SECRET_KEY).'),
		secret: z
			.string()
			.optional()
			.describe('Base58 Solana secret, used only when auto-enlisting from `token`. Falls back to SOLANA_SECRET_KEY env.'),
	},
	// Failures throw so the server wrapper formats them and marks the result
	// isError - the same error channel the read tools use. Business failures
	// (bad arguments, an ineligible wallet) throw typed errors carrying their
	// context on `detail`, which the wrapper passes through.
	async handler(args) {
		let pass = args?.pass ? String(args.pass).trim() : '';

		// Auto-enlist path: no pass but a faction token → run the full proof and
		// rally with the freshly minted pass.
		let enlistment = null;
		if (!pass) {
			if (!args?.token) {
				throw Object.assign(new Error('Provide a `pass` from enlist_faction, or a `token` to auto-enlist.'), {
					code: 'validation_error',
				});
			}
			enlistment = await enlist({ token: args.token, secret: args.secret });
			if (!enlistment.eligible || !enlistment.warPass) {
				const message =
					enlistment.reason === 'not_a_holder'
						? `Wallet ${enlistment.wallet} does not hold ${enlistment.faction} - cannot rally for it.`
						: 'Enlistment was not eligible; no war pass issued.';
				throw Object.assign(new Error(message), {
					code: 'not_eligible',
					detail: { wallet: enlistment.wallet, faction: enlistment.faction, reason: enlistment.reason },
				});
			}
			pass = enlistment.warPass;
		}

		const data = await apiRequest('/api/clash/rally', {
			method: 'POST',
			body: { pass, taps: args.taps },
		});
		const d = data?.data ?? {};
		return {
			ok: true,
			...(enlistment ? { enlisted: { wallet: enlistment.wallet, amount: enlistment.amount, usd: enlistment.usd } } : {}),
			epoch: d.epoch ?? null,
			mint: d.mint ?? null,
			added: d.added ?? 0,
			momentum: d.momentum ?? 1,
			walletPower: d.walletPower ?? 0,
			walletCap: d.walletCap ?? null,
			capped: Boolean(d.capped),
			factionPower: d.factionPower ?? 0,
			msLeft: d.msLeft ?? null,
		};
	},
};
