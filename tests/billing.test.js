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
