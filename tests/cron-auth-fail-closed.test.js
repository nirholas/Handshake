// Regression guard for the 2026-07-23 audit finding: payment-session-sweep
// and forge-finalize failed OPEN when CRON_SECRET was unset ("allow in dev"),
// the only two handlers in /api/cron with an inverted posture. An unset
// CRON_SECRET on a misconfigured deploy would have exposed unauthenticated
// triggering of a money-moving sweep (session-budget refunds) and the forge
// finalize batch. Both must now fail closed with 503, like the other 66.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { requireCron as requireCronSweep } from '../api/cron/payment-session-sweep.js';
import { requireCron as requireCronFinalize } from '../api/cron/forge-finalize.js';

function mockRes() {
	return {
		writeHead: vi.fn().mockReturnThis(),
		end: vi.fn(),
	};
}

const handlers = [
	['payment-session-sweep', requireCronSweep],
	['forge-finalize', requireCronFinalize],
];

describe('cron auth fails closed', () => {
	beforeEach(() => {
		delete process.env.CRON_SECRET;
	});
	afterEach(() => {
		delete process.env.CRON_SECRET;
	});

	for (const [name, requireCron] of handlers) {
		describe(name, () => {
			it('503s and runs nothing when CRON_SECRET is unset', () => {
				const res = mockRes();
				const handled = requireCron({ headers: {} }, res);
				expect(handled).toBe(true);
				expect(res.writeHead).toHaveBeenCalledWith(503, expect.anything());
			});

			it('503s even when a header is presented but CRON_SECRET is unset', () => {
				const res = mockRes();
				const handled = requireCron(
					{ headers: { 'x-cron-secret': 'anything' } },
					res,
				);
				expect(handled).toBe(true);
				expect(res.writeHead).toHaveBeenCalledWith(503, expect.anything());
			});

			it('401s when the secret is set but no header is presented', () => {
				process.env.CRON_SECRET = 'test-cron-secret';
				const res = mockRes();
				expect(requireCron({ headers: {} }, res)).toBe(true);
				expect(res.writeHead).toHaveBeenCalledWith(401, expect.anything());
			});

			it('401s on a wrong secret', () => {
				process.env.CRON_SECRET = 'test-cron-secret';
				const res = mockRes();
				expect(
					requireCron({ headers: { 'x-cron-secret': 'wrong' } }, res),
				).toBe(true);
				expect(res.writeHead).toHaveBeenCalledWith(401, expect.anything());
			});

			it('admits the correct secret via x-cron-secret', () => {
				process.env.CRON_SECRET = 'test-cron-secret';
				const res = mockRes();
				expect(
					requireCron({ headers: { 'x-cron-secret': 'test-cron-secret' } }, res),
				).toBe(false);
				expect(res.writeHead).not.toHaveBeenCalled();
			});

			it('admits the correct secret via Bearer', () => {
				process.env.CRON_SECRET = 'test-cron-secret';
				const res = mockRes();
				expect(
					requireCron(
						{ headers: { authorization: 'Bearer test-cron-secret' } },
						res,
					),
				).toBe(false);
				expect(res.writeHead).not.toHaveBeenCalled();
			});
		});
	}
});
