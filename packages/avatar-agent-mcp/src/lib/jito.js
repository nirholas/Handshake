// Jito Block Engine helpers.
//
// We submit pre-signed transaction bundles to Jito's mainnet block engine.
// A bundle of 1-5 transactions either all land in the same block or none
// land — atomicity is what enables the launch-and-collect tricks in
// nirholas/atomic (separate funder and creator wallets, leaked-key
// rescues, sniper-resistant launches).
//
// Jito tip accounts rotate occasionally; if you start hitting
// "Bundles must write lock at least one tip account" errors, fetch fresh
// ones via the getTipAccounts JSON-RPC method against the block engine.

import { PublicKey } from '@solana/web3.js';

export const JITO_BUNDLE_URL = 'https://mainnet.block-engine.jito.wtf/api/v1/bundles';

export const JITO_TIP_ACCOUNTS = [
	'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
	'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
	'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
	'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
	'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
	'96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
	'3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
	'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
];

export function randomTipAccount() {
	return new PublicKey(JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]);
}

export async function submitBundle(bs58Txs) {
	const res = await fetch(JITO_BUNDLE_URL, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendBundle', params: [bs58Txs] }),
	});
	const body = await res.json().catch(() => ({}));
	if (body.error) {
		const err = new Error(`Jito bundle submit failed: ${JSON.stringify(body.error)}`);
		err.code = 'jito_error';
		err.detail = body.error;
		throw err;
	}
	return {
		bundleId: body.result,
		explorer: `https://explorer.jito.wtf/bundle/${body.result}`,
	};
}

// Poll signature statuses until all are confirmed/failed or the timeout
// elapses. Used after submitting a Jito bundle so callers see a final
// state instead of just the bundle id.
export async function waitForSignatures(connection, signatures, { timeoutMs = 60_000, intervalMs = 2_000 } = {}) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const sigs = await connection.getSignatureStatuses(signatures);
		const all = sigs?.value || [];
		const allConfirmed = all.length === signatures.length
			&& all.every((s) => s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized');
		if (allConfirmed) {
			const anyErr = all.find((s) => s?.err);
			return {
				ok: !anyErr,
				err: anyErr?.err || null,
				statuses: all.map((s) => s?.confirmationStatus || null),
			};
		}
		await new Promise((r) => setTimeout(r, intervalMs));
	}
	return { ok: false, err: 'timeout', statuses: null };
}
