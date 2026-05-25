// x402 "direct" scheme for BNB Smart Chain (chain 56).
//
// Standard x402 settles via a facilitator that submits an EIP-3009
// transferWithAuthorization on the user's behalf. Binance-Peg USDC on BSC
// (0x8AC76a51cc...) does NOT implement EIP-3009, and no public facilitator
// advertises eip155:56, so payments route through the on-chain
// ThreeWSPayments contract instead.
//
// Wire flow:
//   1. Server emits 402 with an accepts entry shaped like:
//      { scheme: 'direct', network: 'eip155:56', payTo: <ThreeWSPayments>,
//        asset: <USDC>, amount: '1000',
//        extra: { contract, method: 'pay(bytes32)', eventTopic } }
//   2. The client wallet (e.g. MetaMask) calls USDC.approve(contract, amount)
//      then contract.pay(ref). The payer broadcasts both txs and pays gas.
//   3. The client retries the resource with X-PAYMENT decoding to
//      { scheme: 'direct', network: 'eip155:56', txHash, ref, payer? }.
//   4. verifyDirectPayment() fetches the receipt from BSC RPC and confirms:
//      status=success, to=contract, Payment(payer, amount, ref) event matches,
//      amount ≥ required, and txHash hasn't been consumed before.
//   5. Settlement is a no-op — the tx is already on-chain. The caller emits
//      a synthetic { success, transaction: txHash, network, payer } so the
//      X-PAYMENT-RESPONSE flow stays identical to the facilitator path.

import {
	createPublicClient,
	decodeEventLog,
	getAddress,
	http,
	parseAbiItem,
} from 'viem';
import { bsc } from 'viem/chains';

import { env } from './env.js';
import { X402Error } from './x402-errors.js';
import { sql } from './db.js';

export const PAYMENT_EVENT = parseAbiItem(
	'event Payment(address indexed payer, uint256 amount, bytes32 indexed ref)',
);

// keccak256("Payment(address,uint256,bytes32)") — advertised in the 402 extra so
// clients can locate the log without parsing the contract ABI.
export const PAYMENT_EVENT_TOPIC =
	'0xd17e8b542e550255f0bc5a7b2230f59fdc24847d2003255bf6199ab46ad8f300';

// Anti-replay: Postgres-backed `bsc_consumed_tx` table is the source of truth
// (PRIMARY KEY on tx_hash enforces single-consumption across Vercel replicas
// and cold starts). A short-lived in-process Map fronts it to avoid a DB round
// trip on the verify hot path when the same instance just consumed the tx.
const SEEN_TTL_MS = 10 * 60 * 1000;
const seenTx = new Map();

function pruneSeen() {
	const now = Date.now();
	for (const [k, exp] of seenTx) if (exp < now) seenTx.delete(k);
}

async function isReplay(txHash) {
	pruneSeen();
	if (seenTx.has(txHash)) return true;
	const rows = await sql`
		SELECT 1 FROM bsc_consumed_tx WHERE tx_hash = ${txHash} LIMIT 1
	`;
	return rows.length > 0;
}

// Atomic "claim this tx" — returns true exactly once for any given tx_hash.
// Concurrent verifiers of the same tx all hit ON CONFLICT; only the row
// returned by RETURNING corresponds to the winner. INSERT-not-found means
// another in-flight request beat us and we must refuse this verify to
// prevent double-spend (audit HIGH-1: BSC verify/settle race across Vercel
// replicas where the in-memory `seenTx` Map can't help).
//
// DB-side errors are still fatal — the audit's prior comment that "the
// on-chain settlement happened, the buyer paid, surface for ops" was wrong:
// without the DB row, the next request with the same tx will pass isReplay()
// and double-spend. Better to fail this request and let the client retry
// once the DB is reachable than to let the payment get consumed twice.
async function claimTx({ txHash, ref, payer, amount, payTo }) {
	pruneSeen();
	const rows = await sql`
		INSERT INTO bsc_consumed_tx (tx_hash, ref, payer, amount, pay_to)
		VALUES (${txHash}, ${ref}, ${payer}, ${amount?.toString() ?? null}, ${payTo})
		ON CONFLICT (tx_hash) DO NOTHING
		RETURNING tx_hash
	`;
	if (rows.length === 0) {
		// Another request just claimed this tx. The in-memory map may or may
		// not know — populate it so this instance fails fast on the next
		// isReplay() check.
		seenTx.set(txHash, Date.now() + SEEN_TTL_MS);
		return false;
	}
	seenTx.set(txHash, Date.now() + SEEN_TTL_MS);
	return true;
}

let cachedClient = null;
function bscClient() {
	if (cachedClient) return cachedClient;
	const rpc = env.getRpcUrl(56) || 'https://bsc-dataseed.binance.org';
	cachedClient = createPublicClient({ chain: bsc, transport: http(rpc) });
	return cachedClient;
}

function requireHex32(value, field) {
	if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
		throw new X402Error(
			'invalid_payment',
			`direct payment ${field} must be a 0x-prefixed 32-byte hex string`,
			402,
		);
	}
	return value.toLowerCase();
}

export async function verifyDirectPayment({ paymentPayload, requirement }) {
	const ref = requireHex32(paymentPayload?.ref, 'ref');
	const txHash = requireHex32(paymentPayload?.txHash, 'txHash');

	if (await isReplay(txHash)) {
		throw new X402Error(
			'invalid_payment',
			`tx ${txHash} has already been consumed by an earlier paid request`,
			402,
		);
	}

	const client = bscClient();
	let receipt;
	try {
		receipt = await client.getTransactionReceipt({ hash: txHash });
	} catch (err) {
		// viem throws TransactionReceiptNotFoundError before the tx is mined.
		if (err.name === 'TransactionReceiptNotFoundError') {
			throw new X402Error('invalid_payment', `tx ${txHash} not yet mined`, 402);
		}
		throw new X402Error(
			'verify_failed',
			`BSC RPC getReceipt failed: ${err.shortMessage || err.message}`,
			502,
		);
	}
	if (!receipt) {
		throw new X402Error('invalid_payment', `tx ${txHash} not yet mined`, 402);
	}
	if (receipt.status !== 'success') {
		throw new X402Error('invalid_payment', `tx ${txHash} reverted on-chain`, 402);
	}

	const expectedTo = getAddress(requirement.payTo);
	const actualTo = receipt.to ? getAddress(receipt.to) : null;
	if (actualTo !== expectedTo) {
		throw new X402Error(
			'invalid_payment',
			`tx.to mismatch; expected ${expectedTo}, got ${actualTo}`,
			402,
		);
	}

	let payer = null;
	let amount = 0n;
	for (const log of receipt.logs) {
		if (getAddress(log.address) !== expectedTo) continue;
		try {
			const decoded = decodeEventLog({
				abi: [PAYMENT_EVENT],
				data: log.data,
				topics: log.topics,
			});
			if (decoded.eventName !== 'Payment') continue;
			const eventRef = String(decoded.args.ref).toLowerCase();
			if (eventRef !== ref) continue;
			payer = getAddress(decoded.args.payer);
			amount = decoded.args.amount;
			break;
		} catch {
			// Not the Payment event — keep scanning.
		}
	}
	if (!payer) {
		throw new X402Error(
			'invalid_payment',
			`no Payment(*, *, ref=${ref}) event found in tx ${txHash} on ${expectedTo}`,
			402,
		);
	}

	const required = BigInt(requirement.amount);
	if (amount < required) {
		throw new X402Error(
			'invalid_payment',
			`paid amount ${amount.toString()} is below required ${required.toString()}`,
			402,
		);
	}

	const won = await claimTx({
		txHash,
		ref,
		payer,
		amount,
		payTo: expectedTo,
	});
	if (!won) {
		// Lost the race against a concurrent verifier in another replica/
		// process. The on-chain tx is real but it's already been consumed by
		// the request that won the claim — accepting it here would let the
		// payer get two paid responses for one BSC payment.
		throw new X402Error(
			'invalid_payment',
			`tx ${txHash} was concurrently claimed by another paid request — retry with a fresh payment`,
			402,
		);
	}
	return { isValid: true, payer, txHash, amount: amount.toString() };
}

// Synthesise the same shape PayAI/CDP /settle returns, so callers in
// x402-spec.js can emit X-PAYMENT-RESPONSE identically.
//
// We re-assert amount >= requirement.amount here as a belt-and-braces check.
// verifyDirectPayment already enforces this, but defensive double-checking
// at settle time means a future code path that calls settleDirectPayment
// without going through verifyDirectPayment can't silently settle for less
// than was charged.
export function settleDirectPayment({ verified, requirement }) {
	let required;
	try { required = BigInt(requirement.amount); }
	catch {
		throw new X402Error('invalid_requirement', `requirement.amount must parse as BigInt, got "${requirement.amount}"`, 500);
	}
	let verifiedAmount;
	try { verifiedAmount = BigInt(verified.amount ?? '0'); }
	catch { verifiedAmount = 0n; }
	if (verifiedAmount < required) {
		throw new X402Error(
			'settle_failed',
			`direct-scheme settle blocked: verified amount ${verifiedAmount.toString()} below required ${required.toString()}`,
			500,
		);
	}
	if (requirement.network !== 'eip155:56') {
		// We only synthesise direct-scheme settlements for BSC. A misconfigured
		// requirement.network here would silently route the wrong settlement to
		// the X-PAYMENT-RESPONSE header — block it explicitly.
		throw new X402Error(
			'settle_failed',
			`direct-scheme settle expected network eip155:56, got ${requirement.network}`,
			500,
		);
	}
	return {
		success: true,
		transaction: verified.txHash,
		network: requirement.network,
		payer: verified.payer,
	};
}
