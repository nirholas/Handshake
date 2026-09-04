import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './helpers/test-server.js';

// The static media routes in vercel.json advertise
// `access-control-allow-methods: GET, HEAD, OPTIONS` so third-party sites can
// load our GLBs, animations, and the agent-3d bundle. The filesystem phase of
// server/index.mjs only serves GET/HEAD, so the OPTIONS request those headers
// invite fell through to the 404 page. A simple cross-origin GET still worked
// (no preflight is sent for one), but any fetch carrying a non-safelisted
// header preflighted, got a 404, and was blocked by the browser: the advertised
// contract and the served one disagreed.
//
// Measured 2026-09-04 against production, before the fix:
//   OPTIONS https://three.ws/avatars/cesium-man.glb -> HTTP/2 404 (with ACAO: *)

let BASE;
let server;

beforeAll(async () => {
	server = await startTestServer();
	BASE = server.base;
}, 30000);

afterAll(() => {
	server?.close();
});

const preflight = (path, headers = {}) =>
	fetch(`${BASE}${path}`, {
		method: 'OPTIONS',
		headers: {
			origin: 'https://example.org',
			'access-control-request-method': 'GET',
			...headers,
		},
		redirect: 'manual',
	});

describe('cross-origin preflight on the public media routes', () => {
	it('answers 204 with the route's own CORS headers', async () => {
		const res = await preflight('/avatars/cesium-man.glb');
		expect(res.status).toBe(204);
		expect(res.headers.get('access-control-allow-origin')).toBe('*');
		expect(res.headers.get('access-control-allow-methods')).toMatch(/OPTIONS/);
	});

	it('echoes the requested headers so a non-safelisted header passes', async () => {
		const res = await preflight('/animations/idle.glb', {
			'access-control-request-headers': 'x-trace-id',
		});
		expect(res.status).toBe(204);
		expect(res.headers.get('access-control-allow-headers')).toBe('x-trace-id');
		expect(res.headers.get('vary') || '').toMatch(/Access-Control-Request-Headers/i);
	});

	it('never lets a shared cache hold one preflight for another header set', async () => {
		const res = await preflight('/avatars/cesium-man.glb', {
			'access-control-request-headers': 'x-trace-id',
		});
		expect(res.headers.get('cache-control')).toBe('no-store');
	});

	it('leaves /api/ preflights to their own handlers', async () => {
		// api/healthz.js answers its own preflight via api/_lib/cors.js, so this
		// branch must not intercept it. The tell is the media branch's signature:
		// it always sets `cache-control: no-store` and varies on the requested
		// headers, and the handler sets neither.
		const res = await preflight('/api/healthz', { 'access-control-request-headers': 'x-trace-id' });
		expect(res.headers.get('cache-control')).not.toBe('no-store');
		expect(res.headers.get('vary') || '').not.toMatch(/Access-Control-Request-Headers/i);
	});

	it('does not turn an unrouted path into a 204', async () => {
		const res = await preflight('/definitely-not-a-real-page-xyz');
		expect(res.status).toBe(404);
	});
});
