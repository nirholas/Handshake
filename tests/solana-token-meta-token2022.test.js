/**
 * api/_lib/solana-token-meta.js: which on-chain account a mint's name, symbol,
 * and off-chain `uri` actually come from.
 *
 * The reader used to look in exactly one place, the Metaplex Token Metadata
 * PDA. Every pump.fun launch since the Token-2022 cutover, the platform coin
 * $THREE included, stores that metadata INSIDE the mint account instead, in the
 * TokenMetadata extension, and has no Metaplex account at all. So the two paid
 * routes built on this reader (/api/x402/mint-to-mesh and its batch sibling)
 * charged a buyer $0.001 and handed back an untitled, untextured cube:
 * name null, symbol null, hasImage false, because the off-chain `uri` that
 * carries the image was never found either.
 *
 * The mint account bytes below are the real 411-byte $THREE mint account read
 * from mainnet, so the Token-2022 path is decoded here exactly as it is in
 * production, with no network and no stub decoder.
 *
 * Third rule pinned here: an address that exists on-chain but is not a token
 * mint at all (a program, a PDA, a wallet) is a 404, not a nameless husk a
 * caller gets billed for.
 */

import { readFileSync } from 'node:fs';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';

const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const SYSTEM_PROGRAM = '11111111111111111111111111111112';

// Real mainnet bytes: the $THREE mint account, carrying the metadataPointer and
// tokenMetadata extensions (name "three.ws", symbol "three", ipfs.io uri).
const THREE_MINT_DATA = Buffer.from(
	readFileSync(
		new URL('./_fixtures/three-mint-token2022.base64', import.meta.url),
		'utf8',
	).trim(),
	'base64',
);

// A classic SPL mint: 82 bytes, owned by the original token program, metadata
// lives in a separate Metaplex PDA. Layout tail is what the reader parses.
const CLASSIC_MINT_DATA = Buffer.alloc(82);

// Metaplex metadata account body: key(1) updateAuthority(32) mint(32) then
// borsh name/symbol/uri, each length-prefixed and space-padded to its max.
function metaplexAccount({ name, symbol, uri }) {
	const parts = [Buffer.alloc(1 + 32 + 32)];
	const padded = (value, max) => {
		const len = Buffer.alloc(4);
		len.writeUInt32LE(value.length, 0);
		const body = Buffer.alloc(max);
		body.write(value, 'utf8');
		return Buffer.concat([len, body]);
	};
	parts.push(padded(name, 32), padded(symbol, 10), padded(uri, 200));
	return Buffer.concat(parts);
}

// Accounts keyed by address; anything not listed does not exist on chain.
let accounts = new Map();

vi.mock('../api/_lib/pump.js', () => ({
	solanaPubkey: (value) => {
		try {
			return new PublicKey(value);
		} catch {
			return null;
		}
	},
	getConnection: () => ({
		getAccountInfo: async (pk) => accounts.get(pk.toBase58()) || null,
	}),
}));

const { fetchTokenMeta } = await import('../api/_lib/solana-token-meta.js');

// The off-chain JSON document is a network read; every case here either has no
// uri or stubs the fetch, so no test touches the internet.
const originalFetch = globalThis.fetch;

beforeEach(() => {
	accounts = new Map();
	globalThis.fetch = originalFetch;
});

describe('fetchTokenMeta: Token-2022 inline metadata', () => {
	it('reads name, symbol, and uri out of the mint account itself', async () => {
		accounts.set(THREE_MINT, { owner: TOKEN_2022_PROGRAM_ID, data: THREE_MINT_DATA });
		// The reader follows the uri to the off-chain document for the image.
		globalThis.fetch = async () =>
			new Response(JSON.stringify({ description: 'the three.ws coin' }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});

		const meta = await fetchTokenMeta(THREE_MINT, { includeImage: false });

		expect(meta.name).toBe('three.ws');
		expect(meta.symbol).toBe('three');
		expect(meta.uri).toBe(
			'https://ipfs.io/ipfs/bafkreiftorgs5knoqr3z53unjpdmgyhp4abjnqjkast3iq3tfofetm2oom',
		);
		expect(meta.description).toBe('the three.ws coin');
	});

	it('does not need a Metaplex account to exist for a Token-2022 mint', async () => {
		accounts.set(THREE_MINT, { owner: TOKEN_2022_PROGRAM_ID, data: THREE_MINT_DATA });
		globalThis.fetch = async () => new Response('{}', { status: 200 });

		// accounts holds ONLY the mint, so any PDA read resolves to null.
		await expect(fetchTokenMeta(THREE_MINT, { includeImage: false })).resolves.toMatchObject({
			symbol: 'three',
		});
	});
});

describe('fetchTokenMeta: classic SPL mints still read the Metaplex PDA', () => {
	it('resolves name and symbol from the metadata account', async () => {
		const mintPk = new PublicKey(THREE_MINT);
		const metadataProgram = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
		const [pda] = PublicKey.findProgramAddressSync(
			[Buffer.from('metadata'), metadataProgram.toBuffer(), mintPk.toBuffer()],
			metadataProgram,
		);
		accounts.set(THREE_MINT, { owner: TOKEN_PROGRAM_ID, data: CLASSIC_MINT_DATA });
		accounts.set(pda.toBase58(), {
			owner: metadataProgram,
			data: metaplexAccount({ name: 'Legacy Coin', symbol: 'LEG', uri: '' }),
		});

		const meta = await fetchTokenMeta(THREE_MINT, { includeImage: false });

		expect(meta.name).toBe('Legacy Coin');
		expect(meta.symbol).toBe('LEG');
	});
});

describe('fetchTokenMeta: addresses that are not token mints', () => {
	it('rejects an on-chain account owned by some other program', async () => {
		// The system program address exists, so the "account not found" guard
		// alone waves it through. Only the owner check catches it.
		accounts.set(SYSTEM_PROGRAM, {
			owner: new PublicKey('11111111111111111111111111111111'),
			data: Buffer.alloc(0),
		});

		await expect(fetchTokenMeta(SYSTEM_PROGRAM)).rejects.toMatchObject({
			code: 'mint_not_found',
			status: 404,
		});
	});

	it('rejects an address with no account at all', async () => {
		await expect(fetchTokenMeta(THREE_MINT)).rejects.toMatchObject({
			code: 'mint_not_found',
			status: 404,
		});
	});

	it('rejects a string that is not a base58 pubkey', async () => {
		await expect(fetchTokenMeta('not-a-mint')).rejects.toMatchObject({
			code: 'invalid_mint',
			status: 400,
		});
	});
});
