#!/usr/bin/env node
// Settle one real Base USDC payment against every live paid x402 endpoint that
// advertises a Base accept, so the CDP Bazaar (and OpenSea's Agent Tools
// marketplace, which mirrors it) indexes all of them — not just the four that
// have historically settled through the CDP facilitator.
//
// The Bazaar only lists an endpoint after its first verify+settle passes
// through the CDP facilitator on Base; probes and registrations alone never
// get an endpoint listed. Each paid call here is a VALID business request:
// the endpoint's own 402 challenge carries extensions.bazaar.input with a
// runnable example (query params or JSON body), and that example is what gets
// sent — so the settle indexes a 200, not a paid 400.
//
// All Base accepts pay to X402_PAY_TO_BASE (the owner's wallet), so the sweep
// is an internal transfer: buyer wallet -> owner wallet, facilitator pays gas.
//
// Usage:
//   X402_BUYER_PRIVATE_KEY=0x... node scripts/x402-bazaar-settle-sweep.mjs --dry-run
//   X402_BUYER_PRIVATE_KEY=0x... node scripts/x402-bazaar-settle-sweep.mjs
//   ... --max-usd=3            # total spend cap (default 3)
//   ... --only=gas-oracle,did  # limit to specific slugs
//   ... --skip=model-check     # skip slugs (e.g. already indexed)
//   ... --include-pump-launch  # NEVER default: $5 and mints a real coin
//
// Endpoints are paid cheapest-first so a low balance still yields the maximum
// number of listings before the budget or balance runs out.

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { wrapFetchWithPayment } from '@x402/fetch';
import { x402Client } from '@x402/core/client';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, http, erc20Abi, formatUnits } from 'viem';
import { base } from 'viem/chains';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { getCatalog } = await import(path.join(root, 'api/_lib/service-catalog/index.js'));

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, dflt) => {
	const hit = argv.find((a) => a.startsWith(`--${name}=`));
	return hit ? hit.slice(name.length + 3) : dflt;
};

const DRY_RUN = flag('dry-run');
const MAX_USD = Number(opt('max-usd', '3'));
const ONLY = (opt('only', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const SKIP = new Set((opt('skip', '') || '').split(',').map((s) => s.trim()).filter(Boolean));
const INCLUDE_PUMP_LAUNCH = flag('include-pump-launch');
const BASE_RPC = process.env.X402_RPC_URL || 'https://mainnet.base.org';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

if (!INCLUDE_PUMP_LAUNCH) SKIP.add('pump-launch');

const PRIVATE_KEY = process.env.X402_BUYER_PRIVATE_KEY || process.env.A2A_PAYER_PRIVATE_KEY;
if (!PRIVATE_KEY && !DRY_RUN) {
	console.error('Missing X402_BUYER_PRIVATE_KEY (funded Base USDC wallet). Use --dry-run to plan without one.');
	process.exit(2);
}

const isBaseAccept = (a) => /8453|^base$/.test(String(a?.network || ''));

// ── 1. plan: probe every live paid endpooint's 402 for a Base accept + example input ──
const catalog = await getCatalog();
const live = catalog.filter((e) => e.source === 'x402' && e.status === 'live');

async function probe(entry) {
	const method = (entry.method || 'GET').toUpperCase();
	try {
		const res = await fetch(entry.endpoint, {
			method,
			headers: { accept: 'application/json', ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
			...(method === 'POST' ? { body: '{}' } : {}),
			signal: AbortSignal.timeout(15_000),
		});
		if (res.status !== 402) return { slug: entry.slug, skip: `probe HTTP ${res.status} (not 402)` };
		const body = await res.json().catch(() => null);
		const accept = (body?.accepts || []).find(isBaseAccept);
		if (!accept) return { slug: entry.slug, skip: 'no Base accept advertised' };
		const input = body?.extensions?.bazaar?.input || null;
		const priceUsd = Number(accept.amount ?? accept.maxAmountRequired ?? 0) / 1e6;
		let url = entry.endpoint;
		let requestBody;
		if (input?.type === 'query' && input.example && typeof input.example === 'object') {
			const qs = new URLSearchParams();
			for (const [k, v] of Object.entries(input.example)) qs.set(k, typeof v === 'string' ? v : JSON.stringify(v));
			if ([...qs.keys()].length) url += (url.includes('?') ? '&' : '?') + qs.toString();
		} else if (input?.type === 'json' && input.example !== undefined) {
			requestBody = JSON.stringify(input.example);
		} else if (method === 'POST') {
			requestBody = '{}';
		}
		return { slug: entry.slug, method, url, requestBody, priceUsd, payTo: accept.payTo };
	} catch (err) {
		return { slug: entry.slug, skip: `probe failed: ${String(err?.message || err).slice(0, 80)}` };
	}
}

console.log(`catalog: ${live.length} live paid endpoints; probing for Base accepts…`);
const probes = [];
for (let i = 0; i < live.length; i += 10) {
	probes.push(...(await Promise.all(live.slice(i, i + 10).map(probe))));
}

const skipped = probes.filter((p) => p.skip || SKIP.has(p.slug) || (ONLY.length && !ONLY.includes(p.slug)));
for (const s of skipped) if (!s.skip) s.skip = ONLY.length && !ONLY.includes(s.slug) ? '--only filter' : '--skip filter';
const plan = probes
	.filter((p) => !p.skip && !SKIP.has(p.slug) && (!ONLY.length || ONLY.includes(p.slug)))
	.sort((a, b) => a.priceUsd - b.priceUsd);

const planTotal = plan.reduce((s, p) => s + p.priceUsd, 0);
console.log(`plan: ${plan.length} endpoints, $${planTotal.toFixed(3)} total (cap $${MAX_USD}); ${skipped.length} skipped`);
for (const s of skipped) console.log(`  SKIP ${s.slug}: ${s.skip}`);

if (DRY_RUN) {
	for (const p of plan) console.log(`  PAY  $${p.priceUsd.toFixed(3).padEnd(6)} ${p.method.padEnd(4)} ${p.url}${p.requestBody ? `  body=${p.requestBody.slice(0, 80)}` : ''}`);
	process.exit(0);
}

// ── 2. buyer preflight: enough Base USDC for at least the cheapest call ──
const account = privateKeyToAccount(PRIVATE_KEY.startsWith('0x') ? PRIVATE_KEY : `0x${PRIVATE_KEY}`);
const reader = createPublicClient({ chain: base, transport: http(BASE_RPC) });
const balanceAtomic = await reader.readContract({ address: USDC_BASE, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] });
const balanceUsd = Number(formatUnits(balanceAtomic, 6));
console.log(`buyer ${account.address}: ${balanceUsd} USDC on Base`);
if (!plan.length) { console.log('nothing to pay.'); process.exit(0); }
if (balanceUsd < plan[0].priceUsd) {
	console.error(`buyer balance $${balanceUsd} cannot cover even the cheapest call ($${plan[0].priceUsd}). Fund ${account.address} with Base USDC.`);
	process.exit(3);
}

const client = new x402Client();
registerExactEvmScheme(client, { signer: account, schemeOptions: { [base.id]: { rpcUrl: BASE_RPC } } });
const fetchWithPayment = wrapFetchWithPayment(fetch, client);

// ── 3. pay cheapest-first under the cap, recording every settle ──
const results = [];
let spent = 0;
for (const p of plan) {
	if (spent + p.priceUsd > MAX_USD) { results.push({ ...p, outcome: 'budget-capped' }); continue; }
	if (spent + p.priceUsd > balanceUsd) { results.push({ ...p, outcome: 'balance-exhausted' }); continue; }
	const t0 = Date.now();
	try {
		const res = await fetchWithPayment(p.url, {
			method: p.method,
			headers: { accept: 'application/json', ...(p.requestBody ? { 'content-type': 'application/json' } : {}) },
			...(p.requestBody ? { body: p.requestBody } : {}),
		});
		const elapsed = Date.now() - t0;
		const text = await res.text();
		let settle = null;
		const settleHeader = res.headers.get('payment-response') || res.headers.get('x-payment-response');
		if (settleHeader) {
			try { settle = JSON.parse(Buffer.from(settleHeader, 'base64').toString('utf8')); } catch { settle = { raw: settleHeader.slice(0, 120) }; }
		}
		const paid = Boolean(settle);
		if (paid) spent += p.priceUsd;
		results.push({
			slug: p.slug, url: p.url, priceUsd: p.priceUsd, status: res.status, elapsedMs: elapsed,
			outcome: paid ? (res.ok ? 'settled-200' : `settled-but-${res.status}`) : `unpaid-${res.status}`,
			tx: settle?.transaction || settle?.txHash || null,
			bodyPreview: text.slice(0, 160),
		});
		console.log(`${paid ? 'PAID' : 'FAIL'} $${p.priceUsd.toFixed(3).padEnd(6)} HTTP ${res.status} ${p.slug}${settle?.transaction ? `  tx ${settle.transaction}` : ''}`);
	} catch (err) {
		results.push({ slug: p.slug, url: p.url, priceUsd: p.priceUsd, outcome: `error: ${String(err?.message || err).slice(0, 100)}` });
		console.log(`ERR  ${p.slug}: ${String(err?.message || err).slice(0, 100)}`);
	}
}

const outDir = path.join(root, 'tasks', 'x402-bazaar');
mkdirSync(outDir, { recursive: true });
const report = {
	ranAt: new Date().toISOString(),
	buyer: account.address,
	spentUsd: Number(spent.toFixed(4)),
	settled: results.filter((r) => String(r.outcome).startsWith('settled')).length,
	planned: plan.length,
	results,
	skipped: skipped.map((s) => ({ slug: s.slug, reason: s.skip })),
};
const outFile = path.join(outDir, 'settle-sweep-report.json');
writeFileSync(outFile, `${JSON.stringify(report, null, '\t')}\n`);
console.log(`\nsettled ${report.settled}/${plan.length} for $${report.spentUsd} — report: ${path.relative(root, outFile)}`);
console.log('Bazaar indexing follows the facilitator settle; verify within ~a day via');
console.log('https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources (search "three.ws").');
