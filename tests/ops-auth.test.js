// The shared ops-dashboard gate: admin session OR dedicated OPS_SECRET,
// fail-closed in production, never CRON_SECRET.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getSessionUser = vi.fn(async () => null);
const isAdminUser = vi.fn(async () => false);

vi.mock('../api/_lib/auth.js', () => ({ getSessionUser }));
vi.mock('../api/_lib/admin.js', () => ({ isAdminUser }));

let authorizeOps;

async function loadFresh() {
	vi.resetModules();
	({ authorizeOps } = await import('../api/_lib/ops-auth.js'));
}

beforeEach(() => {
	vi.clearAllMocks();
	getSessionUser.mockResolvedValue(null);
	isAdminUser.mockResolvedValue(false);
	delete process.env.OPS_SECRET;
	delete process.env.CRON_SECRET;
	delete process.env.NODE_ENV;
	delete process.env.VERCEL_ENV;
});

const reqWith = (headers = {}) => ({ headers });

describe('authorizeOps', () => {
	it('authorizes a signed-in admin with their identity as actor', async () => {
		getSessionUser.mockResolvedValue({ id: 7, wallet_address: 'Wa11etAdmin' });
		isAdminUser.mockResolvedValue(true);
		await loadFresh();
		const r = await authorizeOps(reqWith());
		expect(r.ok).toBe(true);
		expect(r.actor).toBe('Wa11etAdmin');
	});

	it('rejects a signed-in NON-admin (falls through, no secret) in production', async () => {
		process.env.VERCEL_ENV = 'production';
		getSessionUser.mockResolvedValue({ id: 8, wallet_address: 'notadmin' });
		isAdminUser.mockResolvedValue(false);
		await loadFresh();
		expect((await authorizeOps(reqWith())).ok).toBe(false);
	});

	it('accepts the correct OPS_SECRET via x-ops-secret', async () => {
		process.env.OPS_SECRET = 'super-secret-value';
		await loadFresh();
		expect((await authorizeOps(reqWith({ 'x-ops-secret': 'super-secret-value' }))).ok).toBe(true);
		expect((await authorizeOps(reqWith({ 'x-ops-secret': 'wrong' }))).ok).toBe(false);
		expect((await authorizeOps(reqWith())).ok).toBe(false);
	});

	it('accepts OPS_SECRET via Authorization: Bearer', async () => {
		process.env.OPS_SECRET = 'sek';
		await loadFresh();
		expect((await authorizeOps(reqWith({ authorization: 'Bearer sek' }))).ok).toBe(true);
	});

	it('does NOT accept CRON_SECRET (decoupled from the cron credential)', async () => {
		process.env.VERCEL_ENV = 'production';
		process.env.CRON_SECRET = 'cron-key';
		// OPS_SECRET intentionally unset
		await loadFresh();
		expect((await authorizeOps(reqWith({ 'x-ops-secret': 'cron-key' }))).ok).toBe(false);
	});

	it('FAILS CLOSED in production when no OPS_SECRET is configured', async () => {
		process.env.VERCEL_ENV = 'production';
		await loadFresh();
		expect((await authorizeOps(reqWith())).ok).toBe(false);
		expect((await authorizeOps(reqWith({ 'x-ops-secret': 'anything' }))).ok).toBe(false);
	});

	it('is open in local dev (no secret, not production) for developer convenience', async () => {
		// neither NODE_ENV nor VERCEL_ENV = production, no secret
		await loadFresh();
		expect((await authorizeOps(reqWith())).ok).toBe(true);
	});
});
