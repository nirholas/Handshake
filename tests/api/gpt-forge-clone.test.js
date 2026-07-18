// The ChatGPT-dedicated forge pipeline clone — isolation contract.
//
// /api/gpt-forge (api/gpt-forge.js) is an exact clone of /api/forge created so
// the ChatGPT surfaces (the Apps SDK MCP connector and the custom-GPT Actions
// endpoint) can be improved independently without touching the forge pipeline
// or any surface that rides it. These tests pin the wiring both ways:
//
//   1. The clone client (gpt-forge-client.js) talks ONLY to /api/gpt-forge.
//   2. The ChatGPT surfaces import the clone client; the agent surfaces keep
//      the original. Neither side silently re-couples to the other.
//   3. The two clients expose an identical public API, so tools written
//      against one work against the other.
//   4. The cloned orchestrator actually serves: its public catalog is the
//      SAME contract /api/forge serves (both read api/_lib/forge-tiers.js).
//
// Deliberately NOT pinned: byte-parity between api/forge.js and
// api/gpt-forge.js. The clone exists to diverge; the moment it does, parity
// would be a false failure. What must never drift is the wiring above.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

beforeAll(() => {
	Object.assign(process.env, {
		APP_ORIGIN: 'https://three.ws',
		JWT_SECRET: 'test-jwt-secret-at-least-32-characters-long',
	});
});

describe('gpt-forge-client — endpoint isolation', () => {
	it('every fetch targets /api/gpt-forge, never /api/forge', () => {
		const src = read('api/_mcp-studio/gpt-forge-client.js');
		const fetches = src.match(/fetch\(`[^`]+`/g) || [];
		expect(fetches.length).toBeGreaterThanOrEqual(3); // submit, rig, poll
		for (const f of fetches) {
			expect(f).toContain('/api/gpt-forge');
			expect(f).not.toMatch(/\/api\/forge[?`]/);
		}
	});

	it('exposes the exact same public API as forge-client', async () => {
		const orig = await import('../../api/_mcp-studio/forge-client.js');
		const clone = await import('../../api/_mcp-studio/gpt-forge-client.js');
		expect(Object.keys(clone).sort()).toEqual(Object.keys(orig).sort());
	});
});

describe('surface wiring — ChatGPT on the clone, agents on the original', () => {
	const CHATGPT_SURFACES = ['api/_mcp-studio/tools.js', 'api/3d/studio.js'];
	const AGENT_SURFACES = ['api/3d/generate.js', 'api/v1/ai/text-to-3d.js'];

	it.each(CHATGPT_SURFACES)('%s imports gpt-forge-client', (file) => {
		const src = read(file);
		expect(src).toMatch(/from '[^']*gpt-forge-client\.js'/);
		expect(src).not.toMatch(/from '[^']*\/forge-client\.js'/);
	});

	it.each(AGENT_SURFACES)('%s stays on the original forge-client', (file) => {
		const src = read(file);
		expect(src).toMatch(/from '[^']*_mcp-studio\/forge-client\.js'/);
		expect(src).not.toMatch(/gpt-forge-client/);
	});
});

describe('/api/gpt-forge — the cloned orchestrator serves', () => {
	function makeReq(url) {
		return { method: 'GET', url, headers: {} };
	}
	function makeRes() {
		const res = {
			statusCode: 0,
			headers: {},
			body: null,
			setHeader(k, v) {
				this.headers[k.toLowerCase()] = v;
			},
			end(payload) {
				this.body = payload ? JSON.parse(payload) : null;
				this.done = true;
			},
		};
		res.writeHead = (code) => {
			res.statusCode = code;
			return res;
		};
		return res;
	}

	it('answers ?catalog with the same tier/backend contract as /api/forge', async () => {
		const { default: forge } = await import('../../api/forge.js');
		const { default: gptForge } = await import('../../api/gpt-forge.js');

		const a = makeRes();
		await forge(makeReq('/api/forge?catalog=1'), a);
		const b = makeRes();
		await gptForge(makeReq('/api/gpt-forge?catalog=1'), b);

		expect(b.statusCode).toBe(a.statusCode);
		expect(a.statusCode).toBe(200);
		expect(b.body).toEqual(a.body);
		expect(Array.isArray(b.body.backends)).toBe(true);
		expect(b.body.tiers.map((t) => t.id)).toEqual(['draft', 'standard', 'high']);
	});
});
