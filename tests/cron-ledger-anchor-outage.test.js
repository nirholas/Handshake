// A dead on-chain anchor leg must be loud and must stop retrying itself
// (api/cron/reconcile-decisions.js + api/_lib/ledger-anchor.js).
//
// The Reasoning Ledger anchors each agent's chain head as an SPL-Memo so
// /api/ledger/verify/:agentId has an independent on-chain witness. Two distinct
// things can stop that, and they used to be reported identically:
//
//   • no attester key configured. A documented degraded mode: the commitment is
//     still recorded locally, every agent should still get its row, and nobody
//     should be paged.
//   • the broadcast itself rejected (an unfunded attester wallet answers every
//     send with "Attempt to debit an account but found no record of a prior
//     credit"). A real outage: it fails identically for every agent in the run,
//     so re-simulating the same doomed memo for each remaining agent is pure
//     waste, and a silent 200 is how it stayed invisible.
//
// The properties pinned here are exactly that split:
//   1. a rejected broadcast counts as anchor_failed, halts the loop, records what
//      it skipped, and pages ops
//   2. a missing key stays pending for every agent and pages nobody
//
// The matching unit property for anchorLedgerHead itself, that a rejected
// broadcast reports "failed" rather than "pending", is pinned separately in
// ledger-anchor-broadcast-status.test.js, which needs the real module that this
// file mocks out.
import { test, expect, vi, beforeEach } from 'vitest';

const sendOpsAlert = vi.fn(async () => {});
const anchorLedgerHead = vi.fn(async () => ({ status: 'pending', signature: null }));

let sqlHandler = () => [];
vi.mock('../api/_lib/db.js', () => ({
	sql: (strings, ...values) => Promise.resolve(sqlHandler(strings.join('?'), values)),
}));
vi.mock('../api/_lib/alerts.js', () => ({
	sendOpsAlert: (...args) => sendOpsAlert(...args),
}));
vi.mock('../api/_lib/cron-auth.js', () => ({ requireCron: () => true }));
vi.mock('../api/_lib/reasoning-ledger.js', () => ({
	recordOutcome: async () => ({ reconciled: false }),
	computeReputation: () => ({ sample_size: 0, hit_rate: 1, score: 0 }),
	getReputationRecords: async () => [],
}));
vi.mock('../api/_lib/ledger-anchor.js', () => ({
	anchorLedgerHead: (...args) => anchorLedgerHead(...args),
	latestAnchoredAnchor: async () => null,
}));

const handler = (await import('../api/cron/reconcile-decisions.js')).default;

function makeRes() {
	return {
		statusCode: 0,
		body: null,
		headersSent: false,
		writableEnded: false,
		setHeader() {},
		getHeader() {},
		status(code) { this.statusCode = code; return this; },
		end(payload) {
			this.writableEnded = true;
			if (payload && this.body === null) {
				try { this.body = JSON.parse(payload); } catch { this.body = payload; }
			}
			return this;
		},
		json(payload) { this.body = payload; return this; },
	};
}

// Four agents all sitting past their last anchor, nothing to reconcile.
function fourAgentsWithMovedHeads(text) {
	if (text.includes('decision_outcomes o')) return [];          // nothing to reconcile
	if (text.includes('max(seq)')) {
		return [1, 2, 3, 4].map((n) => ({ agent_id: `agent-${n}`, head_seq: n * 10, cnt: n * 10 }));
	}
	if (text.includes('entry_hash')) return [{ entry_hash: 'hash', network: 'mainnet' }];
	return [];
}

beforeEach(() => {
	sendOpsAlert.mockClear();
	anchorLedgerHead.mockClear();
	sqlHandler = fourAgentsWithMovedHeads;
});

test('a rejected broadcast halts the anchor loop, reports it, and pages ops', async () => {
	anchorLedgerHead.mockImplementation(async () => ({
		status: 'failed',
		signature: null,
		detail: 'record_failed: Attempt to debit an account but found no record of a prior credit.',
	}));

	const res = makeRes();
	await handler({ method: 'GET', url: '/api/cron/reconcile-decisions', headers: {} }, res);

	expect(res.body.anchor_failed).toBe(1);
	expect(res.body.anchor_skipped).toBe(3);
	expect(res.body.anchored).toBe(0);
	expect(res.body.anchor_outage).toContain('no record of a prior credit');
	// One doomed send, not one per agent.
	expect(anchorLedgerHead).toHaveBeenCalledTimes(1);
	expect(sendOpsAlert).toHaveBeenCalledTimes(1);
	expect(sendOpsAlert.mock.calls[0][2]).toMatchObject({ signature: 'ledger-anchor-broadcast-failed' });
});

test('a missing attester key records every agent as pending and pages nobody', async () => {
	anchorLedgerHead.mockImplementation(async () => ({
		status: 'pending', signature: null, detail: 'attester_key_not_configured',
	}));

	const res = makeRes();
	await handler({ method: 'GET', url: '/api/cron/reconcile-decisions', headers: {} }, res);

	expect(res.body.anchor_pending).toBe(4);
	expect(res.body.anchor_failed).toBe(0);
	expect(res.body.anchor_skipped).toBe(0);
	expect(res.body.anchor_outage).toBeUndefined();
	expect(anchorLedgerHead).toHaveBeenCalledTimes(4);
	expect(sendOpsAlert).not.toHaveBeenCalled();
});
