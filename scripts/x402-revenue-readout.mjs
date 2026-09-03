#!/usr/bin/env node
// scripts/x402-revenue-readout.mjs
//
// The weekly revenue readout (docs/internal/fable-playbook.md §2). The only sanctioned
// way to answer "how much revenue does three.ws actually have?"
//
// The trap this exists to close: x402_audit_log holds tens of thousands of real,
// on-chain-settled payments, and essentially all of them are the x402 ring
// paying itself (docs/x402-ring-economy.md). Any gross number read off that
// ledger is dogfooding volume wearing a revenue costume. This script splits the
// ledger through api/_lib/x402/revenue-split.js and leads with the external
// figure, which is the only one that counts toward the ladder in the playbook.
//
// It refuses to print an external number it cannot stand behind: if the
// controlled-wallet set fails to resolve, our own ring wallets would be counted
// as external customers, so the run exits non-zero with the reason instead.
//
// Usage:
//   node scripts/x402-revenue-readout.mjs                # trailing 30 days
//   node scripts/x402-revenue-readout.mjs --window 7d    # 24h | 7d | 30d | 90d | all
//   node scripts/x402-revenue-readout.mjs --json         # machine-readable
//   node scripts/x402-revenue-readout.mjs --routes 10    # external route rows to show
//
// Exit codes: 0 = readout produced, 2 = classification not trustworthy,
// 1 = the ledger could not be read.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Load .env.local then .env; first definition wins (matches apply-migrations.mjs).
for (const envFile of ['.env.local', '.env']) {
	try {
		const raw = readFileSync(path.resolve(REPO_ROOT, envFile), 'utf8');
		for (const line of raw.split('\n')) {
			const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
			if (!m || process.env[m[1]]) continue;
			let val = m[2].trim();
			if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
				val = val.slice(1, -1);
			}
			process.env[m[1]] = val;
		}
	} catch { /* file not present */ }
}

const WINDOWS = { '24h': 86_400, '7d': 604_800, '30d': 2_592_000, '90d': 7_776_000, all: null };

const args = process.argv.slice(2);
const JSON_OUT = args.includes('--json');
const windowArg = (args[args.indexOf('--window') + 1] || '').trim();
const WINDOW = args.includes('--window') && windowArg in WINDOWS ? windowArg : '30d';
const routesArg = Number(args[args.indexOf('--routes') + 1]);
const ROUTE_LIMIT = args.includes('--routes') && Number.isFinite(routesArg) ? Math.max(1, routesArg) : 8;

if (args.includes('--window') && !(windowArg in WINDOWS)) {
	console.error(`unknown --window "${windowArg}"; expected one of ${Object.keys(WINDOWS).join(', ')}`);
	process.exit(1);
}

/** Right-align a number for the fixed-width report columns. */
const num = (n, w = 9) => String(n).padStart(w);
const usd = (s) => `$${s}`;

function renderRoutes(label, bucket, limit) {
	if (!bucket.routes.length) return [];
	const out = [`  ${label}`];
	for (const r of bucket.routes.slice(0, limit)) {
		out.push(`    ${num(r.calls, 7)}  ${usd(r.volume_usdc).padStart(14)}  ${r.route}`);
	}
	const rest = bucket.routes.length - limit;
	if (rest > 0) out.push(`    ${' '.repeat(7)}  ${' '.repeat(14)}  (+${rest} more route${rest === 1 ? '' : 's'})`);
	return out;
}

async function main() {
	if (!process.env.DATABASE_URL) {
		console.error('DATABASE_URL is not set. Copy .env.local into this tree (see CLAUDE.md).');
		process.exit(1);
	}

	const { revenueSplit } = await import('../api/_lib/x402/revenue-split.js');
	const seconds = WINDOWS[WINDOW];
	const since = seconds == null ? null : new Date(Date.now() - seconds * 1000);

	const split = await revenueSplit({ since });

	if (JSON_OUT) {
		console.log(JSON.stringify({ window: WINDOW, ...split }, null, 2));
		return split.confident ? 0 : 2;
	}

	const { total, external, internal, synthetic } = split;
	const pct = (b) => `${(b.share_of_calls * 100).toFixed(2).padStart(6)}%`;

	const lines = [
		'',
		`x402 revenue readout, window: ${WINDOW}${split.since ? ` (since ${split.since.slice(0, 10)})` : ' (all time)'}`,
		`generated ${split.generated_at}`,
		'',
		`  settled calls   ${num(total.calls)}`,
		`  gross volume    ${usd(total.volume_usdc).padStart(9)}  USDC   ${total.unique_payers} distinct payer${total.unique_payers === 1 ? '' : 's'}`,
		'',
		`                     calls          volume     share`,
		`  EXTERNAL      ${num(external.calls)}  ${usd(external.volume_usdc).padStart(14)}  ${pct(external)}   <- the only revenue`,
		`  internal ring ${num(internal.calls)}  ${usd(internal.volume_usdc).padStart(14)}  ${pct(internal)}   dogfooding, never traction`,
		`  synthetic     ${num(synthetic.calls)}  ${usd(synthetic.volume_usdc).padStart(14)}  ${pct(synthetic)}   test payers, not money`,
		'',
		`  external buyers ${external.unique_payers}   controlled wallets known ${split.controlled_wallets} (registry rows ${split.registry_rows})`,
		'',
	];

	lines.push(...renderRoutes('external revenue by route:', external, ROUTE_LIMIT));
	if (!external.routes.length) {
		lines.push('  external revenue by route: none in this window');
	}
	lines.push('');

	if (!split.confident) {
		lines.push(`  NOT PUBLISHABLE: ${split.confidence_note}`);
		lines.push('  Ring wallets would be counted as external customers. Fix the wallet');
		lines.push('  registry before quoting any number from this run.');
		lines.push('');
	}

	console.log(lines.join('\n'));
	return split.confident ? 0 : 2;
}

main().then(
	(code) => process.exit(code),
	(err) => {
		console.error(`revenue readout failed: ${err?.message || err}`);
		process.exit(1);
	},
);
