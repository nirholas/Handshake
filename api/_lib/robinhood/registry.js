// Robinhood Chain Stock Token registry accessor.
//
// The registry (stock-tokens.json) is the verified snapshot produced by the
// Wave-1 SDK build: 95 canonical Stock Tokens (ERC-20, 18 decimals) discovered
// via Blockscout's "• Robinhood Token" name pattern, each cross-checked
// on-chain (shared beacon slot, symbol/decimals/uiMultiplier multicall) and 34
// of them mapped to a live Chainlink price feed. It ships with the app so the
// stocks board never has to re-discover tokens on the hot path.
//
// JSON import assertion syntax varies across Node versions; read + parse the
// file once at module load (works on every runtime the app targets).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

let _registry = null;
function load() {
	if (_registry) return _registry;
	const raw = JSON.parse(readFileSync(join(HERE, 'stock-tokens.json'), 'utf8'));
	const tokens = Array.isArray(raw.tokens) ? raw.tokens : [];
	const bySymbol = new Map();
	const byAddress = new Map();
	for (const t of tokens) {
		bySymbol.set(t.symbol.toUpperCase(), t);
		byAddress.set(t.address.toLowerCase(), t);
	}
	_registry = {
		chainId: raw.chainId,
		generatedAtBlock: raw.generatedAtBlock,
		stockBeacon: raw.stockBeacon,
		tokenCount: raw.tokenCount,
		feedCount: raw.feedCount,
		tokens,
		bySymbol,
		byAddress,
	};
	return _registry;
}

/** All 95 canonical Stock Tokens (registry order = alphabetical by symbol). */
export function listStockTokens() {
	return load().tokens;
}

/** Look up one Stock Token by symbol (case-insensitive), or null. */
export function getStockToken(symbol) {
	if (!symbol) return null;
	return load().bySymbol.get(String(symbol).toUpperCase()) || null;
}

/** Look up one Stock Token by contract address (case-insensitive), or null. */
export function getStockTokenByAddress(address) {
	if (!address) return null;
	return load().byAddress.get(String(address).toLowerCase()) || null;
}

/** True when `address` is a canonical Stock Token (used to gate acquisition). */
export function isStockTokenAddress(address) {
	return Boolean(getStockTokenByAddress(address));
}

/** Registry metadata (counts, beacon, generation block). */
export function registryMeta() {
	const r = load();
	return {
		chainId: r.chainId,
		generatedAtBlock: r.generatedAtBlock,
		stockBeacon: r.stockBeacon,
		tokenCount: r.tokenCount,
		feedCount: r.feedCount,
	};
}
