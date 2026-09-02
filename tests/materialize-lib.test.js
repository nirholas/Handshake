// Pure view logic behind /materialize. These functions decide what a buyer sees
// about a price and a physical size, so the edges are the point: a slider whose
// ends disagree with the server rejects at checkout, a scale drawing with the
// wrong proportion misleads about a real object, and an AR scale factor that is
// off by a decimal puts a 14 cm figure on the floor at 14 metres.
import { describe, it, expect } from 'vitest';

import {
	SHIPPING_COUNTRIES,
	arScaleAttribute,
	clampHeight,
	defaultHeight,
	formatLeadTime,
	formatMm,
	formatUsdc,
	printabilityView,
	quoteRows,
	rejectionView,
	scaleReference,
	sliderBounds,
	timelineView,
	validateShipping,
	editionNote,
} from '../src/materialize-lib.js';

const REFERENCES = [
	{ id: 'coin', name: 'A coin', heightMm: 24 },
	{ id: 'mug', name: 'Coffee mug', heightMm: 95 },
	{ id: 'hand', name: 'A hand', heightMm: 180 },
	{ id: 'person', name: 'A person', heightMm: 1750 },
];

const FIT = { id: 'resin-standard', minHeightMm: 41.3, maxHeightMm: 180, limitedBy: { min: 'wall', max: 'material' } };

describe('formatUsdc', () => {
	it('always shows two decimals, and keeps a credit negative', () => {
		expect(formatUsdc(6)).toBe('6.00');
		expect(formatUsdc(34.375)).toBe('34.38');
		expect(formatUsdc(-6.06)).toBe('-6.06');
	});
	it('returns empty for anything that is not a number', () => {
		expect(formatUsdc(undefined)).toBe('');
		expect(formatUsdc('free')).toBe('');
	});
});

describe('formatMm', () => {
	it('drops needless precision as the number grows', () => {
		expect(formatMm(6.42)).toBe('6.4 mm');
		expect(formatMm(35)).toBe('35 mm');
		expect(formatMm(140.4)).toBe('140 mm');
	});
	it('switches to metres past a metre, which is where mm stops being readable', () => {
		expect(formatMm(1750)).toBe('1.75 m');
	});
	it('can omit the unit for dimension triples', () => {
		expect(formatMm(35, { unit: false })).toBe('35');
	});
});

describe('formatLeadTime', () => {
	it('counts days up to a fortnight, then weeks', () => {
		expect(formatLeadTime(12)).toBe('About 12 days to your door');
		expect(formatLeadTime(22)).toBe('About 3 weeks to your door');
	});
	it('never promises a timeline it was not given', () => {
		expect(formatLeadTime(0)).toBe('Timing confirmed at checkout');
		expect(formatLeadTime(null)).toBe('Timing confirmed at checkout');
	});
});

describe('sliderBounds', () => {
	it('rounds inward so either end of the track still quotes', () => {
		const bounds = sliderBounds(FIT);
		expect(bounds.min).toBe(42); // ceil, never below the server's floor
		expect(bounds.max).toBe(180); // floor, never above the server's ceiling
	});
	it('labels the end of the track with the constraint that set it', () => {
		const bounds = sliderBounds({ ...FIT, limitedBy: { min: 'wall', max: 'build_volume' } });
		expect(bounds.minNote).toMatch(/thinnest wall/);
		expect(bounds.maxNote).toMatch(/print bed/);
	});
	it('coarsens the step on a long track so a drag stays on round numbers', () => {
		expect(sliderBounds({ ...FIT, minHeightMm: 12, maxHeightMm: 90 }).step).toBe(1);
		expect(sliderBounds({ ...FIT, minHeightMm: 12, maxHeightMm: 280 }).step).toBe(2);
		expect(sliderBounds({ ...FIT, minHeightMm: 12, maxHeightMm: 600 }).step).toBe(5);
	});
	it('returns nothing when no height works, so the panel hides instead of rendering an inverted track', () => {
		expect(sliderBounds({ ...FIT, minHeightMm: 340, maxHeightMm: 200 })).toBeNull();
		expect(sliderBounds(null)).toBeNull();
	});
});

describe('clampHeight', () => {
	const bounds = sliderBounds({ ...FIT, minHeightMm: 20, maxHeightMm: 200 });
	it('snaps onto the slider grid and holds inside both ends', () => {
		// This track spans 180 mm, so the step is 2 and the grid runs 20, 22, 24…
		expect(bounds.step).toBe(2);
		expect(clampHeight(101, bounds)).toBe(102);
		expect(clampHeight(102, bounds)).toBe(102);
		expect(clampHeight(5, bounds)).toBe(20);
		expect(clampHeight(9999, bounds)).toBe(200);
	});
	it('falls back to the low end rather than NaN', () => {
		expect(clampHeight('tall', bounds)).toBe(20);
	});
});

describe('defaultHeight', () => {
	const presets = [
		{ id: 'keychain', heightMm: 35 },
		{ id: 'desk', heightMm: 80 },
		{ id: 'shelf', heightMm: 140 },
		{ id: 'statement', heightMm: 200 },
	];
	it('opens on the largest preset that fits, not the smallest thing the machine makes', () => {
		expect(defaultHeight(sliderBounds({ ...FIT, minHeightMm: 20, maxHeightMm: 180 }), presets)).toBe(140);
	});
	it('falls back to the middle of the track when no preset is in range', () => {
		const bounds = sliderBounds({ ...FIT, minHeightMm: 150, maxHeightMm: 170 });
		expect(defaultHeight(bounds, presets)).toBe(160);
	});
});

describe('scaleReference', () => {
	it('picks the everyday object closest in magnitude, so both silhouettes stay legible', () => {
		expect(scaleReference(35, REFERENCES).reference.id).toBe('coin');
		expect(scaleReference(110, REFERENCES).reference.id).toBe('mug');
		expect(scaleReference(200, REFERENCES).reference.id).toBe('hand');
	});
	it('draws the taller of the two at full height and the other in true proportion', () => {
		const view = scaleReference(190, REFERENCES, 200); // beside a 180 mm hand
		expect(view.modelPx).toBe(200);
		expect(view.referencePx).toBe(Math.round((180 / 190) * 200));
	});
	it('never draws a silhouette too small to see', () => {
		expect(scaleReference(12, [{ id: 'person', name: 'A person', heightMm: 1750 }], 200).modelPx).toBeGreaterThanOrEqual(6);
	});
	it('says the comparison out loud in both directions', () => {
		expect(scaleReference(190, REFERENCES).caption).toMatch(/1\.1x a hand/);
		expect(scaleReference(48, REFERENCES).caption).toMatch(/percent of coffee mug/);
	});
	it('returns nothing rather than a broken drawing', () => {
		expect(scaleReference(0, REFERENCES)).toBeNull();
		expect(scaleReference(100, [])).toBeNull();
	});
});

describe('quoteRows', () => {
	const quote = {
		lines: [
			{ id: 'setup', label: 'Build setup', detail: 'Charged once', amount: 6 },
			{ id: 'material', label: 'Standard resin', detail: '62.5 cm3', amount: 34.38, estimate: false },
			{ id: 'holder_discount', label: '$THREE holder discount', detail: '', amount: -6.06 },
			{ id: 'shipping', label: 'Shipping', detail: '1.2 kg', amount: 12.45 },
		],
	};
	it('renders every engine line in order, with no arithmetic of its own', () => {
		const rows = quoteRows(quote);
		expect(rows.map((r) => r.id)).toEqual(['setup', 'material', 'holder_discount', 'shipping']);
		expect(rows.map((r) => r.amountText)).toEqual(['6.00', '34.38', '-6.06', '12.45']);
	});
	it('marks a discount as a credit so it can be toned differently', () => {
		expect(quoteRows(quote).find((r) => r.id === 'holder_discount').credit).toBe(true);
		expect(quoteRows(quote).find((r) => r.id === 'setup').credit).toBe(false);
	});
	it('is empty for a quote that never arrived', () => {
		expect(quoteRows(null)).toEqual([]);
	});
});

describe('printabilityView', () => {
	const report = {
		version: 1,
		score: 86,
		manifold: true,
		shells: 2,
		min_wall_mm: 11.7,
		bbox_mm: { x: 1188, y: 1985, z: 626 },
		has_textures: true,
		deductions: [
			{ id: 'open_edges', label: 'Open edges', detail: 'The surface has 42 holes.', points: 8 },
			{ id: 'loose_shells', label: 'Loose pieces', detail: 'Two shells are not joined.', points: 6 },
		],
	};
	it('bands the score generously at the top, because 80 prints beautifully', () => {
		expect(printabilityView({ ...report, score: 94 }).tone).toBe('great');
		expect(printabilityView({ ...report, score: 86 }).tone).toBe('good');
		expect(printabilityView({ ...report, score: 50 }).tone).toBe('fair');
		expect(printabilityView({ ...report, score: 10 }).tone).toBe('poor');
	});
	it('only offers a repair for the deductions a repair pass can actually resolve', () => {
		const view = printabilityView(report);
		expect(view.issues.find((i) => i.id === 'open_edges').repairable).toBe(true);
		expect(view.issues.find((i) => i.id === 'loose_shells').repairable).toBe(false);
		expect(view.repairableCount).toBe(1);
	});
	it('reports loose pieces as a fact a buyer should see, not a silent detail', () => {
		const facts = printabilityView(report).facts;
		expect(facts.find((f) => f.id === 'shells').value).toBe('2 loose pieces');
		expect(facts.find((f) => f.id === 'shells').ok).toBe(false);
	});
	it('holds the score inside 0 to 100 whatever it is handed', () => {
		expect(printabilityView({ ...report, score: 140 }).score).toBe(100);
		expect(printabilityView({ ...report, score: -5 }).score).toBe(0);
	});
});

describe('arScaleAttribute', () => {
	it('turns the quote scale into the three-axis attribute model-viewer reads', () => {
		expect(arScaleAttribute(0.0604286)).toBe('0.0604286 0.0604286 0.0604286');
	});
	it('refuses a scale that would place nothing, rather than defaulting to 1', () => {
		expect(arScaleAttribute(0)).toBeNull();
		expect(arScaleAttribute(-2)).toBeNull();
		expect(arScaleAttribute(undefined)).toBeNull();
	});
});

describe('rejectionView', () => {
	it('carries every failure with its own fix, not just the first', () => {
		const view = rejectionView({
			code: 'walls_too_thin',
			message: 'The thinnest wall would be 0.35 mm.',
			failures: [
				{ code: 'walls_too_thin', message: 'The thinnest wall would be 0.35 mm.', fix: 'Print at 43 mm or larger.', measured: 0.35, required: 0.6 },
			],
			alternatives: [{ id: 'nylon-sls', name: 'SLS nylon (PA12)', class: 'sls_nylon' }],
		});
		expect(view.fixes[0].fix).toMatch(/43 mm/);
		expect(view.alternatives[0].id).toBe('nylon-sls');
		expect(view.offerRepair).toBe(true);
	});
	it('does not offer a repair for a failure a repair cannot fix', () => {
		const view = rejectionView({
			code: 'exceeds_build_volume',
			message: 'Too wide.',
			failures: [{ code: 'exceeds_build_volume', message: 'Too wide.', fix: 'Print at 96 mm or under.' }],
			alternatives: [],
		});
		expect(view.offerRepair).toBe(false);
	});
});

describe('timelineView', () => {
	const events = [
		{ status: 'quoted', created_at: '2026-09-01T10:00:00Z', note: null },
		{ status: 'paid', created_at: '2026-09-01T10:04:00Z', note: null },
		{ status: 'screening', created_at: '2026-09-01T10:05:00Z', note: null },
		{ status: 'submitted', created_at: '2026-09-01T12:00:00Z', note: 'Sent to the floor.' },
	];
	it('marks reached steps done, the live one current, and the rest upcoming', () => {
		const view = timelineView({ status: 'submitted' }, events);
		const byId = Object.fromEntries(view.steps.map((s) => [s.id, s.state]));
		expect(byId.quoted).toBe('done');
		expect(byId.submitted).toBe('current');
		expect(byId.printing).toBe('upcoming');
	});
	it('carries the real timestamp and the operator note onto the step', () => {
		const step = timelineView({ status: 'submitted' }, events).steps.find((s) => s.id === 'submitted');
		expect(step.at).toBe('2026-09-01T12:00:00Z');
		expect(step.note).toBe('Sent to the floor.');
	});
	it('stops the rail where a branch happened instead of promising the rest', () => {
		const view = timelineView({ status: 'rejected' }, [...events, { status: 'rejected', created_at: '2026-09-01T13:00:00Z', note: 'Failed the fabrication gate.' }]);
		expect(view.branch.status).toBe('rejected');
		expect(view.branch.event.note).toBe('Failed the fabrication gate.');
		expect(view.steps.find((s) => s.id === 'printing').state).toBe('stopped');
		expect(view.steps.find((s) => s.id === 'submitted').state).toBe('done');
	});
	it('handles an order with no events at all', () => {
		const view = timelineView({ status: 'created' }, []);
		expect(view.branch).toBeNull();
		expect(view.steps.every((s) => s.state === 'upcoming')).toBe(true);
	});
});

describe('validateShipping', () => {
	const good = { name: 'Ada Lovelace', line1: '1 Analytical Way', city: 'London', postal_code: 'EC1A 1BB', country: 'GB' };
	it('accepts the minimum the server accepts', () => {
		expect(validateShipping(good)).toEqual({ valid: true, errors: {} });
	});
	it('requires exactly the fields api/_lib/print-store.js requires', () => {
		for (const field of ['name', 'line1', 'city', 'postal_code', 'country']) {
			const check = validateShipping({ ...good, [field]: '' });
			expect(check.valid).toBe(false);
			expect(check.errors[field]).toBeTruthy();
		}
	});
	it('leaves the optional fields optional', () => {
		expect(validateShipping({ ...good, line2: '', region: '', phone: '' }).valid).toBe(true);
	});
	it('rejects a country that is not a two-letter code, the way the server does', () => {
		expect(validateShipping({ ...good, country: 'United Kingdom' }).errors.country).toBeTruthy();
	});
	it('holds every field to the 120 characters the column stores', () => {
		expect(validateShipping({ ...good, line1: 'x'.repeat(121) }).errors.line1).toBeTruthy();
		expect(validateShipping({ ...good, phone: 'x'.repeat(121) }).errors.phone).toBeTruthy();
	});
	it('offers only countries the quote engine can price', () => {
		expect(SHIPPING_COUNTRIES.every((c) => /^[A-Z]{2}$/.test(c.code))).toBe(true);
		expect(SHIPPING_COUNTRIES.some((c) => c.code === 'US')).toBe(true);
	});
});

describe('editionNote', () => {
	it('says nothing about an open edition nobody has printed', () => {
		expect(editionNote({ limit: null, issued: 0, remaining: null })).toBe('');
		expect(editionNote(null)).toBe('');
		expect(editionNote(undefined)).toBe('');
	});

	it('counts an open edition once copies exist', () => {
		expect(editionNote({ limit: null, issued: 4, remaining: null })).toBe(
			'Open edition · 4 printed so far, each with its own numbered certificate',
		);
	});

	it('tells a buyer which number they would be', () => {
		expect(editionNote({ limit: 25, issued: 2, remaining: 23 })).toBe(
			'Limited edition of 25 · you would be number 3, 23 left',
		);
	});

	it('says sold out rather than offering a number that cannot exist', () => {
		expect(editionNote({ limit: 5, issued: 5, remaining: 0 })).toBe('Limited edition of 5 · sold out');
	});
});
