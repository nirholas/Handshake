// Resolve which SPL token program owns a mint, for browser transaction builders.
//
// $THREE (and every pump.fun mint minted after the Token-2022 switch) is a
// Token-2022 mint, not a classic SPL Token mint. @solana/spl-token defaults every
// helper to the legacy TOKEN_PROGRAM_ID, so a builder that omits the program id
// derives the WRONG associated-token address and points the instruction at the
// wrong program. The chain rejects that with "incorrect program id for instruction"
// during simulation, which reads like a malformed transaction rather than what it
// is: the right transfer aimed at the wrong token program.
//
// The mint account's owner is the canonical, on-chain way to tell the two apart,
// and it is fixed for the life of the mint, so the answer is cached per mint.
//
// Node/agent code has the same helper in solana-agent-sdk/src/utils/token-program.ts;
// this is the browser-side counterpart (dynamic spl-token import, no TS types).

const cache = new Map();

/**
 * @param {import('@solana/web3.js').Connection} connection
 * @param {import('@solana/web3.js').PublicKey} mint
 * @param {object} spl                                    the loaded @solana/spl-token module
 * @returns {Promise<import('@solana/web3.js').PublicKey>} TOKEN_PROGRAM_ID or TOKEN_2022_PROGRAM_ID
 * @throws if the mint account is missing or is not owned by either SPL token program
 */
export async function resolveTokenProgramId(connection, mint, spl) {
	const key = mint.toBase58();
	const cached = cache.get(key);
	if (cached) return cached;

	const info = await connection.getAccountInfo(mint);
	if (!info) throw new Error(`Token mint not found on this network: ${key}`);

	let programId;
	if (info.owner.equals(spl.TOKEN_2022_PROGRAM_ID)) programId = spl.TOKEN_2022_PROGRAM_ID;
	else if (info.owner.equals(spl.TOKEN_PROGRAM_ID)) programId = spl.TOKEN_PROGRAM_ID;
	else throw new Error(`Not an SPL token mint (owned by ${info.owner.toBase58()}): ${key}`);

	cache.set(key, programId);
	return programId;
}
