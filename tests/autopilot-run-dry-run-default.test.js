// POST /api/agents/:id/autopilot/run moves real funds out of an agent's wallet.
//
// It used to read `body?.dry_run === true`, so a bare `POST {}` ran a REAL cycle,
// while the sibling runner on the same wallet (api/agents/wallet-intents.js) read
// `body.dry_run !== false` and simulated. Same verb, same wallet, opposite default:
// whichever endpoint you reached first decided whether money moved.
//
// These tests pin the safe direction. Spending must be opt-in and explicit.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const runAutopilotCycleMock = vi.fn(async () => ({ ran: true, results: [] }));

vi.mock('../api/_lib/treasury-autopilot.js', () => ({
	getAutopilot: vi.fn(() => ({ armed: true })),
	setAutopilot: vi.fn(async () => ({})),
	compilePolicyFromText: vi.fn(async () => ({})),
	runAutopilotCycle: (...a) => runAutopilotCycleMock(...a),
	computeRunway: vi.fn(async () => ({})),
}));

vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => ({ id: 'user-1' })),
	authenticateBearer: vi.fn(async () => null),
	extractBearer: vi.fn(() => null),
}));

vi.mock('../api/_lib/csrf.js', () => ({ requireCsrf: vi.fn(async () => true) }));

vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { walletRead: vi.fn(async () => ({ success: true })) },
}));

vi.mock('../api/_lib/db.js', () => ({
	sql: vi.fn(async () => [{ id: 'agent-1', user_id: 'user-1', meta: {} }]),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

vi.mock('../api/_lib/agent-trade-guards.js', () => ({
	validateSolanaAddress: vi.fn(() => true),
	getSpendLimits: vi.fn(() => ({})),
}));

const AGENT_ID = 'agent-1';

// Minimal req/res doubles matching what api/_lib/http.js touches.
function makeReq(body) {
	return {
		method: 'POST',
		url: `/api/agents/${AGENT_ID}/autopilot/run`,
		headers: { 'content-type': 'application/json', origin: 'https://three.ws' },
		body,
	};
}

function makeRes() {
	return {
		statusCode: 0,
		payload: null,
		headers: {},
		setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
		getHeader(k) { return this.headers[String(k).toLowerCase()]; },
		removeHeader(k) { delete this.headers[String(k).toLowerCase()]; },
		writeHead(code) { this.statusCode = code; return this; },
		end(chunk) {
			if (chunk) { try { this.payload = JSON.parse(String(chunk)); } catch { this.payload = String(chunk); } }
			return this;
		},
	};
}

let handler;

beforeEach(async () => {
	vi.clearAllMocks();
	runAutopilotCycleMock.mockResolvedValue({ ran: true, results: [] });
	handler = (await import('../api/agents/autopilot.js')).default;
});

describe('POST /autopilot/run — dry_run default', () => {
	it('simulates when the body omits dry_run entirely', async () => {
		await handler(makeReq({}), makeRes(), AGENT_ID, 'run');

		expect(runAutopilotCycleMock).toHaveBeenCalledTimes(1);
		expect(runAutopilotCycleMock.mock.calls[0][0].dryRun).toBe(true);
	});

	it('simulates when the body is not valid JSON at all', async () => {
		// readJson throws, the handler falls back to {}, and that fallback has to be
		// safe too. A malformed request is exactly when you least want a spend.
		await handler(makeReq('not json'), makeRes(), AGENT_ID, 'run');

		expect(runAutopilotCycleMock.mock.calls[0][0].dryRun).toBe(true);
	});

	it('simulates when dry_run is a truthy non-boolean', async () => {
		// The STRING 'false' is not the boolean false. Anything not literally false
		// falls to the safe side rather than being coerced into a spend.
		await handler(makeReq({ dry_run: 'false' }), makeRes(), AGENT_ID, 'run');

		expect(runAutopilotCycleMock.mock.calls[0][0].dryRun).toBe(true);
	});

	it('simulates when dry_run is explicitly true', async () => {
		await handler(makeReq({ dry_run: true }), makeRes(), AGENT_ID, 'run');

		expect(runAutopilotCycleMock.mock.calls[0][0].dryRun).toBe(true);
	});

	it('spends ONLY when dry_run is literally false', async () => {
		await handler(makeReq({ dry_run: false }), makeRes(), AGENT_ID, 'run');

		expect(runAutopilotCycleMock.mock.calls[0][0].dryRun).toBe(false);
	});

	it('returns the cycle result to the caller', async () => {
		runAutopilotCycleMock.mockResolvedValue({
			ran: true,
			results: [{ kind: 'buyback', last_status: 'would_run' }],
		});
		const res = makeRes();
		await handler(makeReq({}), res, AGENT_ID, 'run');

		expect(res.statusCode).toBe(200);
		expect(res.payload.data.results[0].last_status).toBe('would_run');
	});
});
