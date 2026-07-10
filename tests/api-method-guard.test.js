import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { globSync } from 'node:fs';

// Guards a production outage class: `method(req, res, allowed)` (api/_lib/http.js)
// returns TRUE when the verb is allowed and answers 405 itself otherwise. So the
// only correct guard is `if (!method(...)) return;`.
//
// api/diorama.js shipped `if (method(req, res, ['POST'])) return;` — the negation
// dropped. That returns from the handler on exactly the allowed verb WITHOUT ever
// writing a response, so every POST /api/diorama hung until the Cloud Run request
// timeout (observed live 2026-07-10: GET → 400 in 90ms, POST → no bytes after 70s).
// It silently killed the entire Diorama feature: compose, save, export, build, and
// the Scene MCP tools that call the public endpoint.
//
// One inverted call site out of 993 was enough. These tests pin both the specific
// route and the whole class.

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

describe('method() guard is negated at every call site', () => {
	it('no api handler calls `if (method(...))` without negating it', () => {
		const files = globSync('api/**/*.js', { cwd: repoRoot });
		expect(files.length).toBeGreaterThan(100);

		const offenders = [];
		for (const rel of files) {
			const src = readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
			src.split('\n').forEach((line, i) => {
				// Match `if (method(req, res, ...)` but not `if (!method(`.
				if (/\bif\s*\(\s*method\s*\(/.test(line)) {
					offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
				}
			});
		}
		expect(offenders, `un-negated method() guard hangs every allowed request:\n${offenders.join('\n')}`).toEqual([]);
	});
});

describe('POST /api/diorama answers instead of hanging', () => {
	const PORT = 18477;
	const BASE = `http://127.0.0.1:${PORT}`;
	let server;

	beforeAll(async () => {
		server = spawn(process.execPath, ['server/index.mjs'], {
			cwd: repoRoot,
			env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test' },
			stdio: 'ignore',
		});
		const deadline = Date.now() + 20000;
		while (Date.now() < deadline) {
			try {
				const res = await fetch(`${BASE}/api/diorama`, { redirect: 'manual' });
				if (res.status > 0) return;
			} catch { /* not up yet */ }
			await new Promise((r) => setTimeout(r, 250));
		}
		throw new Error('server did not start in time');
	}, 30000);

	afterAll(() => server?.kill());

	// The unknown-action branch sits after the method guard and before any rate
	// limiter, LLM call, or DB read — so this asserts the guard alone, with no
	// Redis or provider dependency.
	it('POST with an unknown action returns 400, not a hang', async () => {
		const res = await fetch(`${BASE}/api/diorama`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ action: 'bogus' }),
			signal: AbortSignal.timeout(10000),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe('unknown_action');
	}, 15000);

	// readJson() rejects a non-object JSON payload with `bad_request` before the
	// handler's own `invalid_body` branch is reached. Either way the contract that
	// matters here is the same: a POST gets a fast, structured 400 — never a hang.
	it('POST with a non-object body returns 400', async () => {
		const res = await fetch(`${BASE}/api/diorama`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '"just a string"',
			signal: AbortSignal.timeout(10000),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe('bad_request');
	}, 15000);

	it('an unsupported verb still gets a 405 with an allow header', async () => {
		const res = await fetch(`${BASE}/api/diorama`, {
			method: 'DELETE',
			signal: AbortSignal.timeout(10000),
		});
		expect(res.status).toBe(405);
		expect(res.headers.get('allow')).toContain('POST');
	}, 15000);
});
