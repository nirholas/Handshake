// Seeker Genesis Token (SGT) verification.
//
// Every Solana Seeker phone mints one soulbound Token-2022 token into its
// owner's wallet. Holding one proves the wallet belongs to a Seeker owner.
// Verification follows the Solana Mobile reference logic
// (docs.solanamobile.com/marketing/engaging-seeker-users): a token account
// under the Token-2022 program with amount >= 1 whose MINT has the SGT mint
// authority, a metadata-pointer extension aimed at the SGT group address, and a
// token-group-member extension whose group is that same address.
//
// Fail closed: every RPC error throws. This module never answers "not a
// Seeker" because the network was down.

import { dasRpcUrl } from './nft-gate.js';

export const SGT_TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const SGT_MINT_AUTHORITY = 'GT2zuHVaZQYZSyQMgJPLzvkmyztfyXg2NJunqFp4p3A4';
export const SGT_GROUP = 'GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te';

const RPC_TIMEOUT_MS = 8000;
const PAGE_LIMIT = 1000;
const MINT_BATCH = 100;

async function rpc(method, params, { fetchImpl, rpcUrl }) {
	const r = await fetchImpl(rpcUrl, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 'seeker-genesis', method, params }),
		signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
	});
	if (!r.ok) throw new Error(`rpc ${method} ${r.status}`);
	const body = await r.json();
	if (body?.error) throw new Error(`rpc ${method} error ${body.error.code}: ${body.error.message}`);
	return body?.result;
}

/**
 * True when a jsonParsed Token-2022 mint account (as returned by
 * getMultipleAccounts / getAccountInfo with encoding jsonParsed) is a Seeker
 * Genesis Token mint. Pure: no network.
 */
export function isSeekerGenesisMint(parsedMintAccount) {
	const data = parsedMintAccount?.data ?? parsedMintAccount;
	const parsed = data?.parsed;
	if (!parsed || parsed.type !== 'mint') return false;
	if (parsedMintAccount?.owner && parsedMintAccount.owner !== SGT_TOKEN_2022_PROGRAM) return false;
	const info = parsed.info || {};
	if (info.mintAuthority !== SGT_MINT_AUTHORITY) return false;
	const extensions = Array.isArray(info.extensions) ? info.extensions : [];
	const pointer = extensions.find((e) => e?.extension === 'metadataPointer');
	const member = extensions.find((e) => e?.extension === 'tokenGroupMember');
	if (!pointer || !member) return false;
	if (pointer.state?.metadataAddress !== SGT_GROUP) return false;
	if (member.state?.group !== SGT_GROUP) return false;
	return true;
}

async function listToken2022Accounts(walletAddress, opts) {
	const out = [];
	let paginationKey;
	do {
		const options = { encoding: 'jsonParsed', limit: PAGE_LIMIT };
		if (paginationKey) options.paginationKey = paginationKey;
		const result = await rpc(
			'getTokenAccountsByOwnerV2',
			[walletAddress, { programId: SGT_TOKEN_2022_PROGRAM }, options],
			opts,
		);
		const page = result?.accounts ?? result?.value ?? [];
		for (const entry of page) {
			const info = entry?.account?.data?.parsed?.info;
			if (!info?.mint) continue;
			const amount = Number(info.tokenAmount?.amount ?? 0);
			if (amount >= 1) out.push({ tokenAccount: entry.pubkey, mint: info.mint });
		}
		paginationKey = result?.paginationKey || null;
	} while (paginationKey);
	return out;
}

/**
 * Scan a wallet for a Seeker Genesis Token. Resolves `{ mint, tokenAccount }`
 * for the first matching holding, or `null` when the wallet holds none.
 * Throws on any RPC failure or when no Helius endpoint is configured.
 */
export async function findSeekerGenesisToken(walletAddress, { fetchImpl = fetch, rpcUrl = dasRpcUrl() } = {}) {
	if (!rpcUrl) throw new Error('Seeker verification requires a Helius RPC endpoint (set HELIUS_API_KEY)');
	const opts = { fetchImpl, rpcUrl };
	const holdings = await listToken2022Accounts(walletAddress, opts);
	for (let i = 0; i < holdings.length; i += MINT_BATCH) {
		const batch = holdings.slice(i, i + MINT_BATCH);
		const result = await rpc('getMultipleAccounts', [batch.map((h) => h.mint), { encoding: 'jsonParsed' }], opts);
		const accounts = result?.value ?? [];
		for (let j = 0; j < batch.length; j++) {
			if (isSeekerGenesisMint(accounts[j])) return { mint: batch[j].mint, tokenAccount: batch[j].tokenAccount };
		}
	}
	return null;
}
