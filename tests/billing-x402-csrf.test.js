// @vitest-environment jsdom
//
// The client half of the /api/user/x402-subscriptions contract.
//
// Rotate and revoke destroy a live API credential, so the endpoint now demands
// a CSRF token. This page posted without one, which would have turned the whole
// key-management UI into a 403 the moment the server-side guard landed. These
// cases pin both halves: the header goes out on every write, and a rejected
// write says something a user can act on instead of "please try again".

import { describe, it, expect, beforeEach, vi } from 'vitest';

const SUB = {
	id: 'sub_live',
	name: 'my key',
	keyPrefix: 'x402_abcdefgh',
	rateLimitPerMinute: 120,
	status: 'active',
	source: 'native',
	isFreeTrial: false,
	createdAt: '2026-08-01T00:00:00Z',
	expiresAt: null,
	usage: { granted: 10, denied: 0, lastSeenAt: '2026-08-14T00:00:00Z' },
};

// Every element the module reaches for by id, plus the state containers it
// toggles. Built once before the module is imported, because it calls load()
// at import time.
document.body.innerHTML = `
	<div id="state-loading" class="state"></div>
	<div id="state-empty" class="state"></div>
	<div id="state-error" class="state">
		<h2 id="error-title"></h2>
		<p id="error-body"></p>
		<button id="btn-retry"></button>
	</div>
	<div id="state-list" class="state">
		<code id="example-prefix"></code>
		<div id="cards"></div>
	</div>
	<div id="toast"></div>
`;

const calls = [];
const responses = { list: { subscriptions: [SUB] }, action: null, actionStatus: 200 };

globalThis.fetch = vi.fn(async (url, init = {}) => {
	calls.push({ url, method: init.method || 'GET', headers: init.headers || {}, body: init.body || null });
	if (url === '/api/csrf-token') {
		return { ok: true, status: 200, json: async () => ({ token: 'csrf-abc123' }) };
	}
	if ((init.method || 'GET') === 'GET') {
		return { ok: true, status: 200, json: async () => responses.list };
	}
	const status = responses.actionStatus;
	return { ok: status < 400, status, json: async () => responses.action ?? {} };
});

window.confirm = vi.fn(() => true);

// jsdom ships no CSS.escape; every browser the page runs in has it. The ids in
// these cases are plain identifiers, so escaping the CSS special characters is
// all the module needs from it.
if (!globalThis.CSS?.escape) {
	globalThis.CSS = { ...(globalThis.CSS || {}), escape: (s) => String(s).replace(/[^\w-]/g, '\\$&') };
}

await import('../src/billing-x402.js');

// The module wires a delegated click listener, so a case drives it the way a
// user does rather than by reaching into a function it does not export.
async function clickAction(action, id) {
	document.getElementById('cards').innerHTML =
		`<div data-card="${id}"><button class="btn" data-action="${action}" data-id="${id}">go</button></div>`;
	document.querySelector(`[data-action="${action}"]`).click();
	// Let the rotate/revoke promise chain (csrf fetch, action fetch, reload) settle.
	for (let i = 0; i < 12; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	for (let i = 0; i < 12; i++) await Promise.resolve();
}

function writes() {
	return calls.filter((c) => c.method === 'POST' && c.url === '/api/user/x402-subscriptions');
}

beforeEach(() => {
	calls.length = 0;
	responses.action = null;
	responses.actionStatus = 200;
});

describe('billing keys page: CSRF on writes', () => {
	it('fetches a token and sends it with a rotate', async () => {
		responses.action = { ok: true, action: 'rotate', subscription: { id: 'sub_new', token: 'x402_secret' } };
		await clickAction('rotate', SUB.id);

		expect(calls.some((c) => c.url === '/api/csrf-token')).toBe(true);
		const [post] = writes();
		expect(post.headers['x-csrf-token']).toBe('csrf-abc123');
		expect(JSON.parse(post.body)).toEqual({ action: 'rotate', id: SUB.id });
	});

	it('fetches a token and sends it with a revoke', async () => {
		responses.action = { ok: true, action: 'revoke', id: SUB.id };
		await clickAction('revoke', SUB.id);

		const [post] = writes();
		expect(post.headers['x-csrf-token']).toBe('csrf-abc123');
		expect(JSON.parse(post.body)).toEqual({ action: 'revoke', id: SUB.id });
	});

	it('never reuses a token: each write asks for its own', async () => {
		responses.action = { ok: true, action: 'revoke', id: SUB.id };
		await clickAction('revoke', SUB.id);
		await clickAction('revoke', SUB.id);
		expect(calls.filter((c) => c.url === '/api/csrf-token')).toHaveLength(2);
	});

	it('tells the user to reload when the token is rejected', async () => {
		responses.actionStatus = 403;
		responses.action = { error: 'csrf_invalid', error_description: 'CSRF token invalid or expired' };
		await clickAction('rotate', SUB.id);
		expect(document.getElementById('toast').textContent).toMatch(/reload/i);
	});

	it('tells the user to wait when the write is rate limited', async () => {
		responses.actionStatus = 429;
		responses.action = { error: 'rate_limited' };
		await clickAction('revoke', SUB.id);
		expect(document.getElementById('toast').textContent).toMatch(/wait/i);
	});

	it('still surfaces a server message when the endpoint sends one', async () => {
		responses.actionStatus = 409;
		responses.action = { error: 'aws_revoke_not_allowed', message: 'This key bills through AWS Marketplace.' };
		await clickAction('revoke', SUB.id);
		expect(document.getElementById('toast').textContent).toBe('This key bills through AWS Marketplace.');
	});
});
