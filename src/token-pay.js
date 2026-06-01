/**
 * $THREE token payment — client helper (Task 18).
 *
 * Drives the server-authoritative quote → sign → settle flow that Task 19
 * (paid spins) and Task 20 (token-priced listings) reuse:
 *
 *   1. POST /api/token/quote  → a signed quote with concrete split legs
 *   2. Build ONE transaction: an idempotent ATA-create + SPL transfer per leg
 *      (burn + treasury, or seller + treasury), plus a memo carrying the nonce
 *   3. Wallet signs & sends it; we wait for confirmation
 *   4. POST /api/token/settle → server verifies on-chain and records it
 *
 * The server is the only authority on whether the payment counts — this helper
 * never reports success on its own. Usage:
 *
 *   import { payWithToken } from './token-pay.js';
 *   const result = await payWithToken({
 *     purpose: 'spin', usd: 0.50, refType: 'spin', refId,
 *     onStatus: (s) => spinner.set(s),
 *   });
 *   if (result.ok) grantSpin();
 */

const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

// Lazy-load the Solana SDKs so they stay out of the initial bundle — Vite
// splits them into a chunk fetched only when a payment actually happens.
let _web3 = null;
let _spl = null;
async function loadSolana() {
	if (!_web3) _web3 = await import('@solana/web3.js');
	if (!_spl) _spl = await import('@solana/spl-token');
	return { web3: _web3, spl: _spl };
}

function rpcEndpoint() {
	return (
		(typeof window !== 'undefined' && window.__solanaRpc) ||
		`${window.location.origin}/api/solana-rpc`
	);
}

async function getProvider(explicit) {
	const wallet = explicit || (typeof window !== 'undefined' ? window.solana : null);
	if (!wallet) {
		throw Object.assign(
			new Error('No Solana wallet found. Install Phantom or connect a wallet.'),
			{
				code: 'no_wallet',
			},
		);
	}
	if (!wallet.isConnected) {
		if (typeof wallet.connect === 'function') await wallet.connect();
		else throw Object.assign(new Error('Wallet is not connected.'), { code: 'not_connected' });
	}
	return wallet;
}

function memoData(nonce) {
	return typeof Buffer !== 'undefined'
		? Buffer.from(nonce, 'utf8')
		: new TextEncoder().encode(nonce);
}

/** GET the public token config (mint, decimals, treasury, burn, split policies). */
export async function fetchTokenConfig() {
	const r = await fetch('/api/token/config', { credentials: 'include' });
	if (!r.ok) throw new Error(`token config ${r.status}`);
	return r.json();
}

/** GET the live token price; pass `usd` to also receive a token-amount quote. */
export async function fetchTokenPrice(usd) {
	const url =
		usd != null ? `/api/token/price?usd=${encodeURIComponent(usd)}` : '/api/token/price';
	const r = await fetch(url, { credentials: 'include' });
	if (!r.ok) throw new Error(`token price ${r.status}`);
	return r.json();
}

/**
 * Run the full quote → sign → settle flow.
 * @param {{
 *   purpose: 'spin'|'marketplace_sale',
 *   usd: number,
 *   sellerWallet?: string,
 *   refType?: string,
 *   refId?: string,
 *   network?: 'mainnet'|'devnet',
 *   wallet?: any,                         // override window.solana
 *   onStatus?: (status: string) => void,  // 'quoting'|'awaiting_signature'|'confirming'|'settling'
 * }} params
 * @returns {Promise<{ ok: boolean, payment_id: string, tx_signature: string, legs: any[], credited: object }>}
 */
export async function payWithToken({
	purpose,
	usd,
	sellerWallet,
	refType,
	refId,
	network = 'mainnet',
	wallet,
	onStatus = () => {},
}) {
	// 1. Quote
	onStatus('quoting');
	const quoteResp = await fetch('/api/token/quote', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		credentials: 'include',
		body: JSON.stringify({
			purpose,
			usd,
			network,
			...(sellerWallet ? { seller_wallet: sellerWallet } : {}),
			...(refType ? { ref_type: refType } : {}),
			...(refId ? { ref_id: refId } : {}),
		}),
	});
	const quote = await quoteResp.json();
	if (!quoteResp.ok) {
		throw Object.assign(new Error(quote.error_description || 'quote failed'), {
			code: quote.error,
		});
	}

	// 2. Build the transaction from the quote legs
	const { web3, spl } = await loadSolana();
	const { Connection, PublicKey, Transaction, TransactionInstruction } = web3;
	const {
		getAssociatedTokenAddressSync,
		createTransferInstruction,
		createAssociatedTokenAccountIdempotentInstruction,
	} = spl;

	const provider = await getProvider(wallet);
	const payer = provider.publicKey;
	if (!payer) throw Object.assign(new Error('Wallet has no public key.'), { code: 'no_pubkey' });

	const connection = new Connection(rpcEndpoint(), 'confirmed');
	const mint = new PublicKey(quote.mint);
	const fromAta = getAssociatedTokenAddressSync(mint, payer);

	const tx = new Transaction();
	for (const leg of quote.legs) {
		const owner = new PublicKey(leg.address);
		// allowOwnerOffCurve: the burn incinerator is off-curve.
		const destAta = getAssociatedTokenAddressSync(mint, owner, true);
		// Idempotent: a no-op if the destination ATA already exists; otherwise the
		// payer funds its rent so burn/treasury/seller can receive on first use.
		tx.add(createAssociatedTokenAccountIdempotentInstruction(payer, destAta, owner, mint));
		tx.add(createTransferInstruction(fromAta, destAta, payer, BigInt(leg.atomics)));
	}
	// Memo carries the quote nonce so the server can bind this tx to the quote.
	tx.add(
		new TransactionInstruction({
			keys: [],
			programId: new PublicKey(MEMO_PROGRAM_ID),
			data: memoData(quote.memo),
		}),
	);

	const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
	tx.feePayer = payer;
	tx.recentBlockhash = blockhash;

	// 3. Sign + send + confirm
	onStatus('awaiting_signature');
	const signature = await provider.sendTransaction(tx, connection);
	onStatus('confirming');
	await connection.confirmTransaction(
		{ signature, blockhash, lastValidBlockHeight },
		'confirmed',
	);

	// 4. Settle (server verifies on-chain and records the payment)
	onStatus('settling');
	const settleResp = await fetch('/api/token/settle', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		credentials: 'include',
		body: JSON.stringify({ quote_token: quote.quote_token, tx_signature: signature, network }),
	});
	const settled = await settleResp.json();
	if (!settleResp.ok) {
		throw Object.assign(new Error(settled.error_description || 'settlement failed'), {
			code: settled.error,
			tx_signature: signature,
		});
	}
	return { ...settled, tx_signature: signature };
}
