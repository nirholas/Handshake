// Reference-view slot invariants for the /forge composer.
//
// Production client-error logs carried a recurring uncaught TypeError from
// /forge and /image-to-3d: "Cannot read properties of undefined (reading
// 'state')", thrown out of a file-input change handler. Root cause was an
// off-by-two between two constants that had to agree and didn't: MAX_VIEWS was
// hardcoded to 6 while VIEW_LABELS (which builds the slot array AND the DOM)
// had 4 entries. Filling the last slot ran nextFreeAfter(3), which walked to
// slots[4] — undefined — and threw, aborting the upload mid-flight.
//
// The fix derives MAX_VIEWS from the labels and bounds the scan by the array,
// so the two can never disagree again. These tests pin both halves, plus the
// agreement with the server's own limit (api/forge.js MAX_VIEWS), since the
// composer must never offer more views than the API accepts.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

const clientSrc = read('src/forge.js');

function clientViewLabels() {
	const m = clientSrc.match(/const VIEW_LABELS = \[([^\]]+)\]/);
	if (!m) throw new Error('VIEW_LABELS not found in src/forge.js');
	return m[1]
		.split(',')
		.map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
		.filter(Boolean);
}

function serverMaxViews() {
	const m = read('api/forge.js').match(/const MAX_VIEWS = (\d+)/);
	if (!m) throw new Error('MAX_VIEWS not found in api/forge.js');
	return Number(m[1]);
}

describe('/forge reference-view slots', () => {
	it('derives MAX_VIEWS from the labels instead of hardcoding a second number', () => {
		expect(clientSrc).toContain('const MAX_VIEWS = VIEW_LABELS.length;');
		// A second literal assignment would reintroduce the exact drift that crashed.
		expect(clientSrc).not.toMatch(/const MAX_VIEWS = \d+/);
	});

	it('builds one real slot per advertised view', () => {
		const labels = clientViewLabels();
		expect(labels.length).toBeGreaterThan(0);
		// slots is built from VIEW_LABELS, so array length tracks the labels and
		// the DOM the same way, by construction.
		expect(clientSrc).toContain('const slots = VIEW_LABELS.map(');
		// Every label must be non-empty: it names the slot in its aria-label.
		for (const label of labels) expect(label.length).toBeGreaterThan(0);
	});

	it('never offers more reference views than the API accepts', () => {
		expect(clientViewLabels().length).toBeLessThanOrEqual(serverMaxViews());
	});

	it('scans for the next free slot within the array, not a separate constant', () => {
		const fn = clientSrc.slice(clientSrc.indexOf('function nextFreeAfter'));
		const body = fn.slice(0, fn.indexOf('\n}') + 2);
		// The loop bound is the array itself: filling the LAST slot must return
		// -1 ("no free slot"), never read one past the end.
		expect(body).toContain('j < slots.length');
		expect(body).not.toContain('j < MAX_VIEWS');
	});

	it('nextFreeAfter semantics: returns -1 past the end rather than throwing', () => {
		// A faithful reimplementation of the fixed function, exercised against the
		// real slot count — the exact call handleFiles makes after filling the
		// final slot, which is what threw in production.
		const slots = clientViewLabels().map(() => ({ state: 'uploaded' }));
		const nextFreeAfter = (i) => {
			for (let j = i + 1; j < slots.length; j++) {
				if (slots[j].state === 'empty' || slots[j].state === 'error') return j;
			}
			return -1;
		};
		expect(() => nextFreeAfter(slots.length - 1)).not.toThrow();
		expect(nextFreeAfter(slots.length - 1)).toBe(-1);

		slots[slots.length - 1] = { state: 'empty' };
		expect(nextFreeAfter(0)).toBe(slots.length - 1);
	});
});
