// Boot the real server on a port claimed at run time.
//
// Several suites spawn `server/index.mjs` and probe it over HTTP. They used to
// hardcode a port each, which broke two ways: two suites picked the SAME port
// (18453 was used by both server-api-traversal and x402-probe-challenge, so any
// full-suite run raced them), and any second concurrent vitest run in the same
// worktree collided with the first. Both surface as `SocketError: other side
// closed` on a varying subset of tests — a failure that reads like a product
// bug and moves between runs.
//
// Claiming the port from the OS removes the class entirely.

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/** An OS-assigned free TCP port, released immediately before the caller reuses it. */
export function freePort() {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.on('error', reject);
		probe.listen(0, '127.0.0.1', () => {
			const { port } = probe.address();
			probe.close((err) => (err ? reject(err) : resolve(port)));
		});
	});
}

/**
 * Spawn server/index.mjs on a free port and resolve once it answers /api/healthz.
 *
 * @param {object} [opts]
 * @param {Record<string,string>} [opts.env] extra env for the child (merged over process.env)
 * @param {number} [opts.timeoutMs] how long to wait for readiness
 * @returns {Promise<{ base: string, port: number, close: () => void }>}
 *   `base` is the origin to fetch against; call `close()` in afterAll.
 *
 * The readiness budget is deliberately far above the ~1.5s the server needs on
 * an idle machine: a full `vitest run` puts a worker on every core, so the boot
 * that takes a second alone can take tens of seconds while 1400 other suites
 * compete for the same CPU. A budget sized for the idle case turns that
 * contention into a red suite that passes the moment it is run on its own.
 */
export async function startTestServer({ env = {}, timeoutMs = 60_000 } = {}) {
	const startedAt = Date.now();
	const port = await freePort();
	const base = `http://127.0.0.1:${port}`;
	const child = spawn(process.execPath, ['server/index.mjs'], {
		cwd: repoRoot,
		env: { ...process.env, PORT: String(port), NODE_ENV: 'test', ...env },
		stdio: 'ignore',
	});

	// A crashed child never becomes reachable. Capturing its exit lets readiness
	// fail with the actual status instead of burning the whole timeout on a
	// vague "did not start".
	let exited = null;
	child.on('exit', (code, signal) => {
		exited = signal ? `signal ${signal}` : `code ${code}`;
	});

	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (exited !== null) throw new Error(`server exited before becoming ready (${exited})`);
		try {
			const res = await fetch(`${base}/api/healthz`);
			if (res.status > 0) break;
		} catch { /* not up yet */ }
		if (Date.now() >= deadline) {
			throw new Error(
				`server did not answer /api/healthz within ${Date.now() - startedAt}ms (${base}); `
				+ 'the process was still alive, so this is a slow boot, not a crash',
			);
		}
		await new Promise((r) => setTimeout(r, 250));
	}

	return { base, port, close: () => child.kill('SIGKILL') };
}
