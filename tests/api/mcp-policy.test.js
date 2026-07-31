// GET /api/mcp-policy: the MCP trust policy endpoint.
//
// An MCP client that consumes this policy will run whatever lands in `allow`
// without asking its user. That makes a mistake here silent and consequential,
// so these tests pin the properties a caller is entitled to assume: the profile
// ladder only ever widens, nothing irreversible is ever auto-approved, and every
// tool in the catalog is accounted for in exactly one bucket.

import { describe, it, expect } from 'vitest';

import handler from '../../api/mcp-policy.js';

function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		body: undefined,
		setHeader(k, v) {
			this._h[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this._h[k.toLowerCase()];
		},
		end(body) {
			this.body = body;
		},
	};
}

async function get(query = '') {
	const req = { method: 'GET', url: `/api/mcp-policy${query}`, headers: {} };
	const res = makeRes();
	await handler(req, res);
	return { res, json: JSON.parse(res.body) };
}

describe('GET /api/mcp-policy', () => {
	it('defaults to the balanced profile and the portable format', async () => {
		const { res, json } = await get();
		expect(res.statusCode).toBe(200);
		expect(json.profile).toBe('balanced');
		expect(json.$schema).toContain('mcp-trust-policy');
		expect(json.rules.allow.length).toBeGreaterThan(0);
	});

	it('accounts for every catalog tool exactly once', async () => {
		for (const profile of ['strict', 'balanced', 'open']) {
			const { json } = await get(`?profile=${profile}`);
			const { allow, confirm, deny } = json.rules;
			const total = allow.length + confirm.length + deny.length;
			expect(total, `${profile} bucket total`).toBe(json.counts.total);

			// Six tool names (list_animations, render_avatar, kol_leaderboard,
			// sns_resolve, find_services, pay_and_call) are published by two servers
			// each, so the bare name is NOT the key. The namespaced permission is,
			// and it is what a client actually allowlists.
			const permissions = [...allow, ...confirm, ...deny].map((t) => t.permission);
			expect(new Set(permissions).size, `${profile} permissions are unique`).toBe(
				permissions.length,
			);
		}
	});

	it('never auto-approves anything irreversible, on any profile', async () => {
		for (const profile of ['strict', 'balanced', 'open']) {
			const { json } = await get(`?profile=${profile}`);
			const bad = json.rules.allow.filter((t) => t.safety === 'irreversible');
			expect(bad.map((t) => t.name), `${profile} auto-approves an irreversible tool`).toEqual([]);
		}
	});

	it('only ever auto-approves reads unless the profile says otherwise', async () => {
		const strict = (await get('?profile=strict')).json;
		// Strict is the promise a cautious integrator relies on: reads, free only.
		for (const tool of strict.rules.allow) {
			expect(tool.safety).toBe('read');
			expect(tool.priceUsd).toBe(0);
		}
		const balanced = (await get('?profile=balanced')).json;
		for (const tool of balanced.rules.allow) expect(tool.safety).toBe('read');
	});

	it('widens monotonically from strict to open', async () => {
		const [strict, balanced, open] = await Promise.all(
			['strict', 'balanced', 'open'].map((p) => get(`?profile=${p}`).then((r) => r.json)),
		);
		const allowed = (p) => new Set(p.rules.allow.map((t) => t.name));
		const s = allowed(strict);
		const b = allowed(balanced);
		const o = allowed(open);

		expect(s.size).toBeLessThanOrEqual(b.size);
		expect(b.size).toBeLessThanOrEqual(o.size);
		// A tool a stricter profile trusts must stay trusted as you loosen, or the
		// ladder would not be a ladder and "upgrading" could silently revoke.
		for (const name of s) expect(b.has(name), `${name} dropped from balanced`).toBe(true);
		for (const name of b) expect(o.has(name), `${name} dropped from open`).toBe(true);

		// Only strict blocks outright; the looser profiles ask instead.
		expect(strict.counts.deny).toBeGreaterThan(0);
		expect(balanced.counts.deny).toBe(0);
		expect(open.counts.deny).toBe(0);
	});

	it('emits a Claude settings block with namespaced permission ids', async () => {
		const { json } = await get('?profile=strict&format=claude');
		expect(Object.keys(json.permissions)).toEqual(['allow', 'ask', 'deny']);
		for (const id of json.permissions.allow) expect(id).toMatch(/^mcp__[\w.-]+__\w+$/);
		expect(json.permissions.deny.length).toBeGreaterThan(0);
		expect(json.$comment).toContain('three.ws');
	});

	it('emits a VS Code auto-approve map where only allowed tools are true', async () => {
		const { json } = await get('?profile=balanced&format=vscode');
		const map = json['chat.tools.autoApprove'];
		const trues = Object.values(map).filter(Boolean).length;
		const policy = (await get('?profile=balanced')).json;
		expect(trues).toBe(policy.counts.allow);
		expect(Object.keys(map).length).toBe(policy.counts.total);
	});

	it('rejects an unknown profile with the list of real ones', async () => {
		const { res, json } = await get('?profile=yolo');
		expect(res.statusCode).toBe(400);
		expect(json.error).toContain('yolo');
		expect(json.profiles.map((p) => p.id)).toEqual(['strict', 'balanced', 'open']);
	});

	it('rejects an unknown format', async () => {
		const { res, json } = await get('?format=yaml');
		expect(res.statusCode).toBe(400);
		expect(json.formats).toContain('claude');
	});

	it('is cacheable and CORS-open, since a client has to fetch it', async () => {
		const { res } = await get();
		expect(res.getHeader('cache-control')).toContain('s-maxage');
		expect(res.getHeader('access-control-allow-origin')).toBe('*');
		expect(res.getHeader('content-type')).toContain('application/json');
	});
});
