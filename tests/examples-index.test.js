// The examples index generator writes into docs/examples.md, a hand-written
// doc. An early version of it replaced the whole file instead of the block
// between its markers, destroying 722 lines of prose. These tests pin the
// behaviour that prevents that: the generated block is replaced in place, the
// hand-written prose above it survives, and a malformed marker pair refuses to
// write at all rather than guessing.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const SCRIPT = join(root, 'scripts/build-examples-index.mjs');
const DOC = join(root, 'docs/examples.md');
const JSON_OUT = join(root, 'data/examples.json');
const START = '<!-- BEGIN GENERATED EXAMPLES INDEX (npm run build:examples) -->';
const END = '<!-- END GENERATED EXAMPLES INDEX -->';

function run() {
	return execFileSync('node', [SCRIPT], { cwd: root, encoding: 'utf8' });
}

function handWrittenPart(text) {
	return text.split(START)[0];
}

describe('examples index generator', () => {
	let original;

	beforeEach(() => {
		original = readFileSync(DOC, 'utf8');
	});

	afterEach(() => {
		writeFileSync(DOC, original);
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
		// slice away real content.
		writeFileSync(DOC, `# Examples Gallery\n\nHand written prose.\n\n${END}\n`);
		expect(() => run()).toThrow();
		expect(readFileSync(DOC, 'utf8')).toContain('Hand written prose.');
	});
});
