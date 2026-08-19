// Per-agent vanity wallet — the grind primitive and the shared wallet chip.
//
// Covers the two pure pieces of the opt-in vanity feature that don't need a DB
// or an RPC: the server-side keypair grinder (api/_lib/pump-vanity.js, also used
// by POST /api/agents/:id/solana/vanity) and the wallet-chip status normalizer
// every agent/avatar surface renders from (src/shared/agent-wallet-chip.js).

import { describe, it, expect } from 'vitest';

import { grindMintKeypair, estimateAttempts, isValidVanityPrefix, BASE58_ALPHABET } from '../api/_lib/pump-vanity.js';
import { getWalletStatus, getWalletIdentity, hasWallet, walletChipHTML, formatWalletUsd } from '../src/shared/agent-wallet-chip.js';

describe('grindMintKeypair', () => {
	it('finds an address with the requested prefix', async () => {
		// One base58 char ≈ 58 attempts expected — comfortably inside the cap.
		const { keypair, iterations } = await grindMintKeypair({ prefix: 'a', ignoreCase: true, maxIterations: 200_000 });
		const addr = keypair.publicKey.toBase58();
		expect(addr.toLowerCase().startsWith('a')).toBe(true);
		expect(iterations).toBeGreaterThan(0);
	});

	it('finds an address with the requested suffix', async () => {
		const { keypair } = await grindMintKeypair({ suffix: 'z', ignoreCase: true, maxIterations: 200_000 });
		expect(keypair.publicKey.toBase58().toLowerCase().endsWith('z')).toBe(true);
	});

	it('honours case-sensitive prefixes exactly', async () => {
		const { keypair } = await grindMintKeypair({ prefix: 'A', ignoreCase: false, maxIterations: 500_000 });
		expect(keypair.publicKey.toBase58().startsWith('A')).toBe(true);
	});

	it('rejects non-base58 patterns', async () => {
		// 0, O, I, l are not in the base58 alphabet.
		await expect(grindMintKeypair({ prefix: '0' })).rejects.toThrow();
		expect(BASE58_ALPHABET).not.toContain('0');
		expect(isValidVanityPrefix('0')).toBe(false);
		expect(isValidVanityPrefix('ab')).toBe(true);
	});

	it('estimates difficulty as alphabet^length', () => {
		expect(estimateAttempts({ prefix: 'a' })).toBe(58);
		expect(estimateAttempts({ prefix: 'ab' })).toBe(58 * 58);
		// case-insensitive folds the alphabet to ~33 distinct buckets
		expect(estimateAttempts({ prefix: 'ab', ignoreCase: true })).toBe(33 * 33);
	});
});

describe('getWalletStatus / wallet chip', () => {
	const VANITY = 'agntSo1111111111111111111111111111111111ws';
	const PLAIN = '4Nd1mDQkSp9Xb6hT2pXc8QwJ5kR7yZ3aB9cD1eF2gH3';

	it('returns null when there is no solana wallet', () => {
		expect(getWalletStatus({ id: 'x' })).toBeNull();
		expect(hasWallet({ id: 'x' })).toBe(false);
	});

	it('reads the address from any record shape', () => {
		expect(getWalletStatus({ id: 'a', solana_address: PLAIN }).address).toBe(PLAIN);
		expect(getWalletStatus({ id: 'a', meta: { solana_address: PLAIN } }).address).toBe(PLAIN);
		expect(getWalletStatus({ id: 'a', wallet: PLAIN }).address).toBe(PLAIN);
	});

	it('detects vanity from top-level or meta fields', () => {
		const top = getWalletStatus({ id: 'a', solana_address: VANITY, solana_vanity_prefix: 'agnt', solana_vanity_suffix: 'ws' });
		expect(top.isVanity).toBe(true);
		expect(top.prefix).toBe('agnt');
		expect(top.suffix).toBe('ws');
		const viaMeta = getWalletStatus({ id: 'a', meta: { solana_address: VANITY, solana_vanity_prefix: 'agnt' } });
		expect(viaMeta.isVanity).toBe(true);
		expect(getWalletStatus({ id: 'a', solana_address: PLAIN }).isVanity).toBe(false);
	});

	it('renders an owner make-vanity entry point only for non-vanity owner wallets', () => {
		const ownerPlain = walletChipHTML({ id: 'agent-1', solana_address: PLAIN }, { isOwner: true });
		expect(ownerPlain).toContain('/agents/agent-1/wallet#vanity');
		expect(ownerPlain).toContain('data-twc-copy');

		const ownerVanity = walletChipHTML({ id: 'agent-1', solana_address: VANITY, solana_vanity_prefix: 'agnt' }, { isOwner: true });
		expect(ownerVanity).toContain('vanity');
		expect(ownerVanity).not.toContain('#vanity'); // already vanity — no upgrade CTA

		const visitor = walletChipHTML({ id: 'agent-1', solana_address: PLAIN }, { isOwner: false });
		expect(visitor).not.toContain('#vanity');
	});

	it('renders a pending chip when asked and no wallet exists', () => {
		expect(walletChipHTML({ id: 'a' }, { showPending: true })).toContain('Wallet pending');
		expect(walletChipHTML({ id: 'a' }, { showPending: false })).toBe('');
	});

	it('omits interactive controls in link:false mode (safe inside card anchors)', () => {
		const ro = walletChipHTML({ id: 'a', solana_address: PLAIN }, { link: false });
		expect(ro).not.toContain('data-twc-copy');
		expect(ro).not.toContain('<a');
	});
});

describe('wallet identity descriptor (multi-chain + ownership)', () => {
	const PLAIN = '4Nd1mDQkSp9Xb6hT2pXc8QwJ5kR7yZ3aB9cD1eF2gH3';
	const EVM = '0x1234567890abcdef1234567890ABCDEF12345678';
	const UUID = '11111111-2222-4333-8444-555555555555';

	it('exposes the EVM side of the identity, never confusing it with Solana', () => {
		const s = getWalletStatus({ id: UUID, solana_address: PLAIN, wallet_address: EVM });
		expect(s.address).toBe(PLAIN);
		expect(s.evmAddress).toBe(EVM);
		expect(s.evmExplorerUrl).toContain(EVM);
		// A base58 in `wallet` must not leak into evmAddress and vice-versa.
		expect(getWalletStatus({ id: UUID, wallet: PLAIN }).evmAddress).toBeNull();
		expect(getWalletStatus({ id: UUID, solana_address: PLAIN, wallet: EVM }).evmAddress).toBe(EVM);
	});

	it('reads ownership attribution for the visitor "by @creator" view', () => {
		const s = getWalletStatus({ id: UUID, solana_address: PLAIN, owner_name: 'satoshi', user_id: 'u1' });
		expect(s.ownerName).toBe('satoshi');
		expect(s.ownerId).toBe('u1');
		const forked = getWalletStatus({ id: UUID, solana_address: PLAIN, meta: { forked_from: { owner_name: 'alice', agent_id: 'a9' } } });
		expect(forked.forkedFrom.owner_name).toBe('alice');
	});

	it('getWalletIdentity is the same normalizer as getWalletStatus', () => {
		expect(getWalletIdentity({ id: UUID, solana_address: PLAIN }).address).toBe(PLAIN);
	});

	it('only hydrates live balance for real (uuid) agents', () => {
		// Real agent → balance slot + hydration attributes present.
		const real = walletChipHTML({ id: UUID, solana_address: PLAIN }, { isOwner: false });
		expect(real).toContain('twc-bal');
		expect(real).toContain(`data-twc-aid="${UUID}"`);
		expect(real).toContain('data-twc-trigger'); // rich popover enabled
		// Non-agent row (KOL leaderboard) → static chip, no stuck skeleton / dead popover.
		const kol = walletChipHTML({ id: 'kol-7', wallet: PLAIN }, { isOwner: false, link: false });
		expect(kol).not.toContain('data-twc-aid');
		expect(kol).not.toContain('twc-bal-sk');
	});

	it('marks the owner chip with a "Yours" badge', () => {
		expect(walletChipHTML({ id: UUID, solana_address: PLAIN }, { isOwner: true })).toContain('twc-own');
		expect(walletChipHTML({ id: UUID, solana_address: PLAIN }, { isOwner: false })).not.toContain('twc-own');
	});

	it('formats USD compactly', () => {
		expect(formatWalletUsd(0)).toBe('$0');
		expect(formatWalletUsd(0.004)).toBe('<$0.01');
		expect(formatWalletUsd(9.4)).toBe('$9.40');
		expect(formatWalletUsd(950)).toBe('$950');
		expect(formatWalletUsd(1234)).toBe('$1.2K');
		expect(formatWalletUsd(3_400_000)).toBe('$3.4M');
		expect(formatWalletUsd(null)).toBeNull();
	});
});
