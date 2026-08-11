/**
 * agent-screen-worker core-path smoke test.
 *
 * Exercises the worker's real transport end to end: a local HTTP server stands
 * in for /api/agent-screen-push and /api/agent-task, and the worker's own
 * capture.js + task-runner.js run against it over real fetch. Nothing in the
 * worker is stubbed. Only the browser handle is a double, so the test can run
 * without launching Chrome.
 *
 * What this pins (each line is a bug this worker actually shipped):
 *   1. Every pushed frame carries the agent id. task-runner.js read `cfg.agentId`
 *      while config.js exports `AGENT_ID`, so every frame went out with
 *      `agentId: undefined` and the push endpoint rejected all of them with 400
 *      missing_agent_id. The startup frame from index.js was the only one that
 *      ever landed.
 *   2. act()/extract() are called on the Stagehand instance with the page passed
 *      as an option. Stagehand v3 moved them off the page object, so the old
 *      `page.act(...)` calls threw on every interactive step.
 *   3. A failing task poll is reported, not swallowed. The GET side of
 *      /api/agent-task was querying a table that does not exist; the worker
 *      silently treated the 500 as "no task queued" and idled forever.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer } from 'node:http';
import { pushFrame } from '../workers/agent-screen-worker/capture.js';
import {
	pollForTask,
	runQueuedTask,
	runAutonomousCycle,
	pickStartUrl,
	breakTaskIntoSteps,
} from '../workers/agent-screen-worker/task-runner.js';

const AGENT_ID = '11111111-2222-3333-4444-555555555555';
const AGENT_JWT = 'test-agent-bearer-token';

// A 1x1 PNG. The worker base64-encodes whatever the browser hands back, so a
// real (tiny) PNG keeps the data-URL assertion honest.
const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
	'base64',
);

let server;
let baseUrl;
/** Frames the stand-in push endpoint received, in order. */
let received;
/** Tasks the stand-in task endpoint hands out, drained FIFO. */
let taskQueue;
/** Status the task endpoint should answer with (to simulate a broken endpoint). */
let taskStatus;

beforeAll(async () => {
	server = createServer((req, res) => {
		const url = new URL(req.url, 'http://localhost');

		if (url.pathname === '/api/agent-task') {
			if (taskStatus !== 200) {
				res.writeHead(taskStatus, { 'content-type': 'application/json' });
				return res.end(JSON.stringify({ error: 'server_error' }));
			}
			res.writeHead(200, { 'content-type': 'application/json' });
			return res.end(JSON.stringify({ task: taskQueue.shift() || null }));
		}

		if (url.pathname === '/api/agent-screen-push') {
			let raw = '';
			req.on('data', (c) => { raw += c; });
			return req.on('end', () => {
				const body = JSON.parse(raw);
				// Mirror the real endpoint's contract: agentId is mandatory.
				if (!body.agentId || typeof body.agentId !== 'string') {
					res.writeHead(400, { 'content-type': 'application/json' });
					return res.end(JSON.stringify({ error: 'missing_agent_id' }));
				}
				received.push({ ...body, authorization: req.headers.authorization });
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ ok: true }));
			});
		}

		res.writeHead(404);
		res.end();
	});

	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => {
	received = [];
	taskQueue = [];
	taskStatus = 200;
});

function makeCfg(overrides = {}) {
	return {
		AGENT_ID,
		AGENT_JWT,
		PUSH_URL: `${baseUrl}/api/agent-screen-push`,
		TASK_URL: `${baseUrl}/api/agent-task`,
		HOME_URL: 'https://three.ws',
		// 0 disables screenshot throttling so every frame in a short test carries
		// an image, instead of the module-level throttle silently downgrading it.
		SCREENSHOT_INTERVAL_MS: 0,
		CYCLE_MS: 1,
		...overrides,
	};
}

// The push() binding index.js hands the runner.
function makePush(cfg) {
	return ({ agentId, page, activity, type }) =>
		pushFrame({
			agentId,
			page,
			activity,
			type,
			pushUrl: cfg.PUSH_URL,
			agentJwt: cfg.AGENT_JWT,
			screenshotIntervalMs: cfg.SCREENSHOT_INTERVAL_MS,
		});
}

// Stand-in for the Stagehand v3 page handle (stagehand.context.activePage()).
function makePage(startUrl = 'https://three.ws/') {
	let current = startUrl;
	const calls = { goto: [], screenshot: 0 };
	return {
		calls,
		url: () => current,
		async goto(target) { calls.goto.push(target); current = target; },
		async screenshot() { calls.screenshot += 1; return PNG; },
	};
}

describe('pushFrame transport', () => {
	it('sends the agent id, the bearer token and a raster data URL', async () => {
		const cfg = makeCfg();
		const page = makePage();
		await makePush(cfg)({ agentId: cfg.AGENT_ID, page, activity: 'hello', type: 'screenshot' });

		expect(received).toHaveLength(1);
		expect(received[0].agentId).toBe(AGENT_ID);
		expect(received[0].authorization).toBe(`Bearer ${AGENT_JWT}`);
		expect(received[0].frame.activity).toBe('hello');
		expect(received[0].frame.data).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/);
	});

	it('degrades to a text-only frame when there is no page handle', async () => {
		const cfg = makeCfg();
		await makePush(cfg)({ agentId: cfg.AGENT_ID, page: null, activity: 'no browser', type: 'screenshot' });

		expect(received).toHaveLength(1);
		expect(received[0].frame.data).toBeNull();
	});
});

describe('idle cycle', () => {
	it('pushes a standing-by frame that carries the agent id', async () => {
		const cfg = makeCfg();
		const page = makePage();
		await runAutonomousCycle({ page, cfg, push: makePush(cfg) });

		expect(received.length).toBeGreaterThan(0);
		for (const frame of received) expect(frame.agentId).toBe(AGENT_ID);
		const last = received.at(-1);
		expect(last.frame.activity).toMatch(/standing by/i);
		expect(last.frame.data).toMatch(/^data:image\/png;base64,/);
	});

	it('navigates home only when the browser has drifted off it', async () => {
		const cfg = makeCfg();
		const onHome = makePage('https://three.ws/create');
		await runAutonomousCycle({ page: onHome, cfg, push: makePush(cfg) });
		expect(onHome.calls.goto).toEqual([]);

		const drifted = makePage('https://news.ycombinator.com/');
		await runAutonomousCycle({ page: drifted, cfg, push: makePush(cfg) });
		expect(drifted.calls.goto).toEqual(['https://three.ws']);
	});
});

describe('task polling', () => {
	it('returns the queued task the platform hands back', async () => {
		taskQueue = [{ text: 'find the weather in Bucharest', type: 'research', ts: 1 }];
		const task = await pollForTask(makeCfg());
		expect(task.text).toBe('find the weather in Bucharest');
	});

	it('returns null on an empty queue and on a failing endpoint', async () => {
		expect(await pollForTask(makeCfg())).toBeNull();
		taskStatus = 500;
		expect(await pollForTask(makeCfg())).toBeNull();
	});
});

describe('queued task execution', () => {
	it('runs a research task end to end with every frame carrying the agent id', async () => {
		const cfg = makeCfg();
		const page = makePage();
		const actCalls = [];
		const extractCalls = [];
		const stagehand = {
			async act(instruction, options) { actCalls.push({ instruction, options }); return { success: true }; },
			async extract(instruction, schema, options) {
				extractCalls.push({ instruction, schema, options });
				return { result: 'Bucharest is 19C and clear.' };
			},
		};

		await runQueuedTask({
			stagehand,
			page,
			cfg,
			push: makePush(cfg),
			task: { text: 'what is the weather in Bucharest', type: 'research', ts: 1 },
		});

		// Every frame reached the endpoint, which means none was rejected for a
		// missing agent id.
		expect(received.length).toBeGreaterThan(3);
		for (const frame of received) expect(frame.agentId).toBe(AGENT_ID);

		// Navigation used the routed start URL for a weather task.
		expect(page.calls.goto).toEqual(['https://weather.com']);

		// extract() ran on the Stagehand instance with the page passed through,
		// and its result was narrated into the stream.
		expect(extractCalls).toHaveLength(1);
		expect(extractCalls[0].options.page).toBe(page);
		expect(received.some((f) => f.frame.activity.includes('Bucharest is 19C'))).toBe(true);

		// A research task observes and extracts; it does not click anything.
		expect(actCalls).toHaveLength(0);

		const last = received.at(-1);
		expect(last.frame.activity).toMatch(/^Task complete:/);
	}, 30_000);

	it('drives act() through the Stagehand instance for an interactive task', async () => {
		const cfg = makeCfg();
		const page = makePage();
		const actCalls = [];
		const stagehand = {
			async act(instruction, options) { actCalls.push({ instruction, options }); return { success: true }; },
			async extract() { return { result: 'done' }; },
		};

		await runQueuedTask({
			stagehand,
			page,
			cfg,
			push: makePush(cfg),
			task: { text: 'search reddit for three.ws', type: 'browse', ts: 1 },
		});

		expect(actCalls).toHaveLength(1);
		expect(actCalls[0].instruction).toBe('search reddit for three.ws');
		expect(actCalls[0].options.page).toBe(page);
		for (const frame of received) expect(frame.agentId).toBe(AGENT_ID);
	}, 30_000);

	it('narrates a step failure instead of aborting the task', async () => {
		const cfg = makeCfg();
		const page = makePage();
		const stagehand = {
			async act() { throw new Error('element not found'); },
			async extract() { return { result: 'recovered' }; },
		};

		await runQueuedTask({
			stagehand,
			page,
			cfg,
			push: makePush(cfg),
			task: { text: 'buy a lamp', type: 'browse', ts: 1 },
		});

		expect(received.some((f) => f.frame.activity === 'Step failed: element not found')).toBe(true);
		expect(received.at(-1).frame.activity).toMatch(/^Task complete:/);
	}, 30_000);
});

describe('task routing helpers', () => {
	it('routes a task to a topical start page and falls back to search', () => {
		expect(pickStartUrl('check the weather')).toBe('https://weather.com');
		expect(pickStartUrl('browse reddit')).toBe('https://www.reddit.com');
		expect(pickStartUrl('quantum computing explainer')).toBe(
			'https://www.google.com/search?q=quantum%20computing%20explainer',
		);
	});

	it('gives research tasks a read-only plan and other tasks an interactive one', () => {
		expect(breakTaskIntoSteps('x', 'research').map((s) => s.action)).toEqual(['observe', 'extract']);
		expect(breakTaskIntoSteps('x', 'browse').map((s) => s.action)).toEqual(['observe', 'act', 'extract']);
	});
});
