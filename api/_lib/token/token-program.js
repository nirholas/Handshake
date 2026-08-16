// Which SPL token program owns the $THREE mint, read from the chain.
//
// $THREE is a Token-2022 mint (as is every pump.fun coin minted since the
// Token-2022 switch), while @solana/spl-token defaults every helper to the legacy
// TOKEN_PROGRAM_ID. Code that takes the default derives an associated-token
// address that does not exist: a balance read comes back as zero for a wallet that
// actually holds tokens, and a transfer built against it is rejected on-chain with
// "incorrect program id for instruction". Both failures are silent-looking, which
// is exactly why this is centralized rather than repeated per call site.
//
// The mint account's owner is canonical and fixed for the life of the mint, so the
// lookup is memoized per process. resolveTokenProgramForMintOwner does the
// classification (and throws a typed 422 for a non-SPL owner).

import { PublicKey } from '@solana/web3.js';
import { resolveTokenProgramForMintOwner } from '../pump-trade-args.js';

const cache = new Map();

/**
 * @param {import('@solana/web3.js').Connection} connection
 * @param {import('@solana/web3.js').PublicKey|string} mint
 * @returns {Promise<PublicKey>} the token program that owns `mint`
 * @throws if the mint account is missing, or is owned by neither SPL token program
 */
export async function tokenProgramIdForMint(connection, mint) {
	const mintPk = mint instanceof PublicKey ? mint : new PublicKey(mint);
	const key = mintPk.toBase58();
	const cached = cache.get(key);
	if (cached) return cached;

	const info = await connection.getAccountInfo(mintPk);
	if (!info) {
		const e = new Error(`mint account not found: ${key}`);
		e.status = 422;
		e.code = 'mint_not_found';
		throw e;
	}

	const programId = resolveTokenProgramForMintOwner(info.owner);
	cache.set(key, programId);
	return programId;
}
