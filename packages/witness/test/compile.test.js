// The compiler's contract, and the one property that matters most: a generated
// test must be RED while the bug is present. A recorder that emits an assertion
// matching the broken behaviour has written a test that locks the bug in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileToPlaywright, narrate, failuresIn, entryRoute, replayConfidence } from '../src/compile.js';

const el = (over = {}) => ({ tag: 'button', strategy: 'testid', value: 'export', attr: 'data-testid', confidence: 100, ...over });

const trace = (events, environment = {}) => ({ version: 1, recordedMs: 4200, environment, events });

const session = trace(
	[
		{ i: 0, type: 'goto', detail: '/avatar-studio' },
		{ i: 1, type: 'click', el: el(), at: 2 },
		{ i: 2, type: 'fill', detail: 'text:11', el: el({ strategy: 'label', value: 'Model name', confidence: 85 }) },
		{ i: 3, type: 'click', el: el({ strategy: 'role', role: 'button', name: 'Download', confidence: 80 }) },
		{ i: 4, type: 'xhr', detail: 'POST /api/export -> 500', fatal: true },
		{ i: 5, type: 'error', detail: 'TypeError: exportGLB is not a function (studio.js:412)', fatal: true },
	],
	{ viewport: { width: 390, height: 844, dpr: 3 }, locale: 'en-GB', touch: true, userAgent: 'iPhone' },
);

test('the generated spec asserts the failure is GONE, never that it happened', () => {
	const { source } = compileToPlaywright(session, { title: 'Export does nothing' });
	assert.match(source, /expect\(failedRequests[^)]*\)\.toEqual\(\[\]\)/);
	assert.match(source, /expect\(pageErrors[^)]*\)\.toEqual\(\[\]\)/);
	// The broken status must appear only as context, never as an expectation.
	assert.ok(!/expect\([^)]*\)\.toBe\(500\)/.test(source), 'must not assert the broken status');
	assert.ok(!/toContain\('TypeError/.test(source), 'must not assert the thrown error');
});

test('the spec is syntactically valid JavaScript', () => {
	// A generated file that does not parse is worse than no file at all, so the
	// output is compiled here. Imports are stripped because Function() bodies
	// cannot hold them; everything else is exactly what lands on disk.
	const { source } = compileToPlaywright(session, { title: "Export does nothing (it's broken)" });
	assert.doesNotThrow(() => new Function(`return async () => { ${source.replace(/^import .*$/gm, '')} }`));
});

test('semantic locators are emitted where the element had a semantic handle', () => {
	const { source } = compileToPlaywright(session, { title: 'x' });
	assert.match(source, /page\.getByTestId\('?"?export/);
	assert.match(source, /page\.getByLabel\("Model name"\)/);
	assert.match(source, /page\.getByRole\("button", \{ name: "Download" \}\)/);
});

test('the session viewport and locale are carried into the replay', () => {
	const { source } = compileToPlaywright(session, { title: 'x' });
	assert.match(source, /viewport: \{ width: 390, height: 844 \}/);
	assert.match(source, /locale: 'en-GB'/);
	assert.match(source, /hasTouch: true/);
});

test('a private field becomes an explicit placeholder, never an invented value', () => {
	const spec = compileToPlaywright(
		trace([
			{ type: 'goto', detail: '/login' },
			{ type: 'fill', detail: 'private', el: el({ strategy: 'label', value: 'Password', confidence: 85 }) },
		]),
		{ title: 'login' },
	);
	assert.match(spec.source, /WITNESS_INPUT \|\| 'replace-me'/);
	assert.ok(!spec.source.includes('hunter2'));
});

test('a report with no machine-visible failure refuses to look green', () => {
	const spec = compileToPlaywright(
		trace([
			{ type: 'goto', detail: '/create' },
			{ type: 'click', el: el() },
		]),
		{ title: 'the result looks wrong' },
	);
	assert.match(spec.source, /test\.fail\(true/);
	assert.match(spec.source, /Add the assertion this report is really about/);
});

test('the entry route drives the goto, and a base url is prefixed once', () => {
	assert.equal(entryRoute(session), '/avatar-studio');
	const { source } = compileToPlaywright(session, { title: 'x', baseUrl: 'https://three.ws/' });
	assert.match(source, /page\.goto\('https:\/\/three\.ws\/avatar-studio'\)/);
});

test('narration and the spec describe the same sequence', () => {
	const steps = narrate(session);
	assert.deepEqual(steps.slice(0, 4), [
		'Open /avatar-studio',
		'Click the button [export]',
		'Type 11 characters into the button labelled "Model name"',
		'Click the button "Download"',
	]);
	assert.ok(steps.some((s) => s.startsWith('The page threw:')));
	assert.ok(steps.some((s) => s.startsWith('The request failed:')));
});

test('replay confidence reports the WEAKEST link, not the average', () => {
	const mixed = trace([
		{ type: 'goto', detail: '/x' },
		{ type: 'click', el: el() },
		{ type: 'click', el: el({ strategy: 'path', value: 'div > button', confidence: 10 }) },
	]);
	const { score, weakest } = replayConfidence(mixed);
	assert.equal(score, 10);
	assert.equal(weakest.strategy, 'path');
});

test('failuresIn separates the kinds so each gets its own assertion', () => {
	const found = failuresIn(session);
	assert.equal(found.network.length, 1);
	assert.equal(found.errors.length, 1);
	assert.equal(found.any, true);
	assert.equal(failuresIn(trace([{ type: 'click', el: el() }])).any, false);
});

test('a comment can never escape its own comment block', () => {
	const nasty = trace([
		{ type: 'goto', detail: '/x' },
		{ type: 'error', detail: 'Error: */ process.exit(1) /*', fatal: true },
	]);
	const { source } = compileToPlaywright(nasty, { title: 'x' });
	assert.ok(!/^\/\/.*\*\/ process\.exit/m.test(source));
	assert.doesNotThrow(() => new Function(`return async () => { ${source.replace(/^import .*$/gm, '')} }`));
});

test('a repeated click is recorded once with its count, not replayed 50 times', () => {
	const spammed = trace([
		{ type: 'goto', detail: '/x' },
		{ type: 'click', el: el(), count: 47 },
	]);
	const { source, steps } = compileToPlaywright(spammed, { title: 'x' });
	assert.equal((source.match(/\.click\(\)/g) || []).length, 1);
	assert.ok(steps.some((s) => s.includes('(x47)')));
});
