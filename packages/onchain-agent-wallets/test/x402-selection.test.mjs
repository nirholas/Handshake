// Choosing which payment option to settle. These refusals are the ones that
// stop an agent paying on the wrong chain, in the wrong asset, or on mainnet
// when it was configured for devnet.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { clusterOf, selectRequirement, requiredUnits } from '../src/lib/x402.js';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const solanaOption = (over = {}) => ({
	scheme: 'exact',
	network: 'solana:mainnet',
	asset: MINT,
	maxAmountRequired: '10000',
	payTo: 'So11111111111111111111111111111111111111112',
	...over,
});

test('cluster ids resolve, and non-Solana networks resolve to nothing', () => {
	assert.equal(clusterOf('solana:mainnet'), 'mainnet');
	assert.equal(clusterOf('solana:devnet'), 'devnet');
	assert.equal(clusterOf('SOLANA:MAINNET'), 'mainnet');
	assert.equal(clusterOf('eip155:8453'), null);
	assert.equal(clusterOf(undefined), null);
});

test('a Solana option is chosen out of a mixed list', () => {
	const accepts = [
		{ scheme: 'exact', network: 'eip155:8453', asset: '0xa0b8', maxAmountRequired: '10000' },
		solanaOption(),
	];
	const picked = selectRequirement({ accepts, mint: MINT, network: 'mainnet' });
	assert.equal(picked.network, 'solana:mainnet');
	assert.equal(requiredUnits(picked), 10_000n);
});

test('an EVM-only resource is refused rather than paid on another chain', () => {
	const accepts = [{ scheme: 'exact', network: 'eip155:8453', asset: '0xa0b8', maxAmountRequired: '10000' }];
	assert.throws(
		() => selectRequirement({ accepts, mint: MINT, network: 'mainnet' }),
		(err) => err.code === 'no_solana_option',
	);
});

test('a mainnet price is refused by a devnet wallet', () => {
	assert.throws(
		() => selectRequirement({ accepts: [solanaOption()], mint: MINT, network: 'devnet' }),
		(err) => err.code === 'wrong_cluster',
	);
});

test('a price in another token is refused', () => {
	assert.throws(
		() => selectRequirement({ accepts: [solanaOption({ asset: 'SomeOtherMint1111111111111111111111111111' })], mint: MINT, network: 'mainnet' }),
		(err) => err.code === 'asset_mismatch',
	);
});

test('an unsupported scheme is refused', () => {
	assert.throws(
		() => selectRequirement({ accepts: [solanaOption({ scheme: 'upto' })], mint: MINT, network: 'mainnet' }),
		(err) => err.code === 'unsupported_scheme',
	);
});

test('a malformed or non-positive amount is refused', () => {
	assert.throws(() => requiredUnits(solanaOption({ maxAmountRequired: '' })), /no amount/);
	assert.throws(() => requiredUnits(solanaOption({ maxAmountRequired: '1.5' })), /base units/);
	assert.throws(() => requiredUnits(solanaOption({ maxAmountRequired: '0' })), /must be positive/);
});
