/**
 * Subscription skill — recurring USDC payments via ERC-7710 delegation.
 *
 * Exports:
 *   setup     — browser: attach "Subscribe" action to agent UI
 *   execute   — browser: open grant modal, register subscription via API
 *   onPeriod  — server-side only: charge the period amount via the relayer
 *
 * onPeriod is imported by api/cron/run-subscriptions.js via dynamic import.
 * It must never be invoked from a browser context.
 */

const SKILL_ID = 'subscription';

// USDC contract addresses by chain ID.
const USDC_BY_CHAIN = {
	84532: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // Base Sepolia
	11155111: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', // Sepolia
};

/**
 * Build an ERC-20 transfer(address,uint256) calldata bundle.
 * Pure function — no imports required.
 *
 * @param {string} tokenAddr - ERC-20 contract address
 * @param {string} recipient - recipient address (EIP-55 or lowercase)
 * @param {string} amountBaseUnits - amount in base units (string)
 * @returns {{ to: string, value: string, data: string }}
 */
export function buildERC20Transfer(tokenAddr, recipient, amountBaseUnits) {
	// transfer(address,uint256) selector
	const selector = 'a9059cbb';
	const paddedAddr = recipient.toLowerCase().replace('0x', '').padStart(64, '0');
	const paddedAmt = BigInt(amountBaseUnits).toString(16).padStart(64, '0');
	return {
		to: tokenAddr,
		value: '0',
		data: '0x' + selector + paddedAddr + paddedAmt,
	};
}

/**
 * Attaches the "Subscribe · 5 USDC / week" action to the agent UI.
 *
 * @param {{ agent: object, host: object }} opts
 */
export async function setup({ agent, host }) {
	host.attachAction({
		id: SKILL_ID,
		label: 'Subscribe · 5 USDC / week',
		skillId: SKILL_ID,
	});
}

/**
 * Viewer's initial subscription action — runs in the browser only.
 *
 * 1. Opens the grant modal pre-filled with the weekly 5 USDC scope.
 * 2. On successful grant, POSTs to /api/agent-subscriptions.
 * 3. Confirms in chat with the expiry date.
 *
 * @param {{ agent: object, host: object, args: object }} opts
 */
export async function execute({ agent, host, args }) {
	const agentId = agent.agentId ?? agent.id;
	const chainId = agent.chainId ?? 84532;

	const scopePreset = {
		token: USDC_BY_CHAIN[chainId] ?? USDC_BY_CHAIN[84532],
		maxAmount: '5000000',
		period: 'weekly',
		targets: [],
		expiry_days: 90,
	};

	let delegation;
	try {
		const { openGrantModal } = await import('/src/permissions/grant-modal.js');
		delegation = await openGrantModal({ agent, scopePreset });
	} catch {
		host.speak('Permission request is not available in this context.');
		return { ok: false, code: 'modal_unavailable' };
	}

	if (!delegation) {
		host.speak('Subscription cancelled.');
		return { ok: false, code: 'user_cancelled' };
	}

	const periodSeconds = 7 * 24 * 3600;

	try {
		// Cookie-session mutation: attach the single-use double-submit CSRF token.
		// Inlined (not imported from /src/api.js) because this file is also
		// dynamically imported server-side by api/cron/run-subscriptions.js.
		const csrf = await fetch('/api/csrf-token', { credentials: 'include' })
			.then((r) => (r.ok ? r.json() : null))
			.then((j) => j?.data?.token || '')
			.catch(() => '');
		const res = await fetch('/api/agent-subscriptions', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf },
			credentials: 'include',
			body: JSON.stringify({
				agentId,
				delegationId: delegation.id,
				periodSeconds,
				amountPerPeriod: scopePreset.maxAmount,
			}),
		});
		if (!res.ok) {
			const body = await res.json().catch(() => ({}));
			throw new Error(body.error_description ?? `HTTP ${res.status}`);
		}

		const expiry = new Date(Date.now() + 90 * 24 * 3600 * 1000).toLocaleDateString();
		host.speak(`You're subscribed until ${expiry}. Revoke anytime in the Manage panel.`);
		return { ok: true };
	} catch (err) {
		host.speak('Failed to record subscription. Please try again.');
		return { ok: false, code: 'api_error', message: err.message };
	}
}

/**
 * Periodic charge handler — server-side only, called by api/cron/run-subscriptions.js.
 *
 * Builds a single ERC-20 transfer call for amountPerPeriod and redeems it
 * through the relayer endpoint (equivalent to redeemFromSkill with mode:'relayer').
 *
 * @param {{
 *   agent: {
 *     agentId: string,
 *     chainId: number,
 *     ownerAddress: string,
 *     usdcAddress: string,
 *     relayerToken: string,
 *     origin: string,
 *   },
 *   subscription: {
 *     id: string,
 *     delegationId: string,
 *     amountPerPeriod: string,
 *   }
 * }} opts
 * @returns {Promise<{ ok: boolean, txHash?: string, code?: string, message?: string }>}
 */
export async function onPeriod({ agent, subscription }) {
	const { agentId, chainId, ownerAddress, usdcAddress, relayerToken, origin } = agent;
	const { delegationId, amountPerPeriod } = subscription;

	const call = buildERC20Transfer(usdcAddress, ownerAddress, amountPerPeriod);

	let res;
	try {
		res = await fetch(`${origin}/api/permissions/redeem`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${relayerToken}`,
			},
			body: JSON.stringify({
				id: delegationId,
				calls: [call],
				agentId,
				chainId: String(chainId),
				skillId: SKILL_ID,
			}),
		});
	} catch (err) {
		return { ok: false, code: 'fetch_error', message: err.message };
	}

	if (!res.ok) {
		const body = await res.json().catch(() => ({}));
		return {
			ok: false,
			code: body.error ?? `http_${res.status}`,
			message: body.error_description ?? `HTTP ${res.status}`,
		};
	}

	const data = await res.json().catch(() => ({}));
	if (!data.txHash) {
		return { ok: false, code: 'no_tx_hash', message: 'Relayer returned no txHash' };
	}

	return { ok: true, txHash: data.txHash };
}
