// Register three.ws paid x402 endpoints with the external x402 directories
// that accept programmatic submissions, and print the exact checklist for the
// surfaces that need a human (wallet signature / web form / GitHub PR).
//
// Why: discovery on x402scan, the CDP Bazaar, and agentic.market is mostly
// crawl- or settlement-driven, but the long tail of directories (402index,
// x402-list) accepts direct registration — free listings we should never
// leave unclaimed. Ranking everywhere is settled-tx volume + distinct buyers
// in the trailing 30 days; registration gets us FOUND, the ring loop's canary
// purchases keep us ACTIVE.
//
// Usage:
//   node scripts/x402-register-directories.mjs --dry-run     # print the plan
//   node scripts/x402-register-directories.mjs               # register a batch
//   node scripts/x402-register-directories.mjs --limit 5     # smaller batch
//   node scripts/x402-register-directories.mjs --state <file>  # custom ledger
//
// 402index rate-limits registration to 10/hour/IP, so each run submits at
// most --limit (default 8) endpoints and records progress in a ledger file
// (data/x402-directory-registrations.json) — re-run hourly until it reports
// nothing left to do. Re-running is safe: registered URLs are skipped via the
// ledger, and the directory itself reviews duplicates.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { getCatalog } = await import(path.join(root, 'api/_lib/service-catalog/index.js'));

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const limitIdx = args.indexOf('--limit');
const BATCH_LIMIT = limitIdx !== -1 ? Math.max(1, Number(args[limitIdx + 1]) || 8) : 8;
const stateIdx = args.indexOf('--state');
const LEDGER_PATH = path.join(
	root,
	stateIdx !== -1 ? args[stateIdx + 1] : 'data/x402-directory-registrations.json',
);

const FOUR02INDEX_REGISTER = 'https://402index.io/api/v1/register';

function loadLedger() {
	if (!existsSync(LEDGER_PATH)) return { '402index': {} };
	try {
		const parsed = JSON.parse(readFileSync(LEDGER_PATH, 'utf8'));
		return { '402index': {}, ...parsed };
	} catch {
		return { '402index': {} };
	}
}

function saveLedger(ledger) {
	writeFileSync(LEDGER_PATH, `${JSON.stringify(ledger, null, '\t')}\n`);
}

// Only endpoints a directory probe can complete against: live paid x402
// routes that answer GET/POST with a spec-valid 402 challenge in production.
const catalog = await getCatalog();
const candidates = catalog
	.filter((e) => e.source === 'x402' && e.status === 'live')
	.map((e) => ({ url: e.endpoint, slug: e.slug, method: e.method, description: e.useCase }));

if (!candidates.length) throw new Error('empty paid catalog — refusing to run');

// Verify each candidate actually serves a 402 in production before submitting
// it — registering a 404 (not-yet-deployed route) gets rejected by the
// directory's probe and burns a rate-limited slot.
async function serves402(entry) {
	try {
		const r = await fetch(entry.url, {
			method: entry.method,
			headers: { accept: 'application/json', ...(entry.method === 'POST' ? { 'content-type': 'application/json' } : {}) },
			...(entry.method === 'POST' ? { body: '{}' } : {}),
			signal: AbortSignal.timeout(10_000),
		});
		return r.status === 402;
	} catch {
		return false;
	}
}

const ledger = loadLedger();
const pending = candidates.filter((c) => !ledger['402index'][c.url]?.ok);
console.log(`catalog: ${candidates.length} live paid endpoints; ${pending.length} not yet registered at 402index`);

let submitted = 0;
for (const entry of pending) {
	if (submitted >= BATCH_LIMIT) break;

	const live = await serves402(entry);
	if (!live) {
		console.log(`SKIP  ${entry.slug} — production does not answer 402 yet (deploy first)`);
		continue;
	}

	if (DRY_RUN) {
		console.log(`DRY   ${entry.slug} → POST ${FOUR02INDEX_REGISTER} url=${entry.url}`);
		submitted++;
		continue;
	}

	try {
		const r = await fetch(FOUR02INDEX_REGISTER, {
			method: 'POST',
			headers: { 'content-type': 'application/json', accept: 'application/json' },
			body: JSON.stringify({
				url: entry.url,
				name: `three.ws ${entry.slug}`,
				protocol: 'x402',
				description: entry.description,
			}),
			signal: AbortSignal.timeout(15_000),
		});
		const body = await r.text();
		const ok = r.ok;
		ledger['402index'][entry.url] = {
			ok,
			status: r.status,
			at: new Date().toISOString(),
			response: body.slice(0, 300),
		};
		saveLedger(ledger);
		console.log(`${ok ? 'OK  ' : 'ERR '} ${entry.slug} → 402index ${r.status} ${body.slice(0, 120)}`);
		submitted++;
	} catch (err) {
		console.log(`ERR  ${entry.slug} → 402index ${err.message}`);
	}
}

const remaining = candidates.filter((c) => !ledger['402index'][c.url]?.ok).length;
console.log(`\n402index: ${submitted} submitted this run, ${remaining} remaining (rate limit 10/h/IP — re-run in an hour if any remain)`);

console.log(`
── Manual / human-gated surfaces (see docs/x402-distribution.md) ──────────────
  x402scan       https://www.x402scan.com/resources/register — one-time SIWX
                 wallet signature per resource (Base + Solana). No funds move.
  x402-list      https://x402-list.com/submit — web form, first submission
                 free; endpoint is auto-probed for a valid 402 handshake.
  x402.org       PR partner metadata to the x402 repo ecosystem page.
  awesome-x402   PRs to xpaysh/awesome-x402 and Merit-Systems/awesome-x402.
  CDP Bazaar     settlement-triggered: settle ≥1 payment per endpoint through
                 the CDP facilitator (needs CDP_API_KEY_ID/SECRET on prod),
                 then verify via GET api.cdp.coinbase.com/platform/v2/x402/
                 discovery/resources. agentic.market auto-indexes from there.
`);
