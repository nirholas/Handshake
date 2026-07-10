/**
 * Repo-wide grep-blindness guard.
 *
 * A literal NUL byte makes grep/ripgrep classify a text file as binary and
 * silently skip every match inside it — the file becomes invisible to the tools
 * every agent and engineer uses to navigate this codebase. It has bitten us
 * twice: once in `api/_lib/rate-limit.js` (fixed in 72f056e65) and once in
 * `src/oracle.js`, where a NUL was used as a map-key separator and hid all 2,405
 * lines from search.
 *
 * A NUL separator is a perfectly reasonable thing to want. Writing it as the
 * `\u0000` escape produces the identical runtime string while keeping the source
 * greppable, so there is never a reason to embed the raw byte.
 *
 * The existing check in tests/api/rate-limit-buckets.test.js covers exactly one
 * file. This one covers every tracked source file, so the next occurrence fails
 * the build instead of quietly degrading the tooling.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));

// Source trees an engineer greps. Build output (dist/), vendored third-party
// bundles, and genuinely binary assets are out of scope.
const TRACKED_GLOBS = [
	'src/**', 'api/**', 'packages/**', 'workers/**',
	'server/**', 'multiplayer/**', 'pages/**', 'scripts/**', 'tests/**',
];
const SOURCE_EXT = /\.(js|mjs|cjs|ts|tsx|jsx|html|css|json|py|md|sql|sh|toml|yaml|yml)$/;

function trackedSourceFiles() {
	// -z + NUL split: filenames themselves may contain anything but a NUL.
	const out = execFileSync('git', ['ls-files', '-z', '--', ...TRACKED_GLOBS], {
		cwd: REPO,
		maxBuffer: 64 * 1024 * 1024,
	}).toString('utf8');
	return out.split('\0').filter((p) => p && SOURCE_EXT.test(p));
}

describe('no raw NUL bytes in tracked source', () => {
	it('every tracked source file stays greppable', () => {
		const offenders = [];
		for (const rel of trackedSourceFiles()) {
			let buf;
			try { buf = readFileSync(join(REPO, rel)); } catch { continue; } // deleted mid-run
			if (buf.includes(0)) offenders.push(rel);
		}
		expect(
			offenders,
			`Raw NUL byte(s) found — grep will treat these as binary and skip them.\n`
			+ `Write the separator as the \\u0000 escape instead (identical at runtime):\n`
			+ offenders.map((f) => `  ${f}`).join('\n'),
		).toEqual([]);
	}, 60_000);
});
