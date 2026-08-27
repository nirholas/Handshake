// Multi-collaborator payment splits for marketplace listings.
// ---------------------------------------------------------------------------
// A skill or asset can be authored by more than one person. When it sells, each
// collaborator must receive their EXACT share of the creator's net (the amount
// left after the platform fee) — atomically, with no rounding leak and no
// platform custody of the difference.
//
// Two layers, mirroring the rest of the economics lane (fee/royalty/license):
//
//   1. Pure money math (always available, no deps): validate that shares sum to
//      100%, and split an atomic amount across N recipients so the parts sum
//      back to the whole EXACTLY (largest-remainder apportionment — every
//      leftover atomic is assigned, never floored away). These are the functions
//      the tests pin: fee + creator-net = price, and Σ recipient atomics = net.
//
//   2. On-chain routing (EVM, via @0xsplits/splits-sdk): for a multi-party EVM
//      listing we resolve/create an immutable 0xSplits contract and use ITS
//      address as the listing's payout target, so the creator's net flows on
//      chain into the split and 0xSplits distributes to each collaborator —
//      trustless, no custody. When the SDK or an EVM signer is unavailable, or
//      the listing settles on Solana (0xSplits is EVM-only), the split degrades
//      to a recorded ledger ("ledger" mode): each recipient's exact allocation
//      is written to `split_distributions` and surfaced on the creator
//      dashboard. We NEVER fabricate a split address we did not actually create.
//
// A single-creator listing has no split row at all and pays the creator
// directly — zero split overhead on the common path.

import { isValidEvmAddress, isValidSolanaAddress } from './validate.js';

/** Hard cap on collaborators per listing — a sane bound, not a business limit.
 *  0xSplits itself supports many; this guards a fat-fingered payload. */
export const MAX_SPLIT_RECIPIENTS = 50;

/** Basis-point total a valid split must reach (100.00%). */
export const FULL_SHARE_BPS = 10_000;

// Build an Error carrying an HTTP status + machine code, matching the
// MonetizationService.svcError convention so handlers map it uniformly.
function splitError(status, code, message) {
	return Object.assign(new Error(message), { status, code });
}

/**
 * Validate an address for a chain. `base`/`evm` are EVM-family; `solana` is
 * base58. Returns true/false — callers decide whether to throw.
 */
export function isValidAddressForChain(address, chain) {
	if (!address || typeof address !== 'string') return false;
	if (chain === 'solana') return isValidSolanaAddress(address);
	return isValidEvmAddress(address); // base, evm, and EVM chain aliases
}

/**
 * Normalize + validate a set of split recipients. Accepts shares expressed
 * either as basis points (`share_bps`, integer) or whole/decimal percent
 * (`percent` / `share`), and normalizes everything to integer basis points.
 *
 * Rules (all enforced):
 *   • 1..MAX_SPLIT_RECIPIENTS recipients.
 *   • Each address is valid for `chain` and unique (case-insensitive).
 *   • Each share is a positive integer number of basis points.
 *   • Shares sum to EXACTLY 10000 bps (100%).
 *
 * @param {Array<{address:string, share_bps?:number, percent?:number, share?:number,
 *                recipient_user_id?:string|null, label?:string|null}>} recipients
 * @param {string} chain - 'solana' | 'base' | 'evm'
 * @returns {Array<{address:string, share_bps:number, recipient_user_id:string|null, label:string|null}>}
 * @throws 400 invalid_split with a precise reason.
 */
export function validateShares(recipients, chain) {
	if (!Array.isArray(recipients) || recipients.length === 0) {
		throw splitError(400, 'invalid_split', 'a split needs at least one recipient');
	}
	if (recipients.length > MAX_SPLIT_RECIPIENTS) {
		throw splitError(400, 'invalid_split', `a split may have at most ${MAX_SPLIT_RECIPIENTS} recipients`);
	}

	const seen = new Set();
	const normalized = recipients.map((r, i) => {
		const address = typeof r?.address === 'string' ? r.address.trim() : '';
		if (!isValidAddressForChain(address, chain)) {
			throw splitError(400, 'invalid_split', `recipient ${i + 1} has an invalid ${chain} address`);
		}
		const key = address.toLowerCase();
		if (seen.has(key)) {
			throw splitError(400, 'invalid_split', `recipient ${address} appears more than once`);
		}
		seen.add(key);

		// Resolve the share to integer basis points. Prefer explicit bps; else
		// accept percent (whole or decimal) and convert with no precision loss
		// for the common 2-decimal case.
		let bps;
		if (r.share_bps != null) {
			bps = Number(r.share_bps);
		} else if (r.percent != null || r.share != null) {
			const pct = Number(r.percent != null ? r.percent : r.share);
			bps = Math.round(pct * 100);
		} else {
			throw splitError(400, 'invalid_split', `recipient ${i + 1} is missing a share`);
		}
		if (!Number.isInteger(bps) || bps <= 0) {
			throw splitError(400, 'invalid_split', `recipient ${i + 1} has an invalid share`);
		}

		return {
			address,
			share_bps: bps,
			recipient_user_id: r.recipient_user_id ?? null,
			label: typeof r.label === 'string' && r.label.trim() ? r.label.trim().slice(0, 80) : null,
		};
	});

	const total = normalized.reduce((s, r) => s + r.share_bps, 0);
	if (total !== FULL_SHARE_BPS) {
		const pct = (total / 100).toFixed(2);
		throw splitError(400, 'invalid_split', `split shares must sum to 100% (got ${pct}%)`);
	}
	return normalized;
}

/**
 * Apportion `totalAtomics` across recipients by their basis-point shares so the
 * parts sum back to the whole EXACTLY. Largest-remainder method: every recipient
 * gets floor(total·bps/10000), then the leftover atomics (total − Σ floors) are
 * handed out one at a time to the recipients with the largest fractional
 * remainder (ties broken by larger share, then original order). No atomic is
 * ever lost or invented — Σ allocations === totalAtomics for any input.
 *
 * @param {bigint|number|string} totalAtomics
 * @param {Array<{share_bps:number}>} recipients - validated (Σ bps === 10000)
 * @returns {Array<T & {amount: bigint}>} same recipients with an exact `amount`
 */
export function allocateAtomics(totalAtomics, recipients) {
	const total = typeof totalAtomics === 'bigint' ? totalAtomics : BigInt(String(totalAtomics ?? '0').split('.')[0]);
	if (total < 0n) throw splitError(400, 'invalid_split', 'cannot split a negative amount');
	if (!recipients?.length) return [];

	const totalBps = BigInt(recipients.reduce((s, r) => s + r.share_bps, 0));
	if (totalBps === 0n) throw splitError(400, 'invalid_split', 'split shares sum to zero');

	// Base (floored) allocation + the remainder for each, both off the same
	// denominator so the apportionment is exact and order-independent.
	let assigned = 0n;
	const parts = recipients.map((r, index) => {
		const numerator = total * BigInt(r.share_bps);
		const base = numerator / totalBps;
		const remainder = numerator % totalBps; // fractional part, scaled by totalBps
		assigned += base;
		return { ...r, amount: base, _remainder: remainder, _index: index };
	});

	// Hand out the leftover atomics to the largest remainders first.
	let leftover = total - assigned;
	const order = [...parts].sort((a, b) => {
		if (a._remainder !== b._remainder) return a._remainder > b._remainder ? -1 : 1;
		if (a.share_bps !== b.share_bps) return b.share_bps - a.share_bps;
		return a._index - b._index;
	});
	for (let i = 0; i < order.length && leftover > 0n; i++) {
		order[i].amount += 1n;
		leftover -= 1n;
	}

	return parts.map(({ _remainder, _index, ...rest }) => rest);
}

/**
 * A buyer-facing description of a proceeds split, e.g. "70 / 30". Pure; used in
 * the purchase quote and on the listing so the buyer sees where money goes.
 *
 * @param {Array<{share_bps:number, label?:string|null, address?:string}>} recipients
 * @returns {{ label: string, recipients: Array<{share_bps:number, percent:number, label:string|null}> }}
 */
export function describeSplit(recipients) {
	const parts = (recipients || []).map((r) => ({
		share_bps: r.share_bps,
		percent: Math.round((r.share_bps / 100) * 100) / 100,
		label: r.label ?? null,
		...(r.address ? { address: r.address } : {}),
	}));
	const label = parts.map((p) => (Number.isInteger(p.percent) ? String(p.percent) : p.percent.toFixed(2))).join(' / ');
	return { label, recipients: parts };
}

// ── Persistence ────────────────────────────────────────────────────────────

/**
 * Read the active split for a listing, or null when single-creator. Returns the
 * config row plus its ordered recipients.
 *
 * @param {Function} sql - tagged-template client
 * @param {string} agentId
 * @param {string} skill
 * @returns {Promise<null | { id, agent_id, skill, chain, split_address, split_mode,
 *           owner_address, recipients: Array<{address, share_bps, recipient_user_id, label}> }>}
 */
export async function resolveListingSplit(sql, agentId, skill) {
	const [cfg] = await sql`
		SELECT id, agent_id, skill, chain, split_address, split_mode, owner_address
		FROM listing_splits
		WHERE agent_id = ${agentId} AND skill = ${skill}
	`;
	if (!cfg) return null;
	const recipients = await sql`
		SELECT address, share_bps, recipient_user_id, label
		FROM listing_split_recipients
		WHERE split_id = ${cfg.id}
		ORDER BY share_bps DESC, created_at ASC
	`;
	if (recipients.length === 0) return null;
	return { ...cfg, recipients };
}

/**
 * Create or replace the split config for a listing in one transaction. Validates
 * shares first (throws on invalid). For EVM listings, best-effort resolves an
 * on-chain 0xSplits address; failure to reach the chain degrades to ledger mode
 * (the allocation is still enforced off-chain) rather than blocking the listing.
 *
 * @param {Function} sql
 * @param {object} o
 * @param {string} o.agentId
 * @param {string} o.skill
 * @param {string} o.chain
 * @param {Array} o.recipients - raw recipients (validated here)
 * @param {string|null} [o.createdBy] - user id setting the split
 * @param {boolean} [o.mutable] - if true, keep an owner who can update the split
 * @returns {Promise<{ split_id:string, split_mode:'onchain'|'ledger', split_address:string|null,
 *                     recipients:Array }>}
 */
export async function persistListingSplit(sql, { agentId, skill, chain, recipients, createdBy = null, mutable = false }) {
	const normalized = validateShares(recipients, chain);

	// Try to anchor the split on-chain for EVM listings. Never block listing
	// creation on it — a chain/SDK hiccup degrades to a recorded ledger split.
	let splitAddress = null;
	let splitMode = 'ledger';
	let ownerAddress = null;
	if (chain !== 'solana') {
		try {
			const onchain = await createOnchainSplit({ recipients: normalized, chain, mutable });
			if (onchain?.address) {
				splitAddress = onchain.address;
				splitMode = 'onchain';
				ownerAddress = onchain.ownerAddress ?? null;
			}
		} catch (e) {
			console.warn('[splits] on-chain split unavailable, using ledger mode', e?.message);
		}
	}

	const [cfg] = await sql`
		INSERT INTO listing_splits (agent_id, skill, chain, split_address, split_mode, owner_address, created_by)
		VALUES (${agentId}, ${skill}, ${chain}, ${splitAddress}, ${splitMode}, ${ownerAddress}, ${createdBy})
		ON CONFLICT (agent_id, skill) DO UPDATE SET
			chain = EXCLUDED.chain,
			split_address = EXCLUDED.split_address,
			split_mode = EXCLUDED.split_mode,
			owner_address = EXCLUDED.owner_address,
			updated_at = now()
		RETURNING id
	`;
	const splitId = cfg.id;

	// Replace recipients atomically.
	await sql`DELETE FROM listing_split_recipients WHERE split_id = ${splitId}`;
	for (const r of normalized) {
		await sql`
			INSERT INTO listing_split_recipients (split_id, recipient_user_id, address, chain, share_bps, label)
			VALUES (${splitId}, ${r.recipient_user_id}, ${r.address}, ${chain}, ${r.share_bps}, ${r.label})
		`;
	}

	return { split_id: splitId, split_mode: splitMode, split_address: splitAddress, recipients: normalized };
}

/**
 * Remove a listing's split (revert to single-creator). Idempotent.
 */
export async function clearListingSplit(sql, agentId, skill) {
	await sql`DELETE FROM listing_splits WHERE agent_id = ${agentId} AND skill = ${skill}`;
}

/**
 * Record how a confirmed purchase's creator-net was divided among collaborators.
 * Idempotent per (purchase, address) so a retried confirm never double-credits.
 * In "onchain" mode the net already flowed into the 0xSplits contract on chain,
 * so rows are stamped settled (informational, for the dashboard); in "ledger"
 * mode rows are 'accrued' and each recipient withdraws their share via the
 * normal payout flow.
 *
 * @param {Function} sql
 * @param {object} o
 * @param {string} o.purchaseId
 * @param {object} o.split - from resolveListingSplit (has id, split_mode, recipients)
 * @param {bigint|string} o.netAtomics - the creator's net (after platform fee)
 * @param {string} o.currencyMint
 * @param {string} o.chain
 * @returns {Promise<Array<{address, recipient_user_id, share_bps, amount:string, mode, status}>>}
 */
export async function recordSplitDistribution(sql, { purchaseId, split, netAtomics, currencyMint, chain }) {
	const allocations = allocateAtomics(netAtomics, split.recipients);
	const mode = split.split_mode === 'onchain' ? 'onchain' : 'ledger';
	const status = mode === 'onchain' ? 'settled' : 'accrued';

	const out = [];
	for (const a of allocations) {
		await sql`
			INSERT INTO split_distributions
				(purchase_id, split_id, recipient_user_id, address, share_bps, amount, currency_mint, chain, mode, status)
			VALUES
				(${purchaseId}, ${split.id}, ${a.recipient_user_id}, ${a.address}, ${a.share_bps},
				 ${a.amount.toString()}, ${currencyMint}, ${chain}, ${mode}, ${status})
			ON CONFLICT (purchase_id, address) DO NOTHING
		`;
		out.push({
			address: a.address,
			recipient_user_id: a.recipient_user_id,
			share_bps: a.share_bps,
			amount: a.amount.toString(),
			mode,
			status,
		});
	}
	return out;
}

// ── On-chain (0xSplits, EVM) ─────────────────────────────────────────────────

const EVM_CHAIN_IDS = { base: 8453, evm: 8453, ethereum: 1, optimism: 10, arbitrum: 42161, polygon: 137 };

/** Resolve a numeric EVM chain id from a chain label, or null. */
export function evmChainIdForSplit(chain) {
	if (typeof chain === 'number') return chain;
	return EVM_CHAIN_IDS[String(chain).toLowerCase()] ?? null;
}

/**
 * Create (or deterministically predict) an immutable 0xSplits contract for a set
 * of recipients on an EVM chain, returning its address. Uses the platform's EVM
 * signer to deploy. Returns null when the SDK, a signer, or the chain is
 * unavailable — the caller then falls back to ledger mode. Pure-read predict is
 * preferred (the immutable split address is deterministic from the recipient
 * set), so the same collaborators always resolve to the same contract.
 *
 * @param {object} o
 * @param {Array<{address:string, share_bps:number}>} o.recipients - validated
 * @param {string} o.chain
 * @param {boolean} [o.mutable]
 * @returns {Promise<{ address:string, ownerAddress:string|null } | null>}
 */
export async function createOnchainSplit({ recipients, chain, mutable = false }) {
	const chainId = evmChainIdForSplit(chain);
	if (!chainId) return null;

	const pk = process.env.EVM_TREASURY_PRIVATE_KEY || process.env.SPLITS_SIGNER_PRIVATE_KEY;
	if (!pk) return null;

	let SplitsClient;
	try {
		({ SplitsClient } = await import('@0xsplits/splits-sdk'));
	} catch {
		return null; // SDK not resolvable in this environment → ledger mode
	}
	if (!SplitsClient) return null;

	const [{ createPublicClient, createWalletClient }, { privateKeyToAccount }, viemChains, { evmTransport }] = await Promise.all([
		import('viem'),
		import('viem/accounts'),
		import('viem/chains'),
		import('./evm/rpc.js'),
	]);
	const chainMap = {
		1: viemChains.mainnet, 8453: viemChains.base, 10: viemChains.optimism,
		42161: viemChains.arbitrum, 137: viemChains.polygon,
	};
	const viemChain = chainMap[chainId];
	if (!viemChain) return null;

	const account = privateKeyToAccount(pk.startsWith('0x') ? pk : `0x${pk}`);
	// The operator's EVM_RPC_URL_<chainId> stays primary; the shared keyed/public
	// endpoints for the chain back it so one dead node cannot strand a split deploy.
	const primaryUrl = process.env[`EVM_RPC_URL_${chainId}`] || null;
	const publicClient = createPublicClient({ chain: viemChain, transport: evmTransport(chainId, { primaryUrl }) });
	const walletClient = createWalletClient({ account, chain: viemChain, transport: evmTransport(chainId, { primaryUrl }) });

	const client = new SplitsClient({ chainId, publicClient, walletClient }).splitV1;

	// 0xSplits expects percentAllocation as a percentage number summing to 100,
	// with at most a couple of decimals. bps/100 is exact for our integer bps.
	const sdkRecipients = recipients.map((r) => ({ address: r.address, percentAllocation: r.share_bps / 100 }));

	// Immutable split (no controller) is deterministic — predict its address and
	// only deploy if it isn't already on chain.
	const ownerAddress = mutable ? account.address : null;
	if (!mutable) {
		const predicted = await client.predictImmutableSplitAddress({
			recipients: sdkRecipients,
			distributorFeePercent: 0,
		});
		const addr = predicted?.splitAddress || predicted?.address || predicted;
		if (predicted?.splitExists && addr) return { address: addr, ownerAddress: null };
		// Deploy the deterministic immutable split.
		const created = await client.createSplit({
			recipients: sdkRecipients,
			distributorFeePercent: 0,
			controller: undefined,
		});
		const createdAddr = created?.splitId || created?.splitAddress || addr;
		if (createdAddr) return { address: createdAddr, ownerAddress: null };
		return null;
	}

	const created = await client.createSplit({
		recipients: sdkRecipients,
		distributorFeePercent: 0,
		controller: account.address,
	});
	const createdAddr = created?.splitId || created?.splitAddress || null;
	return createdAddr ? { address: createdAddr, ownerAddress } : null;
}
