import { Readable } from 'node:stream';

let counter = 0;

export function createTestAgent(overrides = {}) {
	const userId = `user-${++counter}`;
	// Must be a real UUID — the x402 handlers guard agent_id with isUuid() and
	// 404 on anything that doesn't parse, so a synthetic "agent-N-…" id never
	// reaches the manifest/invoke logic under test.
	const agentId = `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
	const agent = {
		id: agentId,
		user_id: userId,
		name: 'Test Agent',
		meta: {
			payments: {
				configured: true,
				provider: 'pumpfun',
				mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
				receiver: 'So11111111111111111111111111111111111111112',
				cluster: 'mainnet',
				default_price: { amount: '1000000', currency: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
			},
		},
		...overrides,
	};
	return { agent, session: { id: userId } };
}

export function createTestUser() {
	const userId = `user-${++counter}`;
	return { session: { id: userId } };
}

export function makeReq({ method = 'GET', url = '/', headers = {}, body = null, query = null } = {}) {
	const base = body
		? Readable.from([Buffer.from(JSON.stringify(body))])
		: Readable.from([]);
	base.method = method;
	base.url = url;
	base.headers = {
		host: 'localhost',
		...(body ? { 'content-type': 'application/json' } : {}),
		...headers,
	};
	if (query) base.query = query;
	return base;
}

export function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		writableEnded: false,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		// A real ServerResponse exposes this and api/_lib/http.js reads it: the
		// secure-cache default checks for an already-set Cache-Control, and
		// varyOn() merges into an existing Vary. Without it those paths silently
		// no-op under test and a header regression sails straight through.
		getHeader(k) {
			return this.headers[k.toLowerCase()];
		},
		end(chunk) {
			if (chunk !== undefined) this.body += chunk;
			this.writableEnded = true;
		},
	};
}

export async function invoke(handler, reqOpts) {
	const req = makeReq(reqOpts);
	const res = makeRes();
	await handler(req, res);
	const payload = res.body ? JSON.parse(res.body) : null;
	return { res, status: res.statusCode, body: payload };
}
