// Unit tests for the Living Avatar identity layer — src/shared/living-avatar.js.
//
// The nameplate is the avatar's "license plate": it composes the platform's one
// identity normalizer (getWalletStatus) with the one tier model (tierForUsd) into
// a single descriptor every fidelity renders from. These tests pin that contract —
// identity field-aliasing, the vanity highlight, the tier buckets (and that they
// match wallet-networth's thresholds), $THREE affinity, the loading vs dormant
// distinction, and ownership — plus the shared address highlighter and the
// nameplate display prefs. All pure: no DOM, no network.

import { describe, it, expect } from 'vitest';
import { resolveLivingAvatar } from '../src/shared/living-avatar.js';
import { highlightAddress } from '../src/shared/agent-wallet-chip.js';
import { tierForUsd } from '../src/shared/wallet-networth.js';
import { normalizePrefs, DEFAULT_PREFS } from '../src/shared/agent-networth.js';

// A clearly-synthetic vanity address: starts "three", ends "pump", 44 base58 chars.
const VANITY_ADDR = `three${'A'.repeat(35)}pump`;
const PLAIN_ADDR = `B${'1'.repeat(42)}C`; // 44 chars, no claimed vanity

const agentWith = (over = {}) => ({
	id: '11111111-1111-1111-1111-111111111111',
	name: 'Nova',
	solana_address: PLAIN_ADDR,
	...over,
});

describe('resolveLivingAvatar — identity composition', () => {
	it('returns an identity-only descriptor when there is no wallet yet', () => {
		const d = resolveLivingAvatar({ id: 'a1', name: 'Fresh' });
		expect(d.hasWallet).toBe(false);
		expect(d.address).toBeNull();
		expect(d.name).toBe('Fresh');
		expect(d.hubUrl).toBe('/agents/a1/wallet');
		expect(d.isOwner).toBe(false);
	});

	it('reads the address + deep links from any supported record shape', () => {
		const d = resolveLivingAvatar(agentWith());
		expect(d.hasWallet).toBe(true);
		expect(d.address).toBe(PLAIN_ADDR);
		expect(d.explorerUrl).toBe(`https://solscan.io/account/${PLAIN_ADDR}`);
		expect(d.agentId).toBe('11111111-1111-1111-1111-111111111111');
	});

	it('honours a matching vanity pattern and ignores a claimed one that does not match', () => {
		const matched = resolveLivingAvatar(agentWith({
			solana_address: VANITY_ADDR, solana_vanity_prefix: 'three', solana_vanity_suffix: 'pump',
		}));
		expect(matched.isVanity).toBe(true);
		expect(matched.prefix).toBe('three');
		expect(matched.suffix).toBe('pump');

		// A prefix the address does not actually start with earns no rarity tier.
		const bogus = resolveLivingAvatar(agentWith({ solana_vanity_prefix: 'three' }));
		expect(bogus.rarity).toBeNull();
	});

	it('carries the viewer ownership flag through', () => {
		expect(resolveLivingAvatar(agentWith(), { isOwner: true }).isOwner).toBe(true);
		expect(resolveLivingAvatar(agentWith(), { isOwner: false }).isOwner).toBe(false);
	});
});

describe('resolveLivingAvatar — tier (loading vs dormant vs funded)', () => {
	it('omits the tier while the wallet value is unknown (loading)', () => {
		const d = resolveLivingAvatar(agentWith()); // no usd passed
		expect(d.hasTier).toBe(false);
		expect(d.tier).toBeNull();
		expect(d.level).toBeNull();
		expect(d.dormant).toBe(false); // not "empty" — just not read yet
	});

	it('a real $0 wallet is dormant, not loading', () => {
		const d = resolveLivingAvatar(agentWith(), { usd: 0 });
		expect(d.hasTier).toBe(true);
		expect(d.tier).toBe('dormant');
		expect(d.level).toBe(0);
		expect(d.dormant).toBe(true);
	});

	it('maps real USD onto the SAME buckets as wallet-networth.tierForUsd', () => {
		for (const usd of [0.5, 1, 25, 250, 2_500, 25_000, 5_000_000]) {
			const d = resolveLivingAvatar(agentWith(), { usd });
			expect(d.tier).toBe(tierForUsd(usd).key);
			expect(d.level).toBe(tierForUsd(usd).level);
		}
	});

	it('never floats a precise value — only the bucketed tier is exposed', () => {
		const d = resolveLivingAvatar(agentWith(), { usd: 1337.42 });
		expect(d).not.toHaveProperty('usd');
		expect(d).not.toHaveProperty('usdTotal');
		expect(d.tier).toBe('glow'); // $1337 → glow bucket, no dollar figure leaked
	});
});

describe('resolveLivingAvatar — $THREE affinity', () => {
	it('flags $THREE holders and shifts the accent warm (vs a SOL-only wallet)', () => {
		const three = resolveLivingAvatar(agentWith(), { usd: 500, holdsThree: true });
		const sol = resolveLivingAvatar(agentWith(), { usd: 500, holdsThree: false });
		expect(three.holdsThree).toBe(true);
		expect(sol.holdsThree).toBe(false);
		// Same tier, but the $THREE accent is a distinct, recognizable mark.
		expect(three.tier).toBe(sol.tier);
		expect(three.accent).not.toBe(sol.accent);
	});
});

describe('highlightAddress — the one vanity highlighter', () => {
	it('emphasizes a matching prefix and suffix, plain-slices otherwise', () => {
		const hi = highlightAddress(VANITY_ADDR, 'three', 'pump', { head: 5, tail: 4 });
		expect(hi).toContain('class="twc-hi">three<');
		expect(hi).toContain('class="twc-hi">pump<');
		expect(hi).toContain('twc-dots');

		const plain = highlightAddress(PLAIN_ADDR, null, null, { head: 4, tail: 4 });
		expect(plain).not.toContain('twc-hi');
		expect(plain).toContain(PLAIN_ADDR.slice(0, 4));
		expect(plain).toContain(PLAIN_ADDR.slice(-4));
	});

	it('does not highlight a claimed pattern the address does not satisfy', () => {
		const hi = highlightAddress(PLAIN_ADDR, 'three', null, { head: 4, tail: 4 });
		expect(hi).not.toContain('twc-hi');
	});

	it('escapes its inputs (no HTML injection through the address)', () => {
		const hi = highlightAddress('<script>', null, null, { head: 4, tail: 4 });
		expect(hi).not.toContain('<script>');
		expect(hi).toContain('&lt;');
	});
});

describe('nameplate display prefs', () => {
	it('defaults the nameplate signals on (address + tier shown)', () => {
		expect(DEFAULT_PREFS.nameplate).toEqual({ address: true, tier: true });
		expect(normalizePrefs(undefined).nameplate).toEqual({ address: true, tier: true });
	});

	it('preserves an owner opt-out and ignores unknown keys', () => {
		const p = normalizePrefs({ nameplate: { address: false, bogus: 1 } });
		expect(p.nameplate.address).toBe(false);
		expect(p.nameplate.tier).toBe(true);
		expect(p.nameplate).not.toHaveProperty('bogus');
	});

	it('still carries the existing reactivity + signal prefs', () => {
		const p = normalizePrefs({ reactivity: 'off', signals: { aura: false } });
		expect(p.reactivity).toBe('off');
		expect(p.signals.aura).toBe(false);
		expect(p.signals.events).toBe(true);
		expect(p.nameplate).toEqual({ address: true, tier: true });
	});
});
