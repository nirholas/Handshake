// The client half of the checkout companion: what it reads off a live page.
//
// The load-bearing test in this file is "never reads an input". Everything else
// here is money parsing, which matters because a mis-parsed total produces a
// confident, specific, wrong warning on somebody's payment screen. The
// separator cases are the ones that break: "1.234,56" and "1,234.56" are the
// same amount written by two continents, and "$1,299" has no cents at all.

import { describe, it, expect, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';
import {
	parseAmount,
	roleFor,
	looksLikeCheckout,
	collectText,
	collectAmounts,
	primaryTotal,
	buildExtract,
} from '../extensions/checkout-companion/extract.js';

describe('parseAmount', () => {
	it('reads the common US form', () => {
		expect(parseAmount('$49.99')).toEqual({ value: 4999, currency: 'USD' });
		expect(parseAmount('Total: $1,234.56')).toEqual({ value: 123456, currency: 'USD' });
	});

	it('reads the European form where the comma is the decimal point', () => {
		expect(parseAmount('1.234,56 EUR')).toEqual({ value: 123456, currency: 'EUR' });
		expect(parseAmount('€9,99')).toEqual({ value: 999, currency: 'EUR' });
	});

	it('treats a thousands separator with no cents as whole units', () => {
		// "$1,299" is twelve hundred and ninety-nine dollars, not $12.99.
		expect(parseAmount('$1,299')).toEqual({ value: 129900, currency: 'USD' });
	});

	it('does not invent cents for a zero-decimal currency', () => {
		expect(parseAmount('¥1250')).toEqual({ value: 1250, currency: 'JPY' });
		expect(parseAmount('JPY 1,250')).toEqual({ value: 1250, currency: 'JPY' });
	});

	it('refuses a number with no currency marker', () => {
		expect(parseAmount('12 items')).toBeNull();
		expect(parseAmount('2026-08-28')).toBeNull();
		expect(parseAmount('Order 1234567')).toBeNull();
		expect(parseAmount('')).toBeNull();
	});

	it('reads a negative or bracketed amount as a credit', () => {
		expect(parseAmount('-$10.00').value).toBe(-1000);
		expect(parseAmount('($10.00)').value).toBe(-1000);
	});

	it('honours a currency hint when the page omits the symbol', () => {
		expect(parseAmount('49.99', { currencyHint: 'GBP' })).toEqual({ value: 4999, currency: 'GBP' });
	});
});

describe('roleFor', () => {
	it('classifies the labels a checkout actually uses', () => {
		expect(roleFor('Order total')).toBe('total');
		expect(roleFor('Amount due today')).toBe('total');
		expect(roleFor('Subtotal')).toBe('subtotal');
		expect(roleFor('Shipping & handling')).toBe('shipping');
		expect(roleFor('Sales tax')).toBe('tax');
		expect(roleFor('Service fee')).toBe('service');
		expect(roleFor('Booking fee')).toBe('fee');
		expect(roleFor('Promo discount')).toBe('discount');
		expect(roleFor('Something else entirely')).toBe('unknown');
	});
});

describe('looksLikeCheckout', () => {
	it('recognises a checkout by url and page language together', () => {
		expect(looksLikeCheckout({ url: 'https://shop.example/checkout', text: 'Place your order' })).toBe(true);
		expect(looksLikeCheckout({ url: 'https://x.example/a', text: 'Order summary. Payment method. Pay now' })).toBe(true);
	});

	it('leaves an ordinary page alone', () => {
		expect(looksLikeCheckout({ url: 'https://news.example/article', text: 'A long article about shoes.' })).toBe(false);
		// A url alone is not enough: /order shows up on order-history pages.
		expect(looksLikeCheckout({ url: 'https://shop.example/orders', text: 'Your past orders' })).toBe(false);
	});
});

describe('reading the DOM', () => {
	let dom;
	const load = (html) => {
		dom = new JSDOM(`<!doctype html><body>${html}</body>`);
		return dom.window;
	};

	beforeEach(() => {
		dom = null;
	});

	it('never reads a value out of an input, a textarea or a select', () => {
		const win = load(`
			<p>Card on file</p>
			<input type="text" value="4242424242424242" placeholder="Card number">
			<textarea>cvv 123</textarea>
			<select><option>secret option</option></select>
		`);
		const text = collectText(win.document.body, { view: win });
		expect(text).toContain('Card on file');
		expect(text).not.toContain('4242424242424242');
		expect(text).not.toContain('cvv 123');
		expect(text).not.toContain('secret option');
	});

	it('never reads a contenteditable surface', () => {
		const win = load('<div contenteditable="true">4242 4242 4242 4242</div><p>Total $10.00</p>');
		const text = collectText(win.document.body, { view: win });
		expect(text).not.toContain('4242');
		expect(text).toContain('Total $10.00');
	});

	it('skips iframes and scripts entirely', () => {
		const win = load('<script>var card="4242";</script><iframe></iframe><p>Order summary</p>');
		const text = collectText(win.document.body, { view: win });
		expect(text).not.toContain('4242');
		expect(text).toBe('Order summary');
	});

	it('skips content hidden from the person reading the page', () => {
		const win = load('<div style="display:none">Hidden $99.00</div><p>Shown $10.00</p>');
		const text = collectText(win.document.body, { view: win });
		expect(text).not.toContain('Hidden');
		expect(text).toContain('Shown $10.00');
	});

	it('stops at maxChars so a huge page cannot stall the tab', () => {
		const win = load(`<p>${'word '.repeat(5000)}</p>`);
		const text = collectText(win.document.body, { view: win, maxChars: 500 });
		expect(text.length).toBeLessThanOrEqual(500);
	});

	it('pairs each amount with the label in its own table row', () => {
		const win = load(`
			<table>
				<tr><td>Subtotal</td><td>$49.99</td></tr>
				<tr><td>Shipping</td><td>$5.00</td></tr>
				<tr><td>Service fee</td><td>$7.50</td></tr>
				<tr><td>Order total</td><td>$62.49</td></tr>
			</table>
		`);
		const amounts = collectAmounts(win.document.body, { view: win });
		const byRole = Object.fromEntries(amounts.map((a) => [a.role, a.value]));
		expect(byRole.subtotal).toBe(4999);
		expect(byRole.shipping).toBe(500);
		expect(byRole.service).toBe(750);
		expect(byRole.total).toBe(6249);
	});

	it('does not collect an amount that only exists inside an input', () => {
		const win = load('<input type="text" value="$99.99"><p>Total $10.00</p>');
		const amounts = collectAmounts(win.document.body, { view: win });
		expect(amounts.map((a) => a.value)).toEqual([1000]);
	});

	it('picks the largest total as the primary one', () => {
		expect(
			primaryTotal([
				{ value: 1000, role: 'total' },
				{ value: 6249, role: 'total' },
				{ value: 9999, role: 'line' },
			]).value,
		).toBe(6249);
		expect(primaryTotal([{ value: 10, role: 'line' }])).toBeNull();
	});
});

describe('buildExtract', () => {
	it('drops the url fragment and caps the payload', () => {
		const out = buildExtract({
			url: 'https://shop.example/checkout#step2',
			title: 'x'.repeat(500),
			text: 'y'.repeat(70_000),
			amounts: [{ value: 100, currency: 'GBP', role: 'total' }],
			quoted: { value: 90 },
		});
		expect(out.url).toBe('https://shop.example/checkout');
		expect(out.title).toHaveLength(300);
		expect(out.text).toHaveLength(60_000);
		expect(out.currency).toBe('GBP');
		expect(out.quoted).toEqual({ value: 90, currency: 'GBP' });
	});

	it('carries no quoted price when there is nothing remembered', () => {
		expect(buildExtract({ url: 'https://a.example/', text: 'x', amounts: [] }).quoted).toBeNull();
	});
});
