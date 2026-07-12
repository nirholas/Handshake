// Ops alerts persist to the dashboard sink (ops_alerts) on every sendOpsAlert(),
// independent of Telegram, and fail soft. Covers the change that moved ops
// alerting from a Telegram-only channel to a durable, admin-dashboard-backed one.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn(async () => []);

vi.mock('../api/_lib/cache.js', () => ({
	cacheGet: vi.fn(async () => null),
	cacheSet: vi.fn(async () => {}),
}));
vi.mock('../api/_lib/db.js', () => ({ sql: sqlMock }));
vi.mock('../api/_lib/env.js', () => ({ databaseConfigured: () => true }));

let sendOpsAlert, severityOf, alertsConfigured;

beforeEach(async () => {
	vi.clearAllMocks();
	delete process.env.TELEGRAM_BOT_TOKEN;
	delete process.env.TELEGRAM_ALERTS_CHAT_ID;
	sqlMock.mockImplementation(async () => []);
	({ sendOpsAlert, severityOf, alertsConfigured } = await import('../api/_lib/alerts.js'));
});

describe('severityOf', () => {
	it('classifies 🚨 and halt/leak/critical words as critical', () => {
		expect(severityOf('🚨 x402 ring LEAK — funds left the set')).toBe('critical');
		expect(severityOf('x402 autonomous loop halted — payer USDC float is empty')).toBe('critical');
		expect(severityOf('CRITICAL: signer compromised')).toBe('critical');
	});
	it('defaults to warn for degradations', () => {
		expect(severityOf('⛽ x402 ring sponsor low on SOL')).toBe('warn');
		expect(severityOf('5xx in /api/chat')).toBe('warn');
	});
	it('honours an explicit info marker', () => {
		expect(severityOf('ℹ️ nightly rollup complete')).toBe('info');
	});
});

describe('sendOpsAlert — dashboard sink', () => {
	it('persists to ops_alerts even when Telegram is not configured', async () => {
		expect(alertsConfigured()).toBe(false); // no telegram env
		await sendOpsAlert('⛽ sponsor low on SOL', 'wallet X below floor', { signature: 'sig-1' });
		expect(sqlMock).toHaveBeenCalledTimes(1);
		// The tagged-template call receives the SQL fragments as its first arg.
		const fragments = sqlMock.mock.calls[0][0];
		expect(fragments.join('?')).toMatch(/insert into ops_alerts/i);
		expect(fragments.join('?')).toMatch(/on conflict \(signature\) do update/i);
	});

	it('passes the derived severity and interpolated values as bound params', async () => {
		await sendOpsAlert('🚨 ring leak', 'detail body', { signature: 'sig-crit' });
		const params = sqlMock.mock.calls[0].slice(1);
		// signature is stored as its stable 16-hex hash (round-tripped to the ack API)
		expect(params.some((p) => typeof p === 'string' && /^[0-9a-f]{16}$/.test(p))).toBe(true);
		expect(params).toContain('🚨 ring leak');    // title
		expect(params).toContain('detail body');     // detail
		expect(params).toContain('critical');        // severity (derived from 🚨)
	});

	it('coalesces repeats under one stable signature (same key for same input)', async () => {
		await sendOpsAlert('⚠️ repeat', 'body', { signature: 'k' });
		await sendOpsAlert('⚠️ repeat', 'body', { signature: 'k' });
		const sig1 = sqlMock.mock.calls[0].slice(1).find((p) => /^[0-9a-f]{16}$/.test(String(p)));
		const sig2 = sqlMock.mock.calls[1].slice(1).find((p) => /^[0-9a-f]{16}$/.test(String(p)));
		expect(sig1).toBe(sig2); // same signature → the upsert increments count, not a new row
	});

	it('never throws when the DB write fails (fail-soft)', async () => {
		sqlMock.mockImplementation(async () => { throw new Error('db down'); });
		await expect(
			sendOpsAlert('warn thing', 'x', { signature: 'sig-2' }),
		).resolves.toBeUndefined();
	});

	it('still persists when a Telegram push IS configured', async () => {
		process.env.TELEGRAM_BOT_TOKEN = 't';
		process.env.TELEGRAM_ALERTS_CHAT_ID = '123';
		// stub fetch so the telegram post is a no-op
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true });
		await sendOpsAlert('⚠️ both sinks', 'body', { signature: 'sig-3' });
		expect(sqlMock).toHaveBeenCalledTimes(1); // dashboard sink ran
		fetchSpy.mockRestore();
	});
});
