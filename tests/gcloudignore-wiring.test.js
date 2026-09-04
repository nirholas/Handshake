// Guards the deploy-context check that the 2026-09-04 healthz outage exposed.
//
// `.gcloudignore` is an allowlist: everything is excluded and specific paths are
// re-included. It never re-included `services/`, so `services/home-relay/src/token.js`
// was absent from the image while `api/_lib/home/relay.js` imported it at module
// load. Revision 00412 answered `/api/healthz`, `/api/wk`, `/api/x402-pay` and every
// `/api/home/*` route with ERR_MODULE_NOT_FOUND on every request, and no build step
// was red: a missing re-include is not a build error, it is a runtime one.
//
// `scripts/check-gcloudignore.mjs` was written to catch exactly that, but it was
// wired into no npm script, so nothing ran it and the omission shipped anyway. These
// tests pin the wiring as well as the rules: an unwired guard is not a guard.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scripts = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;

describe('gcloudignore build-context guard', () => {
	it('is wired into deploy:gcp:submit ahead of the upload', () => {
		const submit = scripts['deploy:gcp:submit'] ?? '';
		expect(submit).toContain('npm run check:gcloudignore');
		expect(submit.indexOf('check:gcloudignore')).toBeLessThan(submit.indexOf('gcloud builds submit'));
	});

	it('is wired into the repo gate', () => {
		expect(scripts.gate ?? '').toContain('npm run check:gcloudignore');
	});

	it('passes against the committed .gcloudignore', () => {
		const run = () =>
			execFileSync('node', ['scripts/check-gcloudignore.mjs'], {
				cwd: ROOT,
				encoding: 'utf8',
				timeout: 120_000,
			});
		expect(run).not.toThrow();
	});

	it('keeps the runtime-imported service modules present and required', () => {
		const guard = readFileSync(path.join(ROOT, 'scripts/check-gcloudignore.mjs'), 'utf8');
		for (const rel of ['services/home-relay/src/token.js', 'services/home-satellite/src/token.js']) {
			expect(existsSync(path.join(ROOT, rel))).toBe(true);
			expect(guard).toContain(rel);
		}
	});
});
