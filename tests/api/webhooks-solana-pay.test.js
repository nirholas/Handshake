// Tests for /api/webhooks/solana-pay - the off-web Solana Pay confirmation leg.
//
// Two contracts matter here and neither was covered before:
//
//   1. The GET discovery probe. Wallets render `label` + `icon` in the sheet the
//      buyer approves, so the icon has to be a URL the site actually serves. It
//      pointed at /assets/logo.png, which 404s to the HTML shell, and carried the
//      retired 3D-Agent brand.
//   2. The POST leg moves money-adjacent state (ledger writes, receipts, referral
//      splits via confirmSkillPurchase), so its auth gate, its input validation,
//      and the mapping from each confirm outcome to a status code are the whole
//      security and correctness surface.
//
// confirmSkillPurchase itself is mocked: this file tests the webhook boundary,
// and the confirm pipeline has its own on-chain coverage.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/_lib/zauth.js', () => ({ instrument: () => {}, drain: async () => {} }));
const captureException = vi.fn();
vi.mock('../../api/_lib/sentry.js', () => ({ captureException }));
const sendOpsAlert = vi.fn(async () => {});
vi.mock('../../api/_lib/alerts.js', () => ({ sendOpsAlert }));
vi.mock('../../api/_lib/env.js', () => ({ env: { APP_ORIGIN: 'https://three.ws' } }));

// One purchase row, keyed by reference, so the handler's lookup is real SQL
// shape against an in-memory table.
const purchasesByReference = new Map();
const sqlMock = vi.fn(async (strings, ...values) => {
	const text = strings.join('?').toLowerCase();
	if (text.includes('from skill_purchases')) {
		const row = purchasesByReference.get(values[0]);
		return row ? [row] : [];
	}
	return [];
});
vi.mock('../../api/_lib/db.js', () => ({
	sql: sqlMock,
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
	isStoragePressured: async () => ({ pressured: false }),
}));

const confirmSkillPurchase = vi.fn(async () => ({ status: 'pending' }));
vi.mock('../../api/_lib/purchase-confirm.js', () => ({ confirmSkillPurchase }));

const { default: handler } = await import('../../api/webhooks/solana-pay.js');

const SECRET = 'test-webhook-secret';
const REFERENCE = 'THREEsyntheticReference1111111111111111111';

function mkReq({ method = 'POST', body = null, headers = {} } = {}) {
	const listeners = {};
	const req = {
		method,
		url: '/api/webhooks/solana-pay',
		headers: { 'content-type': 'application/json', ...headers },
		on(event, cb) { listeners[event] = cb; return req; },
		destroy() {},
	};
	queueMicrotask(() => {
		if (body && listeners.data) listeners.data(Buffer.from(body, 'utf8'));
		if (listeners.end) listeners.end();
	});
	return req;
}

function mkRes() {
	return {
		statusCode: 200,
		headers: {},
		body: undefined,
		headersSent: false,
		writableEnded: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		getHeader(k) { return this.headers[k.toLowerCase()]; },
		end(b) { this.body = b; this.writableEnded = true; },
	};
}

async function invoke(opts = {}) {
	const res = mkRes();
	await handler(mkReq(opts), res);
	return { status: res.statusCode, headers: res.headers, body: res.body ? JSON.parse(res.body) : undefined };
}

function authed(body) {
	return { body: JSON.stringify(body), headers: { authorization: `Bearer ${SECRET}` } };
}

describe('/api/webhooks/solana-pay discovery probe', () => {
	it('advertises the current brand and an icon URL the site actually serves', async () => {
		const { status, body } = await invoke({ method: 'GET' });
		expect(status).toBe(200);
		expect(body.label).toContain('three.ws');
		// The regression this file exists for: /assets/logo.png is not a real path,
		// so a wallet rendered a broken merchant icon at the approval step.
		expect(body.icon).toBe('https://three.ws/logo.png');
		expect(body.icon).not.toContain('/assets/');
	});

	it('answers cross-origin so a wallet can fetch the probe', async () => {
		const { headers } = await invoke({ method: 'GET', headers: { origin: 'https://phantom.app' } });
		expect(headers['access-control-allow-origin']).toBe('*');
	});

	it('short-circuits the CORS preflight', async () => {
		const { status } = await invoke({ method: 'OPTIONS', headers: { origin: 'https://phantom.app' } });
		expect(status).toBe(204);
	});

	it('rejects a method the endpoint does not implement', async () => {
		const { status, body } = await invoke({ method: 'PUT' });
		expect(status).toBe(405);
		expect(body.error).toBe('method_not_allowed');
	});
});

describe('/api/webhooks/solana-pay confirm leg', () => {
	beforeEach(() => {
		confirmSkillPurchase.mockClear();
		captureException.mockClear();
		sendOpsAlert.mockClear();
		purchasesByReference.clear();
		purchasesByReference.set(REFERENCE, {
			id: 'pur-1',
			user_id: 'user-1',
			agent_id: 'agent-1',
			skill: 'render',
			status: 'pending',
			amount: '1500000',
			chain: 'solana',
			reference: REFERENCE,
			mint_decimals: 6,
		});
		process.env.WEBHOOK_SECRET = SECRET;
	});

	it('rejects a request with no bearer secret', async () => {
		const { status, body } = await invoke({ body: JSON.stringify({ reference: REFERENCE }) });
		expect(status).toBe(401);
		expect(body.error).toBe('unauthorized');
		expect(confirmSkillPurchase).not.toHaveBeenCalled();
	});

	it('rejects a wrong bearer secret', async () => {
		const { status } = await invoke({
			body: JSON.stringify({ reference: REFERENCE }),
			headers: { authorization: 'Bearer not-the-secret' },
		});
		expect(status).toBe(401);
		expect(confirmSkillPurchase).not.toHaveBeenCalled();
	});

	it('refuses every caller when no secret is configured on the deployment', async () => {
		delete process.env.WEBHOOK_SECRET;
		const { status } = await invoke(authed({ reference: REFERENCE }));
		expect(status).toBe(401);
		expect(confirmSkillPurchase).not.toHaveBeenCalled();
	});

	it('validates that a reference was supplied', async () => {
		const { status, body } = await invoke(authed({}));
		expect(status).toBe(400);
		expect(body.error).toBe('validation_error');
	});

	it('rejects a non-string reference rather than coercing it into the lookup', async () => {
		const { status } = await invoke(authed({ reference: { $ne: null } }));
		expect(status).toBe(400);
		expect(confirmSkillPurchase).not.toHaveBeenCalled();
	});

	it('404s a reference with no purchase row', async () => {
		const { status, body } = await invoke(authed({ reference: 'THREEsyntheticUnknown22222222222222222222' }));
		expect(status).toBe(404);
		expect(body.error).toBe('not_found');
		expect(confirmSkillPurchase).not.toHaveBeenCalled();
	});

	it('returns the settled signature once the on-chain transfer validates', async () => {
		confirmSkillPurchase.mockResolvedValueOnce({ status: 'confirmed', tx_signature: 'sig-abc' });
		const { status, body } = await invoke(authed({ reference: REFERENCE }));
		expect(status).toBe(200);
		expect(body.data).toEqual({ status: 'confirmed', tx_signature: 'sig-abc' });
		expect(confirmSkillPurchase.mock.calls[0][0].reference).toBe(REFERENCE);
	});

	it('reports pending while the buyer has not broadcast yet', async () => {
		confirmSkillPurchase.mockResolvedValueOnce({ status: 'pending' });
		const { status, body } = await invoke(authed({ reference: REFERENCE }));
		expect(status).toBe(200);
		expect(body.data.status).toBe('pending');
	});

	it('maps an expired purchase to 410', async () => {
		confirmSkillPurchase.mockResolvedValueOnce({ status: 'expired' });
		const { status, body } = await invoke(authed({ reference: REFERENCE }));
		expect(status).toBe(410);
		expect(body.error).toBe('expired');
	});

	it('maps a mismatched transfer to 409', async () => {
		confirmSkillPurchase.mockResolvedValueOnce({ status: 'mismatch', message: 'no matching transfer found' });
		const { status, body } = await invoke(authed({ reference: REFERENCE }));
		expect(status).toBe(409);
		expect(body.error).toBe('transfer_mismatch');
	});

	it('surfaces the tipped amount so an underpaying buyer is not told their funds vanished', async () => {
		confirmSkillPurchase.mockResolvedValueOnce({
			status: 'tipped',
			message: 'transfer was smaller than the price',
			tipped_amount: '250000',
			tx_signature: 'sig-tip',
		});
		const { status, body } = await invoke(authed({ reference: REFERENCE }));
		expect(status).toBe(409);
		expect(body.status).toBe('tipped');
		expect(body.tipped_amount).toBe('250000');
		expect(body.tx_signature).toBe('sig-tip');
	});

	it('forwards a settlement hash so an EVM purchase is confirmable, not stuck pending', async () => {
		confirmSkillPurchase.mockResolvedValueOnce({ status: 'confirmed', tx_signature: '0xdead' });
		const { status } = await invoke(authed({ reference: REFERENCE, tx_hash: '0xdead' }));
		expect(status).toBe(200);
		expect(confirmSkillPurchase.mock.calls[0][1]).toEqual({ txHash: '0xdead' });
	});

	it('passes no hash for the Solana path, which scans by reference instead', async () => {
		confirmSkillPurchase.mockResolvedValueOnce({ status: 'pending' });
		await invoke(authed({ reference: REFERENCE }));
		expect(confirmSkillPurchase.mock.calls[0][1]).toEqual({ txHash: null });
	});

	it('escalates a confirm fault to the error tracker instead of swallowing it into a bare 500', async () => {
		confirmSkillPurchase.mockRejectedValueOnce(
			new Error('rpc failed: https://mainnet.helius-rpc.com/?api-key=leaky'),
		);
		const { status, body } = await invoke(authed({ reference: REFERENCE }));
		expect(status).toBe(500);
		// wrap() owns the 5xx envelope: the upstream message (which embeds a keyed
		// RPC URL) must never reach the caller, and ops must see the exception.
		expect(JSON.stringify(body)).not.toContain('api-key');
		expect(captureException).toHaveBeenCalledTimes(1);
	});
});
