// Unit tests for the pure normalizer against REAL on-chain logs captured live
// from Robinhood Chain mainnet (chain 4663) during development — see
// tests/fixtures/*.json and the capture commands in README.md. No mocks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
	normalizeLaunch, normalizeCurveTrade, normalizeUniswapSwap, normalizeGraduation,
} from '../src/normalize.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tradedFixture = JSON.parse(readFileSync(join(__dirname, 'fixtures/traded-logs.json'), 'utf8'));
const launchFixture = JSON.parse(readFileSync(join(__dirname, 'fixtures/launch-swap-logs.json'), 'utf8'));

const bi = (v) => BigInt(v);

test('normalizeCurveTrade: real Odyssey Traded log → pump-compatible trade', () => {
	const raw = tradedFixture.traded[0];
	assert.equal(raw.eventName, 'Traded');
	const trade = {
		launchpad: 'odyssey',
		token: raw.args.token,
		trader: raw.args.trader,
		isBuy: raw.args.isBuy,
		tokenAmount: bi(raw.args.tokenAmount),
		quoteAmount: bi(raw.args.quoteAmount),
		fee: bi(raw.args.fee),
		blockNumber: bi(raw.blockNumber),
		transactionHash: raw.transactionHash,
	};
	const out = normalizeCurveTrade({ trade, name: 'Test Coin', symbol: 'TEST', ethUsd: 3000, atMs: 1_800_000_000_000 });

	assert.equal(out.chain, 'robinhood-chain');
	assert.equal(out.chain_id, 4663);
	assert.equal(out.mint, raw.args.token);
	assert.equal(out.address, raw.args.token);
	assert.equal(out.is_buy, raw.args.isBuy);
	assert.equal(out.tx_type, raw.args.isBuy ? 'buy' : 'sell');
	assert.equal(out.trader, raw.args.trader);
	assert.equal(out.user, raw.args.trader); // chart-screen reads `user`
	assert.equal(out.tx, raw.transactionHash); // chart-screen dedupe key
	// quoteAmount 90044474151232482 wei = 0.090044474151232482 ETH
	assert.ok(Math.abs(out.sol_amount - 0.090044474151232482) < 1e-9);
	assert.ok(Math.abs(out.usd_amount - 0.090044474151232482 * 3000) < 1e-6);
	assert.equal(out.usd_amount, out.sol_value_usd);
	assert.equal(out.quote_symbol, 'ETH');
	assert.ok(Number.isFinite(out.price_usd));
	assert.equal(out.block_number, Number(raw.blockNumber));
});

test('normalizeCurveTrade: zero ETH price leaves USD fields null, never NaN', () => {
	const raw = tradedFixture.traded[0];
	const trade = {
		launchpad: 'odyssey', token: raw.args.token, trader: raw.args.trader,
		isBuy: raw.args.isBuy, tokenAmount: bi(raw.args.tokenAmount), quoteAmount: bi(raw.args.quoteAmount),
		fee: bi(raw.args.fee), blockNumber: bi(raw.blockNumber), transactionHash: raw.transactionHash,
	};
	const out = normalizeCurveTrade({ trade, ethUsd: 0 });
	assert.equal(out.usd_amount, null);
	assert.equal(out.price_usd, null);
	assert.ok(Number.isFinite(out.sol_amount)); // native amount is always known
});

test('normalizeLaunch: real NOXA TokenLaunched log → pump-compatible launch', () => {
	const raw = launchFixture.noxa[0];
	assert.equal(raw.args.pool, launchFixture.pool);
	const launch = {
		launchpad: 'noxa',
		token: raw.args.token,
		creator: raw.args.deployer,
		pool: raw.args.pool,
		blockNumber: bi(raw.blockNumber),
		transactionHash: raw.transactionHash,
		initialBuyAmount: bi(raw.args.initialBuyAmount),
	};
	const out = normalizeLaunch({ launch, name: 'Some Token', symbol: 'SOME', ethUsd: 3000, atMs: 1_800_000_000_000 });

	assert.equal(out.launchpad, 'noxa');
	assert.equal(out.mint, raw.args.token);
	assert.equal(out.creator, raw.args.deployer);
	assert.equal(out.pool, raw.args.pool);
	assert.equal(out.signature, raw.transactionHash);
	// initialBuyAmount 100000000000000000 wei = 0.1 ETH
	assert.ok(Math.abs(out.initial_buy_native - 0.1) < 1e-9);
	assert.ok(Math.abs(out.initial_buy_usd - 300) < 1e-6);
	assert.equal(out.explorer_url, `https://robinhoodchain.blockscout.com/address/${raw.args.token}`);
});

test('normalizeGraduation: Odyssey token created (used as a graduation-shape sanity check)', () => {
	const raw = launchFixture.created[0];
	const grad = {
		token: raw.args.token,
		pool: '0xF11561e6448924ECC6e68B0fA59408089FB775C1',
		blockNumber: bi(raw.blockNumber),
		transactionHash: raw.transactionHash,
	};
	const out = normalizeGraduation({ grad, name: 'Grad Coin', symbol: 'GRAD', atMs: 1_800_000_000_000 });
	assert.equal(out.mint, raw.args.token);
	assert.equal(out.pool, grad.pool);
	assert.equal(out.tx_signature, raw.transactionHash);
});

test('normalizeUniswapSwap: real Uniswap v3 Swap log on the NOXA pool → BUY when coin is token1 and leaves the pool', () => {
	const raw = launchFixture.swaps[0];
	// From capture: pool token0=WETH (0x0Bd7...), token1=coin. amount0 positive
	// (WETH in), amount1 negative (coin out) ⇒ trader bought the coin with ETH.
	const swap = {
		amount0: bi(raw.args.amount0),
		amount1: bi(raw.args.amount1),
		recipient: raw.args.recipient,
		sender: raw.args.sender,
		transactionHash: raw.transactionHash,
		blockNumber: bi(raw.blockNumber),
	};
	assert.ok(swap.amount0 > 0n && swap.amount1 < 0n);
	const out = normalizeUniswapSwap({
		swap, token: launchFixture.noxa[0].args.token, pool: launchFixture.pool,
		coinIsToken0: false, quoteSymbol: 'ETH', quoteDecimals: 18,
		name: 'Some Token', symbol: 'SOME', ethUsd: 3000, atMs: 1_800_000_000_000,
	});
	assert.equal(out.is_buy, true);
	assert.equal(out.tx_type, 'buy');
	assert.equal(out.trader, raw.args.recipient);
	assert.ok(out.sol_amount > 0); // native ETH magnitude, always positive
	assert.ok(out.usd_amount > 0);
	assert.equal(out.pool, launchFixture.pool);
});

test('normalizeUniswapSwap: coin flowing IN (positive delta on coin side) is a SELL', () => {
	const raw = launchFixture.swaps[0];
	const swap = {
		amount0: bi(raw.args.amount1) * -1n, // coin now positive (flowing in)
		amount1: bi(raw.args.amount0) * -1n,
		recipient: raw.args.recipient, sender: raw.args.sender,
		transactionHash: raw.transactionHash, blockNumber: bi(raw.blockNumber),
	};
	const out = normalizeUniswapSwap({
		swap, token: launchFixture.noxa[0].args.token, pool: launchFixture.pool,
		coinIsToken0: true, quoteSymbol: 'ETH', quoteDecimals: 18, ethUsd: 3000,
	});
	assert.equal(out.is_buy, false);
	assert.equal(out.tx_type, 'sell');
});

test('normalizeUniswapSwap: USDG quote uses 1:1 USD, no ETH price dependency', () => {
	const raw = launchFixture.swaps[0];
	const swap = {
		amount0: bi(raw.args.amount0), amount1: bi(raw.args.amount1),
		recipient: raw.args.recipient, sender: raw.args.sender,
		transactionHash: raw.transactionHash, blockNumber: bi(raw.blockNumber),
	};
	const out = normalizeUniswapSwap({
		swap, token: launchFixture.noxa[0].args.token, pool: launchFixture.pool,
		coinIsToken0: false, quoteSymbol: 'USDG', quoteDecimals: 6, ethUsd: 0,
	});
	assert.equal(out.quote_symbol, 'USDG');
	assert.ok(out.usd_amount > 0); // resolved without any ETH price
});
