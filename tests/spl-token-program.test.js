/**
 * Token program resolution for browser transaction builders.
 *
 * $THREE is a Token-2022 mint. Any builder that leaves @solana/spl-token on its
 * legacy TOKEN_PROGRAM_ID default derives associated-token addresses that do not
 * exist on chain and points instructions at the wrong program, which the runtime
 * rejects during simulation with "incorrect program id for instruction". These
 * tests pin the resolver's contract: read the owner off the mint account, cache
 * it, and refuse anything that is not an SPL mint rather than guessing legacy.
 */

import { describe, it, expect, vi } from 'vitest';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { resolveTokenProgramId } from '../src/shared/spl-token-program.js';

const spl = { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID };

// Distinct mints per case: the resolver caches by mint for the life of the module.
// Only $THREE is real; the rest are synthetic, since the resolver only ever reads
// the owner the stub connection hands back.
const MINT_2022 = new PublicKey('FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump');
const MINT_LEGACY = new PublicKey('THREEsynthetic111111111111111111111111basic');
const MINT_CACHED = new PublicKey('THREEsynthetic11111111111111111111111cached');
const MINT_MISSING = new PublicKey('THREEsynthetic1111111111111111111111missing');
const MINT_FOREIGN = new PublicKey('THREEsynthetic1111111111111111111111foreign');

const connFor = (owner) => ({
	getAccountInfo: vi.fn(async () => (owner ? { owner } : null)),
});

describe('resolveTokenProgramId', () => {
	it('resolves a Token-2022 mint to the Token-2022 program', async () => {
		const conn = connFor(TOKEN_2022_PROGRAM_ID);
		const programId = await resolveTokenProgramId(conn, MINT_2022, spl);
		expect(programId.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
	});

	it('resolves a classic SPL mint to the legacy token program', async () => {
		const conn = connFor(TOKEN_PROGRAM_ID);
		const programId = await resolveTokenProgramId(conn, MINT_LEGACY, spl);
		expect(programId.equals(TOKEN_PROGRAM_ID)).toBe(true);
	});

	it('caches per mint so repeated builds hit RPC once', async () => {
		const first = connFor(TOKEN_2022_PROGRAM_ID);
		await resolveTokenProgramId(first, MINT_CACHED, spl);
		expect(first.getAccountInfo).toHaveBeenCalledTimes(1);

		const second = connFor(TOKEN_2022_PROGRAM_ID);
		const programId = await resolveTokenProgramId(second, MINT_CACHED, spl);
		expect(second.getAccountInfo).not.toHaveBeenCalled();
		expect(programId.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
	});

	it('throws when the mint account does not exist', async () => {
		await expect(resolveTokenProgramId(connFor(null), MINT_MISSING, spl)).rejects.toThrow(
			/not found/i,
		);
	});

	it('throws instead of falling back to legacy for a non-SPL owner', async () => {
		const conn = connFor(SystemProgram.programId);
		await expect(resolveTokenProgramId(conn, MINT_FOREIGN, spl)).rejects.toThrow(
			/not an spl token mint/i,
		);
	});
});
