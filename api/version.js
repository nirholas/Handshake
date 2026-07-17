// GET /api/version
// ----------------
// Deployment traceability. Answers "which commit is live, and on which Cloud Run
// revision?" without cross-referencing revision timestamps against `git log`.
//
// Two sources, both zero-cost at request time:
//   1. dist/build-info.json — written by scripts/write-build-info.mjs at build
//      time (see build:gcp). Ships in the image via the Dockerfile `COPY . .`.
//      Carries the git commit, branch, commit/build timestamps, and version.
//   2. Cloud Run runtime env — K_REVISION / K_SERVICE / K_CONFIGURATION are set
//      by the platform on every instance, so the live revision is reported with
//      no deploy-time env injection.
//
// The build-info file is read once and cached for process lifetime (it never
// changes within a running instance). Missing file (e.g. local `vite dev`, or a
// build that skipped the stamp) degrades to nulls plus package version — the
// endpoint never fails.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { cors, json, method, wrap } from './_lib/http.js';

const STARTED_AT = Date.now();
const require = createRequire(import.meta.url);

// Read + cache build-info.json once. process.cwd() is /app in the container
// (WORKDIR), where dist/ sits alongside api/. Resolve from cwd so it works
// regardless of where this module is imported from.
let _buildInfo;
function buildInfo() {
	if (_buildInfo !== undefined) return _buildInfo;
	try {
		_buildInfo = JSON.parse(
			readFileSync(resolve(process.cwd(), 'dist/build-info.json'), 'utf8'),
		);
	} catch {
		// No stamp: fall back to package version so `version` is still meaningful.
		let version = 'unknown';
		try {
			version = require('../package.json').version || 'unknown';
		} catch {
			/* package.json unreadable — leave as unknown */
		}
		_buildInfo = {
			version,
			commit: process.env.VERCEL_GIT_COMMIT_SHA || 'unknown',
			commitShort: (process.env.VERCEL_GIT_COMMIT_SHA || 'unknown').slice(0, 9),
			commitTime: null,
			commitSubject: null,
			branch: process.env.VERCEL_GIT_COMMIT_REF || 'unknown',
			dirty: false,
			builtAt: null,
			node: process.version,
			stamped: false,
		};
		return _buildInfo;
	}
	_buildInfo.stamped = true;
	return _buildInfo;
}

// Exported for tests so each case starts with a cold cache.
export function _resetBuildInfoCache() {
	_buildInfo = undefined;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const build = buildInfo();
	const now = Date.now();

	return json(
		res,
		200,
		{
			status: 'ok',
			// What commit is live.
			version: build.version,
			commit: build.commit,
			commitShort: build.commitShort,
			commitSubject: build.commitSubject,
			commitTime: build.commitTime,
			branch: build.branch,
			dirty: build.dirty,
			builtAt: build.builtAt,
			// Whether the running image carries a real build stamp (false = the
			// deploy skipped write-build-info; commit fields are best-effort).
			stamped: build.stamped !== false,
			// Where it is running. K_* are set by Cloud Run; null off-platform.
			runtime: {
				service: process.env.K_SERVICE || null,
				revision: process.env.K_REVISION || null,
				configuration: process.env.K_CONFIGURATION || null,
				region: process.env.CLOUD_RUN_REGION || process.env.FUNCTION_REGION || null,
				node: build.node || process.version,
				uptimeMs: now - STARTED_AT,
			},
		},
		// Short cache: dashboards and deploy-verification scripts poll this, but a
		// new revision must show up promptly.
		{ 'cache-control': 'public, max-age=10, s-maxage=10' },
	);
});
