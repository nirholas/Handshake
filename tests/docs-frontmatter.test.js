// Docs reader: YAML frontmatter must never reach the reader.
//
// Nine docs are article drafts that open with a YAML frontmatter block (title,
// venue, account, tags, canonical URL). Markdown has no frontmatter concept, so
// marked reads the opening `---` as a thematic break and the closing `---` as a
// setext underline for the paragraph between them: the whole metadata block
// rendered as a giant <h2> above the article on every one of those pages, in
// production. The reader strips it before parsing, which also keeps it out of
// the "Copy page" markdown handed to an LLM.
//
// The stripper lives inline in docs/index.html (the reader is a single shipped
// file, not a module), so this test extracts the shipped declarations and runs
// them. Reimplementing the regex here would test a copy of it.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SHELL = readFileSync(resolve(ROOT, 'docs/index.html'), 'utf8');

/** Pull the shipped FRONTMATTER regex + stripFrontmatter() out of the reader. */
function extractStripper() {
	const start = SHELL.indexOf('const FRONTMATTER =');
	if (start === -1) throw new Error('FRONTMATTER not found in docs/index.html');
	const marker = 'function stripFrontmatter(md) {';
	const fn = SHELL.indexOf(marker, start);
	if (fn === -1) throw new Error('stripFrontmatter() not found after FRONTMATTER');
	const end = SHELL.indexOf('}', fn + marker.length);
	if (end === -1) throw new Error('unbalanced braces in stripFrontmatter()');
	return SHELL.slice(start, end + 1) + '\nreturn stripFrontmatter(md);';
}

const strip = new Function('md', extractStripper());

describe('docs reader: frontmatter stripping', () => {
	// Only the block and its closing newline go; the blank line the author left
	// after it stays, which marked ignores.
	it('removes a leading YAML block and leaves the article intact', () => {
		const md = '---\ntitle: "One paywall"\nvenue: AWS Builder Center\ntags: [aws]\n---\n\n# One paywall\n\nBody.';
		expect(strip(md)).toBe('\n# One paywall\n\nBody.');
	});

	it('tolerates CRLF line endings and a trailing space on the fence', () => {
		expect(strip('---\r\ntitle: X\r\n--- \r\n\r\n# H\r\n')).toBe('\r\n# H\r\n');
	});

	it('strips a block that is the entire file, leaving nothing behind', () => {
		expect(strip('---\ntitle: X\n---\n')).toBe('');
	});

	it('leaves a doc that opens with a heading untouched', () => {
		const md = '# Heading\n\nBody with a --- horizontal rule below.\n\n---\n\nMore.';
		expect(strip(md)).toBe(md);
	});

	it('leaves a mid-document horizontal rule alone', () => {
		const md = 'Intro.\n\n---\n\nAfter the rule.';
		expect(strip(md)).toBe(md);
	});

	it('does not eat a doc whose first line is a rule but that has no closing fence', () => {
		const md = '---\n\n# Heading\n\nBody.';
		expect(strip(md)).toBe(md);
	});

	it('strips only the first block, so a later fence pair survives as content', () => {
		const md = '---\ntitle: X\n---\n\n# H\n\n---\nnot: frontmatter\n---\n';
		expect(strip(md)).toBe('\n# H\n\n---\nnot: frontmatter\n---\n');
	});

	// The regression that shipped: every doc opening with `---` must render its
	// own h1 first, not a heading built out of its YAML keys.
	it('leaves no frontmatter key at the top of any doc that carries one', () => {
		const docs = readdirSync(resolve(ROOT, 'docs')).filter((f) => f.endsWith('.md'));
		const carriers = docs.filter((f) =>
			readFileSync(join(ROOT, 'docs', f), 'utf8').startsWith('---\n'),
		);
		// If this drops to zero the fixture set moved; the guard would pass vacuously.
		expect(carriers.length).toBeGreaterThan(0);
		for (const f of carriers) {
			const out = strip(readFileSync(join(ROOT, 'docs', f), 'utf8')).trimStart();
			expect(out.startsWith('#'), `${f} still opens with frontmatter`).toBe(true);
		}
	});
});
