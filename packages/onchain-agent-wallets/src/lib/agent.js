// Everything a spend needs, gathered in one place: the agent record, its
// keypair, live on-chain vault state, the owner's policy, and the rolling spend
// window. Tools stay thin because this is where the pipeline lives:
//
//     context -> authorize -> execute -> record
//
// Authorization always runs against numbers read from the chain in the same
// call, never against cached notes, so a revoke that landed one second ago is
// respected.

import { NETWORK } from '../config.js';
import { connectionFor, keypairFrom, mintDecimals, tokenProgramFor, fromBaseUnits, toBaseUnits } from './solana.js';
import { readVault, spendableUnits, vaultAddress } from './vault.js';
import { evaluateSpend, spentInWindow, normalizePolicy } from './policy.js';
import { getAgent, recordSpend, spendHistory } from './store.js';

/** Load an agent and everything currently true about it. */
export async function agentContext(agentId) {
	const record = getAgent(agentId);
	const connection = connectionFor(NETWORK);
	const programId = await tokenProgramFor(connection, record.mint);
	const decimals = await mintDecimals(connection, record.mint, programId);
	const vault = await readVault({ connection, vault: record.vault, programId });
	const policy = normalizePolicy({}, record.policy);
	const ledger = spendHistory(record.id);
	const spentToday = spentInWindow(ledger, { hours: 24 });

	return {
		record,
		connection,
		network: NETWORK,
		programId,
		decimals,
		vault,
		policy,
		ledger,
		spentToday,
		spendable: spendableUnits(vault),
		keypair: () => keypairFrom(record.agent_secret, `agent key for "${record.id}"`),
		human: (units) => fromBaseUnits(units, decimals),
		units: (amount) => toBaseUnits(amount, decimals),
	};
}

/**
 * Run the guardrails. Returns the decision on approval; on refusal it records
 * the denial in the ledger and throws an error carrying every check, so the
 * caller sees exactly which rule stopped it and what to change.
 */
export function authorizeSpend(ctx, { amount, recipient, host, confirm = false, kind, resource }) {
	const decision = evaluateSpend({
		policy: ctx.policy,
		amount,
		decimals: ctx.decimals,
		spentToday: ctx.spentToday,
		remainingAllowance: ctx.vault.exists ? ctx.vault.delegatedAmount : 0n,
		recipient,
		host,
		confirm,
	});

	if (!decision.allowed) {
		recordSpend({
			agent: ctx.record.id,
			kind: kind || 'spend',
			allowed: false,
			amount: ctx.human(amount),
			base_units: String(amount),
			mint: ctx.record.mint,
			recipient: recipient || null,
			resource: resource || null,
			code: decision.code,
			reason: decision.reason,
		});
		throw Object.assign(new Error(decision.reason), {
			code: decision.code,
			checks: decision.checks,
			policy: ctx.policy,
			spendable: ctx.human(ctx.spendable),
			spent_24h: ctx.human(ctx.spentToday),
		});
	}

	if (amount > ctx.spendable) {
		const shortfall = amount - ctx.spendable;
		throw Object.assign(
			new Error(
				`the vault can only cover ${ctx.human(ctx.spendable)} right now (short by ${ctx.human(shortfall)}). ` +
					`Vault balance ${ctx.human(ctx.vault.balance)}, remaining allowance ${ctx.human(ctx.vault.delegatedAmount)}. ` +
					'Ask the owner to run fund_agent_wallet.',
			),
			{ code: 'insufficient_vault', checks: decision.checks },
		);
	}

	return decision;
}

/** Write the successful spend to the ledger. The daily cap is computed from these rows. */
export function logSpend(ctx, entry) {
	return recordSpend({
		agent: ctx.record.id,
		allowed: true,
		mint: ctx.record.mint,
		...entry,
	});
}

/** The public view of an agent: no secret material, live on-chain numbers. */
export function describeAgent(ctx) {
	return {
		id: ctx.record.id,
		label: ctx.record.label || null,
		network: ctx.network,
		owner: ctx.record.owner,
		agent_address: ctx.record.agent_pubkey,
		vault: ctx.record.vault,
		mint: ctx.record.mint,
		asset: ctx.record.asset_symbol || null,
		created_at: ctx.record.created_at,
		vault_balance: ctx.human(ctx.vault.balance),
		allowance_remaining: ctx.human(ctx.vault.exists ? ctx.vault.delegatedAmount : 0n),
		spendable_now: ctx.human(ctx.spendable),
		spent_24h: ctx.human(ctx.spentToday),
		delegate_is_agent: ctx.vault.delegate === ctx.record.agent_pubkey,
		revoked: ctx.vault.exists && !ctx.vault.delegate,
		policy: ctx.policy,
		deployment: ctx.record.deployment || null,
	};
}

/** Confirm the on-chain delegation still names this agent. Cheap, and catches a silent revoke. */
export function assertDelegated(ctx) {
	if (!ctx.vault.exists) {
		throw Object.assign(new Error(`the vault for "${ctx.record.id}" does not exist on ${ctx.network} yet`), {
			code: 'no_vault',
		});
	}
	if (!ctx.vault.delegate) {
		throw Object.assign(
			new Error(`the owner has revoked "${ctx.record.id}". Run approve_agent_allowance to grant a new allowance.`),
			{ code: 'revoked' },
		);
	}
	if (ctx.vault.delegate !== ctx.record.agent_pubkey) {
		throw Object.assign(
			new Error(
				`the vault is delegated to ${ctx.vault.delegate}, not to this agent (${ctx.record.agent_pubkey}). ` +
					'An approve for a different key replaced this one.',
			),
			{ code: 'delegate_mismatch' },
		);
	}
	if (ctx.vault.frozen) {
		throw Object.assign(new Error('the vault token account is frozen by the mint authority'), { code: 'frozen' });
	}
}

export { vaultAddress };
