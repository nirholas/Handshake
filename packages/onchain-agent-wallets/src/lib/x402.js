// x402 over Solana.
//
// The agent pays HTTP 402 responses out of its allowance. Two details make
// this custody-safe rather than a hole in it:
//
//   1. The resource is probed FIRST, unpaid, so the price is known before any
//      money moves and the guardrails see the real number.
//   2. The agent's own token account is topped up just in time, for exactly the
//      shortfall, by a delegated pull from the owner's vault. The agent never
//      sits on a balance, and every unit it spends came out of the ceiling the
//      token program is enforcing.
//
// Step 2 exists because the x402 exact scheme has the payer sign a transfer
// from an account it owns. A delegation cannot be handed to a third-party
// facilitator, so the agent's account acts as a till: filled per payment,
// emptied by the payment.

import { x402Client } from '@x402/core/client';
import { ExactSvmScheme } from '@x402/svm';
import { wrapFetchWithPayment, decodePaymentResponseHeader } from '@x402/fetch';
import { createKeyPairSignerFromBytes } from '@solana/kit';

import { HTTP_TIMEOUT_MS, USER_AGENT, rpcFor } from '../config.js';

/** Send the request without paying, to learn the price. */
export async function probeResource({ url, method = 'GET', headers = {}, body }) {
	const response = await fetch(url, {
		method,
		headers: { accept: 'application/json', 'user-agent': USER_AGENT, ...headers },
		body,
		signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
	});

	if (response.status !== 402) {
		return { paid: false, status: response.status, response };
	}

	let parsed;
	try {
		parsed = await response.clone().json();
	} catch {
		throw Object.assign(
			new Error(`${url} returned 402 but its body is not valid x402 JSON, so the price cannot be verified`),
			{ code: 'bad_402_body' },
		);
	}
	const accepts = Array.isArray(parsed?.accepts) ? parsed.accepts : [];
	if (accepts.length === 0) {
		throw Object.assign(new Error(`${url} returned 402 with no payment options in "accepts"`), { code: 'bad_402_body' });
	}
	return { paid: false, status: 402, response, x402Version: parsed.x402Version ?? 2, accepts };
}

/** Which Solana cluster a CAIP-2-ish network id refers to. */
export function clusterOf(network) {
	const value = String(network || '').toLowerCase();
	if (!value.startsWith('solana')) return null;
	return value.includes('devnet') ? 'devnet' : 'mainnet';
}

/**
 * Choose the payment option this agent can actually settle: the exact scheme,
 * on our cluster, denominated in the mint the agent's allowance is in.
 */
export function selectRequirement({ accepts, mint, network }) {
	const solana = accepts.filter((r) => clusterOf(r.network));
	if (solana.length === 0) {
		const offered = [...new Set(accepts.map((r) => r.network))].join(', ');
		throw Object.assign(
			new Error(
				`this resource does not accept Solana payments (it offers: ${offered}). ` +
					'This agent wallet is Solana-native and will not pay on another chain.',
			),
			{ code: 'no_solana_option' },
		);
	}

	const onCluster = solana.filter((r) => clusterOf(r.network) === network);
	if (onCluster.length === 0) {
		throw Object.assign(
			new Error(
				`the resource wants payment on Solana ${clusterOf(solana[0].network)} but this wallet is configured for ` +
					`${network}. Refusing rather than paying on the wrong cluster.`,
			),
			{ code: 'wrong_cluster' },
		);
	}

	const exact = onCluster.filter((r) => (r.scheme || 'exact') === 'exact');
	if (exact.length === 0) {
		throw Object.assign(
			new Error(`the resource only offers the "${onCluster[0].scheme}" scheme, which this wallet does not implement`),
			{ code: 'unsupported_scheme' },
		);
	}

	const matching = exact.find((r) => r.asset === mint);
	if (!matching) {
		const assets = [...new Set(exact.map((r) => r.asset))].join(', ');
		throw Object.assign(
			new Error(
				`the resource wants payment in ${assets}, but this agent's allowance is denominated in ${mint}. ` +
					'Create an agent wallet for that mint, or ask the resource for a price in this one.',
			),
			{ code: 'asset_mismatch' },
		);
	}
	return matching;
}

/** The price of a requirement, in base units. */
export function requiredUnits(requirement) {
	const raw = requirement.maxAmountRequired ?? requirement.amount;
	if (raw === undefined || raw === null || raw === '') {
		throw Object.assign(new Error('the payment requirement carries no amount'), { code: 'bad_402_body' });
	}
	let units;
	try {
		units = BigInt(String(raw));
	} catch {
		throw Object.assign(new Error(`the payment requirement amount "${raw}" is not an integer of base units`), {
			code: 'bad_402_body',
		});
	}
	if (units <= 0n) {
		throw Object.assign(new Error('the payment requirement amount must be positive'), { code: 'bad_402_body' });
	}
	return units;
}

/**
 * Pay and fetch. The agent's keypair signs the payment transfer; the facilitator
 * pays the Solana fee and settles it.
 */
export async function payAndFetch({ url, method = 'GET', headers = {}, body, secretKey, network, requirement }) {
	const signer = await createKeyPairSignerFromBytes(secretKey);
	const client = new x402Client().register(requirement.network, new ExactSvmScheme(signer, { rpcUrl: rpcFor(network) }));
	const paidFetch = wrapFetchWithPayment(fetch, client);

	const response = await paidFetch(url, {
		method,
		headers: { accept: 'application/json', 'user-agent': USER_AGENT, ...headers },
		body,
		signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
	});

	let settlement = null;
	const header = response.headers.get('x-payment-response');
	if (header) {
		try {
			settlement = decodePaymentResponseHeader(header);
		} catch {
			settlement = { raw: header };
		}
	}
	return { response, settlement };
}

/** Read a response body once, as JSON when it is JSON, as text otherwise. */
export async function readBody(response, maxChars = 20_000) {
	const type = response.headers.get('content-type') || '';
	if (type.includes('application/json')) {
		try {
			return { json: await response.json() };
		} catch {
			return { text: '(the server declared JSON but sent something else)' };
		}
	}
	const text = await response.text();
	return { text: text.length > maxChars ? `${text.slice(0, maxChars)}\n[truncated]` : text };
}
