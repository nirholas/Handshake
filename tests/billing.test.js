import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const p = (...parts) => resolve(repoRoot, ...parts);

describe('billing — vercel.json routing', () => {
	const vercel = JSON.parse(readFileSync(p('vercel.json'), 'utf8'));
	const routes = vercel.routes || [];

	it('routes /api/billing/summary to the serverless endpoint', () => {
		const r = routes.find((x) => x.src === '/api/billing/summary');
		expect(r).toBeTruthy();
		expect(r.dest).toBe('/api/billing/summary');
	});
});

describe('billing — dashboard tab', () => {
	const dashjs = readFileSync(p('src/dashboard/dashboard.js'), 'utf8');

	it('renderBilling is async and fetches billing data', () => {
		expect(dashjs).toContain('async function renderBilling');
		expect(dashjs).toContain('/api/billing/summary');
	});

	it('billing tab renders quota meters for avatars, storage, MCP', () => {
		expect(dashjs).toContain('usage.mcp_calls_24h');
		expect(dashjs).toContain('usage.total_bytes');
		expect(dashjs).toContain('usage.avatar_count');
	});
});

describe('billing — endpoint file', () => {
	const src = readFileSync(p('api/billing/summary.js'), 'utf8');

	it('exports a default handler', () => {
		expect(src).toContain('export default');
	});

	it('queries plan_quotas joined with users', () => {
		expect(src).toContain('plan_quotas');
		expect(src).toContain('user.id');
	});

	it('returns usage fields for avatars, agents, mcp, llm', () => {
		expect(src).toContain('avatar_count');
		expect(src).toContain('agent_count');
		expect(src).toContain('mcp_calls_24h');
		expect(src).toContain('llm_calls_month');
	});

	it('requires authentication', () => {
		expect(src).toContain('getSessionUser');
		expect(src).toContain('401');
	});
});

describe('billing — pricing + invoices routing', () => {
	const vercel = JSON.parse(readFileSync(p('vercel.json'), 'utf8'));
	const routes = vercel.routes || [];
	const route = (src) => routes.find((x) => x.src === src);

	it('routes /api/pricing to the aggregate pricing endpoint', () => {
		expect(route('/api/pricing')?.dest).toBe('/api/pricing');
	});

	it('routes /api/billing/invoices to the invoice statement endpoint', () => {
		expect(route('/api/billing/invoices')?.dest).toBe('/api/billing/invoices');
	});

	it('routes /billing to the statement page', () => {
		expect(route('/billing/?')?.dest).toBe('/billing.html');
	});
});

describe('billing — /api/pricing serves server truth', () => {
	const src = readFileSync(p('api/pricing.js'), 'utf8');

	it('aggregates the catalog, platform fee, and holder tier ladder', () => {
		expect(src).toContain('publicCatalog');
		expect(src).toContain('getFeeBps');
		expect(src).toContain('TIERS');
	});

	it('personalizes the holder price via the real charge-rail price function', () => {
		expect(src).toContain('priceForAction');
		expect(src).toContain('your_usd');
		expect(src).toContain('resolveUserTier');
	});

	it('never blocks the page on the balance read (degrades to public price)', () => {
		// The personalization is wrapped in try/catch so an RPC hiccup falls back.
		expect(src).toMatch(/try\s*{[\s\S]*resolveUserTier[\s\S]*catch/);
	});
});

describe('billing — invoices endpoint rolls usage into a statement', () => {
	const src = readFileSync(p('api/billing/invoices.js'), 'utf8');

	it('uses the metering rollup + reconciliation helpers', () => {
		expect(src).toContain('rollupInvoice');
		expect(src).toContain('reconciliationStatus');
	});

	it('requires authentication', () => {
		expect(src).toContain('getSessionUser');
		expect(src).toContain('401');
	});

	it('supports a CSV download of the statement', () => {
		expect(src).toContain('format');
		expect(src).toContain('text/csv');
	});
});

describe('billing — receipts serves a per-charge metered receipt', () => {
	const src = readFileSync(p('api/billing/receipts.js'), 'utf8');

	it('returns a metered receipt by event_id via getReceipt', () => {
		expect(src).toContain('event_id');
		expect(src).toContain('getReceipt');
	});

	it('keeps the existing signed purchase receipt path', () => {
		expect(src).toContain('purchase_id');
		expect(src).toContain('purchase_receipts');
	});
});

describe('billing — metering is wired into the one charge choke point', () => {
	const charge = readFileSync(p('api/_lib/pricing/charge-three.js'), 'utf8');

	it('meters after a settled $THREE charge', () => {
		expect(charge).toContain('recordUsageSafe');
		expect(charge).toContain('meterSettledCharge');
	});

	it('meters the allowance rail too, keyed by the settlement id', () => {
		// Both the settle and allowance success paths call the meter helper.
		const calls = charge.match(/meterSettledCharge\(/g) || [];
		expect(calls.length).toBeGreaterThanOrEqual(3); // 1 def + 2 call sites
	});
});

describe('billing — usage metering migration', () => {
	const sqlText = readFileSync(p('api/_lib/migrations/20260623170000_usage_metering.sql'), 'utf8');

	it('adds the metering columns to usage_events', () => {
		for (const col of ['meter_action', 'price_usdc_atomics', 'fee_usdc_atomics', 'settlement_ref', 'idempotency_key']) {
			expect(sqlText).toContain(col);
		}
	});

	it('enforces idempotency with a unique index on the idempotency key', () => {
		expect(sqlText).toContain('create unique index if not exists usage_events_idem');
	});
});
