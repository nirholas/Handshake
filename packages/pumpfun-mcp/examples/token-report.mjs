// token-report.mjs: build a live on-chain report for one pump.fun token using
// five free, read-only tools.
//
//   1. pumpfun_bot_status  which lanes the backend can serve right now
//   2. get_token_details   SPL mint facts: decimals, supply, authorities
//   3. get_bonding_curve   graduation progress, or confirmation it graduated
//   4. get_token_holders   top holders and top-holder concentration
//   5. get_token_trades    the most recent real buys and sells
//
// Every number comes from Solana mainnet through the canonical three.ws backend.
// No API key, no RPC URL, no wallet, and no payment: this server has no write
// tool at all, so nothing here can sign or send a transaction.
//
//   node examples/token-report.mjs
//   node examples/token-report.mjs <MINT_ADDRESS>
//
// The default mint is $THREE, the three.ws platform token. Pass any pump.fun
// mint as the first argument to report on it instead.

import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
	StdioClientTransport,
	getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER_PATH = fileURLToPath(new URL('../src/index.js', import.meta.url));
// PUMPFUN_MCP_URL repoints the bridge at a self-hosted backend.
const FORWARDED_ENV = ['PUMPFUN_MCP_URL'];

// $THREE on Solana mainnet, the one coin this platform promotes.
const MINT = process.argv[2] || 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

function childEnv() {
	const env = getDefaultEnvironment();
	for (const key of FORWARDED_ENV) {
		const value = process.env[key];
		if (value) env[key] = value;
	}
	return env;
}

/**
 * Call a tool and return its structured payload. This server returns
 * structuredContent alongside the text mirror, so prefer the structured form
 * and fall back to parsing the text block.
 */
async function call(client, name, args) {
	const result = await client.callTool({ name, arguments: args });
	if (result.isError) {
		const text = result.content?.find((c) => c.type === 'text')?.text ?? 'tool error';
		throw new Error(`${name} failed: ${text}`);
	}
	if (result.structuredContent !== undefined) return result.structuredContent;
	const text = result.content?.find((c) => c.type === 'text')?.text ?? 'null';
	return JSON.parse(text);
}

/** Raw base units to a human amount using the mint's decimals. */
function fromBaseUnits(raw, decimals) {
	const n = Number(raw);
	if (!Number.isFinite(n)) return 'unknown';
	return (n / 10 ** decimals).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function ago(unixSeconds) {
	const seconds = Math.max(0, Math.floor(Date.now() / 1000 - Number(unixSeconds)));
	if (seconds < 60) return `${seconds}s ago`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
	return `${Math.floor(seconds / 86400)}d ago`;
}

const transport = new StdioClientTransport({
	command: process.execPath,
	args: [SERVER_PATH],
	env: childEnv(),
	stderr: 'inherit',
});
const client = new Client({ name: 'pumpfun-mcp-token-report-example', version: '1.0.0' });
await client.connect(transport);

try {
	// ── 1. pumpfun_bot_status ──────────────────────────────────────────────
	// The indexer-backed discovery tools (search_tokens, get_trending_tokens,
	// and friends) only exist when the backend has PUMPFUN_BOT_URL set. The
	// on-chain tools this example uses never depend on it.
	const status = await call(client, 'pumpfun_bot_status', {});
	console.log('\npumpfun_bot_status:');
	console.log(`  indexer configured: ${status.configured}`);
	console.log(`  indexer healthy:    ${status.healthy}`);
	if (status.message) console.log(`  ${status.message}`);

	// ── 2. get_token_details ───────────────────────────────────────────────
	const details = await call(client, 'get_token_details', { mint: MINT });
	const decimals = Number(details.decimals) || 0;
	console.log(`\nget_token_details: ${MINT}`);
	console.log(`  decimals:         ${decimals}`);
	console.log(`  supply:           ${fromBaseUnits(details.supply, decimals)}`);
	console.log(`  mint authority:   ${details.mintAuthority ?? 'revoked (no further minting)'}`);
	console.log(`  freeze authority: ${details.freezeAuthority ?? 'revoked (accounts cannot be frozen)'}`);

	// ── 3. get_bonding_curve ───────────────────────────────────────────────
	const curve = await call(client, 'get_bonding_curve', { mint: MINT });
	console.log('\nget_bonding_curve:');
	if (curve.complete) {
		console.log('  curve complete: yes, this token graduated off the bonding curve');
		console.log('  price now comes from the PumpSwap pool, so use pumpfun_quote_swap');
	} else {
		console.log(`  curve complete:  no, ${Number(curve.graduationPercent).toFixed(2)}% of the way to graduation`);
		console.log(`  real reserves:   ${curve.solReserves} SOL`);
		console.log(`  virtual quote:   ${curve.virtualSolReserves} lamports`);
		console.log(`  virtual tokens:  ${curve.virtualTokenReserves} base units`);
	}

	// ── 4. get_token_holders ───────────────────────────────────────────────
	const holders = await call(client, 'get_token_holders', { mint: MINT, limit: 5 });
	console.log('\nget_token_holders: top 5');
	console.log(`  top-holder share: ${Number(holders.topHolderPercent).toFixed(2)}%`);
	for (const holder of holders.holders ?? []) {
		console.log(
			`  ${Number(holder.percent).toFixed(2).padStart(6)}%  ${holder.address}  ${holder.uiAmount.toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
		);
	}

	// ── 5. get_token_trades ────────────────────────────────────────────────
	const trades = await call(client, 'get_token_trades', { mint: MINT, limit: 5 });
	console.log(`\nget_token_trades: last ${trades.count} on-chain`);
	for (const trade of trades.trades ?? []) {
		const side = trade.isBuy ? 'BUY ' : 'SELL';
		const usd = Number(trade.usdValue).toFixed(4);
		console.log(`  ${side}  $${usd.padStart(10)}  ${trade.solAmount} SOL  ${ago(trade.timestamp)}`);
	}

	console.log('\nEvery call was a read. Nothing was signed, sent, or paid for.');
} finally {
	await client.close();
}
