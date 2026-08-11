/**
 * services/agent-screen-caster core-path smoke test.
 *
 * Runs the real service against a real browser: Playwright Chromium drives a
 * page served by a local HTTP server, and that same server stands in for
 * /api/agent-screen-push so every byte the caster emits can be inspected.
 * Nothing in the caster is stubbed, and the frames asserted here are genuine
 * JPEGs captured from a genuine render.
 *
 * What this pins:
 *   1. navigate()/act() push an activity record BEFORE the work and a frame
 *      after it, so a watcher sees the narration and the result in that order.
 *   2. Every push carries the agentId and the bearer token. A frame without the
 *      agent id is rejected by the endpoint with 400 missing_agent_id, which is
 *      how a caster goes silently dark while looking healthy in its own logs.
 *   3. Frames are real JPEG data URLs (the endpoint drops anything that is not
 *      a base64 raster image down to text-only).
 *   4. The frame loop keeps capturing on its interval and stops on demand.
 *   5. An activity push survives a transient 503, and a 4xx is not retried.
 *      The caster is a long-running process: dying on one blip loses a session.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer } from 'node:http';
import { AgentScreenCaster, isRetryableStatus } from '../services/agent-screen-caster/caster.js';

const AGENT_ID = '11111111-2222-3333-4444-555555555555';
const BEARER = 'sk_live_test_caster_token';

const PAGE_HTML = `<!doctype html><html><head><title>Caster test page</title></head>
<body style="background:#101014;color:#eaeaf0;font:16px system-ui">
<h1 id="headline">Live agent screen</h1><p id="price">$0.0421</p></body></html>`;

let server;
let baseUrl;
/** Every push the stand-in endpoint received, in order. */
let received;
/** Statuses the push endpoint answers with, drained FIFO; 200 once empty. */
let statusQueue;

beforeAll(async () => {
	server = createServer((req, res) => {
		if (req.url === '/page') {
			res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
			res.end(PAGE_HTML);
			return;
		}

		if (req.url === '/api/agent-screen-push' && req.method === 'POST') {
			let body = '';
			req.on('data', (c) => { body += c; });
			req.on('end', () => {
				const status = statusQueue.length ? statusQueue.shift() : 200;
				let parsed = null;
				try { parsed = JSON.parse(body); } catch { /* recorded as null */ }
				received.push({ status, auth: req.headers.authorization, body: parsed });
				if (status !== 200) {
					res.writeHead(status, { 'content-type': 'application/json' });
					res.end(JSON.stringify({ error: 'transient' }));
					return;
				}
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ ok: true, ts: Date.now() }));
			});
			return;
		}

		res.writeHead(404);
		res.end();
	});

	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
	await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
	received = [];
	statusQueue = [];
});

const pushUrl = () => `${baseUrl}/api/agent-screen-push`;
const frames = () => received.filter((r) => r.body?.frame?.data);
const activities = () => received.filter((r) => r.body?.frame?.activity);

describe('AgentScreenCaster constructor', () => {
	it('refuses to run without an identity to push as', () => {
		expect(() => new AgentScreenCaster({ bearerToken: BEARER })).toThrow(/agentId/);
		expect(() => new AgentScreenCaster({ agentId: AGENT_ID })).toThrow(/bearerToken/);
	});
});

describe('isRetryableStatus', () => {
	it('retries a rate limit and a server error, never a client error', () => {
		expect(isRetryableStatus(429)).toBe(true);
		expect(isRetryableStatus(500)).toBe(true);
		expect(isRetryableStatus(503)).toBe(true);
		expect(isRetryableStatus(400)).toBe(false);
		expect(isRetryableStatus(401)).toBe(false);
		expect(isRetryableStatus(403)).toBe(false);
		expect(isRetryableStatus(200)).toBe(false);
	});
});

describe('push transport', () => {
	it('retries an activity push through a transient 503 and reports the summary once', async () => {
		const caster = new AgentScreenCaster({ agentId: AGENT_ID, bearerToken: BEARER, pushUrl: pushUrl() });
		statusQueue = [503];

		await caster.pushActivity([{ type: 'analysis', summary: 'Reading the board', ts: Date.now() }]);

		expect(received).toHaveLength(2);
		expect(received[0].status).toBe(503);
		expect(received[1].status).toBe(200);
		expect(received[1].body.frame.activity).toBe('Reading the board');
		expect(received[1].body.agentId).toBe(AGENT_ID);
	});

	it('gives up immediately on a 401 rather than hammering a dead credential', async () => {
		const caster = new AgentScreenCaster({ agentId: AGENT_ID, bearerToken: 'stale', pushUrl: pushUrl() });
		statusQueue = [401, 401, 401];

		await expect(
			caster.pushActivity([{ type: 'activity', summary: 'Waking up', ts: Date.now() }]),
		).rejects.toThrow(/screen-push 401/);

		expect(received).toHaveLength(1);
	});

	it('skips an entry with no summary instead of pushing a blank line', async () => {
		const caster = new AgentScreenCaster({ agentId: AGENT_ID, bearerToken: BEARER, pushUrl: pushUrl() });

		await caster.pushActivity([{ type: 'activity', summary: '' }, null, { type: 'activity' }]);

		expect(received).toHaveLength(0);
	});
});

describe('live browser core path', () => {
	let caster;

	afterAll(async () => {
		await caster?.close();
	});

	it('navigates, acts, and streams real JPEG frames to the push endpoint', async () => {
		caster = new AgentScreenCaster({
			agentId: AGENT_ID,
			bearerToken: BEARER,
			pushUrl: pushUrl(),
			frameIntervalMs: 250,
			jpegQuality: 50,
		});

		await caster.launch(true);
		await caster.navigate(`${baseUrl}/page`);

		// The page really rendered: the caster's own browser handle reads it back.
		expect(await caster.page.title()).toBe('Caster test page');

		// navigate() narrates first, then captures.
		const navActivity = activities()[0];
		expect(navActivity.body.frame.activity).toContain('/page');
		expect(navActivity.body.frame.type).toBe('navigate');
		expect(navActivity.auth).toBe(`Bearer ${BEARER}`);
		expect(frames().length).toBeGreaterThan(0);

		// Frames are genuine JPEGs, not an empty or malformed data URL.
		const jpeg = frames()[0].body.frame;
		expect(jpeg.type).toBe('screenshot');
		expect(jpeg.data.startsWith('data:image/jpeg;base64,')).toBe(true);
		const bytes = Buffer.from(jpeg.data.split(',')[1], 'base64');
		expect(bytes.length).toBeGreaterThan(1000);
		expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xff, 0xd8, 0xff]);

		// act() wraps a real page interaction between its narration and its frame.
		const beforeAct = received.length;
		await caster.act('analysis', 'Reading the headline', async () => {
			await caster.page.waitForSelector('#headline');
		});
		const actPushes = received.slice(beforeAct);
		expect(actPushes[0].body.frame.activity).toBe('Reading the headline');
		expect(actPushes[0].body.frame.type).toBe('analysis');
		expect(actPushes[actPushes.length - 1].body.frame.data).toContain('data:image/jpeg;base64,');

		// The frame loop keeps the stream alive on its own interval, and stops.
		const beforeLoop = frames().length;
		caster.startFrameLoop();
		await new Promise((r) => setTimeout(r, 1200));
		expect(frames().length).toBeGreaterThan(beforeLoop);

		// After stopping, let the capture already in flight land, then confirm the
		// count holds: no timer is still firing behind it.
		caster.stopFrameLoop();
		await new Promise((r) => setTimeout(r, 700));
		const settled = frames().length;
		await new Promise((r) => setTimeout(r, 700));
		expect(frames().length).toBe(settled);

		// Every push in the whole run identified the agent and carried the token.
		for (const r of received) {
			expect(r.body.agentId).toBe(AGENT_ID);
			expect(r.auth).toBe(`Bearer ${BEARER}`);
		}
	});

	it('shuts down without a failed capture racing the closing browser', async () => {
		caster.startFrameLoop();
		const errors = [];
		const realError = console.error;
		console.error = (...args) => { errors.push(args.join(' ')); };
		try {
			await caster.close();
			await new Promise((r) => setTimeout(r, 500));
		} finally {
			console.error = realError;
		}
		expect(errors.filter((e) => e.includes('frame push failed'))).toHaveLength(0);
		expect(caster.page).toBeNull();
	});
});
