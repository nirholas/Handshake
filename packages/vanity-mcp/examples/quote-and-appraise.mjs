// quote-and-appraise.mjs: price a vanity pattern and appraise an address with
// four free, read-only tools.
//
//   1. vanity_config    is the market able to pay out, and in what asset
//   2. vanity_quote     difficulty and honest suggested bounty for a pattern
//   3. vanity_appraise  rarity of an existing address (pure math, nothing stored)
//   4. vanity_stats     live market pulse: open, escrowed, paid out
//
// Every call hits the live public /api/vanity endpoints. Nothing here needs a
// key, a signer, or a payment: posting a bounty and claiming one are the
// x402-paid HTTP write paths, which this MCP server deliberately does not
// expose, so this example cannot spend anything.
//
//   node examples/quote-and-appraise.mjs
//   node examples/quote-and-appraise.mjs THREE
//   node examples/quote-and-appraise.mjs abc <SOLANA_ADDRESS>
//
// Arg 1 is the Base58 prefix to quote (default THREE). Arg 2 is the address to
// appraise (default: the $THREE mint, a real mainnet address).

import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
	StdioClientTransport,
	getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER_PATH = fileURLToPath(new URL('../src/index.js', import.meta.url));
const FORWARDED_ENV = ['THREE_WS_BASE', 'THREE_WS_TIMEOUT_MS'];

const [prefixArg, addressArg] = process.argv.slice(2);
const PREFIX = prefixArg || 'THREE';
// The $THREE mint on Solana mainnet: a real address, and the one coin this
// platform promotes. Any Base58 public key works here.
const ADDRESS = addressArg || 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

function childEnv() {
	const env = getDefaultEnvironment();
	for (const key of FORWARDED_ENV) {
		const value = process.env[key];
		if (value) env[key] = value;
	}
	return env;
}

/** Unwrap an MCP tool result's JSON payload from its text content block. */
function payload(result) {
	const text = result?.content?.find((c) => c.type === 'text')?.text ?? '';
	try {
		return JSON.parse(text);
	} catch {
		return { ok: false, raw: text };
	}
}

/** Call a tool and fail loudly rather than continuing on half-data. */
async function call(client, name, args) {
	const data = payload(await client.callTool({ name, arguments: args }));
	if (!data.ok) {
		throw new Error(`${name} failed: ${data.message || data.error || data.raw || 'unknown error'}`);
	}
	return data;
}

/** Atomic units to a human amount, using the decimals the market advertises. */
function human(atomics, decimals) {
	if (atomics === undefined || atomics === null) return 'unstated';
	return (Number(atomics) / 10 ** decimals).toFixed(Math.min(decimals, 6));
}

/** Seconds to a compact duration, for grind-time estimates. */
function duration(seconds) {
	const s = Number(seconds);
	if (!Number.isFinite(s)) return 'unknown';
	if (s < 1) return 'under a second';
	if (s < 60) return `${s.toFixed(1)}s`;
	if (s < 3600) return `${(s / 60).toFixed(1)}m`;
	if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
	return `${(s / 86400).toFixed(1)}d`;
}

const transport = new StdioClientTransport({
	command: process.execPath,
	args: [SERVER_PATH],
	env: childEnv(),
	stderr: 'inherit',
});
const client = new Client({ name: 'vanity-mcp-quote-appraise-example', version: '1.0.0' });
await client.connect(transport);

try {
	// ── 1. vanity_config ───────────────────────────────────────────────────
	const config = await call(client, 'vanity_config', {});
	const decimals = Number(config.decimals) || 6;
	console.log('\nvanity_config:');
	console.log(`  payouts configured: ${config.payoutConfigured}`);
	console.log(`  settlement asset:   ${config.asset} (${decimals} decimals)`);
	console.log(`  escrow networks:    ${(config.networks ?? []).join(', ') || 'none'}`);
	console.log(
		`  pricing band:       ${human(config.band?.floorAtomics, decimals)} to ${human(config.band?.maxAtomics, decimals)} ${config.asset}`,
	);
	console.log(`  protocol:           ${config.protocol}`);

	// ── 2. vanity_quote ────────────────────────────────────────────────────
	const quote = await call(client, 'vanity_quote', { prefix: PREFIX });
	const d = quote.difficulty ?? {};
	console.log(`\nvanity_quote: prefix "${PREFIX}", case-sensitive`);
	console.log(`  tier:              ${d.tierLabel} (${d.rarityBits} bits of rarity)`);
	console.log(`  expected attempts: ${Number(d.expectedAttempts).toLocaleString('en-US')}`);
	console.log(`  expected grind:    ${duration(d.expectedGrindSeconds)} on the reference rig`);
	console.log(`  suggested bounty:  ${human(quote.oracle?.suggestedAtomics, decimals)} ${config.asset}`);
	console.log(`  generous bounty:   ${human(quote.oracle?.generousAtomics, decimals)} ${config.asset}`);

	// ── 3. vanity_appraise ─────────────────────────────────────────────────
	const appraisal = (await call(client, 'vanity_appraise', { address: ADDRESS })).appraisal ?? {};
	console.log(`\nvanity_appraise: ${ADDRESS}`);
	console.log(`  detected pattern:  prefix "${appraisal.prefix ?? 'none'}", suffix "${appraisal.suffix ?? 'none'}"`);
	console.log(`  tier:              ${appraisal.tierLabel} (score ${appraisal.rarityScore})`);
	console.log(`  expected attempts: ${Number(appraisal.expectedAttempts).toLocaleString('en-US')}`);
	console.log(`  grind time:        ${appraisal.grindHuman}`);
	console.log(`  scoring model:     ${appraisal.model}`);

	// ── 4. vanity_stats ────────────────────────────────────────────────────
	const stats = await call(client, 'vanity_stats', {});
	console.log('\nvanity_stats:');
	console.log(`  open bounties:  ${stats.open} (${human(stats.openEscrowAtomics, decimals)} ${config.asset} escrowed)`);
	console.log(`  settled:        ${stats.settled} (${human(stats.paidOutAtomics, decimals)} ${config.asset} paid out)`);
	console.log(`  total ever:     ${stats.total}`);

	console.log('\nAll four calls were read-only. No bounty was posted, claimed, or paid.');
} finally {
	await client.close();
}
