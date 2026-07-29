/**
 * Pure helpers for the /receipts page (buyer-side x402 receipt vault).
 *
 * Kept free of DOM and wallet dependencies so the signing-message contract,
 * explorer routing, and CSV export are unit-testable. The message built here
 * MUST stay byte-identical to buildExpectedMessage() in
 * api/x402/my-receipts.js or signatures stop verifying.
 */

/**
 * Build the personal-sign message the API expects.
 * EVM addresses are lowercased (matching the server's normalization);
 * Solana base58 is case-sensitive and stays verbatim.
 *
 * @param {string} address
 * @param {string} issuedAt ISO timestamp
 * @param {'evm'|'solana'} network
 * @returns {string}
 */
export function buildReceiptsMessage(address, issuedAt, network) {
	const normalized = network === 'solana' ? address : address.toLowerCase();
	return `three.ws x402 receipts read\nNetwork: ${network}\nAddress: ${normalized}\nIssued At: ${issuedAt}`;
}

/** Seconds a signature stays fresh server-side (mirrors MAX_AGE_SECONDS). */
export const SIGNATURE_TTL_SECONDS = 300;

/**
 * True when a previously issued signature is still inside the server's
 * freshness window, with a safety margin so an in-flight request can't
 * expire mid-round-trip.
 *
 * @param {string} issuedAt ISO timestamp the signature was issued at
 * @param {number} [nowMs] injection point for tests
 */
export function signatureStillFresh(issuedAt, nowMs = Date.now()) {
	const ts = Date.parse(issuedAt);
	if (!Number.isFinite(ts)) return false;
	const ageSec = (nowMs - ts) / 1000;
	return ageSec >= 0 && ageSec <= SIGNATURE_TTL_SECONDS - 30;
}

// Stored receipt networks arrive either as CAIP-2 ("eip155:8453",
// "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp") or as the plain x402 network
// string ("base", "solana"). Both forms route here.
const EXPLORER_BY_CHAIN = {
	solana: { label: 'Solana', tx: 'https://solscan.io/tx/' },
	'solana-devnet': { label: 'Solana Devnet', tx: 'https://solscan.io/tx/' },
	'eip155:1': { label: 'Ethereum', tx: 'https://etherscan.io/tx/' },
	'eip155:8453': { label: 'Base', tx: 'https://basescan.org/tx/' },
	'eip155:84532': { label: 'Base Sepolia', tx: 'https://sepolia.basescan.org/tx/' },
	'eip155:56': { label: 'BNB Chain', tx: 'https://bscscan.com/tx/' },
	'eip155:137': { label: 'Polygon', tx: 'https://polygonscan.com/tx/' },
	'eip155:42161': { label: 'Arbitrum', tx: 'https://arbiscan.io/tx/' },
};

const PLAIN_ALIASES = {
	ethereum: 'eip155:1',
	base: 'eip155:8453',
	'base-sepolia': 'eip155:84532',
	bsc: 'eip155:56',
	polygon: 'eip155:137',
	arbitrum: 'eip155:42161',
};

/** @param {string|null|undefined} network */
function chainKey(network) {
	const raw = String(network || '').trim().toLowerCase();
	if (!raw) return null;
	if (raw.startsWith('solana')) return raw.includes('devnet') ? 'solana-devnet' : 'solana';
	if (EXPLORER_BY_CHAIN[raw]) return raw;
	if (PLAIN_ALIASES[raw]) return PLAIN_ALIASES[raw];
	if (raw.startsWith('eip155:')) return raw;
	return null;
}

/**
 * Human label for a stored receipt network. Unknown networks fall back to the
 * raw string so nothing renders blank.
 * @param {string|null|undefined} network
 */
export function networkLabel(network) {
	const key = chainKey(network);
	if (key && EXPLORER_BY_CHAIN[key]) return EXPLORER_BY_CHAIN[key].label;
	return String(network || 'unknown');
}

/**
 * Explorer URL for a settlement transaction, or null when the chain has no
 * mapped explorer (callers then render the raw hash, copyable).
 * @param {string|null|undefined} network
 * @param {string|null|undefined} transaction
 */
export function explorerTxUrl(network, transaction) {
	if (!transaction) return null;
	const key = chainKey(network);
	const entry = key ? EXPLORER_BY_CHAIN[key] : null;
	if (!entry) return null;
	const suffix = key === 'solana-devnet' ? '?cluster=devnet' : '';
	return `${entry.tx}${encodeURIComponent(transaction)}${suffix}`;
}

/** @param {string} addr */
export function shortAddress(addr) {
	const s = String(addr || '');
	if (s.length <= 12) return s;
	return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

/**
 * Compact display path for a receipt's resource URL: strips the origin when
 * it is a three.ws URL, otherwise shows host + path.
 * @param {string} resourceUrl
 */
export function resourceDisplay(resourceUrl) {
	const s = String(resourceUrl || '');
	try {
		const u = new URL(s);
		const host = u.host.replace(/^www\./, '');
		const path = u.pathname + (u.search || '');
		return host === 'three.ws' ? path : `${host}${path}`;
	} catch {
		return s;
	}
}

// Every x402 asset we settle in is a 6-decimal stablecoin (USDC on Solana and
// on each EVM chain). Anything else stays unformatted rather than being
// rendered at the wrong scale.
const SIX_DECIMAL_ASSETS = new Set([
	'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC, Solana mainnet
	'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC, Base
	'0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', // USDC, BNB Chain
	'0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC, Ethereum
]);

/**
 * Human amount for a settled receipt, or null when we can't render it safely.
 * @param {string|number|null|undefined} amountAtomics
 * @param {string|null|undefined} asset
 * @returns {{ value: number, label: string }|null}
 */
export function formatReceiptAmount(amountAtomics, asset) {
	if (amountAtomics == null || amountAtomics === '') return null;
	const atomic = Number(amountAtomics);
	if (!Number.isFinite(atomic)) return null;
	const key = String(asset || '').toLowerCase();
	const known = SIX_DECIMAL_ASSETS.has(String(asset || '')) || SIX_DECIMAL_ASSETS.has(key);
	if (!known) return null;
	const value = atomic / 1e6;
	// Sub-cent micropayments are the norm on this rail, so show enough
	// precision that a $0.001 call doesn't render as $0.00.
	const label =
		value > 0 && value < 0.01
			? `$${value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`
			: `$${value.toFixed(2)}`;
	return { value, label };
}

/**
 * Total spend across rows whose amount we can render, plus how many rows had
 * no recorded amount (receipts issued before settlement capture landed).
 * @param {Array<{amountAtomics?: string|null, asset?: string|null}>} rows
 */
export function totalSpend(rows) {
	let total = 0;
	let priced = 0;
	let unpriced = 0;
	for (const r of rows || []) {
		const amt = formatReceiptAmount(r.amountAtomics, r.asset);
		if (amt) {
			total += amt.value;
			priced++;
		} else {
			unpriced++;
		}
	}
	const label = total > 0 && total < 0.01 ? `$${total.toFixed(4)}` : `$${total.toFixed(2)}`;
	return { total, label, priced, unpriced };
}

function csvCell(value) {
	const s = value == null ? '' : String(value);
	return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * CSV export of the loaded receipt rows. Columns are stable and documented in
 * docs/x402-receipts.md; the signed receipt itself is excluded (use the
 * per-row JSON download for the full artifact).
 *
 * @param {Array<{id: string|number, issuedAt: string, network: string,
 *   resourceUrl: string, transaction: string|null, format: string,
 *   payer: string}>} rows
 * @returns {string}
 */
export function receiptsToCsv(rows) {
	const header =
		'id,issued_at,network,resource_url,amount_atomics,asset,transaction,format,payer';
	const lines = (rows || []).map((r) =>
		[
			r.id,
			r.issuedAt,
			r.network,
			r.resourceUrl,
			r.amountAtomics,
			r.asset,
			r.transaction,
			r.format,
			r.payer,
		]
			.map(csvCell)
			.join(','),
	);
	return [header, ...lines].join('\n');
}

/**
 * Aggregate stats for the KPI strip.
 * @param {Array<{resourceUrl: string, issuedAt: string, network: string}>} rows
 */
export function summarizeReceipts(rows) {
	const list = rows || [];
	const endpoints = new Set();
	const networks = new Set();
	let first = null;
	let last = null;
	for (const r of list) {
		if (r.resourceUrl) endpoints.add(resourceDisplay(r.resourceUrl));
		if (r.network) networks.add(networkLabel(r.network));
		const ts = Date.parse(r.issuedAt);
		if (Number.isFinite(ts)) {
			if (first === null || ts < first) first = ts;
			if (last === null || ts > last) last = ts;
		}
	}
	return {
		total: list.length,
		endpoints: endpoints.size,
		networks: [...networks],
		firstAt: first === null ? null : new Date(first).toISOString(),
		lastAt: last === null ? null : new Date(last).toISOString(),
	};
}
