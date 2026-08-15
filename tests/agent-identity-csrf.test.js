// Regression: agent action-log writes must carry a CSRF token.
//
// recordAction() once used a raw fetch() with no CSRF header, so every
// owned-agent action POST to /api/agent-actions was rejected 403 csrf_missing
// (visible as repeating 403s on the live widget). It now routes through
// apiFetch (src/api.js), which attaches a fresh single-use token to every
// mutation. These tests lock that in and guard the owner/anon gating.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgentIdentity } from '../src/agent-identity.js';

const CSRF = 'tok_deadbeef';

function ownedIdentity() {
	const id = new AgentIdentity({ agentId: 'agt_test', autoLoad: false });
	id._record = { id: 'agt_test', skills: [], meta: {} };
	id._backendConfirmed = true;
	id._owned = true;
	return id;
}

describe('agent-identity CSRF', () => {
	let calls;

	beforeEach(() => {
		calls = [];
		globalThis.fetch = vi.fn(async (path, init = {}) => {
			calls.push({ path: String(path), init });
			// apiFetch probes the session before asking for a token, so a caller it
			// can see is signed out never prints a 401 in a visitor's console. An
			// owner recording an action IS signed in, so the probe has to say so or
			// the CSRF pre-flight is skipped and this test measures the wrong path.
			if (String(path).includes('/api/auth/me')) {
				return new Response(JSON.stringify({ user: { id: 'usr_test' } }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			}
			if (String(path).includes('/api/csrf-token')) {
				return new Response(JSON.stringify({ data: { token: CSRF } }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			}
			return new Response(JSON.stringify({ action: { id: '1' } }), {
				status: 201,
				headers: { 'content-type': 'application/json' },
			});
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		delete globalThis.fetch;
	});

	it('recordAction attaches an x-csrf-token header to the append POST', async () => {
		await ownedIdentity().recordAction({ type: 'view', payload: { x: 1 } });

		const post = calls.find((c) => c.path.includes('/api/agent-actions'));
		expect(post, 'expected a POST to /api/agent-actions').toBeTruthy();
		expect(post.init.method).toBe('POST');

		const headers = new Headers(post.init.headers);
		expect(headers.get('x-csrf-token')).toBe(CSRF);
		expect(headers.get('content-type')).toBe('application/json');
		expect(post.init.credentials).toBe('include'); // apiFetch carries the session cookie

		const body = JSON.parse(post.init.body);
		expect(body).toMatchObject({ agent_id: 'agt_test', type: 'view' });
	});

	it('recordAction is a no-op when the session does not own the agent', async () => {
		const id = ownedIdentity();
		id._owned = false; // viewing someone else's agent
		await id.recordAction({ type: 'view', payload: {} });
		expect(calls).toHaveLength(0);
	});

	it('recordAction is a no-op before the backend confirms a session', async () => {
		const id = ownedIdentity();
		id._backendConfirmed = false;
		await id.recordAction({ type: 'view', payload: {} });
		expect(calls).toHaveLength(0);
	});

	it('recordAction swallows backend failures (fire-and-forget)', async () => {
		globalThis.fetch = vi.fn(async () => {
			throw new Error('network down');
		});
		await expect(ownedIdentity().recordAction({ type: 'view', payload: {} })).resolves.toBeUndefined();
	});
});
