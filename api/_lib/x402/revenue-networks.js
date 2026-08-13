// Network identity for the revenue ledger (x402_audit_log.network).
//
// Settlements record their chain as a CAIP-2 id: 'solana:5eykt4Us…' for the
// Solana rail, 'eip155:8453' for Base, and so on. Two things need that raw id
// turned into something usable:
//
//   1. Display. 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' is not a label a
//      reader should ever see. `networkIdentity()` folds it to a stable family
//      slug ('solana') plus a human label ('Solana').
//   2. Filtering. A visitor filters by family ('?network=solana'), not by
//      genesis hash, and older rows were written with the bare legacy name
//      ('solana', 'base'). `resolveNetworkFilter()` maps one family slug to
//      every raw id that belongs to it, so a filter matches both spellings.
//
// The explorer link is derived from the same identity: a Base settlement's tx
// hash on solscan.io is a dead link, so `revenueTxUrl()` routes each family to
// its own explorer and returns null rather than guessing.

import { CHAIN_BY_ID } from '../erc8004-chains.js';

// Families we name explicitly. `ids` lists every raw value the ledger may hold
// for that family: the canonical CAIP-2 id first, then legacy spellings. The
// table is the single source of truth for both directions (id → family and
// family → ids), so display and filtering can never disagree.
const FAMILIES = [
	{
		family: 'solana',
		label: 'Solana',
		ids: ['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 'solana:mainnet', 'solana', 'mainnet'],
	},
	{
		family: 'solana-devnet',
		label: 'Solana devnet',
		cluster: 'devnet',
		ids: ['solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', 'solana:devnet', 'devnet'],
	},
	{
		family: 'solana-testnet',
		label: 'Solana testnet',
		cluster: 'testnet',
		ids: ['solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z', 'solana:testnet'],
	},
	{ family: 'base', label: 'Base', chainId: 8453, ids: ['eip155:8453', 'base'] },
	{
		family: 'base-sepolia',
		label: 'Base Sepolia',
		chainId: 84532,
		ids: ['eip155:84532', 'base-sepolia'],
	},
	{ family: 'bsc', label: 'BNB Chain', chainId: 56, ids: ['eip155:56', 'bsc', 'bnb'] },
	{ family: 'ethereum', label: 'Ethereum', chainId: 1, ids: ['eip155:1', 'ethereum'] },
	{ family: 'arbitrum', label: 'Arbitrum One', chainId: 42161, ids: ['eip155:42161', 'arbitrum'] },
	{ family: 'optimism', label: 'Optimism', chainId: 10, ids: ['eip155:10', 'optimism'] },
	{ family: 'polygon', label: 'Polygon', chainId: 137, ids: ['eip155:137', 'polygon'] },
	{ family: 'xlayer', label: 'X Layer', chainId: 196, ids: ['eip155:196', 'xlayer', 'x-layer'] },
];

const BY_ID = new Map();
for (const f of FAMILIES) for (const id of f.ids) BY_ID.set(id.toLowerCase(), f);

const BY_FAMILY = new Map(FAMILIES.map((f) => [f.family, f]));

const UNKNOWN = { family: 'unknown', label: 'Unknown network', cluster: null, chainId: null };

const EVM_TX_RE = /^0x[0-9a-f]{64}$/i;

/**
 * Fold a raw ledger network value into a stable family slug plus a display label.
 * Unrecognised CAIP-2 ids still resolve: an `eip155:<id>` borrows its name from
 * the chain table, and any other `solana:<ref>` reads as Solana.
 *
 * @param {string|null|undefined} raw
 * @returns {{ id: string|null, family: string, label: string, cluster: string|null, chainId: number|null }}
 */
export function networkIdentity(raw) {
	const id = typeof raw === 'string' ? raw.trim() : '';
	if (!id) return { id: null, ...UNKNOWN };

	const known = BY_ID.get(id.toLowerCase());
	if (known) {
		return {
			id,
			family: known.family,
			label: known.label,
			cluster: known.cluster || null,
			chainId: known.chainId || null,
		};
	}

	const evm = /^eip155:(\d{1,9})$/i.exec(id);
	if (evm) {
		const chainId = Number(evm[1]);
		const chain = CHAIN_BY_ID[chainId];
		return {
			id,
			family: `eip155-${chainId}`,
			label: chain?.name || `EVM chain ${chainId}`,
			cluster: null,
			chainId,
		};
	}

	// Any other Solana reference (a cluster we have not named) is still Solana.
	if (/^solana:/i.test(id)) {
		return { id, family: 'solana', label: 'Solana', cluster: null, chainId: null };
	}

	return { id, ...UNKNOWN };
}

/** Display label for a raw ledger network value. */
export function networkLabel(raw) {
	return networkIdentity(raw).label;
}

/**
 * Turn a caller-supplied `?network=` value into the set of raw ledger ids it
 * selects. Accepts a family slug ('solana', 'base'), a legacy bare name, or a
 * full CAIP-2 id, so a deep link built from any of them resolves to the same
 * rows. Returns null when the value names no network we can match, which callers
 * treat as "no filter" rather than "match nothing".
 *
 * @param {string|null|undefined} input
 * @returns {{ family: string, ids: string[] }|null}
 */
export function resolveNetworkFilter(input) {
	const v = typeof input === 'string' ? input.trim().toLowerCase() : '';
	if (!v) return null;

	const direct = BY_FAMILY.get(v);
	if (direct) return { family: direct.family, ids: [...direct.ids] };

	const byId = BY_ID.get(v);
	if (byId) return { family: byId.family, ids: [...byId.ids] };

	const evm = /^(?:eip155-|eip155:)(\d{1,9})$/.exec(v);
	if (evm) return { family: `eip155-${evm[1]}`, ids: [`eip155:${evm[1]}`] };

	return null;
}

/**
 * Explorer URL for a settlement transaction on its own chain. Returns null when
 * the chain has no explorer we know, so the UI renders no link instead of one
 * that lands on the wrong chain's 404.
 *
 * @param {string|null|undefined} hash
 * @param {string|null|undefined} raw network id from the ledger
 * @returns {string|null}
 */
export function revenueTxUrl(hash, raw) {
	const sig = typeof hash === 'string' ? hash.trim() : '';
	if (!sig) return null;
	const net = networkIdentity(raw);

	if (net.chainId) {
		const explorer = CHAIN_BY_ID[net.chainId]?.explorer;
		return explorer ? `${explorer}/tx/${sig}` : null;
	}
	if (net.family.startsWith('solana')) {
		return `https://solscan.io/tx/${sig}${net.cluster ? `?cluster=${net.cluster}` : ''}`;
	}
	if (net.family.startsWith('eip155-')) return null;

	// Unknown network: the signature shape still tells the two rails apart, and
	// only Solana can be resolved without a chain id.
	return EVM_TX_RE.test(sig) ? null : `https://solscan.io/tx/${sig}`;
}

/**
 * Collapse per-raw-id revenue rows into one row per family, so the UI shows
 * "Solana" once instead of a genesis hash per cluster spelling. Rows keep the
 * raw ids they folded in (`caip`) for anyone reconciling against the ledger.
 *
 * @param {Array<{network: string|null, count: number, gross_usd: number}>} rows
 * @returns {Array<{network: string, label: string, count: number, gross_usd: number, caip: string[]}>}
 */
export function foldNetworkRows(rows) {
	const byFamily = new Map();
	for (const r of rows || []) {
		const net = networkIdentity(r.network);
		const cur = byFamily.get(net.family) || {
			network: net.family,
			label: net.label,
			count: 0,
			gross_usd: 0,
			caip: [],
		};
		cur.count += Number(r.count) || 0;
		cur.gross_usd += Number(r.gross_usd) || 0;
		if (r.network && !cur.caip.includes(r.network)) cur.caip.push(r.network);
		byFamily.set(net.family, cur);
	}
	return [...byFamily.values()]
		.map((r) => ({ ...r, gross_usd: Number(r.gross_usd.toFixed(6)) }))
		.sort((a, b) => b.gross_usd - a.gross_usd || b.count - a.count);
}
