// The checkout companion's two guarantees, held to by test rather than by hope.
//
//   1. Nothing that identifies a person or their card leaves the browser.
//   2. Every number in a finding was computed here, never read off a model.
//
// Both are properties of api/_lib/companion/checkout.js, which is pure, so they
// are checkable without a network, a key, or a browser. A regression in either
// is a privacy incident or a false accusation rendered over a real merchant's
// payment page, which is why the money-math cases below are exact rather than
// approximate.

import { describe, it, expect } from 'vitest';
import {
	redactPageText,
	deterministicFindings,
	sanitizeModelFindings,
	mergeFindings,
	spokenSummary,
	formatAmount,
	analyzeCheckout,
	buildAnalysisPrompt,
} from '../api/_lib/companion/checkout.js';

describe('redactPageText', () => {
	it('removes a card number and keeps only the last four', () => {
		// 4242 4242 4242 4242 is Stripe's documented test number and passes Luhn.
		const out = redactPageText('Paying with 4242 4242 4242 4242 today');
		expect(out.text).not.toContain('4242 4242 4242 4242');
		expect(out.text).toContain('[card ending 4242]');
		expect(out.counts.card).toBe(1);
	});

	it('leaves a long number that is not a card alone', () => {
		// Order ids are exactly the context a finding needs, and they fail Luhn.
		const out = redactPageText('Order 1234567890123456 confirmed');
		expect(out.text).toContain('1234567890123456');
		expect(out.counts.card).toBe(0);
	});

	it('removes emails, phones, security codes and bank accounts', () => {
		const out = redactPageText(
			'Receipt to buyer@example.com, call (415) 555-0132, CVV: 123, IBAN GB29 NWBK 6016 1331 9268 19',
		);
		expect(out.text).not.toContain('buyer@example.com');
		expect(out.text).not.toContain('555-0132');
		expect(out.text).not.toContain('123456');
		expect(out.text).not.toMatch(/CVV: 123/);
		expect(out.counts.email).toBe(1);
		expect(out.counts.phone).toBe(1);
		expect(out.counts.cvv).toBe(1);
		expect(out.counts.iban).toBe(1);
		expect(out.redactionCount).toBe(4);
	});

	it('reports zero redactions for an ordinary page', () => {
		const out = redactPageText('Total $49.99. Ships in two days.');
		expect(out.redactionCount).toBe(0);
		expect(out.text).toBe('Total $49.99. Ships in two days.');
	});
});

describe('deterministicFindings: the arithmetic', () => {
	it('catches a total higher than the price the person was quoted', () => {
		const findings = deterministicFindings({
			currency: 'USD',
			quoted: { value: 4999 },
			amounts: [{ value: 6249, role: 'total' }],
			text: '',
		});
		const hit = findings.find((f) => f.id === 'total_above_quoted');
		expect(hit).toBeDefined();
		expect(hit.amount).toBe(1250);
		expect(hit.severity).toBe('flag');
		expect(hit.detail).toContain('$12.50');
	});

	it('stays silent when the total matches what was quoted', () => {
		const findings = deterministicFindings({
			quoted: { value: 4999 },
			amounts: [{ value: 4999, role: 'total' }],
			text: '',
		});
		expect(findings.find((f) => f.id === 'total_above_quoted')).toBeUndefined();
	});

	it('flags money in the total that no line item explains', () => {
		const findings = deterministicFindings({
			amounts: [
				{ value: 4999, role: 'line' },
				{ value: 500, role: 'shipping' },
				{ value: 6249, role: 'total' },
			],
			text: '',
		});
		const hit = findings.find((f) => f.id === 'unexplained_addition');
		expect(hit.amount).toBe(750);
		expect(hit.detail).toContain('$7.50');
	});

	it('treats a one-cent gap as rounding, not a dark pattern', () => {
		const findings = deterministicFindings({
			amounts: [
				{ value: 3333, role: 'line' },
				{ value: 3333, role: 'line' },
				{ value: 3333, role: 'line' },
				{ value: 10000, role: 'total' },
			],
			text: '',
		});
		expect(findings.find((f) => f.id === 'unexplained_addition')).toBeUndefined();
	});

	it('names the fees and adds them up', () => {
		const findings = deterministicFindings({
			amounts: [
				{ value: 250, role: 'fee', context: 'Service fee' },
				{ value: 199, role: 'processing', context: 'Processing' },
			],
			text: '',
		});
		const hit = findings.find((f) => f.id === 'fees_present');
		expect(hit.amount).toBe(449);
		expect(hit.detail).toContain('Service fee');
	});

	it('reports a discount as information rather than a warning', () => {
		const findings = deterministicFindings({
			amounts: [
				{ value: 5000, role: 'line' },
				{ value: 4000, role: 'total' },
			],
			text: '',
		});
		const hit = findings.find((f) => f.id === 'total_below_lines');
		expect(hit.severity).toBe('info');
	});
});

describe('deterministicFindings: the language', () => {
	it('flags a charge that repeats', () => {
		const findings = deterministicFindings({
			amounts: [],
			text: 'Your plan auto-renews every month until cancelled.',
		});
		expect(findings.find((f) => f.id === 'recurring')).toBeDefined();
	});

	it('flags a trial that turns into a paid plan', () => {
		const findings = deterministicFindings({
			amounts: [],
			text: 'Start your free trial. After the trial you will be billed.',
		});
		const hit = findings.find((f) => f.id === 'trial_converts');
		expect(hit.severity).toBe('flag');
		expect(hit.evidence).toContain('trial');
	});

	it('says nothing about an ordinary one-off purchase', () => {
		const findings = deterministicFindings({
			amounts: [{ value: 4999, role: 'total' }],
			quoted: { value: 4999 },
			text: 'One pair of running shoes. Ships in two days. Free returns.',
		});
		expect(findings).toEqual([]);
	});
});

describe('sanitizeModelFindings: what the model is not allowed to say', () => {
	it('drops a finding that calls the charge illegal', () => {
		const out = sanitizeModelFindings({
			findings: [
				{ severity: 'flag', title: 'This is illegal', detail: 'The merchant is breaking the law.' },
			],
		});
		expect(out).toEqual([]);
	});

	it('drops a finding that invents an amount', () => {
		// Arithmetic is never the model's job; a number here is unverified.
		const out = sanitizeModelFindings({
			findings: [{ severity: 'flag', title: 'Hidden fee', detail: 'They add $12.50 at the end.' }],
		});
		expect(out).toEqual([]);
	});

	it('keeps a plain reading of a cancellation clause', () => {
		const out = sanitizeModelFindings({
			findings: [
				{
					severity: 'notice',
					title: 'Cancelling needs 30 days of notice',
					detail: 'The terms say the plan must be cancelled a full period before it renews.',
					evidence: 'cancel at least 30 days before renewal',
				},
			],
		});
		expect(out).toHaveLength(1);
		expect(out[0].source).toBe('reading');
	});

	it('parses JSON out of a model reply wrapped in prose', () => {
		const out = sanitizeModelFindings(
			'Here you go:\n{"findings":[{"severity":"info","title":"Ships from overseas","detail":"Delivery is quoted from an overseas warehouse."}]}\nHope that helps.',
		);
		expect(out).toHaveLength(1);
	});

	it('returns nothing for unparseable output instead of throwing', () => {
		expect(sanitizeModelFindings('the model said no')).toEqual([]);
		expect(sanitizeModelFindings({ findings: 'nope' })).toEqual([]);
	});
});

describe('ordering and the spoken line', () => {
	it('puts computed money above read prose at the same severity', () => {
		const merged = mergeFindings(
			[{ id: 'a', severity: 'flag', title: 'Total is higher', source: 'arithmetic' }],
			[{ id: 'b', severity: 'flag', title: 'It repeats', source: 'reading' }],
		);
		expect(merged[0].source).toBe('arithmetic');
	});

	it('sorts a flag above a notice', () => {
		const merged = mergeFindings(
			[{ id: 'n', severity: 'notice', title: 'Refund policy', source: 'phrase' }],
			[{ id: 'f', severity: 'flag', title: 'It repeats', source: 'reading' }],
		);
		expect(merged[0].severity).toBe('flag');
	});

	it('speaks the exact difference when there is one', () => {
		const line = spokenSummary([
			{ severity: 'flag', source: 'arithmetic', id: 'total_above_quoted', amount: 1250, title: 'x' },
		]);
		expect(line).toContain('$12.50');
	});

	it('stays quiet when nothing is worth interrupting for', () => {
		expect(spokenSummary([{ severity: 'notice', title: 'Refund policy', source: 'phrase' }])).toBeNull();
		expect(spokenSummary([])).toBeNull();
	});
});

describe('formatAmount', () => {
	it('renders minor units for a two-decimal currency', () => {
		expect(formatAmount(1250, 'USD')).toBe('$12.50');
		expect(formatAmount(5, 'USD')).toBe('$0.05');
		expect(formatAmount(100000, 'EUR')).toBe('€1000.00');
	});

	it('renders a zero-decimal currency without cents', () => {
		expect(formatAmount(1250, 'JPY')).toBe('¥1250');
	});
});

describe('analyzeCheckout', () => {
	const extract = {
		url: 'https://shop.example/checkout',
		title: 'Checkout',
		currency: 'USD',
		quoted: { value: 4999 },
		amounts: [{ value: 6249, role: 'total' }],
		text: 'Total due today. Your plan auto-renews every month. Card 4242 4242 4242 4242.',
	};

	it('redacts before the model ever sees the page', async () => {
		let seen = null;
		await analyzeCheckout(extract, {
			complete: async ({ user }) => {
				seen = user;
				return '{"findings":[]}';
			},
		});
		expect(seen).not.toContain('4242 4242 4242 4242');
		expect(seen).toContain('[card ending 4242]');
	});

	it('still reports the arithmetic when the model is unreachable', async () => {
		const out = await analyzeCheckout(extract, {
			complete: async () => {
				throw new Error('llm down');
			},
		});
		expect(out.reading_status).toBe('unavailable');
		expect(out.findings.find((f) => f.id === 'total_above_quoted')).toBeDefined();
		expect(out.spoken).toContain('$12.50');
	});

	it('reports how many redactions it made', async () => {
		const out = await analyzeCheckout(extract, { complete: null });
		expect(out.redactions).toBe(1);
		expect(out.redaction_counts.card).toBe(1);
		expect(out.reading_status).toBe('skipped');
	});

	it('never puts the page URL path into the prompt, only the host', () => {
		const prompt = buildAnalysisPrompt({
			url: 'https://shop.example/checkout/order/abc123?email=buyer@example.com',
			text: 'hello',
		});
		expect(prompt).toContain('shop.example');
		expect(prompt).not.toContain('abc123');
		expect(prompt).not.toContain('buyer@example.com');
	});
});
