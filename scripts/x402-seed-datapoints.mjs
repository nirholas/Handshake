#!/usr/bin/env node
// scripts/x402-seed-datapoints.mjs
//
// Seeds real Solana USDC settlements against the granular datapoint fabric
// (api/x402/d/[...path].js) so each per-metric URL carries settled on-chain
// volume and gets picked up by the public x402 indexers (x402scan, Bazaar,
// 402index). The datapoint fabric advertises ~4,400 payable URLs in the
// discovery doc but the ring coverage sweep only pays the ~68 named
// RING_CATALOG endpoints — the granular URLs have never settled, so indexers
// treat them as a dead static list. This closes that gap.
//
// The seed list is pulled LIVE from the platform's own discovery doc
// (/.well-known/x402.json), so every URL is guaranteed to be a real advertised
// resource — no hand-maintained list to drift. It is bucketed by family and
// capped per-family (core metrics like price/tvl/supply/volume first) so a
// bounded budget proves the whole surface is live rather than over-settling
// one family.
//
// Payments are circular: the payer wallet (X402_SEED_SOLANA_SECRET_BASE58)
// pays the platform treasury (X402_PAY_TO_SOLANA). Both are platform-owned, so
// the USDC round-trips and only the Solana network fee is truly spent. An
// onAccept gate refuses any payment whose payTo is not the expected treasury —
// money never moves to an address we did not configure.
//
// Real payments only — no mocks. Requires a funded, env-complete context:
//   X402_SEED_SOLANA_SECRET_BASE58  funded with USDC + a little SOL
//   X402_ASSET_MINT_SOLANA          USDC mint (settlement asset)
//   X402_PAY_TO_SOLANA              expected treasury (recipient gate)
//   SOLANA_RPC_URL                  a non-rate-limited RPC
//
// Usage:
//   node scripts/x402-seed-datapoints.mjs --dry-run              # plan only, no spend
//   node scripts/x402-seed-datapoints.mjs --max-usd=0.15         # hard spend cap (USDC)
//   node scripts/x402-seed-datapoints.mjs --per-family=20        # cap URLs per family
//   node scripts/x402-seed-datapoints.mjs --only=coin,protocol   # restrict families
//   node scripts/x402-seed-datapoints.mjs --origin=https://three.ws

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
	payX402,
	bootstrapSolanaContext,
	loadSeedKeypair,
	fetchWithTimeout,
} from '../api/_lib/x402/pay.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'tasks', 'x402-ring');

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, dflt) => {
	const hit = argv.find((a) => a.startsWith(`--${name}=`));
	return hit ? hit.slice(name.length + 3) : dflt;
};
const DRY_RUN = flag('dry-run');
const MAX_USD = Number(opt('max-usd', '0.15'));
const PER_FAMILY = Number(opt('per-family', '20'));
const ONLY = (opt('only', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const ORIGIN = (opt('origin', process.env.APP_ORIGIN || 'https://three.ws')).replace(/\/$/, '');
const DELAY_MS = Number(opt('delay-ms', '250'));

// Core metrics settled first when a family is capped — the ones an indexer's
// sample call is most likely to hit, and the ones buyers actually want.
const CORE_METRICS = new Set([
	'price', 'tvl', 'supply', 'volume-24h', 'market-cap', 'apy', 'index',
	'fees-24h', 'open-interest-btc', 'standard', 'btc-dominance', 'risk-level',
	'change-24h', 'trust-score',
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const familyOf = (url) => {
	const m = url.match(/\/api\/x402\/d\/([^/]+)\//);
	return m ? m[1] : 'other';
};
const metricOf = (url) => url.split('/').pop();

async function loadSeedList() {
	const res = await fetchWithTimeout(`${ORIGIN}/.well-known/x402.json`, {}, 20_000);
	let doc;
	try {
		doc = typeof res.body === 'string' ? JSON.parse(res.body) : res.body;
	} catch {
		throw new Error('could not parse discovery doc');
	}
	const resources = (doc.resources || doc.items || [])
		.map((r) => r.resource || r.url || '')
		.filter((u) => u.includes('/api/x402/d/'));

	const byFamily = new Map();
	for (const url of resources) {
		const fam = familyOf(url);
		if (ONLY.length && !ONLY.includes(fam)) continue;
		if (!byFamily.has(fam)) byFamily.set(fam, []);
		byFamily.get(fam).push(url);
	}

	const picked = [];
	for (const [fam, urls] of byFamily) {
		urls.sort((a, b) => {
			const ca = CORE_METRICS.has(metricOf(a)) ? 0 : 1;
			const cb = CORE_METRICS.has(metricOf(b)) ? 0 : 1;
			return ca - cb;
		});
		for (const url of urls.slice(0, PER_FAMILY)) picked.push({ fam, url });
	}
	return picked;
}

async function main() {
	mkdirSync(OUT_DIR, { recursive: true });
	const seeds = await loadSeedList();
	const families = [...new Set(seeds.map((s) => s.fam))].sort();

	console.log(`seed list: ${seeds.length} datapoint URLs across ${families.length} families`);
	console.log(`families: ${families.join(', ')}`);
	console.log(`budget cap: $${MAX_USD} USDC   per-family cap: ${PER_FAMILY}   origin: ${ORIGIN}`);

	if (DRY_RUN) {
		const perFam = {};
		for (const s of seeds) perFam[s.fam] = (perFam[s.fam] || 0) + 1;
		console.log('\n[dry-run] no payments sent. per-family counts:');
		for (const f of families) console.log(`  ${f.padEnd(20)} ${perFam[f]}`);
		console.log('\n[dry-run] sample URLs:');
		for (const s of seeds.slice(0, 12)) console.log('  ' + s.url.replace(ORIGIN, ''));
		return;
	}

	const expectedPayTo = process.env.X402_PAY_TO_SOLANA;
	if (!expectedPayTo) throw new Error('X402_PAY_TO_SOLANA (recipient gate) not set — refusing to pay');

	const buyer = loadSeedKeypair();
	const ctx = await bootstrapSolanaContext({ buyer });
	console.log(`payer: ${buyer.publicKey.toBase58()}   treasury gate: ${expectedPayTo}`);

	// Recipient gate: refuse any payment not going to the configured treasury.
	const onAccept = (accept) => {
		if (accept.payTo !== expectedPayTo) {
			return { abort: true, reason: `unexpected_payto:${String(accept.payTo).slice(0, 12)}` };
		}
		return null;
	};

	const capAtomics = Math.round(MAX_USD * 1e6);
	let spentAtomics = 0;
	const rows = [];
	let ok = 0, skipped = 0, failed = 0, nonce = 0;

	for (const { fam, url } of seeds) {
		const remainingCap = capAtomics - spentAtomics;
		if (remainingCap <= 0) {
			console.log(`\nspend cap $${MAX_USD} reached — stopping (${ok} settled).`);
			break;
		}
		let r;
		try {
			r = await payX402({ url, method: 'GET', ...ctx, remainingCap, nonce: nonce++, onAccept });
		} catch (err) {
			r = { success: false, paid: false, skipped: false, errorMsg: String(err?.message || err).slice(0, 100) };
		}
		if (r.paid && r.success) {
			ok++;
			spentAtomics += Number(r.amountAtomic || 0);
			console.log(`  ✓ ${fam.padEnd(16)} ${url.replace(ORIGIN, '').padEnd(48)} ${((r.amountAtomic || 0) / 1e6).toFixed(4)} USDC  ${r.txSig || ''}`);
		} else if (r.skipped) {
			skipped++;
			console.log(`  ~ ${fam.padEnd(16)} ${url.replace(ORIGIN, '').padEnd(48)} skipped: ${r.errorMsg}`);
		} else {
			failed++;
			console.log(`  ✗ ${fam.padEnd(16)} ${url.replace(ORIGIN, '').padEnd(48)} fail: ${r.errorMsg}`);
		}
		rows.push({ fam, url, paid: !!r.paid, success: !!r.success, amountAtomic: r.amountAtomic || 0, txSig: r.txSig || null, error: r.errorMsg || null });
		await sleep(DELAY_MS);
	}

	const report = { generatedAt: new Date().toISOString(), origin: ORIGIN, seeded: seeds.length, settled: ok, skipped, failed, spentUsdc: spentAtomics / 1e6, rows };
	writeFileSync(join(OUT_DIR, 'datapoint-seed-report.json'), JSON.stringify(report, null, 2));

	console.log(`\ndone: ${ok} settled, ${skipped} skipped, ${failed} failed, $${(spentAtomics / 1e6).toFixed(4)} USDC moved (payer→treasury).`);
	console.log(`report: tasks/x402-ring/datapoint-seed-report.json`);
}

main().catch((err) => { console.error('seed failed:', err); process.exit(1); });
