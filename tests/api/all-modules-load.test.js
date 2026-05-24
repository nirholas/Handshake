// Smoke test: every api routed-handler module must import cleanly.
//
// Catches broken import paths, wrong-stack imports, and placeholder code that
// throws on module init. If this fails on a file that is intentionally a stub,
// fix the stub or add it to SKIP_MODULES below with a clear reason.
import { describe, it, expect } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const API_DIR = join(process.cwd(), 'api');

// Files we know fail because they load env-gated infrastructure not present in the
// test sandbox (DB, RPC, keypair files). Add only with a clear reason; never to
// hide a real bug.
const SKIP_MODULES = new Set([
	// @nirholas/pump-sdk has an ESM exports map that vite's import-analysis
	// stage cannot resolve (works fine in plain node + vercel runtime).
	// Verified: `node -e "import('./api/pump/curve.js')"` succeeds.
	'api/pump/curve.js',
	'api/pump/quote-sdk.js',
]);

function* walk(dir) {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		const st = statSync(path);
		if (st.isDirectory()) {
			// Skip _lib, _id (helpers), and node_modules — those are imported by routed handlers,
			// so they get exercised transitively. We only enumerate routed surfaces here.
			if (name === '_lib' || name === '_id' || name === 'node_modules') continue;
			yield* walk(path);
		} else if (st.isFile() && name.endsWith('.js')) {
			yield path;
		}
	}
}

const files = [...walk(API_DIR)]
	.map((p) => relative(process.cwd(), p))
	.filter((rel) => !SKIP_MODULES.has(rel))
	.sort();

// Some handlers transitively load heavy ESM SDKs (@coinbase/x402, jsdom, the
// neon serverless client, etc.). On slow CI workers the cold-import alone can
// exceed vitest's default 5s. We give each load 30s — still well under a real
// hang, but generous enough to absorb a Codespace cache miss.
describe('every api/**/*.js handler loads', () => {
	for (const rel of files) {
		it(
			rel,
			async () => {
				const url = pathToFileURL(join(process.cwd(), rel)).href;
				const mod = await import(url);
				expect(mod).toBeTruthy();
				// Most Vercel handlers export `default`; some export named handlers (e.g. cron jobs).
				// We don't enforce shape — only that the module evaluates without throwing.
			},
			30_000,
		);
	}
});
