#!/usr/bin/env node
/**
 * Refuse to build or deploy a tree carrying unresolved merge-conflict markers.
 *
 * Why this exists
 * ---------------
 * This worktree is shared by concurrent agents. On 2026-07-29 one of them ran a
 * `git stash pop`, hit conflicts in seven files, and committed the result
 * wholesale — `<<<<<<< Updated upstream` and friends landed in HEAD across
 * production source (`api/chat/config.js`, `src/avatar-garment.js`,
 * `src/walk-net.js`, `src/garment-taxonomy.js`,
 * `public/studio/launch-panel.js`) and two test files.
 *
 * Nothing caught it. A conflict marker is not a lint rule violation, it is a
 * SYNTAX error, so eslint and vitest report it as an unparseable file rather
 * than as the obvious thing it is — and neither runs on commit. The frontend
 * build would have failed on the `src/` files, but only after the load-bearing
 * step order had already wiped `dist/`, and `api/` handlers are not bundled at
 * build time at all: `api/chat/config.js` would have shipped to Cloud Run and
 * 500'd every chat request at runtime.
 *
 * The check is one `git grep` over tracked files, so it costs milliseconds and
 * runs in `build:gcp` and `gate` before anything is built. The opening marker
 * at the start of a line is the trigger on its own: that is never legitimate
 * source in any language we ship, and requiring a closing marker too would miss
 * the interrupted merges (see the `character-studio/.gitignore` note below).
 * What keeps it quiet is the column-0 anchor, not marker pairing — a bare
 * `=======` is an ordinary markdown rule and is never matched.
 *
 * Usage:
 *   node scripts/check-merge-conflicts.mjs          # exits 1 on any marker
 */

import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

// Deliberately built at runtime: a literal in this file would make the script
// match itself, and a self-exclusion by filename is the kind of hole that stops
// working the moment the file is renamed.
const OPEN = '<'.repeat(7);
const CLOSE = '>'.repeat(7);

function git(args) {
	try {
		return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	} catch (err) {
		// `git grep` exits 1 with no output when nothing matches — not an error.
		if (err?.status === 1 && !err.stdout) return '';
		throw err;
	}
}

/** Tracked files carrying `marker` at the start of a line, as a Set of paths. */
function filesWithMarker(marker) {
	// ANCHORED to column 0. git writes conflict markers only at the start of a
	// line, so anchoring loses no real conflict — but an unanchored -F search
	// also matches any file that merely *mentions* a marker in prose, which is
	// exactly what this script's own test file and the docs describing conflict
	// resolution do. That false positive failed a production build on
	// 2026-07-29, and "reword the prose" is the wrong fix: the rule the header
	// comment already claims (start of a line) is the correct one.
	const out = git(['grep', '-l', '-E', `^${marker} `, '--', '.']);
	return new Set(out.split('\n').filter(Boolean));
}

const self = basename(new URL(import.meta.url).pathname);

// The opening marker alone is the trigger, not the OPEN/CLOSE pair. The same
// 2026-07-29 stash-pop left `character-studio/.gitignore` with two nested
// opening markers, two `=======` separators and NO closing marker at all — a
// pair-matching check calls that file clean, which is precisely backwards: an
// unterminated conflict means the merge was interrupted, so even MORE of the
// file is unaccounted for. `<{7} ` at the start of a line is not valid syntax
// in any language we ship, so matching it alone needs no suppression list.
const opened = filesWithMarker(OPEN);
const closed = filesWithMarker(CLOSE);
const conflicted = [...opened].filter((f) => basename(f) !== self).sort();

if (!conflicted.length) {
	console.log('check:conflicts: no unresolved merge-conflict markers in tracked files');
	process.exit(0);
}

console.error(`\ncheck:conflicts — ${conflicted.length} file(s) carry unresolved merge-conflict markers:\n`);
for (const file of conflicted) {
	const hits = git(['grep', '-n', '-E', `^${OPEN} `, '--', file])
		.split('\n')
		.filter(Boolean)
		.map((line) => line.slice(file.length + 1).split(':')[0]);
	// An opening marker with no closing one means the merge stopped partway:
	// call that out, because the missing side is not visible in the diff.
	const truncated = closed.has(file) ? '' : '  [no closing marker — merge left partway]';
	console.error(`  ${file}  (line${hits.length > 1 ? 's' : ''} ${hits.join(', ')})${truncated}`);
}
console.error(`
Resolve every conflict before building. For each file, open it, pick the
correct side (or merge both), and delete all three marker lines. Verify with:

  node --check <file>                      # for .js / .mjs
  node scripts/check-merge-conflicts.mjs   # re-run this check
`);
process.exit(1);
