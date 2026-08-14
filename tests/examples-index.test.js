// The examples index generator writes into docs/examples.md, a hand-written
// doc. An early version of it replaced the whole file instead of the block
// between its markers, destroying 722 lines of prose. These tests pin the
// behaviour that prevents that: the generated block is replaced in place, the
// hand-written prose above it survives, and a malformed marker pair refuses to
// write at all rather than guessing.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = process.cwd();
const SCRIPT = join(root, 'scripts/build-examples-index.mjs');
const DOC = join(root, 'docs/examples.md');
const JSON_OUT = join(root, 'data/examples.json');
const START = '<!-- BEGIN GENERATED EXAMPLES INDEX (npm run build:examples) -->';
const END = '<!-- END GENERATED EXAMPLES INDEX -->';

function run(env = {}) {
	return execFileSync('node', [SCRIPT], { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } });
}

function handWrittenPart(text) {
	return text.split(START)[0];
}

describe('examples index generator', () => {
	// Running the generator rewrites two files other tests read (and other
	// agents share this worktree), so snapshot and restore both. The generator
	// itself writes atomically, so a concurrent reader never sees a torn file.
	let originalDoc;
	let originalJson;

	function restore() {
		if (originalDoc === undefined) return;
		writeFileSync(DOC, originalDoc);
		if (originalJson !== null) writeFileSync(JSON_OUT, originalJson);
	}

	// afterEach never runs if the run is interrupted (a killed CI job, a Ctrl-C, a
	// vitest timeout). The malformed fixture no longer goes anywhere near the real
	// doc, so the worst an interrupt can now leave behind is a correctly
	// regenerated file, but restoring on the catchable signals still keeps the
	// shared worktree byte-identical to how the run found it.
	const onExit = () => restore();
	const onSignal = () => {
		restore();
		process.exit(1);
	};

	beforeEach(() => {
		originalDoc = readFileSync(DOC, 'utf8');
		originalJson = existsSync(JSON_OUT) ? readFileSync(JSON_OUT, 'utf8') : null;
		process.once('exit', onExit);
		process.once('SIGINT', onSignal);
		process.once('SIGTERM', onSignal);
	});

	afterEach(() => {
		restore();
		process.off('exit', onExit);
		process.off('SIGINT', onSignal);
		process.off('SIGTERM', onSignal);
	});

	it('emits a machine-readable index whose entries all exist on disk', () => {
		run();
		const payload = JSON.parse(readFileSync(JSON_OUT, 'utf8'));
		expect(payload.examples.length).toBeGreaterThan(0);
		expect(payload.counts.total).toBe(payload.examples.length);
		for (const entry of payload.examples) {
			expect(existsSync(join(root, entry.path)), `${entry.path} should exist`).toBe(true);
			expect(entry.title).toBeTruthy();
			expect(entry.kind).toMatch(/^(html-demo|project|package)$/);
		}
	});

	it('is idempotent: running it repeatedly does not grow or shrink the doc', () => {
		run();
		const afterFirst = readFileSync(DOC, 'utf8');
		run();
		run();
		expect(readFileSync(DOC, 'utf8')).toBe(afterFirst);
	});

	it('preserves the hand-written prose above the generated block', () => {
		const before = handWrittenPart(readFileSync(DOC, 'utf8'));
		run();
		run();
		const after = handWrittenPart(readFileSync(DOC, 'utf8'));
		expect(after.length).toBeGreaterThanOrEqual(before.length);
		expect(after).toContain('# Examples Gallery');
	});

	it('refuses to write when the markers are malformed instead of rewriting the file', () => {
		// An END with no START is the shape that would make a naive indexOf pair
		// slice away real content. The broken fixture goes in a scratch file, not
		// the real docs/examples.md: a fork killed between the write and the
		// restore used to leave the repo holding it, and every later run then
		// failed on a doc nobody had edited.
		const dir = mkdtempSync(join(tmpdir(), 'examples-index-'));
		const scratch = join(dir, 'examples.md');
		try {
			writeFileSync(scratch, `# Examples Gallery\n\nHand written prose.\n\n${END}\n`);
			expect(() => run({ EXAMPLES_DOC: scratch })).toThrow();
			expect(readFileSync(scratch, 'utf8')).toContain('Hand written prose.');
			// The real doc is untouched by the refusal.
			expect(readFileSync(DOC, 'utf8')).toContain(START);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
