// The selector ladder is what decides whether a generated test survives the
// next refactor, so every rung is pinned here, including the demotions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
	describeElement,
	toPlaywrightLocator,
	describeForHuman,
	accessibleName,
	roleOf,
	structuralPath,
} from '../src/selector.js';

function dom(html) {
	const win = new JSDOM(`<!doctype html><body>${html}</body>`).window;
	// CSS.escape is not implemented by jsdom; the module falls back on its own
	// escaping when it is absent, which is exactly the path a real browser
	// without CSS.escape would take.
	globalThis.CSS = undefined;
	return win.document;
}

test('a test id wins over everything else on the element', () => {
	const doc = dom('<button data-testid="export" id="btn" aria-label="Export model">Export</button>');
	const desc = describeElement(doc.querySelector('button'));
	assert.equal(desc.strategy, 'testid');
	assert.equal(desc.value, 'export');
	assert.equal(toPlaywrightLocator(desc), 'page.getByTestId("export")');
});

test('a framework-generated id is refused in favour of the accessible name', () => {
	const doc = dom('<button id=":r3a:">Save changes</button>');
	const desc = describeElement(doc.querySelector('button'));
	assert.notEqual(desc.strategy, 'id');
	assert.equal(desc.strategy, 'role');
	assert.equal(toPlaywrightLocator(desc), 'page.getByRole("button", { name: "Save changes" })');
});

test('a hash-like class is refused, a hand-written one is kept', () => {
	const doc = dom('<div><span class="css-1x2y3z4 price-tag">$12</span></div>');
	const desc = describeElement(doc.querySelector('span'));
	assert.equal(desc.strategy, 'class');
	assert.equal(desc.value, 'price-tag');
});

test('utility classes never become selectors', () => {
	const doc = dom('<div><i class="px-4 py-2 text-sm rounded-lg"></i></div>');
	const desc = describeElement(doc.querySelector('i'));
	assert.equal(desc.strategy, 'path');
});

test('a duplicated role and name demotes rather than producing an ambiguous locator', () => {
	const doc = dom('<button>Delete</button><button>Delete</button>');
	const desc = describeElement(doc.querySelectorAll('button')[1]);
	assert.equal(desc.strategy, 'path');
	assert.match(desc.value, /nth-of-type\(2\)/);
});

test('an input is named by its label, and emits getByLabel only when aria-label is present', () => {
	const doc = dom('<label for="email-field">Email address</label><input id="email-field" name="email">');
	const input = doc.querySelector('input');
	assert.equal(accessibleName(input), 'Email address');
	// The id is hand-written, so it is the stronger handle and wins the ladder.
	const desc = describeElement(input);
	assert.equal(desc.strategy, 'id');
	assert.equal(toPlaywrightLocator(desc), 'page.locator("#email-field")');
});

test('aria-label produces a getByLabel locator', () => {
	const doc = dom('<div><button aria-label="Close dialog">x</button></div>');
	const desc = describeElement(doc.querySelector('button'));
	assert.equal(desc.strategy, 'label');
	assert.equal(toPlaywrightLocator(desc), 'page.getByLabel("Close dialog")');
});

test('aria-labelledby is resolved the way a screen reader resolves it', () => {
	const doc = dom('<h2 id="t">Billing</h2><section aria-labelledby="t"><p>x</p></section>');
	assert.equal(accessibleName(doc.querySelector('section')), 'Billing');
});

test('roles are implicit where the spec makes them implicit', () => {
	const doc = dom('<a href="/x">Go</a><a>Not a link</a><input type="checkbox"><h3>Title</h3>');
	assert.equal(roleOf(doc.querySelectorAll('a')[0]), 'link');
	assert.equal(roleOf(doc.querySelectorAll('a')[1]), null);
	assert.equal(roleOf(doc.querySelector('input')), 'checkbox');
	assert.equal(roleOf(doc.querySelector('h3')), 'heading');
});

test('a structural path is bounded so it stays readable', () => {
	const doc = dom('<div><div><div><div><div><div><span>deep</span></div></div></div></div></div></div>');
	const path = structuralPath(doc.querySelector('span'));
	assert.ok(path.split('>').length <= 5, path);
});

test('confidence falls as the ladder is descended', () => {
	const strong = describeElement(dom('<button data-testid="a">A</button>').querySelector('button'));
	const weak = describeElement(dom('<div><i></i></div>').querySelector('i'));
	assert.ok(strong.confidence > weak.confidence);
});

test('a human-readable description exists for every strategy', () => {
	const cases = [
		'<button data-testid="export">E</button>',
		'<button id="save-btn">S</button>',
		'<button aria-label="Close">x</button>',
		'<button>Unique text</button>',
		'<div><input placeholder="Search models"></div>',
		'<div><i class="thing-marker"></i></div>',
		'<div><em></em></div>',
	];
	for (const html of cases) {
		const doc = dom(html);
		const el = doc.body.querySelector('button, input, i, em');
		const text = describeForHuman(describeElement(el));
		assert.ok(text && text.length > 2, `${html} -> ${text}`);
	}
});
