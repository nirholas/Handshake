/**
 * Solana Pay TRANSACTION request for a pending skill purchase.
 *
 *   GET  /api/purchase/skill?reference=<base58>
 *        → { label, icon }: what the wallet shows before it asks to sign.
 *   POST /api/purchase/skill?reference=<base58>   body: { account: <base58> }
 *        → { transaction: <base64>, message }: the prepared purchase transfer.
 *
 * Why this exists next to the plain `solana:<recipient>?amount=…` transfer-request
 * QR (src/shared/skill-purchase.js): a transfer request can only express ONE leg
 * paid by the scanning wallet, so on that rail the buyer must already hold SOL for
 * the network fee, the creator's token account must already exist, and a platform
 * fee split cannot be expressed at all. Building the transaction here fixes all
 * three: the marketplace payer sponsors the network fee when it is configured,
 * missing associated token accounts are created idempotently, and the treasury fee
 * leg rides the same transaction the buyer signs.
 *
 * The purchase row is NEVER created here. A buyer is a signed-in user and this
 * endpoint is reached by a wallet with no session, so the pending row (buyer,
 * price, fee split, expiry) is created by the authenticated checkout,
 * POST /api/marketplace/purchase, and this endpoint only builds the transaction
 * that settles it. `reference` is the base58 Solana Pay key of that row.
 *
 * Instruction order is load-bearing: @solana/pay's validateTransfer inspects the
 * LAST instruction, so the reference-carrying creator leg is always last and the
 * treasury fee leg (when there is one) sits before it. api/_lib/purchase-confirm.js
 * verifies exactly that shape.
 */
import { PublicKey, Transaction } from '@solana/web3.js';
import {
	getAccount,
	getAssociatedTokenAddressSync,
	createAssociatedTokenAccountIdempotentInstruction,
	createTransferCheckedInstruction,
	TokenAccountNotFoundError,
	TokenInvalidAccountOwnerError,
} from '@solana/spl-token';

import { sql } from '../_lib/db.js';
import { env } from '../_lib/env.js';
import { cors, error, json, method, readBody, wrap, rateLimited } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { logEvent, resolvePayoutAddress } from '../_lib/purchase-confirm.js';
import { solanaConnection } from '../_lib/solana/connection.js';
import { resolveMarketplacePayer } from '../_lib/solana/gasless-tx.js';

const REFERENCE_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/; // base58 Pubkey

// Solana Pay wallets surface `message` on a failed request; the rest of the
// platform reads the { error, error_description } shape. Send both.
function payError(res, status, code, message) {
	return error(res, status, code, message, { message });
}

// Atomic units are meaningless to a buyer reading a wallet toast, so shortfalls
// are rendered in whole tokens ("0.35"), trailing zeros trimmed.
function formatAtomics(atomics, decimals) {
	const negative = atomics < 0n;
	const digits = (negative ? -atomics : atomics).toString().padStart(decimals + 1, '0');
	const whole = digits.slice(0, digits.length - decimals);
	const fraction = decimals ? digits.slice(digits.length - decimals).replace(/0+$/, '') : '';
	return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

// The Solana Pay spec has the wallet POST JSON, but the header it arrives with is
// outside our control: in-app browsers and proxies routinely rewrite or drop
// `content-type`, and readJson() rejects those outright. The body is the only
// thing that matters here, so parse the raw bytes and let the account validation
// below decide, rather than answering a well-formed request with a header
// complaint the buyer cannot act on.
async function readAccount(req) {
	const raw = await readBody(req, 8_192).catch(() => null);
	if (!raw?.length) return '';
	try {
		const parsed = JSON.parse(raw.toString('utf8'));
		return typeof parsed?.account === 'string' ? parsed.account.trim() : '';
	} catch {
		return '';
	}
}

// The buyer signs a transferChecked out of their own token account, so a wallet
// that has never held this mint, or holds less than the price, produces an opaque
// simulation failure inside the wallet. Ask the chain first and turn that into a
// message the buyer can act on. Returns the balance in atomic units, or null when
// the RPC could not answer: an unreachable node must never reject a purchase the
// chain would have accepted.
async function readBuyerBalance(connection, buyerAta) {
	try {
		const account = await getAccount(connection, buyerAta, 'confirmed');
		return account.amount;
	} catch (err) {
		if (err instanceof TokenAccountNotFoundError || err instanceof TokenInvalidAccountOwnerError) {
			return 0n;
		}
		return null;
	}
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const url = new URL(req.url, 'http://x');
	const reference = (url.searchParams.get('reference') || '').trim();
	if (!REFERENCE_RE.test(reference)) {
		return payError(res, 400, 'validation_error', 'a valid purchase reference is required');
	}

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const [purchase] = await sql`
		SELECT sp.reference, sp.status, sp.expires_at, sp.agent_id, sp.skill, sp.kind,
		       sp.amount, sp.currency_mint, sp.chain,
		       sp.platform_fee_amount, sp.platform_fee_wallet,
		       COALESCE(asp.mint_decimals, 6) AS mint_decimals,
		       a.name AS agent_name
		FROM skill_purchases sp
		LEFT JOIN agent_skill_prices asp
		       ON asp.agent_id = sp.agent_id AND asp.skill = sp.skill
		LEFT JOIN agent_identities a ON a.id = sp.agent_id
		WHERE sp.reference = ${reference}
		LIMIT 1
	`;
	if (!purchase) return payError(res, 404, 'not_found', 'no pending purchase matches this reference');

	const skillLabel = String(purchase.skill).slice(0, 40);

	if (req.method === 'GET') {
		// Solana Pay spec: the GET is the wallet's "who am I paying" probe.
		return json(
			res,
			200,
			{ label: `three.ws · ${skillLabel}`, icon: `${env.APP_ORIGIN}/favicon.svg` },
			{ 'cache-control': 'no-store' },
		);
	}

	if (purchase.status === 'confirmed') {
		return payError(res, 409, 'already_confirmed', 'this purchase is already paid');
	}
	if (purchase.status !== 'pending') {
		return payError(res, 410, 'purchase_not_payable', `this purchase is ${purchase.status}`);
	}
	if (purchase.expires_at && new Date(purchase.expires_at).getTime() <= Date.now()) {
		return payError(res, 410, 'purchase_expired', 'this pending purchase expired; start a new one');
	}
	if (purchase.chain !== 'solana') {
		return payError(res, 400, 'unsupported_chain', 'only solana purchases settle through this endpoint');
	}

	const account = await readAccount(req);
	if (!REFERENCE_RE.test(account)) {
		return payError(res, 400, 'validation_error', 'account must be a base58 wallet address');
	}

	const payoutAddress = await resolvePayoutAddress(purchase.agent_id, 'solana');
	if (!payoutAddress) {
		return payError(res, 412, 'creator_wallet_missing', 'the agent owner has not configured a payout wallet');
	}

	const feeAtomics = BigInt(purchase.platform_fee_amount || 0);
	const feeWallet = feeAtomics > 0n ? purchase.platform_fee_wallet : null;
	const creatorAtomics = BigInt(purchase.amount) - (feeWallet ? feeAtomics : 0n);
	if (creatorAtomics <= 0n) {
		return payError(res, 409, 'invalid_quote', 'this purchase has no payable creator amount');
	}

	let buyer;
	let mintKey;
	let creatorKey;
	let feeKey = null;
	try {
		buyer = new PublicKey(account);
		mintKey = new PublicKey(purchase.currency_mint);
		creatorKey = new PublicKey(payoutAddress);
		if (feeWallet) feeKey = new PublicKey(feeWallet);
	} catch {
		return payError(res, 400, 'validation_error', 'account, mint, or payout address is not a valid public key');
	}

	const decimals = Number(purchase.mint_decimals ?? 6);
	const referenceKey = new PublicKey(reference);
	// No pinned URL: solanaRpcEndpoints() puts a pinned one AHEAD of the operator's
	// SOLANA_RPC_URL and every keyed provider, so pinning the public cluster as a
	// default would make the most-throttled endpoint the primary lane for a
	// checkout. Passing nothing keeps the platform's ordered failover chain intact.
	const connection = solanaConnection({ commitment: 'confirmed' });
	const payer = await resolveMarketplacePayer();
	const feePayer = payer ? payer.publicKey : buyer;

	const buyerAta = getAssociatedTokenAddressSync(mintKey, buyer);
	const creatorAta = getAssociatedTokenAddressSync(mintKey, creatorKey);

	const required = creatorAtomics + (feeKey ? feeAtomics : 0n);
	const buyerBalance = await readBuyerBalance(connection, buyerAta);
	if (buyerBalance !== null && buyerBalance < required) {
		const short = formatAtomics(required - buyerBalance, decimals);
		return payError(
			res,
			409,
			'insufficient_funds',
			`this wallet is ${short} short of the ${skillLabel} price; top it up and scan again`,
		);
	}

	const instructions = [];

	// A creator (or treasury) who has never held this mint has no token account
	// yet, and a transfer into a missing account fails. Idempotent creation costs
	// nothing when the account already exists and rescues the purchase when it
	// does not; the fee payer funds the rent.
	instructions.push(
		createAssociatedTokenAccountIdempotentInstruction(feePayer, creatorAta, creatorKey, mintKey),
	);
	if (feeKey) {
		const treasuryAta = getAssociatedTokenAddressSync(mintKey, feeKey);
		instructions.push(
			createAssociatedTokenAccountIdempotentInstruction(feePayer, treasuryAta, feeKey, mintKey),
			createTransferCheckedInstruction(buyerAta, mintKey, treasuryAta, buyer, feeAtomics, decimals),
		);
	}

	// Creator leg LAST, carrying the Solana Pay reference: this is the
	// instruction findReference locates and validateTransfer checks.
	const creatorIx = createTransferCheckedInstruction(
		buyerAta,
		mintKey,
		creatorAta,
		buyer,
		creatorAtomics,
		decimals,
	);
	creatorIx.keys.push({ pubkey: referenceKey, isSigner: false, isWritable: false });
	instructions.push(creatorIx);

	const { blockhash } = await connection.getLatestBlockhash('confirmed');
	const tx = new Transaction({ feePayer, recentBlockhash: blockhash }).add(...instructions);
	// Sponsored checkout: the platform signs as fee payer so a buyer holding only
	// USDC can still pay. The buyer adds the authority signature in their wallet.
	if (payer) tx.partialSign(payer);

	const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });

	await logEvent(reference, 'transaction_request_built', {
		account,
		gasless: !!payer,
		fee_leg: !!feeKey,
	});

	const agentName = purchase.agent_name ? ` on ${String(purchase.agent_name).slice(0, 40)}` : '';
	return json(
		res,
		200,
		{
			transaction: serialized.toString('base64'),
			message: purchase.kind === 'time_pass'
				? `Unlock timed access to ${skillLabel}${agentName}`
				: `Unlock ${skillLabel}${agentName}`,
		},
		{ 'cache-control': 'no-store' },
	);
});
