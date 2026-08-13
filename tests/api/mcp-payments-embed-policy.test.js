// api/_mcp/payments.js and api/_mcp/embed-policy.js — the two small shared
// modules the MCP servers reach for on the paid path and the embed gate.
//
// payments.js is the single error boundary for every hand-rolled x402 MCP
// endpoint (/api/mcp, /api/mcp-3d, /api/mcp-agent, /api/mcp-bazaar,
// /api/ibm-mcp, /api/okx/3d/*). It has to tell three cases apart: a genuine
// "pay me" (402 with the full payment envelope), a client's own fault (the
// X402Error's own status and code), and an unexpected server fault (a 500 that
// leaks nothing but a support reference). Getting the third case wrong is how a
// driver stack trace reaches a paying agent, so all three are pinned here.
//
// embed-policy.js is the MCP surface's view of an agent's embed policy. The one
// thing render_avatar depends on is that a caller-supplied avatar id that is not
// a uuid never reaches the database.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const send402Mock = vi.fn(async (res) => {
	res.statusCode = 402;
	res.setHeader('content-type', 'application/json; charset=utf-8');
	res.end(JSON.stringify({ x402Version: 1, accepts: [] }));
});

vi.mock('../../api/_lib/x402-spec.js', async (importOriginal) => ({
	...(await importOriginal()),
	send402: (...a) => send402Mock(...a),
}));

const reportServerErrorMock = vi.fn(() => 'ref_abc123');
vi.mock('../../api/_lib/http.js', async (importOriginal) => ({
	...(await importOriginal()),
	reportServerError: (...a) => reportServerErrorMock(...a),
}));

const sqlMock = vi.fn(async () => []);
vi.mock('../../api/_lib/db.js', () => ({
	sql: (...a) => sqlMock(...a),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const { X402Error } = await import('../../api/_lib/x402-errors.js');
const { sendX402Error, reservePaymentProof } = await import('../../api/_mcp/payments.js');
const { readMcpPolicyByAvatar } = await import('../../api/_mcp/embed-policy.js');

function mkRes() {
	const headers = {};
	return {
		statusCode: 200,
		body: null,
		headers,
		setHeader(k, v) {
			headers[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return headers[k.toLowerCase()];
		},
		end(body) {
			this.body = body;
		},
	};
}

const CTX = { resourceUrl: 'https://three.ws/api/mcp', accepts: [{ scheme: 'exact' }] };

beforeEach(() => {
	send402Mock.mockClear();
	reportServerErrorMock.mockClear();
	sqlMock.mockReset();
	sqlMock.mockResolvedValue([]);
});

// ── payments.js ─────────────────────────────────────────────────────────────
describe('sendX402Error', () => {
	it('re-issues the full payment envelope for a 402 X402Error', async () => {
		const res = mkRes();
		await sendX402Error(res, CTX, new X402Error('payment_required', 'pay first', 402));

		expect(send402Mock).toHaveBeenCalledTimes(1);
		const [, opts] = send402Mock.mock.calls[0];
		expect(opts.resourceUrl).toBe(CTX.resourceUrl);
		expect(opts.accepts).toBe(CTX.accepts);
		expect(opts.error).toBe('pay first');
		expect(res.statusCode).toBe(402);
		// A payment fault is the caller's problem, never ours to report.
		expect(reportServerErrorMock).not.toHaveBeenCalled();
	});

	it('passes a non-402 X402Error through with its own status and code', async () => {
		const res = mkRes();
		await sendX402Error(res, CTX, new X402Error('unsupported_network', 'unsupported network: foo', 400));

		expect(send402Mock).not.toHaveBeenCalled();
		expect(res.statusCode).toBe(400);
		expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
		expect(JSON.parse(res.body)).toEqual({
			error: 'unsupported_network',
			error_description: 'unsupported network: foo',
		});
		expect(reportServerErrorMock).not.toHaveBeenCalled();
	});

	// Failure path: an unexpected fault must reach the shared boundary and come
	// back as an opaque 500 carrying only a support reference.
	it('routes an unexpected fault to the error boundary and leaks nothing', async () => {
		const res = mkRes();
		const err = new Error('relation "x402_settlements" does not exist');
		err.code = '42P01';
		await sendX402Error(res, CTX, err);

		expect(reportServerErrorMock).toHaveBeenCalledTimes(1);
		const [reported, opts] = reportServerErrorMock.mock.calls[0];
		expect(reported).toBe(err);
		expect(opts.code).toBe('mcp_x402_failed');
		expect(opts.context).toEqual({ resourceUrl: CTX.resourceUrl });

		expect(res.statusCode).toBe(500);
		const body = JSON.parse(res.body);
		expect(body.error).toBe('internal');
		expect(body.ref).toBe('ref_abc123');
		expect(body.error_description).toContain('ref_abc123');
		// The driver detail stays server-side.
		expect(res.body).not.toContain('x402_settlements');
		expect(res.body).not.toContain('42P01');
		expect(send402Mock).not.toHaveBeenCalled();
	});

	it('re-exports the shared replay guard so every MCP server uses one implementation', () => {
		expect(typeof reservePaymentProof).toBe('function');
	});
});

// ── embed-policy.js ─────────────────────────────────────────────────────────
describe('readMcpPolicyByAvatar', () => {
	it('returns the normalized policy for an avatar owned by a registered agent', async () => {
		sqlMock.mockResolvedValue([{ embed_policy: { surfaces: { mcp: false } } }]);
		const policy = await readMcpPolicyByAvatar('11111111-1111-4111-8111-111111111111');

		expect(sqlMock).toHaveBeenCalledTimes(1);
		expect(policy).toBeTruthy();
		// Normalization fills the rest of the policy in around the stored override.
		expect(policy.surfaces.mcp).toBe(false);
		expect(policy.version).toBeDefined();
		expect(policy.origins).toBeDefined();
	});

	it('returns null when no agent claims the avatar, leaving the surface open', async () => {
		sqlMock.mockResolvedValue([]);
		expect(await readMcpPolicyByAvatar('11111111-1111-4111-8111-111111111111')).toBeNull();
	});

	// Failure path: a caller-supplied id that is not a uuid never reaches the DB.
	it('rejects a non-uuid avatar id without querying', async () => {
		for (const bad of ["'; DROP TABLE avatars; --", '', 'not-a-uuid', null, undefined]) {
			expect(await readMcpPolicyByAvatar(bad)).toBeNull();
		}
		expect(sqlMock).not.toHaveBeenCalled();
	});
});
