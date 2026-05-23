/**
 * Pay-by-name client.
 *
 * One self-contained flow:
 *   1. Connect a Solana wallet (Phantom-style window.solana).
 *   2. Ask /api/x402/pay-by-name to resolve the name and build an unsigned
 *      USDC SPL transfer with the connected wallet as fee payer + source.
 *   3. Ask the wallet to sign + send the transaction.
 *   4. Confirm via the same blockhash returned by the backend.
 *
 * Callers don't have to know anything about Solana — they pass a name and an
 * amount and get back `{ signature, recipient, amount_usdc }`. The status
 * callback gives them a string to show in the UI at each step.
 *
 * Imports `@solana/web3.js` dynamically so pages that don't open the modal
 * never pay for the chunk.
 */

const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

let _web3 = null;
async function loadWeb3() {
	if (!_web3) _web3 = await import('@solana/web3.js');
	return _web3;
}

// Phantom, Solflare, Backpack — all inject Solana-Web-Standard-ish providers.
// We accept the lowest common denominator: connect() + signTransaction() (or
// signAndSendTransaction()) on either window.solana or window.phantom.solana.
function detectWallet() {
	const candidates = [
		typeof window !== 'undefined' && window.phantom?.solana,
		typeof window !== 'undefined' && window.solana,
		typeof window !== 'undefined' && window.solflare,
		typeof window !== 'undefined' && window.backpack?.solana,
	].filter(Boolean);
	return candidates[0] || null;
}

export function hasInjectedWallet() {
	return !!detectWallet();
}

/**
 * Connect the wallet and return { wallet, publicKey } (publicKey as base58).
 * Throws if no wallet is installed or the user rejects.
 */
export async function connectWallet() {
	const wallet = detectWallet();
	if (!wallet) {
		const e = new Error('No Solana wallet detected. Install Phantom, Solflare, or Backpack.');
		e.code = 'no_wallet';
		throw e;
	}
	if (!wallet.isConnected || !wallet.publicKey) {
		await wallet.connect();
	}
	const publicKey = wallet.publicKey?.toBase58?.() || wallet.publicKey?.toString?.();
	if (!publicKey || !ADDR_RE.test(publicKey)) {
		const e = new Error('Wallet connected but did not expose a public key.');
		e.code = 'wallet_no_pubkey';
		throw e;
	}
	return { wallet, publicKey };
}

/**
 * Run the full pay-by-name flow.
 *
 * @param {object} opts
 * @param {string} opts.name             The .sol name / @handle / address to pay.
 * @param {number} opts.amount           USDC amount, in dollar units (not atoms).
 * @param {(step: string) => void} [opts.onStatus]
 *                                       Callback invoked at each phase with a
 *                                       user-facing status string.
 * @param {string} [opts.rpcUrl]         Override the RPC used for confirmation.
 *                                       Defaults to the same-origin proxy at
 *                                       `/api/solana-rpc` which avoids public
 *                                       mainnet 403s.
 *
 * Returns { signature, recipient, amount_usdc, explorer }.
 */
export async function payByName({ name, amount, onStatus, rpcUrl }) {
	const status = (s) => { try { onStatus?.(s); } catch {} };

	status('Connecting wallet…');
	const { wallet, publicKey } = await connectWallet();

	status('Resolving name…');
	const prepRes = await fetch('/api/x402/pay-by-name', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			mode: 'prep',
			name,
			amount_usdc: amount,
			payer_wallet: publicKey,
		}),
	});
	const prepBody = await prepRes.json();
	if (!prepRes.ok) {
		const e = new Error(prepBody?.error_description || `prep failed (${prepRes.status})`);
		e.code = prepBody?.error || 'prep_failed';
		throw e;
	}
	const { recipient, amount_usdc, tx_base64, blockhash, last_valid_block_height } = prepBody.data;

	status(`Sign in wallet — ${amount_usdc} USDC to ${recipient.resolved}…`);
	const { Connection, VersionedTransaction } = await loadWeb3();
	const rawTx = Uint8Array.from(atob(tx_base64), (c) => c.charCodeAt(0));
	const tx = VersionedTransaction.deserialize(rawTx);

	let signature;
	if (typeof wallet.signAndSendTransaction === 'function') {
		// Phantom's preferred path — wallet handles signing + RPC submission.
		const result = await wallet.signAndSendTransaction(tx);
		signature = result?.signature || result;
	} else {
		// Wallets that only expose signTransaction (Solflare older builds).
		const signed = await wallet.signTransaction(tx);
		const conn = new Connection(rpcUrl || `${location.origin}/api/solana-rpc`, 'confirmed');
		signature = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false });
	}
	if (!signature || typeof signature !== 'string') {
		throw new Error('Wallet did not return a transaction signature.');
	}

	status('Confirming on-chain…');
	const conn = new Connection(rpcUrl || `${location.origin}/api/solana-rpc`, 'confirmed');
	try {
		await conn.confirmTransaction(
			{ signature, blockhash, lastValidBlockHeight: last_valid_block_height },
			'confirmed',
		);
	} catch (err) {
		// Confirmation timeout doesn't mean failure — the tx may have landed
		// after our window. Surface the signature so the caller can verify in
		// Solscan, and let the modal show a "check on explorer" link instead
		// of pretending it failed.
		const e = new Error(`Submitted but not confirmed in window: ${err?.message || 'timeout'}`);
		e.code = 'confirm_timeout';
		e.signature = signature;
		throw e;
	}

	status('Done.');
	return {
		signature,
		recipient,
		amount_usdc,
		explorer: `https://solscan.io/tx/${signature}`,
	};
}
