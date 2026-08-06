// EVM USDC payment verification.
//
// The Solana confirm path scans for a transaction by Solana-Pay reference. EVM
// has no equivalent, so the buyer submits the settlement tx hash and we verify
// it on-chain: the tx must be mined and successful, have enough confirmations,
// and contain a USDC ERC-20 Transfer to the seller's payout address for at least
// the expected amount. This mirrors the strictness of `validateTransfer` on the
// Solana side. Coin-agnostic settlement plumbing: USDC is the settlement asset.

import { createPublicClient, getAddress, decodeEventLog, parseAbiItem } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { env } from './env.js';
import { evmTransport } from './evm/rpc.js';
import { EVM_USDC } from '../payments/_config.js';

// Map our stored `chain` string to an EVM chain id. Only Base is wired today;
// extend here (and EVM_USDC) to add another settlement network.
const CHAIN_IDS = {
	base: 8453,
	'base-mainnet': 8453,
	'base-sepolia': 84532,
	base_sepolia: 84532,
};

const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const TRANSFER_ABI = [TRANSFER_EVENT];

// Confirmations required before a payment is final enough to grant access. Base
// has ~2s blocks and fast finality; 2 confirmations is a safe default and is
// overridable via env for stricter merchants.
const MIN_CONFIRMATIONS = (() => {
	const v = parseInt(process.env.EVM_MIN_CONFIRMATIONS || '2', 10);
	return Number.isFinite(v) && v >= 1 ? v : 2;
})();

export function evmChainId(chain) {
	return CHAIN_IDS[String(chain || '').toLowerCase()] ?? null;
}

const _clients = new Map();
function clientFor(chainId) {
	if (_clients.has(chainId)) return _clients.get(chainId);
	const chain = chainId === 84532 ? baseSepolia : base;
	// Multi-endpoint failover (explicit override → Alchemy → public), identical to
	// every other EVM read path (evm-transfer, club payouts, ERC-8004 reads). The
	// settlement-verify path must never be the one place a single flaky Base RPC
	// strands a payment: viem's fallback transport rotates to the next endpoint on
	// a transport fault, while a genuine "not mined yet" still surfaces as the soft,
	// retryable `pending` the callers already handle. BASE_RPC_URL is pinned first
	// so an operator's private node keeps buyer addresses off the public lanes.
	const transport = evmTransport(chainId, { primaryUrl: env.BASE_RPC_URL });
	const client = createPublicClient({ chain, transport });
	_clients.set(chainId, client);
	return client;
}

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Verify a USDC settlement on an EVM chain.
 *
 * @param {object} opts
 * @param {string} opts.txHash          0x-prefixed 32-byte tx hash from the buyer
 * @param {string} opts.chain           stored chain string (e.g. 'base')
 * @param {string|null} opts.recipient   seller payout address (0x…). Pass null to
 *   accept a transfer to ANY address: used only where the destination genuinely
 *   is not knowable server-side (an x402 service whose payout address we do not
 *   hold), so the check degrades to "this transaction is real, succeeded, and
 *   moved at least this much USDC" instead of degrading to no check at all.
 * @param {string|bigint} opts.expectedAmount  USDC atomics (6 decimals) required
 * @returns {Promise<{ status:'pending'|'match'|'mismatch', txHash?:string,
 *                     actualAmount?:string, from?:string, message?:string }>}
 */
export async function verifyEvmUsdcPayment({ txHash, chain, recipient, expectedAmount }) {
	if (!txHash || !TX_HASH_RE.test(txHash)) {
		return { status: 'mismatch', message: 'a valid 0x transaction hash is required' };
	}
	const chainId = evmChainId(chain);
	if (!chainId) return { status: 'mismatch', message: `unsupported EVM chain '${chain}'` };
	const usdc = EVM_USDC[chainId];
	if (!usdc) return { status: 'mismatch', message: `no USDC contract known for chain ${chainId}` };

	let to = null;
	if (recipient != null) {
		try {
			to = getAddress(recipient);
		} catch {
			return { status: 'mismatch', message: 'seller payout address is not a valid EVM address' };
		}
	}

	const client = clientFor(chainId);

	let receipt;
	try {
		receipt = await client.getTransactionReceipt({ hash: txHash });
	} catch {
		// Not mined yet (or RPC blip) — the buyer can retry confirm.
		return { status: 'pending', txHash };
	}
	if (!receipt) return { status: 'pending', txHash };
	if (receipt.status !== 'success') return { status: 'mismatch', txHash, message: 'transaction reverted on-chain' };

	// Require enough confirmations so a reorg can't strip a granted payment.
	try {
		const head = await client.getBlockNumber();
		if (head - receipt.blockNumber + 1n < BigInt(MIN_CONFIRMATIONS)) {
			return { status: 'pending', txHash };
		}
	} catch {
		return { status: 'pending', txHash };
	}

	// Sum every USDC Transfer in this tx whose `to` is the seller's wallet.
	const usdcAddr = getAddress(usdc);
	let total = 0n;
	let from = null;
	for (const log of receipt.logs) {
		let logAddr;
		try { logAddr = getAddress(log.address); } catch { continue; }
		if (logAddr !== usdcAddr) continue;
		let decoded;
		try {
			decoded = decodeEventLog({ abi: TRANSFER_ABI, data: log.data, topics: log.topics });
		} catch {
			continue; // not a Transfer event
		}
		if (decoded.eventName !== 'Transfer') continue;
		if (to !== null && getAddress(decoded.args.to) !== to) continue;
		total += decoded.args.value;
		from = from || decoded.args.from;
	}

	if (total === 0n) {
		return {
			status: 'mismatch',
			txHash,
			message: to === null
				? 'no USDC transfer found in this transaction'
				: 'no USDC transfer to the seller wallet found in this transaction',
		};
	}
	const expected = BigInt(expectedAmount);
	if (total < expected) {
		return { status: 'mismatch', txHash, actualAmount: total.toString(), from, message: 'USDC amount transferred is less than the price' };
	}

	return { status: 'match', txHash, actualAmount: total.toString(), from };
}
