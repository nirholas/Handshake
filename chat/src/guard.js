// GuardChain preflight for fund-moving client tools.
//
// Before a wallet tool body runs (and before the wallet ever prompts), the
// call is preflighted through POST /api/agent/guard, the seven-layer policy
// engine from @three-ws/agent-runtime. A `block` verdict stops the tool
// without touching the wallet; `require_approval` and `allow` proceed into
// the existing TxApprovalModal, enriched with the verdict so the user sees
// WHY the platform thinks this call is fine, risky, or under-checked.
// Argument adjustments (the MEV slippage clamp) are applied before execution.
//
// Fail-open by design: this endpoint is defense-in-depth on top of the
// wallet-approval modal, which always gates signing. If the preflight is
// unreachable, the modal still stands between the model and the wallet, so
// losing the enrichment is strictly better than bricking transfers.

import { writable } from 'svelte/store';

/** The most recent guard verdict, consumed by TxApprovalModal. */
export const lastGuardVerdict = writable(null);

/** Tools whose execution moves value out of the connected wallet. */
const FUND_MOVING_TOOLS = new Set([
	'solana_transfer',
	'solana_swap',
	'evm_transfer',
	'evm_swap',
	'pumpfunBuy',
	'pumpfunSell',
	'pumpfunSellAll',
	'LaunchPumpToken',
	'MintScene',
	'agentPaymentsDistribute',
	'agentPaymentsWithdraw',
]);

export function isFundMovingTool(name) {
	return FUND_MOVING_TOOLS.has(name);
}

/** Pull the destination/token facts the firewall layers understand. */
function callFacts(name, args = {}) {
	const destination = args.recipient || args.destination || args.to || undefined;
	const token = args.token || args.inputMint || args.fromToken || args.mint || undefined;
	return { destination, token };
}

/**
 * Preflight one tool call. Resolves to the GuardChain verdict
 * ({ decision, reason, layers, warnings, blindSpots, coverageScore,
 * modifiedArguments }) or null when the guard endpoint cannot be reached.
 */
export async function guardPreflight(name, args) {
	const { destination, token } = callFacts(name, args);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 5000);
	try {
		const res = await fetch('/api/agent/guard', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			signal: controller.signal,
			body: JSON.stringify({
				calls: [
					{
						identifier: name,
						apiName: name,
						arguments: args || {},
						destination,
						token,
						// The wallet modal always gates these tools, so the
						// intervention layer should agree with reality.
						interventionConfig: 'required',
					},
				],
				approvalMode: 'manual',
			}),
		});
		if (!res.ok) return null;
		const data = await res.json();
		const verdict = data?.verdicts?.[0]?.verdict || null;
		if (verdict) lastGuardVerdict.set(verdict);
		return verdict;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}
