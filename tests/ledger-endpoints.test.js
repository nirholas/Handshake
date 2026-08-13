/**
 * GET /api/ledger/:agentId and GET /api/ledger/verify/:agentId — the two public
 * Reasoning Ledger reads.
 *
 * Both handlers run for real against an in-memory `sql` that speaks enough of the
 * agent_decisions / decision_outcomes / agent_identities / ledger_anchors schema
 * for their actual queries (composed fragments included). The chains under test
 * are built with the real buildChain, so every hash the verify endpoint checks is
 * a genuine one and a tampered entry fails exactly the way production would.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => {
	const store = { decisions: [], outcomes: [], identities: [], anchors: [] };

	// Flatten a tagged template (with nested fragments) the way api/_lib/db.js does.
	function flatten(node) {
		let text = '';
		const params = [];
		const walk = (strings, values) => {
			for (let i = 0; i < strings.length; i++) {
				text += strings[i];
				if (i < values.length) {
					const v = values[i];
					if (v && v.__frag) walk(v.strings, v.values);
					else { params.push(v); text += '$' + params.length; }
				}
			}
		};
		walk(node.strings, node.values);
		return { text: text.toLowerCase().replace(/\s+/g, ' '), params };
	}

	function exec({ text, params }) {
		if (text.includes('from agent_identities')) {
			const [id] = params;
			const row = store.identities.find((a) => a.id === id);
			return row ? [{ ...row }] : [];
		}
		if (text.includes('from ledger_anchors')) {
			const [agentId] = params;
			const anchored = text.includes("status = 'anchored'");
			const rows = store.anchors
				.filter((a) => a.agent_id === agentId && (!anchored || a.status === 'anchored'))
				.sort((a, b) => Number(b.through_seq) - Number(a.through_seq));
			return rows.length ? [{ ...rows[0] }] : [];
		}
		// Reputation records: one row per decision, outcome left-joined.
		if (text.includes('d.kind, d.confidence, d.decided_at')) {
			const [agentId] = params;
			return store.decisions.filter((d) => d.agent_id === agentId).map((d) => {
				const o = store.outcomes.find((x) => x.decision_id === d.id);
				return { kind: d.kind, confidence: d.confidence, decided_at: d.decided_at, was_correct: o ? o.was_correct : null, pnl_sol: o ? o.pnl_sol : null };
			});
		}
		// Timeline, newest first, with the optional kind / q / before fragments.
		if (text.includes('order by d.seq desc')) {
			let i = 0;
			const agentId = params[i++];
			const kind = text.includes('d.kind = $') ? params[i++] : null;
			const q = text.includes('ilike') ? (i += 2, params[i - 2]) : null;
			const beforeSeq = text.includes('d.seq < $') ? params[i++] : null;
			const limit = Number(params[i]);
			const needle = q ? String(q).replace(/%/g, '').toLowerCase() : null;
			return store.decisions
				.filter((d) => d.agent_id === agentId)
				.filter((d) => (kind ? d.kind === kind : true))
				.filter((d) => (beforeSeq != null ? Number(d.seq) < Number(beforeSeq) : true))
				.filter((d) => (needle
					? String(d.rationale || '').toLowerCase().includes(needle) || String(d.subject_ref || '').toLowerCase().includes(needle)
					: true))
				.sort((a, b) => Number(b.seq) - Number(a.seq))
				.slice(0, limit)
				.map((d) => {
					const o = store.outcomes.find((x) => x.decision_id === d.id);
					return {
						...d,
						observed: o ? o.observed : null,
						was_correct: o ? o.was_correct : null,
						pnl_sol: o ? o.pnl_sol : null,
						impact: o ? o.impact : null,
						outcome_status: o ? o.status : null,
						reconciled_at: o ? o.reconciled_at : null,
					};
				});
		}
		// Full chain, ascending — what the verify endpoint rehashes.
		if (text.includes('from agent_decisions') && text.includes('order by seq asc')) {
			const [agentId] = params;
			return store.decisions.filter((d) => d.agent_id === agentId).sort((a, b) => Number(a.seq) - Number(b.seq)).map((d) => ({ ...d }));
		}
		return [];
	}

	const fakeSql = (strings, ...values) => {
		let settled = null;
		const run = () => (settled ||= Promise.resolve().then(() => exec(flatten(node))));
		const node = {
			__frag: true,
			strings,
			values,
			then: (a, b) => run().then(a, b),
			catch: (b) => run().catch(b),
			finally: (f) => run().finally(f),
		};
		return node;
	};
	return { store, fakeSql };
});

vi.mock('../api/_lib/db.js', () => ({
	sql: h.fakeSql,
	sqlValues: () => {},
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
	isStoragePressured: async () => ({ pressured: false }),
}));

const { buildChain } = await import('../api/_lib/reasoning-ledger.js');
const { default: timelineHandler } = await import('../api/ledger/[agentId].js');
const { default: verifyHandler } = await import('../api/ledger/verify/[agentId].js');

const AGENT = '22222222-2222-2222-2222-222222222222';

function makeReq(url, query) {
	return { method: 'GET', url, headers: {}, ...(query ? { query } : {}) };
}
function makeRes() {
	const r = { statusCode: 200, _h: {}, _b: null, headersSent: false, writableEnded: false };
	r.setHeader = (k, v) => { r._h[k.toLowerCase()] = v; };
	r.getHeader = (k) => r._h[k.toLowerCase()];
	r.end = (b) => { r._b = b; r.writableEnded = true; };
	r.body = () => JSON.parse(r._b);
	return r;
}
async function call(handler, url, query) {
	const res = makeRes();
	await handler(makeReq(url, query), res);
	return res;
}

/** Seed `n` real chain entries (hashes computed by the production builder). */
async function seedChain(n, over = {}) {
	const raw = Array.from({ length: n }, (_, i) => ({
		kind: 'snipe',
		subject_ref: `mint-${i + 1}`,
		action_ref: `pos-${i + 1}`,
		inputs: { position_id: `pos-${i + 1}` },
		rationale: `decision number ${i + 1}`,
		prediction: { direction: 'up' },
		confidence: 0.8,
		network: 'mainnet',
		decided_at: new Date(1_700_000_000_000 + i * 1000).toISOString(),
		...over,
	}));
	const chain = await buildChain(AGENT, raw);
	store().decisions.push(...chain.map((e, i) => ({ ...e, id: `dec-${i + 1}` })));
	return chain;
}
const store = () => h.store;

beforeEach(() => {
	h.store.decisions = [];
	h.store.outcomes = [];
	h.store.identities = [];
	h.store.anchors = [];
});

describe('GET /api/ledger/:agentId', () => {
	it('returns the timeline, reputation, and a reconciled outcome', async () => {
		await seedChain(3);
		h.store.identities.push({ id: AGENT, name: 'Sniper One', profile_image_url: 'https://cdn.example/a.png', avatar_url: null, is_public: true, deleted_at: null });
		h.store.outcomes.push({ decision_id: 'dec-1', observed: { sell_sig: 'sig-1' }, was_correct: true, pnl_sol: 1.5, impact: 0.2, status: 'reconciled', reconciled_at: '2026-08-01T00:00:00.000Z' });

		const res = await call(timelineHandler, `/api/ledger/${AGENT}`);
		expect(res.statusCode).toBe(200);
		const body = res.body();
		expect(body.agent).toEqual({ id: AGENT, name: 'Sniper One', image: 'https://cdn.example/a.png' });
		expect(body.decisions).toHaveLength(3);
		expect(body.decisions[0].seq).toBe(3);
		expect(body.decisions[0].outcome.status).toBe('pending');
		const reconciled = body.decisions.find((d) => d.seq === 1);
		expect(reconciled.outcome).toMatchObject({ status: 'reconciled', was_correct: true, pnl_sol: 1.5 });
		expect(reconciled.outcome.proof_url).toBe('https://solscan.io/tx/sig-1');
		expect(body.reputation.sample_size).toBe(1);
		expect(body.reputation.pending_count).toBe(2);
		expect(body.paging.next_before_seq).toBeNull();
		expect(res.getHeader('cache-control')).toContain('s-maxage');
	});

	it('pages: a full page hands back the cursor the next call resumes from', async () => {
		await seedChain(3);
		const first = await call(timelineHandler, `/api/ledger/${AGENT}?limit=2`);
		expect(first.body().decisions.map((d) => d.seq)).toEqual([3, 2]);
		expect(first.body().paging.next_before_seq).toBe(2);

		const second = await call(timelineHandler, `/api/ledger/${AGENT}?limit=2&before=2`);
		expect(second.body().decisions.map((d) => d.seq)).toEqual([1]);
		expect(second.body().paging.next_before_seq).toBeNull();
	});

	it('filters by kind and free text', async () => {
		await seedChain(2);
		await (async () => {
			const extra = await buildChain(AGENT, [{ kind: 'exit', subject_ref: 'mint-9', action_ref: 'pos-9', inputs: {}, rationale: 'took profit', prediction: {}, confidence: 0.4, network: 'mainnet', decided_at: '2026-08-02T00:00:00.000Z' }], 3, h.store.decisions[1].entry_hash);
			h.store.decisions.push({ ...extra[0], id: 'dec-3' });
		})();

		const byKind = await call(timelineHandler, `/api/ledger/${AGENT}?kind=exit`);
		expect(byKind.body().decisions.map((d) => d.kind)).toEqual(['exit']);
		const byText = await call(timelineHandler, `/api/ledger/${AGENT}?q=took%20profit`);
		expect(byText.body().decisions).toHaveLength(1);
		expect(byText.body().filters).toEqual({ kind: null, q: 'took profit' });
	});

	it('never publishes the name or avatar of a private or deleted agent', async () => {
		await seedChain(1);
		h.store.identities.push({ id: AGENT, name: 'Hidden', profile_image_url: 'https://cdn.example/h.png', avatar_url: null, is_public: false, deleted_at: null });
		const res = await call(timelineHandler, `/api/ledger/${AGENT}`);
		expect(res.body().agent).toEqual({ id: AGENT, name: null, image: null });
		expect(res.body().decisions).toHaveLength(1);

		h.store.identities[0] = { ...h.store.identities[0], is_public: true, deleted_at: '2026-08-01T00:00:00.000Z' };
		const deleted = await call(timelineHandler, `/api/ledger/${AGENT}`);
		expect(deleted.body().agent).toEqual({ id: AGENT, name: null, image: null });
	});

	it('rejects a malformed agent id, cursor, page size, and filter', async () => {
		const badId = await call(timelineHandler, '/api/ledger/not-a-uuid');
		expect(badId.statusCode).toBe(400);
		expect(badId.body().error).toBe('bad_request');

		const badCursor = await call(timelineHandler, `/api/ledger/${AGENT}?before=abc`);
		expect(badCursor.statusCode).toBe(400);
		expect(badCursor.body().error_description).toMatch(/before/);

		const overLimit = await call(timelineHandler, `/api/ledger/${AGENT}?limit=500`);
		expect(overLimit.statusCode).toBe(400);
		expect(overLimit.body().error_description).toMatch(/limit/);

		const longFilter = await call(timelineHandler, `/api/ledger/${AGENT}?q=${'x'.repeat(201)}`);
		expect(longFilter.statusCode).toBe(400);
	});

	it('treats an empty page-size param as unset and reads the id from req.query', async () => {
		await seedChain(1);
		const res = await call(timelineHandler, '/api/ledger/[agentId]?limit=', { agentId: AGENT });
		expect(res.statusCode).toBe(200);
		expect(res.body().decisions).toHaveLength(1);
	});

	it('answers 405 with an Allow header on a write attempt', async () => {
		const res = makeRes();
		await timelineHandler({ method: 'POST', url: `/api/ledger/${AGENT}`, headers: {} }, res);
		expect(res.statusCode).toBe(405);
		expect(String(res.getHeader('allow'))).toContain('GET');
	});
});

describe('GET /api/ledger/verify/:agentId', () => {
	it('reports an empty ledger as empty, not as a failure', async () => {
		const res = await call(verifyHandler, `/api/ledger/verify/${AGENT}`);
		expect(res.statusCode).toBe(200);
		expect(res.body().status).toBe('empty');
		expect(res.body().chain).toMatchObject({ ok: true, count: 0 });
		expect(res.getHeader('cache-control')).toBe('no-store');
	});

	it('verifies an intact but unanchored chain', async () => {
		await seedChain(3);
		const res = await call(verifyHandler, `/api/ledger/verify/${AGENT}`);
		expect(res.body().status).toBe('verified_unanchored');
		expect(res.body().chain.ok).toBe(true);
		expect(res.body().anchor).toBeNull();
	});

	it('verifies a chain whose head matches the on-chain anchor', async () => {
		const chain = await seedChain(3);
		h.store.anchors.push({
			agent_id: AGENT, network: 'mainnet', through_seq: 3, head_hash: chain[2].entry_hash,
			entry_count: 3, signature: 'anchor-sig', status: 'anchored', anchored_at: '2026-08-01T00:00:00.000Z',
		});
		const res = await call(verifyHandler, `/api/ledger/verify/${AGENT}`);
		expect(res.body().status).toBe('verified');
		expect(res.body().anchor).toMatchObject({ matches_chain: true, through_seq: 3, explorer_url: 'https://solscan.io/tx/anchor-sig' });
	});

	it('pinpoints a tampered entry and still shows the anchor it no longer matches', async () => {
		const chain = await seedChain(3);
		h.store.anchors.push({
			agent_id: AGENT, network: 'mainnet', through_seq: 3, head_hash: chain[2].entry_hash,
			entry_count: 3, signature: 'anchor-sig', status: 'anchored', anchored_at: '2026-08-01T00:00:00.000Z',
		});
		h.store.decisions[1].rationale = 'rewritten after the fact';

		const res = await call(verifyHandler, `/api/ledger/verify/${AGENT}`);
		expect(res.body().status).toBe('verification_failed');
		expect(res.body().chain).toMatchObject({ ok: false, broken_at: 2 });
		expect(res.body().chain.reason).toMatch(/altered/);
		expect(res.body().anchor).toMatchObject({ matches_chain: false, signature: 'anchor-sig' });
	});

	it('rejects a malformed agent id and a write attempt', async () => {
		const bad = await call(verifyHandler, '/api/ledger/verify/nope');
		expect(bad.statusCode).toBe(400);
		expect(bad.body().error).toBe('bad_request');

		const res = makeRes();
		await verifyHandler({ method: 'POST', url: `/api/ledger/verify/${AGENT}`, headers: {} }, res);
		expect(res.statusCode).toBe(405);
	});
});
