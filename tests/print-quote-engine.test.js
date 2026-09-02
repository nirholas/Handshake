// The Materialize quote engine: the only place a print price is computed.
//
// Every number a buyer, an operator or a paying agent sees comes out of these
// functions, so the tests below hold the two properties that matter. First, the
// arithmetic: volume goes as the cube of the linear scale, so the same mesh at
// twice the height costs eight times the material, and a mistake here is a
// mispriced physical object nobody can un-ship. Second, the token: a price that
// can be edited in flight is not a price, so a tampered, expired or foreign
// token has to fail exactly like a forged one.
import { describe, it, expect, beforeAll } from 'vitest';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

import {
	fitHeightRange,
	findMaterial,
	loadCatalog,
	materialFits,
	publicCatalog,
	quotePrint,
	signQuote,
	verifyQuote,
	zoneForCountry,
} from '../api/_lib/print/quote.js';

// A version-1 report shaped exactly like api/_lib/print/analyze.js emits: a
// 100 mm tall mesh, 62.5 cm3 of solid, with a 1.4 mm thinnest wall at that size.
const REPORT = Object.freeze({
	version: 1,
	bbox_mm: { x: 60, y: 100, z: 45, diagonal: 125 },
	volume_cm3: 62.5,
	surface_area_cm2: 190,
	min_wall_mm: 1.4,
	triangles: 30000,
	has_textures: true,
	color_source: 'texture',
	manifold: true,
	shells: 1,
	score: 86,
});

const base = { report: REPORT, targetHeightMm: 100, country: 'US' };
const amountOf = (quote, id) => quote.lines.find((l) => l.id === id)?.amount;

let catalog;
beforeAll(() => {
	catalog = loadCatalog();
});

describe('the catalog itself', () => {
	it('cites a real source and a retrieval date for every rate it sets', () => {
		expect(catalog._sources.length).toBeGreaterThan(0);
		for (const source of catalog._sources) {
			expect(source.url).toMatch(/^https:\/\//);
			expect(source.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		}
	});
	it('gives every material the constraints the engine needs to reject on', () => {
		for (const material of catalog.materials) {
			expect(material.minWallMm).toBeGreaterThan(0);
			expect(material.maxBoundingBoxMm.x).toBeGreaterThan(0);
			expect(material.finishes.length).toBeGreaterThan(0);
			expect(material.ratePerCm3).toBeGreaterThan(0);
		}
	});
	it('never shows a buyer the declared margin or the sourcing notes', () => {
		const view = publicCatalog();
		expect(view._sources).toBeUndefined();
		expect(view.pricing.marginFraction).toBeUndefined();
		expect(view.pricing.holderDiscount.maxBps).toBe(catalog.pricing.holderDiscount.maxBps);
	});
});

describe('quotePrint arithmetic', () => {
	it('charges the measured volume at the material rate', () => {
		const resin = findMaterial('resin-standard');
		const { quote } = quotePrint({ ...base, materialId: 'resin-standard' });
		expect(quote.geometry.volumeCm3).toBe(62.5);
		expect(amountOf(quote, 'material')).toBeCloseTo(resin.ratePerCm3 * 62.5, 2);
		expect(amountOf(quote, 'setup')).toBe(resin.setupFee);
	});

	it('scales volume with the cube of the height, which is what a print actually costs', () => {
		const small = quotePrint({ ...base, materialId: 'resin-standard', targetHeightMm: 60 });
		const large = quotePrint({ ...base, materialId: 'resin-standard', targetHeightMm: 120 });
		expect(large.quote.geometry.volumeCm3 / small.quote.geometry.volumeCm3).toBeCloseTo(8, 3);
	});

	it('charges material per unit but setup once, because one setup serves the run', () => {
		const one = quotePrint({ ...base, materialId: 'resin-standard', quantity: 1 });
		const four = quotePrint({ ...base, materialId: 'resin-standard', quantity: 4 });
		expect(amountOf(four.quote, 'material')).toBeCloseTo(amountOf(one.quote, 'material') * 4, 2);
		expect(amountOf(four.quote, 'setup')).toBe(amountOf(one.quote, 'setup'));
	});

	it('applies the quantity break at the catalog thresholds and no earlier', () => {
		expect(amountOf(quotePrint({ ...base, materialId: 'resin-standard', quantity: 4 }).quote, 'quantity_break')).toBeUndefined();
		const five = quotePrint({ ...base, materialId: 'resin-standard', quantity: 5 }).quote;
		const twenty = quotePrint({ ...base, materialId: 'resin-standard', quantity: 20 }).quote;
		expect(amountOf(five, 'quantity_break')).toBeLessThan(0);
		expect(amountOf(twenty, 'quantity_break')).toBeLessThan(amountOf(five, 'quantity_break'));
	});

	it('hollows to the material wall and never quotes more than the solid it came from', () => {
		const solid = quotePrint({ ...base, materialId: 'resin-standard' }).quote;
		const hollow = quotePrint({ ...base, materialId: 'resin-standard', hollow: true }).quote;
		expect(hollow.hollow).toBe(true);
		expect(hollow.geometry.volumeCm3).toBeLessThan(solid.geometry.volumeCm3);
		expect(hollow.total).toBeLessThan(solid.total);
	});

	it('ignores a hollow request on a material that cannot be hollowed', () => {
		const quote = quotePrint({ ...base, materialId: 'nylon-sls', hollow: true }).quote;
		expect(quote.hollow).toBe(false);
	});

	it('caps the $THREE holder discount and keeps it off shipping', () => {
		const cap = catalog.pricing.holderDiscount.maxBps;
		const plain = quotePrint({ ...base, materialId: 'resin-standard' }).quote;
		const genesis = quotePrint({ ...base, materialId: 'resin-standard', holderDiscountBps: 3000 }).quote;
		const line = genesis.lines.find((l) => l.id === 'holder_discount');
		expect(line.bps).toBe(cap);
		// The discountable base is setup plus material plus finish, never shipping.
		const discountable = amountOf(genesis, 'setup') + amountOf(genesis, 'material');
		expect(Math.abs(line.amount)).toBeCloseTo((discountable * cap) / 10_000, 2);
		expect(amountOf(genesis, 'shipping')).toBe(amountOf(plain, 'shipping'));
	});

	it('never renders a discount the buyer did not earn', () => {
		const quote = quotePrint({ ...base, materialId: 'resin-standard', holderDiscountBps: 0 }).quote;
		expect(quote.lines.some((l) => l.id === 'holder_discount')).toBe(false);
	});

	it('charges shipping on the volumetric weight when the box outgrows the grams', () => {
		const near = quotePrint({ ...base, materialId: 'resin-standard', country: 'CN' }).quote;
		const far = quotePrint({ ...base, materialId: 'resin-standard', country: 'AU' }).quote;
		expect(zoneForCountry('CN').id).toBe('cn');
		expect(zoneForCountry('AU').id).toBe('row'); // no explicit zone, falls to the default
		expect(amountOf(far, 'shipping')).toBeGreaterThan(amountOf(near, 'shipping'));
		expect(near.geometry.chargeableKg).toBeGreaterThan(near.geometry.massGramsEach / 1000);
	});

	it('lifts a tiny order to the catalog floor rather than quoting it at a loss', () => {
		const tiny = quotePrint({
			...base,
			report: { ...REPORT, volume_cm3: 0.4, surface_area_cm2: 6, bbox_mm: { x: 10, y: 20, z: 10, diagonal: 24 } },
			materialId: 'pla-draft',
			targetHeightMm: 22,
			country: 'CN',
		}).quote;
		expect(tiny.total).toBe(catalog.pricing.minOrderUsdc);
		expect(tiny.lines.some((l) => l.id === 'minimum')).toBe(true);
	});

	it('prices metal as an estimate and marks it for a human', () => {
		const quote = quotePrint({ ...base, materialId: 'steel-316l', targetHeightMm: 80 }).quote;
		expect(quote.quoteOnRequest).toBe(true);
		expect(quote.estimate).toBe(true);
	});
});

describe('quotePrint rejections', () => {
	it('refuses a wall the material cannot hold, and names the height that would work', () => {
		const result = quotePrint({ ...base, materialId: 'resin-standard', targetHeightMm: 25 });
		expect(result.ok).toBe(false);
		expect(result.rejection.code).toBe('walls_too_thin');
		expect(result.rejection.failures[0].measured).toBeCloseTo(0.35, 2);
		expect(result.rejection.failures[0].required).toBe(0.6);
		expect(result.rejection.failures[0].fix).toMatch(/\d+ mm tall or larger/);
	});

	it('refuses a footprint over the bed, and names the height that fits', () => {
		const wide = { ...REPORT, bbox_mm: { x: 400, y: 100, z: 400, diagonal: 580 } };
		const result = quotePrint({ ...base, report: wide, materialId: 'resin-standard', targetHeightMm: 160 });
		expect(result.ok).toBe(false);
		expect(result.rejection.code).toBe('exceeds_build_volume');
		expect(result.rejection.failures[0].fix).toMatch(/47 mm tall or under/);
	});

	it('refuses full colour on a mesh with no colour data', () => {
		const result = quotePrint({
			...base,
			report: { ...REPORT, has_textures: false, color_source: 'none' },
			materialId: 'sandstone-full-color',
			targetHeightMm: 150,
		});
		expect(result.ok).toBe(false);
		expect(result.rejection.code).toBe('no_colour_data');
	});

	it('hands back the materials that would take the mesh, so the next click works', () => {
		const result = quotePrint({ ...base, materialId: 'sandstone-full-color', targetHeightMm: 120 });
		expect(result.ok).toBe(false);
		for (const alternative of result.rejection.alternatives) {
			expect(quotePrint({ ...base, materialId: alternative.id, targetHeightMm: 120 }).ok).toBe(true);
		}
	});

	it('refuses input it cannot price rather than inventing a number', () => {
		expect(quotePrint({ ...base, materialId: 'no-such-material' }).rejection.code).toBe('unknown_material');
		expect(quotePrint({ ...base, materialId: 'resin-standard', finishId: 'gold-leaf' }).rejection.code).toBe('unknown_finish');
		expect(quotePrint({ ...base, materialId: 'resin-standard', quantity: 0 }).rejection.code).toBe('invalid_quantity');
		expect(quotePrint({ ...base, materialId: 'resin-standard', targetHeightMm: 0 }).rejection.code).toBe('invalid_height');
		expect(quotePrint({ ...base, report: { version: 2 }, materialId: 'resin-standard' }).rejection.code).toBe('invalid_report');
	});
});

describe('fitHeightRange and materialFits', () => {
	it('narrows the machine range by this mesh, from both ends', () => {
		const fit = fitHeightRange({ report: REPORT, material: findMaterial('resin-standard') });
		// The 1.4 mm wall at 100 mm reaches resin's 0.6 mm floor at 42.9 mm.
		expect(fit.minHeightMm).toBeCloseTo(42.9, 1);
		expect(fit.limitedBy.min).toBe('wall');
		expect(fit.maxHeightMm).toBe(180);
		expect(fit.limitedBy.max).toBe('material');
	});

	it('lets the build volume set the ceiling when the mesh is wide', () => {
		const wide = { ...REPORT, bbox_mm: { x: 400, y: 100, z: 400, diagonal: 580 } };
		const fit = fitHeightRange({ report: wide, material: findMaterial('resin-standard') });
		expect(fit.maxHeightMm).toBeCloseTo(47.5, 1);
		expect(fit.limitedBy.max).toBe('build_volume');
	});

	it('agrees with quotePrint at both ends of the range it publishes', () => {
		for (const fit of materialFits({ report: REPORT })) {
			if (fit.blocked || fit.quoteOnRequest) continue;
			for (const height of [Math.ceil(fit.minHeightMm), Math.floor(fit.maxHeightMm)]) {
				const result = quotePrint({ ...base, materialId: fit.id, targetHeightMm: height });
				expect(result.ok, `${fit.id} at ${height} mm: ${result.rejection?.message}`).toBe(true);
			}
		}
	});

	it('says why a material cannot take the mesh at any height', () => {
		const fits = materialFits({ report: { ...REPORT, has_textures: false } });
		expect(fits.find((f) => f.id === 'sandstone-full-color').blocked).toMatch(/colours/);
		const thin = materialFits({ report: { ...REPORT, min_wall_mm: 0.2 } });
		expect(thin.find((f) => f.id === 'sandstone-full-color').blocked).toBeTruthy();
	});
});

describe('quote tokens', () => {
	const quoteFor = (overrides = {}) => quotePrint({ ...base, materialId: 'resin-standard', ...overrides }).quote;

	it('round-trips every priced parameter, so checkout never reads the request body', () => {
		const quote = quoteFor({ quantity: 3, country: 'DE' });
		const decoded = verifyQuote(signQuote(quote, { reportHash: 'abc', sourceUrl: 'https://example.com/a.glb' }));
		expect(decoded.materialId).toBe('resin-standard');
		expect(decoded.quantity).toBe(3);
		expect(decoded.country).toBe('DE');
		expect(decoded.total).toBe(quote.total);
		expect(decoded.targetHeightMm).toBe(quote.targetHeightMm);
		expect(decoded.reportHash).toBe('abc');
	});

	it('refuses a token whose payload was edited to a cheaper price', () => {
		const token = signQuote(quoteFor(), { reportHash: 'abc' });
		const [prefix, payload, signature] = token.split('.');
		const body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
		body.t = 1;
		const forged = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
		expect(verifyQuote(`${prefix}.${forged}.${signature}`)).toBeNull();
	});

	it('refuses a token past its expiry, however well signed', () => {
		const token = signQuote(quoteFor(), { reportHash: 'abc', ttlSeconds: 60 });
		expect(verifyQuote(token)).not.toBeNull();
		expect(verifyQuote(token, { now: Date.now() + 61_000 })).toBeNull();
	});

	it('refuses anything that is not one of our tokens', () => {
		expect(verifyQuote('')).toBeNull();
		expect(verifyQuote('pq1.only-two-parts')).toBeNull();
		expect(verifyQuote('f1.abc.def')).toBeNull(); // a forge job handle, not a quote
		expect(verifyQuote(null)).toBeNull();
	});
});
