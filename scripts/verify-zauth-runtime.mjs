// Runtime proof that the zauth (Provider Hub) telemetry layer actually fires.
//
// Static review already confirmed the wiring matches the SDK + docs; this goes
// further and exercises our REAL api/_lib/zauth.js (instrument → res.end →
// drain) with a test API key, intercepting global.fetch to confirm the SDK
// emits a telemetry POST to back.zauthx402.com for monitored requests — and
// stays silent for non-monitored ones.
//
//   node scripts/verify-zauth-runtime.mjs
//
// Uses a synthetic key, so the upstream would reject it; we only assert that
// the request lifecycle drives an outbound telemetry submission.
import { EventEmitter } from 'node:events';

// Enable the layer with a synthetic key BEFORE importing our module (env.js
// reads process.env live, and the middleware is built lazily on first use).
process.env.ZAUTH_API_KEY = 'zk_test_runtime_verify_0001';
process.env.ZAUTH_DEBUG = '1';

// Capture every outbound telemetry POST instead of hitting the network.
const telemetryCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
	const u = typeof url === 'string' ? url : url?.url || String(url);
	if (/zauthx402\.com/i.test(u)) {
		telemetryCalls.push({ url: u, method: init.method || 'GET', body: init.body });
		return new Response(JSON.stringify({ ok: true, accepted: 1 }), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		});
	}
	return realFetch ? realFetch(url, init) : new Response('null', { status: 200 });
};

const { instrument, drain, status } = await import('../api/_lib/zauth.js');

function makeReq({ url, method = 'GET', headers = {} }) {
	return {
		url,
		method,
		headers: { host: 'three.ws', ...headers },
		socket: { remoteAddress: '203.0.113.7' },
	};
}

// Minimal ServerResponse stand-in: an EventEmitter exposing the surface the
// Express-shaped SDK touches (statusCode, header accessors, end/write).
function makeRes() {
	const res = new EventEmitter();
	const headersStore = {};
	res.statusCode = 200;
	res.headersSent = false;
	res.writableEnded = false;
	res.setHeader = (k, v) => {
		headersStore[String(k).toLowerCase()] = v;
	};
	res.getHeader = (k) => headersStore[String(k).toLowerCase()];
	res.removeHeader = (k) => delete headersStore[String(k).toLowerCase()];
	res.write = () => true;
	res.end = function end(body) {
		res.writableEnded = true;
		res.headersSent = true;
		res.emit('finish');
		res.emit('close');
		return res;
	};
	return res;
}

async function runCase({ name, req: reqSpec, statusCode = 200, expectMonitored }) {
	telemetryCalls.length = 0;
	const req = makeReq(reqSpec);
	const res = makeRes();
	const monitored = instrument(req, res);

	// Simulate a handler producing a response.
	res.statusCode = statusCode;
	res.setHeader('content-type', 'application/json');
	res.end(JSON.stringify({ ok: true }));

	if (monitored) await drain();
	// Give any microtask-scheduled submission a beat to run.
	await new Promise((r) => setTimeout(r, 50));

	const emitted = telemetryCalls.length > 0;
	const pass = monitored === expectMonitored && emitted === expectMonitored;
	console.log(
		`${pass ? '✓' : '✗'} ${name}\n` +
			`    shouldMonitor=${monitored} (expected ${expectMonitored}) · ` +
			`telemetryPOSTs=${telemetryCalls.length}` +
			(telemetryCalls[0] ? ` → ${telemetryCalls[0].method} ${telemetryCalls[0].url}` : ''),
	);
	return pass;
}

console.log('— zauth runtime verification —');
const st = status();
console.log('status():', JSON.stringify(st));
const initOk = st.initialized && st.hasKey;
console.log(initOk ? '✓ middleware initialized with key' : '✗ middleware did NOT initialize');

const results = [];
// Paid call: carries an x402 payment header → monitored on ANY path.
results.push(
	await runCase({
		name: 'paid x402 service (X-PAYMENT header) on /api/x402/tutor',
		req: { url: '/api/x402/tutor', method: 'POST', headers: { 'x-payment': 'eyJ0eXAiOiJ...' } },
		statusCode: 200,
		expectMonitored: true,
	}),
);
// 402 challenge on a path the regex covers (no payment header yet).
results.push(
	await runCase({
		name: '402 challenge on /api/mcp (path-matched)',
		req: { url: '/api/mcp', method: 'POST' },
		statusCode: 402,
		expectMonitored: true,
	}),
);
// Paid x402 service WITHOUT a payment header — path-matched since the
// /api/x402/* monitor expansion (previously only header-matched).
results.push(
	await runCase({
		name: '402 challenge on /api/x402/tutor (path-matched, no header)',
		req: { url: '/api/x402/tutor', method: 'POST' },
		statusCode: 402,
		expectMonitored: true,
	}),
);
// Paid MCP variants are their own endpoints, not sub-paths of /api/mcp.
results.push(
	await runCase({
		name: '402 challenge on /api/mcp-bazaar (paid MCP variant)',
		req: { url: '/api/mcp-bazaar', method: 'POST' },
		statusCode: 402,
		expectMonitored: true,
	}),
);
results.push(
	await runCase({
		name: '402 challenge on /api/pump-fun-mcp (paid MCP variant)',
		req: { url: '/api/pump-fun-mcp', method: 'POST' },
		statusCode: 402,
		expectMonitored: true,
	}),
);
// Free x402 metadata/read endpoints must NOT pollute the registry.
results.push(
	await runCase({
		name: 'free GET /api/x402/my-receipts (must be ignored)',
		req: { url: '/api/x402/my-receipts?address=0xabc', method: 'GET' },
		statusCode: 200,
		expectMonitored: false,
	}),
);
results.push(
	await runCase({
		name: 'free GET /api/x402/did (must be ignored)',
		req: { url: '/api/x402/did', method: 'GET' },
		statusCode: 200,
		expectMonitored: false,
	}),
);
results.push(
	await runCase({
		name: 'free GET /api/x402/pay-by-name (must be ignored)',
		req: { url: '/api/x402/pay-by-name?name=%40nich', method: 'GET' },
		statusCode: 200,
		expectMonitored: false,
	}),
);
// Unrelated traffic must NOT be reported.
results.push(
	await runCase({
		name: 'unrelated GET /api/agents (must be ignored)',
		req: { url: '/api/agents?limit=10', method: 'GET' },
		statusCode: 200,
		expectMonitored: false,
	}),
);

const allPass = initOk && results.every(Boolean);
console.log(
	'\nRESULT:',
	allPass ? 'PASS ✓ — telemetry fires for monitored x402 traffic' : 'FAIL ✗',
);
process.exitCode = allPass ? 0 : 1;
