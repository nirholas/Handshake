// The Materialize quote engine: the only place a print price is ever computed.
//
// Pure by construction. It takes a printability report (api/_lib/print/analyze.js),
// a material id, a target height, a quantity and a destination, and returns an
// itemization or a named rejection. No I/O, no clock beyond the expiry stamp, no
// database. Every surface that shows a buyer a number reads that number from
// here: the page, the operator console, the x402 challenge and the order row all
// call this function or read the itemization it produced. Nothing recomputes.
//
// Scaling is the heart of it. The analyzer measures the mesh at its native glTF
// size; the buyer chooses a height in millimetres. Volume goes as the cube of the
// scale factor and wall thickness goes linearly, so a figure that is too thin for
// resin at 60 mm is fine at 120 mm and costs eight times as much. Both facts are
// derived here, and both are shown to the buyer rather than being applied behind
// the price.

import { readFileSync } from 'node:fs';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { env } from '../env.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// Fields that exist for the owner tuning prices, not for the buyer reading them.
// The public catalog handler and every itemization strip these.
const INTERNAL_KEYS = new Set(['_sources', '_note', '_marginNote', '_quantityNote', '_volumetricNote', 'marginFraction']);

let cached = null;

function catalogPath() {
	// In dev and tests this module sits in api/_lib/print/; in the Cloud Run image
	// the whole repo is present, so the repo-relative path is the reliable one.
	return join(HERE, '..', '..', '..', 'data', 'print-catalog.json');
}

/** The full catalog, including owner-only fields. Read once per process. */
export function loadCatalog({ force = false } = {}) {
	if (!cached || force) cached = JSON.parse(readFileSync(catalogPath(), 'utf8'));
	return cached;
}

function stripInternal(value) {
	if (Array.isArray(value)) return value.map(stripInternal);
	if (value && typeof value === 'object') {
		const out = {};
		for (const [k, v] of Object.entries(value)) {
			if (INTERNAL_KEYS.has(k)) continue;
			out[k] = stripInternal(v);
		}
		return out;
	}
	return value;
}

/** The buyer-facing catalog: same data, minus margin and sourcing notes. */
export function publicCatalog(catalog = loadCatalog()) {
	return stripInternal(catalog);
}

export function findMaterial(materialId, catalog = loadCatalog()) {
	return catalog.materials.find((m) => m.id === materialId) || null;
}

export function findFinish(material, finishId) {
	if (!material) return null;
	if (!finishId) return material.finishes.find((f) => f.default) || material.finishes[0] || null;
	return material.finishes.find((f) => f.id === finishId) || null;
}

/** Destination country to shipping zone, falling back to the zone marked default. */
export function zoneForCountry(country, catalog = loadCatalog()) {
	const code = String(country || '').trim().toUpperCase();
	const zones = catalog.shipping.zones;
	return zones.find((z) => z.countries.includes(code)) || zones.find((z) => z.default) || zones[zones.length - 1];
}

function round(value, places = 2) {
	const f = 10 ** places;
	return Math.round((value + Number.EPSILON) * f) / f;
}

/**
 * What one unit weighs and how much box it takes, at the ordered size. Shipping
 * is charged on whichever is larger, which is why both are computed here rather
 * than in the shipping line.
 */
function unitPhysicals({ report, material, scale, volumeCm3, catalog }) {
	const packMm = catalog.shipping.packagingMm;
	const box = {
		x: report.bbox_mm.x * scale + packMm * 2,
		y: report.bbox_mm.y * scale + packMm * 2,
		z: report.bbox_mm.z * scale + packMm * 2,
	};
	return {
		massGrams: volumeCm3 * material.densityGramsPerCm3,
		boxCm3: (box.x / 10) * (box.y / 10) * (box.z / 10),
		boxMm: { x: round(box.x, 1), y: round(box.y, 1), z: round(box.z, 1) },
	};
}

/**
 * The heights at which THIS mesh can actually be printed in THIS material.
 *
 * The catalog's own min/max are a property of the machine; this narrows them by
 * the two properties of the mesh: its widest axis has to fit the bed, and its
 * thinnest wall has to survive at the chosen scale. The /materialize size slider
 * is bounded by this, which is why a buyer moving it never lands on a rejection
 * they could not have predicted.
 *
 * `limitedBy` names which constraint bit, so the UI can label the end of the
 * track ("as tall as the bed allows") instead of just stopping.
 *
 * @returns {{ minHeightMm: number, maxHeightMm: number, feasible: boolean,
 *   limitedBy: { min: string, max: string } }}
 */
export function fitHeightRange({ report, material }) {
	const heightMm = report?.bbox_mm?.y;
	if (!(heightMm > 0)) {
		return { minHeightMm: material.minHeightMm, maxHeightMm: material.maxHeightMm, feasible: false, limitedBy: { min: 'material', max: 'material' } };
	}

	let minHeightMm = material.minHeightMm;
	let minLimit = 'material';
	// Wall thickness scales linearly with height, so the smallest printable height
	// is the one where the thinnest measured wall reaches the material's minimum.
	if (report.min_wall_mm > 0) {
		const wallFloor = (material.minWallMm / report.min_wall_mm) * heightMm;
		if (wallFloor > minHeightMm) {
			minHeightMm = wallFloor;
			minLimit = 'wall';
		}
	}

	let maxHeightMm = material.maxHeightMm;
	let maxLimit = 'material';
	for (const axis of ['x', 'z']) {
		const span = report.bbox_mm?.[axis];
		if (!(span > 0)) continue;
		// Uniform scale: the height at which this axis exactly fills the bed.
		const cap = (material.maxBoundingBoxMm[axis] / span) * heightMm;
		if (cap < maxHeightMm) {
			maxHeightMm = cap;
			maxLimit = 'build_volume';
		}
	}

	return {
		minHeightMm: round(minHeightMm, 1),
		maxHeightMm: round(maxHeightMm, 1),
		feasible: maxHeightMm >= minHeightMm,
		limitedBy: { min: minLimit, max: maxLimit },
	};
}

/**
 * Every reason a mesh cannot be printed in a material, with the fix attached.
 * A rejection that only says "no" makes the buyer guess; each one here names the
 * measured number, the required number, and the action that resolves it.
 */
function constraintFailures({ report, material, targetHeightMm, scale }) {
	const failures = [];
	const scaledWall = report.min_wall_mm === null || report.min_wall_mm === undefined
		? null
		: report.min_wall_mm * scale;

	if (targetHeightMm < material.minHeightMm) {
		failures.push({
			code: 'below_min_height',
			message: `${material.name} cannot hold detail below ${material.minHeightMm} mm tall.`,
			fix: `Raise the size to at least ${material.minHeightMm} mm.`,
			measured: round(targetHeightMm, 1),
			required: material.minHeightMm,
		});
	}
	if (targetHeightMm > material.maxHeightMm) {
		failures.push({
			code: 'above_max_height',
			message: `${material.name} builds up to ${material.maxHeightMm} mm tall.`,
			fix: `Lower the size to ${material.maxHeightMm} mm or under, or choose a material with a larger bed.`,
			measured: round(targetHeightMm, 1),
			required: material.maxHeightMm,
		});
	}
	const box = material.maxBoundingBoxMm;
	for (const axis of ['x', 'z']) {
		const value = report.bbox_mm[axis] * scale;
		if (value > box[axis]) {
			// The fix is a number, not an instruction to fiddle: the tallest this
			// model can be printed in this material before its widest axis runs out
			// of bed. A slider that already clamps to fitHeightRange() rarely lands
			// here, but a deep link or an agent request can.
			const fits = Math.floor(fitHeightRange({ report, material }).maxHeightMm);
			failures.push({
				code: 'exceeds_build_volume',
				message: `At this size the model is ${round(value, 1)} mm across, over the ${box[axis]} mm build volume for ${material.name}.`,
				fix: fits >= material.minHeightMm
					? `Print it at ${fits} mm tall or under, or choose a material with a larger build volume.`
					: 'This model is too wide for this material at any printable height; choose a material with a larger build volume.',
				measured: round(value, 1),
				required: box[axis],
			});
			break;
		}
	}
	if (scaledWall !== null && scaledWall < material.minWallMm) {
		failures.push({
			code: 'walls_too_thin',
			message: `The thinnest wall would be ${round(scaledWall, 2)} mm, under the ${material.minWallMm} mm ${material.name} needs.`,
			fix: `Repair thickens thin walls automatically, or print at ${Math.ceil((material.minWallMm / scaledWall) * targetHeightMm)} mm tall or larger.`,
			measured: round(scaledWall, 2),
			required: material.minWallMm,
		});
	}
	if (material.requiresTexture && !report.has_textures) {
		failures.push({
			code: 'no_colour_data',
			message: `${material.name} prints the model's own colours, and this model carries no texture.`,
			fix: 'Choose a single-colour material, or print a textured version of this model.',
			measured: report.color_source || 'none',
			required: 'texture',
		});
	}
	return failures;
}

/**
 * Every material measured against THIS mesh: the height range it can actually be
 * printed at, and, when none exists, the reason in the buyer's words.
 *
 * The /materialize material cards render straight off this, so a card that cannot
 * take the model says why on its face rather than failing after it is clicked.
 */
export function materialFits({ report, catalog = loadCatalog() }) {
	return catalog.materials.map((material) => {
		const fit = fitHeightRange({ report, material });
		let blocked = null;
		if (material.requiresTexture && !report.has_textures) {
			blocked = `${material.name} prints the model's own colours, and this model has no texture.`;
		} else if (!fit.feasible) {
			blocked = fit.limitedBy.max === 'build_volume'
				? `This model is too wide for the ${material.name} build volume at any height that keeps its walls printable.`
				: `This model cannot hold a ${material.minWallMm} mm wall anywhere in the ${material.minHeightMm} to ${material.maxHeightMm} mm range ${material.name} prints.`;
		}
		return {
			id: material.id,
			name: material.name,
			class: material.class,
			minHeightMm: fit.minHeightMm,
			maxHeightMm: fit.maxHeightMm,
			limitedBy: fit.limitedBy,
			quoteOnRequest: Boolean(material.quoteOnRequest),
			hollowSupported: Boolean(material.hollow?.supported),
			blocked,
		};
	});
}

/**
 * Materials that would accept this mesh at this height. A rejection hands the
 * buyer this list so the next click is a working order rather than a retry.
 */
function alternativesFor({ report, targetHeightMm, catalog, excludeId }) {
	const out = [];
	for (const material of catalog.materials) {
		if (material.id === excludeId) continue;
		const scale = targetHeightMm / report.bbox_mm.y;
		if (constraintFailures({ report, material, targetHeightMm, scale }).length) continue;
		out.push({ id: material.id, name: material.name, class: material.class });
	}
	return out;
}

/**
 * Price a print.
 *
 * @param {object} args
 * @param {object} args.report     printability report, version 1
 * @param {string} args.materialId
 * @param {string} [args.finishId]
 * @param {number} args.targetHeightMm
 * @param {number} [args.quantity]
 * @param {string} args.country    ISO-3166 alpha-2 destination
 * @param {boolean} [args.hollow]  hollow when the material supports it
 * @param {number} [args.holderDiscountBps] from api/_lib/three-tier.js, capped here
 * @returns {{ ok: true, quote: object } | { ok: false, rejection: object }}
 */
export function quotePrint({
	report,
	materialId,
	finishId = null,
	targetHeightMm,
	quantity = 1,
	country,
	hollow = false,
	holderDiscountBps = 0,
	catalog = loadCatalog(),
}) {
	if (!report || report.version !== 1 || !report.bbox_mm?.y || !(report.volume_cm3 > 0)) {
		return { ok: false, rejection: { code: 'invalid_report', message: 'A version-1 printability report with a positive volume is required to quote.', failures: [] } };
	}
	const material = findMaterial(materialId, catalog);
	if (!material) {
		return { ok: false, rejection: { code: 'unknown_material', message: `No material with id "${materialId}".`, failures: [] } };
	}
	const finish = findFinish(material, finishId);
	if (!finish) {
		return { ok: false, rejection: { code: 'unknown_finish', message: `No finish "${finishId}" for ${material.name}.`, failures: [] } };
	}
	// An explicit 0, -3 or "many" is a caller error worth naming; only an absent
	// quantity defaults to one. Coercing a bad value silently would quote a
	// different order than the one that was asked for.
	const qty = quantity === null || quantity === undefined ? 1 : Math.floor(Number(quantity));
	if (!Number.isFinite(qty) || !(qty >= 1 && qty <= 500)) {
		return { ok: false, rejection: { code: 'invalid_quantity', message: 'Quantity must be between 1 and 500.', failures: [] } };
	}
	const height = Number(targetHeightMm);
	if (!(height > 0)) {
		return { ok: false, rejection: { code: 'invalid_height', message: 'A positive target height in millimetres is required.', failures: [] } };
	}

	const scale = height / report.bbox_mm.y;
	const failures = constraintFailures({ report, material, targetHeightMm: height, scale });
	if (failures.length) {
		return {
			ok: false,
			rejection: {
				code: failures[0].code,
				message: failures[0].message,
				failures,
				alternatives: alternativesFor({ report, targetHeightMm: height, catalog, excludeId: material.id }),
			},
		};
	}

	// Volume scales with the cube of the linear scale; surface area with the square.
	const solidVolumeCm3 = report.volume_cm3 * scale ** 3;
	const surfaceCm2 = (report.surface_area_cm2 ?? 0) * scale ** 2;
	const canHollow = Boolean(hollow && material.hollow?.supported);
	// A shell's volume is its surface times its wall thickness, which is the same
	// number the prepare step's erosion produces to within the wall's own curvature.
	// Never above the solid it came from, and never below a floor that keeps a tiny
	// print from quoting as free.
	const hollowVolumeCm3 = canHollow
		? Math.min(solidVolumeCm3, Math.max(surfaceCm2 * (material.hollow.wallMm / 10), solidVolumeCm3 * 0.15))
		: solidVolumeCm3;
	const volumeCm3 = round(hollowVolumeCm3, 3);

	const physicals = unitPhysicals({ report, material, scale, volumeCm3, catalog });

	const lines = [];
	const setup = round(material.setupFee, 2);
	lines.push({
		id: 'setup',
		label: `Build setup, ${material.name}`,
		detail: 'Machine preparation and file staging, charged once per model.',
		amount: setup,
	});

	const materialAmount = round(material.ratePerCm3 * volumeCm3 * qty, 2);
	lines.push({
		id: 'material',
		label: material.name,
		detail: `${volumeCm3} cm3 at ${material.ratePerCm3.toFixed(2)} USDC per cm3${canHollow ? `, hollowed to a ${material.hollow.wallMm} mm wall` : ''}${qty > 1 ? ` x ${qty}` : ''}.`,
		amount: materialAmount,
		volumeCm3,
		estimate: Boolean(material.rateEstimate),
	});

	const finishAmount = round((finish.fee || 0) * qty, 2);
	if (finishAmount > 0) {
		lines.push({
			id: 'finish',
			label: finish.name,
			detail: qty > 1 ? `Applied to all ${qty} pieces.` : 'Applied after printing.',
			amount: finishAmount,
		});
	}

	const discountable = setup + materialAmount + finishAmount;

	const breaks = catalog.pricing.quantityBreaks
		.filter((b) => qty >= b.minQuantity)
		.sort((a, b) => b.discountBps - a.discountBps);
	let quantityAmount = 0;
	if (breaks.length) {
		quantityAmount = -round((discountable * breaks[0].discountBps) / 10_000, 2);
		lines.push({
			id: 'quantity_break',
			label: `Quantity break, ${breaks[0].minQuantity}+`,
			detail: `One setup and one prepared file serve the whole run, so ${breaks[0].discountBps / 100} percent comes off.`,
			amount: quantityAmount,
		});
	}

	const cappedBps = Math.max(0, Math.min(Number(holderDiscountBps) || 0, catalog.pricing.holderDiscount.maxBps));
	let holderAmount = 0;
	if (cappedBps > 0) {
		holderAmount = -round(((discountable + quantityAmount) * cappedBps) / 10_000, 2);
		lines.push({
			id: 'holder_discount',
			label: `$THREE holder discount, ${cappedBps / 100} percent`,
			detail: 'Applied to setup, material and finish. Shipping is passed through at cost.',
			amount: holderAmount,
			bps: cappedBps,
		});
	}

	const zone = zoneForCountry(country, catalog);
	const volumetricKg = (physicals.boxCm3 * qty) / catalog.shipping.volumetricDivisor;
	const realKg = (physicals.massGrams * qty) / 1000;
	const chargeableKg = Math.max(catalog.shipping.minChargeableKg, volumetricKg, realKg);
	const shippingAmount = round(zone.baseFee + zone.perKg * chargeableKg, 2);
	lines.push({
		id: 'shipping',
		label: `Shipping to ${zone.name}`,
		detail: `${round(chargeableKg, 2)} chargeable kg${volumetricKg > realKg ? ' (volumetric)' : ''}, ${zone.transitDays} days in transit.`,
		amount: shippingAmount,
		zone: zone.id,
	});

	const subtotal = round(lines.reduce((sum, l) => sum + l.amount, 0), 2);
	const minimum = catalog.pricing.minOrderUsdc;
	let total = subtotal;
	if (subtotal < minimum) {
		const topUp = round(minimum - subtotal, 2);
		lines.push({
			id: 'minimum',
			label: 'Order minimum',
			detail: `Every order carries a ${minimum} USDC floor; this one came in under it.`,
			amount: topUp,
		});
		total = minimum;
	}

	const leadTimeDays = material.leadTimeDays + (finish.leadTimeDays || 0) + zone.transitDays;

	return {
		ok: true,
		quote: {
			version: 1,
			currency: catalog.currency,
			chain: catalog.chain,
			material: { id: material.id, name: material.name, class: material.class },
			finish: { id: finish.id, name: finish.name },
			targetHeightMm: round(height, 1),
			quantity: qty,
			hollow: canHollow,
			country: String(country || '').trim().toUpperCase() || null,
			shippingZone: zone.id,
			geometry: {
				scale: round(scale, 6),
				volumeCm3,
				solidVolumeCm3: round(solidVolumeCm3, 3),
				massGramsEach: round(physicals.massGrams, 1),
				boxMm: physicals.boxMm,
				chargeableKg: round(chargeableKg, 2),
				minWallAtSizeMm: report.min_wall_mm === null || report.min_wall_mm === undefined ? null : round(report.min_wall_mm * scale, 2),
			},
			lines,
			subtotal,
			total,
			leadTimeDays,
			quoteOnRequest: Boolean(material.quoteOnRequest),
			estimate: Boolean(material.rateEstimate),
		},
	};
}

// Quote tokens. Same construction and the same secret as the forge job handles:
// an HMAC over a compact payload, prefix-tagged so a token's kind is readable
// before it is verified. The token carries every priced parameter, so checkout
// re-derives what it charges from the token and never from the request body.
const TOKEN_PREFIX = 'pq1';

function sign(payload) {
	return createHmac('sha256', env.JWT_SECRET).update(payload).digest('base64url');
}

/**
 * @param {object} quote the itemization from quotePrint
 * @param {{ reportHash: string, sourceUrl?: string, creationId?: string, ttlSeconds?: number }} context
 */
export function signQuote(quote, context) {
	const ttl = context.ttlSeconds ?? loadCatalog().pricing.quoteTtlSeconds;
	const body = {
		v: 1,
		m: quote.material.id,
		f: quote.finish.id,
		h: quote.targetHeightMm,
		q: quote.quantity,
		w: quote.hollow ? 1 : 0,
		c: quote.country,
		t: quote.total,
		g: quote.geometry.volumeCm3,
		l: quote.leadTimeDays,
		r: context.reportHash,
		u: context.sourceUrl || null,
		i: context.creationId || null,
		exp: Math.floor(Date.now() / 1000) + ttl,
	};
	const payload = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
	return `${TOKEN_PREFIX}.${payload}.${sign(payload)}`;
}

/**
 * Verify and decode a quote token. Returns null for anything that is not a
 * currently-valid token this server signed, which is the single check checkout
 * makes before it charges: a tampered price, a stale price and a forged token
 * all fail here identically.
 */
export function verifyQuote(token, { now = Date.now() } = {}) {
	if (typeof token !== 'string' || !token.startsWith(`${TOKEN_PREFIX}.`)) return null;
	const parts = token.split('.');
	if (parts.length !== 3) return null;
	const [, payload, signature] = parts;
	if (!payload || !signature) return null;
	try {
		const expected = Buffer.from(sign(payload), 'utf8');
		const actual = Buffer.from(signature, 'utf8');
		if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
		const body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
		if (body.v !== 1 || !body.exp || body.exp * 1000 < now) return null;
		return {
			materialId: body.m,
			finishId: body.f,
			targetHeightMm: body.h,
			quantity: body.q,
			hollow: body.w === 1,
			country: body.c,
			total: body.t,
			volumeCm3: body.g,
			leadTimeDays: body.l,
			reportHash: body.r,
			sourceUrl: body.u,
			creationId: body.i,
			expiresAt: body.exp * 1000,
		};
	} catch {
		return null;
	}
}
