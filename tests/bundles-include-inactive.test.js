// GET /api/agents/:id/bundles - who is allowed to see a paused bundle.
//
// `DELETE` on a bundle sets `is_active = false`, and the list was active-only
// for everyone, which made pausing a one-way door: the owner's own bundle left
// every surface that could bring it back. `include_inactive=1` reopens it, and
// that flag is exactly the kind of parameter that quietly turns a public
// endpoint into a leak. This endpoint is public (no session required), so the
// flag has to be ignored for anyone who does not own the agent.
//
// These tests assert the WHERE fragment the handler actually builds, per caller:
// only a session that owns the agent may widen it past `is_active = true`.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const queries = [];
const state = { user: null, ownsAgent: false };

vi.mock('../api/_lib/db.js', () => ({
	sql: vi.fn((strings, ...values) => {
		const text = Array.isArray(strings) ? strings.join('?') : String(strings);
		const lower = text.toLowerCase();
		queries.push({ text, values });
		if (/from agent_identities/.test(lower)) {
			return Promise.resolve(state.ownsAgent ? [{ id: AGENT_ID }] : []);
		}
		if (/from skill_bundles/.test(lower)) return Promise.resolve([]);
		// Anything else is a composable fragment the handler embeds in a query.
		return { fragment: text };
	}),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => state.user),
	authenticateBearer: vi.fn(async () => null),
	extractBearer: vi.fn(() => null),
}));

vi.mock('../api/_lib/csrf.js', () => ({ requireCsrf: vi.fn(async () => true) }));
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { authIp: vi.fn(async () => ({ success: true })) },
	clientIp: () => '127.0.0.1',
}));

const AGENT_ID = '33333333-3333-4333-8333-333333333333';
const { default: handler } = await import('../api/agents/[id]/bundles.js');

function makeRes() {
	return {
		statusCode: 0,
		payload: null,
		headers: {},
		setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
		getHeader(k) { return this.headers[String(k).toLowerCase()]; },
		removeHeader(k) { delete this.headers[String(k).toLowerCase()]; },
		writeHead(code) { this.statusCode = code; return this; },
		get headersSent() { return false; },
		get writableEnded() { return false; },
		end(chunk) {
			if (chunk) { try { this.payload = JSON.parse(String(chunk)); } catch { this.payload = String(chunk); } }
			return this;
		},
	};
}

async function list(query) {
	const res = makeRes();
	await handler({ method: 'GET', url: `/api/agents/${AGENT_ID}/bundles${query}`, headers: {} }, res);
	return res;
}

/** The `${visible}` fragment the list query was built with. */
function visibilityFragment() {
	const listQuery = queries.find((q) => /from skill_bundles/i.test(q.text));
	expect(listQuery, 'the handler never ran the list query').toBeTruthy();
	const fragment = listQuery.values.find((v) => v && typeof v === 'object' && 'fragment' in v);
	return fragment?.fragment;
}

beforeEach(() => {
	queries.length = 0;
	state.user = null;
	state.ownsAgent = false;
});

describe('GET /api/agents/:id/bundles visibility', () => {
	it('is active-only for an anonymous caller', async () => {
		const res = await list('');
		expect(res.statusCode).toBe(200);
		expect(visibilityFragment()).toBe('sb.is_active = true');
	});

	it('ignores include_inactive for an anonymous caller', async () => {
		const res = await list('?include_inactive=1');
		expect(res.statusCode).toBe(200);
		expect(visibilityFragment()).toBe('sb.is_active = true');
	});

	it('ignores include_inactive for a signed-in caller who does not own the agent', async () => {
		state.user = { id: 'someone-else' };
		state.ownsAgent = false;
		const res = await list('?include_inactive=1');
		expect(res.statusCode).toBe(200);
		expect(visibilityFragment()).toBe('sb.is_active = true');
	});

	it('includes paused bundles for the agent owner', async () => {
		state.user = { id: 'owner-1' };
		state.ownsAgent = true;
		const res = await list('?include_inactive=1');
		expect(res.statusCode).toBe(200);
		expect(visibilityFragment()).toBe('TRUE');
	});

	it('stays active-only for the owner who did not ask for paused bundles', async () => {
		state.user = { id: 'owner-1' };
		state.ownsAgent = true;
		const res = await list('');
		expect(res.statusCode).toBe(200);
		expect(visibilityFragment()).toBe('sb.is_active = true');
		// No ownership lookup is worth doing when the flag is absent.
		expect(queries.some((q) => /from agent_identities/i.test(q.text))).toBe(false);
	});

	it('only honours the exact flag value', async () => {
		state.user = { id: 'owner-1' };
		state.ownsAgent = true;
		const res = await list('?include_inactive=true');
		expect(res.statusCode).toBe(200);
		expect(visibilityFragment()).toBe('sb.is_active = true');
	});
});
