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

async function rememberTx({ txHash, ref, payer, amount, payTo }) {
	pruneSeen();
	seenTx.set(txHash, Date.now() + SEEN_TTL_MS);
	// INSERT … ON CONFLICT DO NOTHING — concurrent verifiers of the same tx
	// resolve to one consumer; the second caller will see the row on read.
	try {
		await sql`
			INSERT INTO bsc_consumed_tx (tx_hash, ref, payer, amount, pay_to)
			VALUES (${txHash}, ${ref}, ${payer}, ${amount?.toString() ?? null}, ${payTo})
			ON CONFLICT (tx_hash) DO NOTHING
		`;
	} catch (err) {
		// DB persist failure is observable but must not roll back the verify —
		// the on-chain settlement happened, the buyer paid. Surface for ops.
		console.error('[x402-bsc-direct] persist consumed_tx failed', {
			tx_hash: txHash,
			error: err?.message,
		});
	}
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

	await rememberTx({
		txHash,
		ref,
		payer,
		amount,
		payTo: expectedTo,
	});
	return { isValid: true, payer, txHash, amount: amount.toString() };
}

// Synthesise the same shape PayAI/CDP /settle returns, so callers in
// x402-spec.js can emit X-PAYMENT-RESPONSE identically.
export function settleDirectPayment({ verified, requirement }) {
	return {
		success: true,
		transaction: verified.txHash,
		network: requirement.network,
		payer: verified.payer,
	};
}
