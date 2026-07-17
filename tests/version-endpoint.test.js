/**
 * /api/version + build-info stamp — unit tests.
 *
 * The endpoint is deploy-traceability infrastructure: it must (a) always answer
 * 200 with a well-formed shape even when the build stamp is absent, (b) reflect
 * the live Cloud Run revision from the platform K_* env vars, and (c) the
 * generator must emit a valid, parseable stamp. These guard the "which commit is
 * live?" answer that the manual deploy runbook now depends on.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import handler, { _resetBuildInfoCache } from '../api/version.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fakeReq(method = 'GET') {
	return { method, headers: {}, url: '/api/version' };
}

function fakeRes() {
	const headers = {};
	return {
		statusCode: 0,
		body: undefined,
		ended: false,
		setHeader(k, v) {
			headers[String(k).toLowerCase()] = v;
		},
		getHeader(k) {
			return headers[String(k).toLowerCase()];
		},
		end(b) {
			this.body = b;
			this.ended = true;
		},
		_headers: headers,
	};
}

async function call() {
	const res = fakeRes();
	await handler(fakeReq('GET'), res);
	return { res, json: res.body ? JSON.parse(res.body) : undefined };
}

describe('GET /api/version', () => {
	let savedRevision, savedService;
	beforeEach(() => {
		_resetBuildInfoCache();
		savedRevision = process.env.K_REVISION;
		savedService = process.env.K_SERVICE;
	});
	afterEach(() => {
		if (savedRevision === undefined) delete process.env.K_REVISION;
		else process.env.K_REVISION = savedRevision;
		if (savedService === undefined) delete process.env.K_SERVICE;
		else process.env.K_SERVICE = savedService;
		_resetBuildInfoCache();
	});

	it('returns 200 JSON with the traceability shape', async () => {
		const { res, json } = await call();
		expect(res.statusCode).toBe(200);
		expect(res.getHeader('content-type')).toMatch(/application\/json/);
		expect(json.status).toBe('ok');
		expect(typeof json.version).toBe('string');
		expect(typeof json.commitShort).toBe('string');
		expect(typeof json.stamped).toBe('boolean');
		expect(json.runtime).toBeTruthy();
		expect(typeof json.runtime.uptimeMs).toBe('number');
	});

	it('is cacheable but short-lived so a new revision shows up fast', async () => {
		const { res } = await call();
		expect(res.getHeader('cache-control')).toMatch(/max-age=10/);
	});

	it('reflects the live Cloud Run revision from platform env', async () => {
		process.env.K_SERVICE = 'three-ws-api';
		process.env.K_REVISION = 'three-ws-api-99999-test';
		const { json } = await call();
		expect(json.runtime.service).toBe('three-ws-api');
		expect(json.runtime.revision).toBe('three-ws-api-99999-test');
	});

	it('reports null runtime revision off-platform (no K_* set)', async () => {
		delete process.env.K_REVISION;
		delete process.env.K_SERVICE;
		const { json } = await call();
		expect(json.runtime.revision).toBeNull();
		expect(json.runtime.service).toBeNull();
	});
});

describe('write-build-info.mjs generator', () => {
	it('emits a valid, parseable build-info.json', () => {
		execSync('node scripts/write-build-info.mjs', { cwd: ROOT, stdio: 'ignore' });
		const p = resolve(ROOT, 'dist/build-info.json');
		expect(existsSync(p)).toBe(true);
		const info = JSON.parse(readFileSync(p, 'utf8'));

		// version mirrors package.json
		const pkgVersion = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).version;
		expect(info.version).toBe(pkgVersion);

		// commit is a full 40-char sha (this is a git repo) or the explicit fallback
		expect(info.commit === 'unknown' || /^[0-9a-f]{40}$/.test(info.commit)).toBe(true);
		expect(info.commitShort).toBe(
			info.commit === 'unknown' ? 'unknown' : info.commit.slice(0, 9),
		);

		// builtAt round-trips as ISO 8601
		expect(new Date(info.builtAt).toISOString()).toBe(info.builtAt);
		expect(typeof info.dirty).toBe('boolean');
	});

	it('trusts a pre-build snapshot for the dirty flag, then consumes it', () => {
		// The build mutates tracked files, so a live dirty read at stamp time is
		// meaningless. build:gcp records the pre-build truth via --snapshot; the
		// final stamp must honor that snapshot even though the tree is now dirty.
		const gitDir = execSync('git rev-parse --absolute-git-dir', { cwd: ROOT })
			.toString()
			.trim();
		const sidecar = resolve(gitDir, 'three-ws-build-dirty');
		writeFileSync(sidecar, '0'); // pretend the tree was clean pre-build
		try {
			execSync('node scripts/write-build-info.mjs', { cwd: ROOT, stdio: 'ignore' });
			const info = JSON.parse(readFileSync(resolve(ROOT, 'dist/build-info.json'), 'utf8'));
			expect(info.dirty).toBe(false); // honored the snapshot, not the live (dirty) tree
			expect(existsSync(sidecar)).toBe(false); // consumed so it can't leak into a later build
		} finally {
			if (existsSync(sidecar)) rmSync(sidecar, { force: true });
		}
	});
});
