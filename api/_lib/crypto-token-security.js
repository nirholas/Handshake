// Token security / rug-signal composition for the free Crypto Data API
// (/api/crypto/security).
//
// The single most-requested pre-trade check in agent workflows: before buying or
// LPing into a token, is there a rug lever? This wraps the platform's EXISTING
// fact readers rather than inventing new ones:
//   - parseMintAccount / parseTopHolders / parseLiquidity from the v1 security
//     reader (api/v1/token/security.js) — mint & freeze authority, supply,
//     top-holder concentration, liquidity depth.
//   - fetchTokenMarket (token-market.js / DexScreener) — the liquidity read.
//   - fetchPumpCoin + isGraduated (pump-bonding.js / pump-launch-feed.js) — the
//     LP-custody fact for pump.fun-native coins: on-curve liquidity sits in the
//     bonding-curve program and graduated liquidity is burned (Raydium) or
//     protocol-owned (PumpSwap), so the deployer cannot pull it either way.
//   - A pure Metaplex Token Metadata parser (the existing solana-token-meta.js
//     decoder stops before is_mutable; this one reads the full tail) — whether
//     the token's identity can still be rewritten.
//
// The riskLevel is a DOCUMENTED, DETERMINISTIC rule over the boolean checks —
// never an LLM opinion, and an unknown input is never guessed (docs/crypto-api.md
// spells out the exact rule). Every network dependency is injectable so each
// state — full data, each source down, keyless degradation — is unit-testable.

import { PublicKey } from '@solana/web3.js';
import { parseMintAccount, parseTopHolders, parseLiquidity } from '../v1/token/security.js';
import { fetchTokenMarket } from './token-market.js';
import { fetchPumpCoin } from './pump-bonding.js';
import { isGraduated } from './pump-launch-feed.js';
import { solanaRpcEndpoints, makeRotatingFetch } from './solana/connection.js';

const METADATA_PROGRAM = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
// Budget for ONE JSON-RPC read across the WHOLE failover chain, not per
// endpoint. makeRotatingFetch bounds each attempt itself (10s) and composes the
// caller's signal with AbortSignal.any, so a caller cap below that bound spends
// the entire budget on the first endpoint and every rotation after it aborts
// instantly: at 8s a read that hit one slow lane logged "all 9 endpoints failed
// this request" and answered 503, while a retry seconds later succeeded. Sized
// to cover a couple of real attempts, matching the wallet-activity lane.
const RPC_TIMEOUT_MS = 25_000;

// Concentration thresholds shared with the v1 reader's flags, so the two
// security surfaces can never disagree about what "concentrated" means.
export const TOP1_FLAG_PCT = 20;
export const TOP10_FLAG_PCT = 80;
export const THIN_LIQUIDITY_USD = 10_000;

/** Metadata PDA for a mint — ["metadata", program, mint] under the Metaplex program. */
export function metadataPdaFor(mint) {
	const [pda] = PublicKey.findProgramAddressSync(
		[Buffer.from('metadata'), METADATA_PROGRAM.toBuffer(), new PublicKey(mint).toBuffer()],
		METADATA_PROGRAM,
	);
	return pda.toBase58();
}

/**
 * Parse a raw Metaplex Token Metadata account buffer through to the is_mutable
 * flag. Layout: key(1) + updateAuthority(32) + mint(32) + name/symbol/uri (each
 * u32 length prefix + fixed-max padded bytes) + sellerFeeBasisPoints(2) +
 * Option<creators>(1 [+ 4 + n*34]) + primarySaleHappened(1) + isMutable(1).
 * Returns null on a buffer too short/malformed to read honestly.
 *
 * @param {Buffer} buf
 * @returns {null | { updateAuthority: string, isMutable: boolean }}
 */
export function parseMetadataAccount(buf) {
	if (!Buffer.isBuffer(buf) || buf.length < 1 + 32 + 32 + 4) return null;
	let cursor = 1 + 32 + 32;
	for (const max of [32, 10, 200]) { // name, symbol, uri
		if (cursor + 4 > buf.length) return null;
		cursor += 4 + max;
	}
	cursor += 2; // seller_fee_basis_points
	if (cursor >= buf.length) return null;
	const hasCreators = buf.readUInt8(cursor) === 1;
	cursor += 1;
	if (hasCreators) {
		if (cursor + 4 > buf.length) return null;
		const count = buf.readUInt32LE(cursor);
		if (count > 5) return null; // Metaplex caps creators at 5 — anything else is not this layout
		cursor += 4 + count * 34; // creator = address(32) + verified(1) + share(1)
	}
	cursor += 1; // primary_sale_happened
	if (cursor >= buf.length) return null;
	return {
		updateAuthority: new PublicKey(buf.subarray(1, 33)).toBase58(),
		isMutable: buf.readUInt8(cursor) === 1,
	};
}

/**
 * Metadata mutability for a Token-2022 mint, read from the SAME jsonParsed
 * getAccountInfo the authority check uses. pump.fun (and increasingly the rest
 * of the ecosystem) mints Token-2022 with the token-metadata extension embedded
 * in the mint account — there is NO Metaplex PDA for these tokens. The
 * extension's updateAuthority is the mutability fact: set → the identity can
 * be rewritten; None → immutable. Returns null for classic SPL mints (no
 * extensions array), which fall back to the Metaplex PDA parse above.
 */
export function metaFromMintExtensions(result) {
	const info = result?.value?.data?.parsed?.info;
	const exts = Array.isArray(info?.extensions) ? info.extensions : null;
	if (!exts) return null;
	const tm = exts.find((e) => e?.extension === 'tokenMetadata');
	if (!tm) return null;
	const updateAuthority = tm.state?.updateAuthority ?? null;
	return { updateAuthority, isMutable: updateAuthority !== null };
}

/**
 * Derive the six named checks from the resolved sections. Every check is a hard
 * observable; an unresolved input yields null, never a guess.
 *
 * lpBurnedOrLocked is only assertable for pump.fun-native coins, where it is a
 * protocol fact: on-curve liquidity is custodied by the bonding-curve program,
 * and graduation burns the LP (Raydium) or moves it to a protocol-owned pool
 * (PumpSwap). For every other token it is null (unknown), never a fake "safe".
 */
export function deriveChecks({ mint, holders, liquidity, meta, pump }) {
	const top1 = holders?.top1_pct ?? null;
	const top10 = holders?.top10_pct ?? null;
	return {
		mintAuthorityRevoked: mint ? mint.mint_authority.revoked : null,
		freezeAuthorityRevoked: mint ? mint.freeze_authority.revoked : null,
		metadataMutable: meta ? meta.isMutable : null,
		lpBurnedOrLocked: pump?.isPump ? true : null,
		liquidityUsd: liquidity?.usd ?? null,
		topHolderPctFlag:
			top1 == null && top10 == null
				? null
				: (top1 != null && top1 > TOP1_FLAG_PCT) || (top10 != null && top10 > TOP10_FLAG_PCT),
	};
}

/**
 * The deterministic checks → riskLevel rule (documented in docs/crypto-api.md;
 * keep the two in sync):
 *
 *   HIGH    — a live rug lever: mint or freeze authority NOT revoked, or
 *             concentrated holders (topHolderPctFlag) on thin liquidity
 *             (< $10k).
 *   MEDIUM  — no live lever, but a caution signal: concentrated holders,
 *             thin liquidity (< $10k), or mutable metadata.
 *   LOW     — both authorities verifiably revoked, no concentration flag, and
 *             liquidity known and ≥ $10k.
 *   UNKNOWN — the inputs needed to clear LOW are unresolved and nothing
 *             triggered HIGH/MEDIUM (e.g. RPC couldn't read the mint).
 *
 * Returns reasons[] naming, in plain language, exactly which conditions fired —
 * including which inputs were unknown when the level is 'unknown'.
 */
export function deriveRiskLevel(checks) {
	const reasons = [];
	const {
		mintAuthorityRevoked, freezeAuthorityRevoked, metadataMutable,
		liquidityUsd, topHolderPctFlag,
	} = checks;

	if (mintAuthorityRevoked === false) {
		reasons.push('mint authority is still active — the deployer can mint unlimited new supply');
	}
	if (freezeAuthorityRevoked === false) {
		reasons.push('freeze authority is still active — the deployer can freeze holders\' token accounts');
	}
	const thin = liquidityUsd != null && liquidityUsd < THIN_LIQUIDITY_USD;
	if (topHolderPctFlag === true && thin) {
		reasons.push(`holder concentration (top1 > ${TOP1_FLAG_PCT}% or top10 > ${TOP10_FLAG_PCT}%) on thin liquidity (< $${THIN_LIQUIDITY_USD.toLocaleString('en-US')}) — trivially dumpable`);
	}
	if (reasons.length) return { riskLevel: 'high', reasons };

	if (topHolderPctFlag === true) {
		reasons.push(`top holders are concentrated (top1 > ${TOP1_FLAG_PCT}% or top10 > ${TOP10_FLAG_PCT}% of supply)`);
	}
	if (thin) {
		reasons.push(`liquidity is under $${THIN_LIQUIDITY_USD.toLocaleString('en-US')} — large exits will slip hard`);
	}
	if (metadataMutable === true) {
		reasons.push('token metadata is mutable — name/symbol/image can still be rewritten');
	}
	if (reasons.length) return { riskLevel: 'medium', reasons };

	if (mintAuthorityRevoked === true && freezeAuthorityRevoked === true && liquidityUsd != null && topHolderPctFlag !== null) {
		reasons.push('mint and freeze authorities are revoked, holders are not concentrated, and liquidity is healthy');
		return { riskLevel: 'low', reasons };
	}

	if (mintAuthorityRevoked == null) reasons.push('mint account could not be read — authority status unknown');
	if (topHolderPctFlag == null) reasons.push('holder concentration could not be read');
	if (liquidityUsd == null) reasons.push('no liquidity data — token may have no indexed pair yet');
	return { riskLevel: 'unknown', reasons };
}

// One JSON-RPC call over the platform's failover chain (same envelope semantics
// as the v1 reader: a JSON-RPC error is an answered-but-empty section, a
// rejection means every endpoint is down).
async function rpcCall(rpcFetch, method, params) {
	const resp = await rpcFetch(null, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
		signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
	});
	return resp.json();
}

// Default network dependency bundle — split out so composeTokenSecurity can be
// driven by synthetic fixtures in tests.
export function realSecurityDeps() {
	const rpcFetch = makeRotatingFetch(solanaRpcEndpoints('mainnet'));
	return {
		fetchMintAccount: (address) =>
			rpcCall(rpcFetch, 'getAccountInfo', [address, { encoding: 'jsonParsed', commitment: 'confirmed' }]),
		fetchLargestAccounts: (address) =>
			rpcCall(rpcFetch, 'getTokenLargestAccounts', [address, { commitment: 'confirmed' }]),
		fetchMetadataAccount: (address) =>
			rpcCall(rpcFetch, 'getAccountInfo', [metadataPdaFor(address), { encoding: 'base64', commitment: 'confirmed' }]),
		fetchMarket: (address) => fetchTokenMarket(address),
		fetchPump: (address) => fetchPumpCoin(address),
	};
}

/**
 * Compose the full security report for one Solana mint. All five reads run in
 * parallel and degrade independently — a partial upstream failure nulls only
 * its checks; the call resolves if ANY section answered.
 *
 * @param {{ address: string }} input
 * @param {ReturnType<typeof realSecurityDeps>} [deps]
 * @returns {Promise<
 *   | { status: 'ok', checks: object, riskLevel: string, reasons: string[], sources: string[] }
 *   | { status: 'not_found' }
 *   | { status: 'upstream_down' }
 * >}
 */
export async function composeTokenSecurity({ address }, deps = realSecurityDeps()) {
	const [acct, largest, metaAcct, mkt, pump] = await Promise.allSettled([
		deps.fetchMintAccount(address),
		deps.fetchLargestAccounts(address),
		deps.fetchMetadataAccount(address),
		deps.fetchMarket(address),
		deps.fetchPump(address),
	]);

	const mint = acct.status === 'fulfilled' ? parseMintAccount(acct.value?.result) : null;
	const holders = largest.status === 'fulfilled'
		? parseTopHolders(largest.value?.result?.value, mint?.supply)
		: null;
	const liquidity = mkt.status === 'fulfilled' ? parseLiquidity(mkt.value) : null;

	// Metadata mutability: Token-2022 mints carry it in the mint account itself
	// (the tokenMetadata extension); classic SPL mints keep a Metaplex PDA.
	let meta = acct.status === 'fulfilled' ? metaFromMintExtensions(acct.value?.result) : null;
	if (!meta && metaAcct.status === 'fulfilled') {
		const b64 = metaAcct.value?.result?.value?.data?.[0];
		if (b64) meta = parseMetadataAccount(Buffer.from(b64, 'base64'));
	}

	const pumpResolved = pump.status === 'fulfilled' ? pump.value : null;
	const pumpFact = pumpResolved?.kind === 'ok'
		? { isPump: true, graduated: isGraduated(pumpResolved.coin) }
		: null;

	const sources = [];
	if (mint || holders || meta) sources.push('solana-rpc');
	if (liquidity) sources.push('dexscreener');
	if (pumpFact) sources.push('pumpfun');

	if (!sources.length) {
		// Nothing answered with data. Distinguish "all transport failed" (retry)
		// from "sources answered, token unknown" (client input) — an outage must
		// never masquerade as a not-found, and vice versa.
		const allFailed =
			acct.status !== 'fulfilled' &&
			largest.status !== 'fulfilled' &&
			mkt.status !== 'fulfilled' &&
			(pump.status !== 'fulfilled' || pumpResolved?.kind === 'upstream_down');
		return { status: allFailed ? 'upstream_down' : 'not_found' };
	}

	const checks = deriveChecks({ mint, holders, liquidity, meta, pump: pumpFact });
	const { riskLevel, reasons } = deriveRiskLevel(checks);
	return { status: 'ok', checks, riskLevel, reasons, sources };
}
