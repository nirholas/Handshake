// Payment-requirement selection: the decision that picks which advertised
// `accepts[]` entry the extension actually signs. Getting it wrong spends the
// wrong token on the wrong chain, so every branch is pinned here.

import test from 'node:test';
import assert from 'node:assert/strict';

import { railOf, selectRequirement, summarize } from '../src/inspect.js';
import { isThreeAccept, isUsdcAccept, tokenLabel, solanaSecretBytes, SOLANA_MAINNET, THREE_MINT } from '../src/solana.js';

const USDC_SOLANA = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE = 'eip155:8453';

const solUsdc = { scheme: 'exact', network: SOLANA_MAINNET, asset: USDC_SOLANA, amount: '1000', payTo: 'wwww', extra: { name: 'USDC', decimals: 6 } };
const solThree = { scheme: 'exact', network: SOLANA_MAINNET, asset: THREE_MINT, amount: '10000000', payTo: 'wwww', extra: { name: 'THREE', decimals: 6 } };
const baseUsdc = { scheme: 'exact', network: BASE, asset: USDC_BASE, amount: '1000', payTo: '0x40', extra: { name: 'USD Coin', decimals: 6 } };

test('railOf routes each accept to the rail that can settle it', () => {
	assert.equal(railOf(solUsdc), 'solana');
	assert.equal(railOf(solThree), 'solana');
	assert.equal(railOf(baseUsdc), 'evm');
	// A chain neither rail signs is not payable at all.
	assert.equal(railOf({ scheme: 'exact', network: 'cosmos:hub-4', asset: 'uatom', amount: '1' }), null);
});

test('auto selection is Solana-first, USDC-first', () => {
	const chosen = selectRequirement([baseUsdc, solThree, solUsdc], { preferToken: 'auto' });
	assert.equal(chosen, solUsdc, 'Solana USDC outranks both $THREE and Base USDC');
});

test('auto falls to a Solana $THREE accept before any EVM accept', () => {
	assert.equal(selectRequirement([baseUsdc, solThree], { preferToken: 'auto' }), solThree);
});

test('auto settles on Base when Solana is not offered', () => {
	assert.equal(selectRequirement([baseUsdc], { preferToken: 'auto' }), baseUsdc);
});

test('preferToken three picks the $THREE accept over USDC', () => {
	assert.equal(selectRequirement([solUsdc, solThree, baseUsdc], { preferToken: 'three' }), solThree);
});

test('preferToken usdc never picks $THREE', () => {
	const chosen = selectRequirement([solThree, solUsdc], { preferToken: 'usdc' });
	assert.equal(chosen, solUsdc);
});

test('an explicit network preference outranks the token preference', () => {
	assert.equal(selectRequirement([solUsdc, baseUsdc], { preferNetwork: BASE, preferToken: 'usdc' }), baseUsdc);
});

test('preferring a token nobody offers still settles (fails open)', () => {
	assert.equal(selectRequirement([baseUsdc], { preferToken: 'three' }), baseUsdc);
});

test('auth-hint placeholders are never selected', () => {
	const authHint = { scheme: 'exact', network: SOLANA_MAINNET, asset: USDC_SOLANA, amount: '0', extra: { authRequired: 'siwx' } };
	assert.equal(selectRequirement([authHint]), null, 'a zero-amount auth hint is not a payable requirement');
	assert.equal(selectRequirement([authHint, baseUsdc]), baseUsdc);
});

test('a rail with no wallet configured is skipped', () => {
	// Solana key only: the Base accept must not be chosen.
	assert.equal(selectRequirement([baseUsdc, solUsdc], { wallets: { evm: false, solana: true } }), solUsdc);
	// EVM key only: the Solana accepts must not be chosen.
	assert.equal(selectRequirement([solUsdc, solThree, baseUsdc], { wallets: { evm: true, solana: false } }), baseUsdc);
	// No key at all: nothing is payable.
	assert.equal(selectRequirement([solUsdc, baseUsdc], { wallets: { evm: false, solana: false } }), null);
});

test('token classification reads the mint, not just the declared name', () => {
	assert.ok(isThreeAccept({ asset: THREE_MINT }));
	assert.ok(isThreeAccept({ extra: { name: 'three' } }));
	assert.ok(isUsdcAccept({ asset: USDC_BASE }), 'Base USDC is matched case-insensitively');
	assert.ok(isUsdcAccept({ extra: { name: 'USD Coin' } }), 'the Base challenge spells USDC "USD Coin"');
	assert.ok(!isUsdcAccept({ asset: THREE_MINT, extra: { name: 'THREE' } }));
	assert.equal(tokenLabel(solThree), '$THREE');
	assert.equal(tokenLabel(baseUsdc), 'USDC');
	assert.equal(tokenLabel({ extra: { name: 'BONK' } }), 'BONK');
	assert.equal(tokenLabel({}), 'token');
});

test('summarize flags the chosen accept and says so when none is payable', () => {
	const paid = summarize({ status: 402, accepts: [solUsdc, baseUsdc], chosen: solUsdc });
	assert.ok(paid.some((l) => l.includes('payable by this wallet')));
	assert.ok(paid.some((l) => l.includes('[solana]') && l.includes('USDC')));

	const unpayable = summarize({ status: 402, accepts: [{ network: 'cosmos:hub-4', amount: '1' }], chosen: null });
	assert.ok(unpayable.some((l) => l.includes('No requirement this wallet can satisfy')));

	const free = summarize({ status: 200, paid: true, accepts: [], chosen: null });
	assert.ok(free.some((l) => l.includes('No payment required')));
});

test('a Solana secret is accepted as base58 or a JSON byte array, and validated', () => {
	const bytes = solanaSecretBytes(JSON.stringify(Array.from({ length: 64 }, (_, i) => i % 256)));
	assert.equal(bytes.length, 64);
	assert.throws(() => solanaSecretBytes(''), /No Solana signer configured/);
	assert.throws(() => solanaSecretBytes('[1, 2'), /JSON array but failed to parse/);
	assert.throws(() => solanaSecretBytes('not base58 0OIl'), /base58 string or a JSON byte array/);
});
