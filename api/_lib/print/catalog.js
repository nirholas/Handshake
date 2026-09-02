// Materialize catalog loader: data/print-catalog.json, validated once at module
// load, projected two ways.
//
// The file is data and the owner tunes it; this module is the only thing that
// reads it. It fails LOUDLY at import time on a malformed catalog rather than
// at request time, because a catalog that lost its shipping zones or grew a
// negative rate is a pricing incident, and the deploy is the right place to
// find out.
//
// Two projections:
//   PRINT_CATALOG   the full record, including the owner-only fields
//                   (margin_fraction, _sources, the _note keys).
//   publicCatalog() what GET /api/print/catalog serves: buyer-facing only.
//                   Margin and sourcing are ours, not the buyer's.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CATALOG_PATH = fileURLToPath(new URL('../../../data/print-catalog.json', import.meta.url));

const MATERIAL_CLASSES = new Set([
	'resin',
	'sls_nylon',
	'full_color',
	'fdm_draft',
	'metal_quote_only',
]);

function fail(message) {
	throw new Error(`print-catalog: ${message}`);
}

function positiveNumber(value, label) {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
		fail(`${label} must be a positive number, got ${JSON.stringify(value)}`);
	}
	return value;
}

function nonNegativeNumber(value, label) {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
		fail(`${label} must be a non-negative number, got ${JSON.stringify(value)}`);
	}
	return value;
}

function validateFinish(finish, materialId) {
	const where = `material ${materialId} finish ${finish?.id}`;
	if (!finish?.id || typeof finish.id !== 'string') fail(`${where}: missing id`);
	if (!finish.name) fail(`${where}: missing name`);
	nonNegativeNumber(finish.fee_usd, `${where}.fee_usd`);
	nonNegativeNumber(finish.fee_usd_cm3, `${where}.fee_usd_cm3`);
	nonNegativeNumber(finish.lead_time_days, `${where}.lead_time_days`);
}

function validateMaterial(material) {
	const id = material?.id;
	if (!id || typeof id !== 'string') fail('a material is missing its id');
	if (!MATERIAL_CLASSES.has(material.class)) {
		fail(`material ${id}: unknown class ${JSON.stringify(material.class)}`);
	}
	if (!material.name) fail(`material ${id}: missing name`);
	positiveNumber(material.density_g_cm3, `material ${id}.density_g_cm3`);
	nonNegativeNumber(material.rate_usd_cm3, `material ${id}.rate_usd_cm3`);
	nonNegativeNumber(material.setup_fee_usd, `material ${id}.setup_fee_usd`);
	positiveNumber(material.min_wall_mm, `material ${id}.min_wall_mm`);
	positiveNumber(material.min_height_mm, `material ${id}.min_height_mm`);
	positiveNumber(material.max_height_mm, `material ${id}.max_height_mm`);
	if (material.max_height_mm <= material.min_height_mm) {
		fail(`material ${id}: max_height_mm must exceed min_height_mm`);
	}
	if (!Array.isArray(material.max_bbox_mm) || material.max_bbox_mm.length !== 3) {
		fail(`material ${id}: max_bbox_mm must be three numbers`);
	}
	for (const [i, dim] of material.max_bbox_mm.entries()) {
		positiveNumber(dim, `material ${id}.max_bbox_mm[${i}]`);
	}
	nonNegativeNumber(material.lead_time_days, `material ${id}.lead_time_days`);
	if (typeof material.quote_only !== 'boolean') fail(`material ${id}: quote_only must be a boolean`);
	// A priced material with a zero rate would quote every print at the setup fee
	// alone. Only a quote-on-request material is allowed to carry no rate.
	if (!material.quote_only && material.rate_usd_cm3 <= 0) {
		fail(`material ${id}: a priced material needs a positive rate_usd_cm3`);
	}
	if (!Array.isArray(material.finishes) || material.finishes.length === 0) {
		fail(`material ${id}: needs at least one finish`);
	}
	for (const finish of material.finishes) validateFinish(finish, id);
	const finishIds = material.finishes.map((f) => f.id);
	if (new Set(finishIds).size !== finishIds.length) fail(`material ${id}: duplicate finish ids`);
}

function validateZone(zone) {
	const id = zone?.id;
	if (!id) fail('a shipping zone is missing its id');
	if (!zone.name) fail(`zone ${id}: missing name`);
	nonNegativeNumber(zone.base_usd, `zone ${id}.base_usd`);
	nonNegativeNumber(zone.per_kg_usd, `zone ${id}.per_kg_usd`);
	nonNegativeNumber(zone.transit_days, `zone ${id}.transit_days`);
	if (!Array.isArray(zone.countries)) fail(`zone ${id}: countries must be an array`);
	for (const code of zone.countries) {
		if (!/^[A-Z]{2}$/.test(code)) fail(`zone ${id}: ${JSON.stringify(code)} is not an ISO 3166-1 alpha-2 code`);
	}
}

function validate(catalog) {
	if (!Number.isInteger(catalog?.version) || catalog.version < 1) fail('version must be a positive integer');
	if (!Array.isArray(catalog.materials) || catalog.materials.length === 0) fail('no materials');
	for (const material of catalog.materials) validateMaterial(material);
	const ids = catalog.materials.map((m) => m.id);
	if (new Set(ids).size !== ids.length) fail('duplicate material ids');

	if (!Array.isArray(catalog.shipping_zones) || catalog.shipping_zones.length === 0) fail('no shipping zones');
	for (const zone of catalog.shipping_zones) validateZone(zone);
	const zoneIds = catalog.shipping_zones.map((z) => z.id);
	if (new Set(zoneIds).size !== zoneIds.length) fail('duplicate shipping zone ids');
	// Every zone but the fallback names its countries; the fallback names none,
	// and there must be exactly one of it or a destination could resolve nowhere.
	const fallbacks = catalog.shipping_zones.filter((z) => z.countries.length === 0);
	if (fallbacks.length !== 1) fail('exactly one shipping zone must be the empty-country fallback');
	const seen = new Set();
	for (const zone of catalog.shipping_zones) {
		for (const code of zone.countries) {
			if (seen.has(code)) fail(`country ${code} is claimed by more than one zone`);
			seen.add(code);
		}
	}

	const q = catalog.quote;
	positiveNumber(q?.ttl_seconds, 'quote.ttl_seconds');
	nonNegativeNumber(q?.minimum_manufacturing_usd, 'quote.minimum_manufacturing_usd');
	positiveNumber(q?.floor_price_usd, 'quote.floor_price_usd');
	positiveNumber(q?.max_quantity, 'quote.max_quantity');
	positiveNumber(q?.volumetric_divisor_cm3_per_kg, 'quote.volumetric_divisor_cm3_per_kg');
	nonNegativeNumber(q?.packaging_weight_kg, 'quote.packaging_weight_kg');
	positiveNumber(q?.max_parcel_weight_kg, 'quote.max_parcel_weight_kg');

	const hd = catalog.holder_discount;
	nonNegativeNumber(hd?.max_bps, 'holder_discount.max_bps');
	if (hd.max_bps > 10_000) fail('holder_discount.max_bps cannot exceed 10000');

	if (!Array.isArray(catalog.quantity_breaks)) fail('quantity_breaks must be an array');
	let previousQuantity = 1;
	for (const brk of catalog.quantity_breaks) {
		positiveNumber(brk?.min_quantity, 'quantity_breaks[].min_quantity');
		nonNegativeNumber(brk?.discount_bps, 'quantity_breaks[].discount_bps');
		if (brk.discount_bps > 10_000) fail('a quantity break cannot exceed 10000 bps');
		// Ascending order is load-bearing: bestQuantityBreak() walks the list and
		// keeps the last match, so an unsorted list would silently under-discount.
		if (brk.min_quantity <= previousQuantity) fail('quantity_breaks must ascend by min_quantity');
		previousQuantity = brk.min_quantity;
	}

	if (!Array.isArray(catalog._sources) || catalog._sources.length === 0) fail('no _sources');
	for (const source of catalog._sources) {
		if (!source?.id || !source.url || !source.retrieved) fail('a _sources entry is missing id/url/retrieved');
	}
	const sourceIds = new Set(catalog._sources.map((s) => s.id));
	for (const material of catalog.materials) {
		for (const sid of material.source_ids || []) {
			if (!sourceIds.has(sid)) fail(`material ${material.id} cites unknown source ${sid}`);
		}
	}
	return catalog;
}

export const PRINT_CATALOG = Object.freeze(
	validate(JSON.parse(readFileSync(CATALOG_PATH, 'utf8'))),
);

const MATERIALS_BY_ID = new Map(PRINT_CATALOG.materials.map((m) => [m.id, m]));
const ZONES_BY_ID = new Map(PRINT_CATALOG.shipping_zones.map((z) => [z.id, z]));
const ZONE_BY_COUNTRY = new Map();
for (const zone of PRINT_CATALOG.shipping_zones) {
	for (const code of zone.countries) ZONE_BY_COUNTRY.set(code, zone);
}
const FALLBACK_ZONE = PRINT_CATALOG.shipping_zones.find((z) => z.countries.length === 0);

/** The material record for an id, or null. */
export function materialById(id) {
	return MATERIALS_BY_ID.get(String(id || '')) || null;
}

/** A material's finish record by id, or null. */
export function finishById(material, id) {
	return material?.finishes?.find((f) => f.id === String(id || '')) || null;
}

/** A shipping zone by its id, or null. */
export function zoneById(id) {
	return ZONES_BY_ID.get(String(id || '')) || null;
}

/**
 * The shipping zone serving a destination country. An unrecognized or absent
 * country resolves to the fallback zone rather than throwing: a destination we
 * have not named is still a destination we ship to, at the rest-of-world rate.
 */
export function zoneForCountry(country) {
	const code = String(country || '').trim().toUpperCase();
	return ZONE_BY_COUNTRY.get(code) || FALLBACK_ZONE;
}

/** ISO alpha-2 shape check, so a quote never prices "United States" as row. */
export function isCountryCode(country) {
	return /^[A-Za-z]{2}$/.test(String(country || '').trim());
}

function publicFinish(finish) {
	return {
		id: finish.id,
		name: finish.name,
		blurb: finish.blurb || '',
		fee_usd: finish.fee_usd,
		fee_usd_cm3: finish.fee_usd_cm3,
		lead_time_days: finish.lead_time_days,
	};
}

function publicMaterial(material) {
	return {
		id: material.id,
		name: material.name,
		class: material.class,
		blurb: material.blurb || '',
		density_g_cm3: material.density_g_cm3,
		rate_usd_cm3: material.rate_usd_cm3,
		setup_fee_usd: material.setup_fee_usd,
		min_wall_mm: material.min_wall_mm,
		min_height_mm: material.min_height_mm,
		max_height_mm: material.max_height_mm,
		max_bbox_mm: material.max_bbox_mm,
		lead_time_days: material.lead_time_days,
		quote_only: material.quote_only,
		color_capable: material.color_capable === true,
		finishes: material.finishes.map(publicFinish),
	};
}

function publicZone(zone) {
	return {
		id: zone.id,
		name: zone.name,
		base_usd: zone.base_usd,
		per_kg_usd: zone.per_kg_usd,
		transit_days: zone.transit_days,
		countries: zone.countries,
	};
}

/**
 * The buyer-facing catalog: everything a human or an agent needs to choose a
 * material and predict a price, and nothing about our margin or our sourcing.
 */
export function publicCatalog() {
	return {
		version: PRINT_CATALOG.version,
		updated: PRINT_CATALOG.updated,
		currency: PRINT_CATALOG.currency,
		settlement: PRINT_CATALOG.settlement,
		quote: {
			ttl_seconds: PRINT_CATALOG.quote.ttl_seconds,
			minimum_manufacturing_usd: PRINT_CATALOG.quote.minimum_manufacturing_usd,
			floor_price_usd: PRINT_CATALOG.quote.floor_price_usd,
			max_quantity: PRINT_CATALOG.quote.max_quantity,
			max_parcel_weight_kg: PRINT_CATALOG.quote.max_parcel_weight_kg,
		},
		holder_discount: {
			max_bps: PRINT_CATALOG.holder_discount.max_bps,
			applies_to: PRINT_CATALOG.holder_discount.applies_to,
		},
		quantity_breaks: PRINT_CATALOG.quantity_breaks.map((b) => ({ ...b })),
		materials: PRINT_CATALOG.materials.map(publicMaterial),
		shipping_zones: PRINT_CATALOG.shipping_zones.map(publicZone),
	};
}
