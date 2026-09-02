// Pure view logic for /materialize.
//
// Everything in this file is a function of its arguments: no DOM, no fetch, no
// clock. It exists so the parts of the page that are easy to get subtly wrong
// (which scale reference to draw beside a 40 mm keychain, how a negative line
// renders in an itemization, where a slider's ends go for THIS mesh in THIS
// material) can be tested directly rather than eyeballed in a browser.
//
// The hard rule this file exists to protect: no price is ever computed here.
// Amounts arrive from the quote engine (api/_lib/print/quote.js) already
// decided, and these functions only choose how to say them.

/** A quoted amount as a buyer reads it. Negative lines keep their sign. */
export function formatUsdc(amount) {
	const n = Number(amount);
	if (!Number.isFinite(n)) return '';
	const sign = n < 0 ? '-' : '';
	return `${sign}${Math.abs(n).toFixed(2)}`;
}

/** Millimetres, at the precision the number deserves: 6.4 mm, 140 mm, 1.2 m. */
export function formatMm(mm, { unit = true } = {}) {
	const n = Number(mm);
	if (!Number.isFinite(n)) return '';
	if (n >= 1000) return `${(n / 1000).toFixed(2)}${unit ? ' m' : ''}`;
	const text = n >= 100 ? String(Math.round(n)) : n.toFixed(1).replace(/\.0$/, '');
	return `${text}${unit ? ' mm' : ''}`;
}

export function formatLeadTime(days) {
	const n = Math.round(Number(days) || 0);
	if (n <= 0) return 'Timing confirmed at checkout';
	if (n < 14) return `About ${n} days to your door`;
	const weeks = Math.round(n / 7);
	return `About ${weeks} weeks to your door`;
}

/**
 * Where the size slider's ends go for one material and one mesh.
 *
 * The server already measured both limits (api/_lib/print/quote.js
 * fitHeightRange), so this only turns them into a track: a step fine enough to
 * feel continuous, ends rounded inward so a drag to either extreme lands on a
 * height that quotes rather than one that rejects by a rounding error, and the
 * label the end of the track earns.
 */
export function sliderBounds(fit) {
	if (!fit || !(fit.maxHeightMm > 0)) return null;
	const min = Math.ceil(Number(fit.minHeightMm) || 0);
	const max = Math.floor(Number(fit.maxHeightMm) || 0);
	if (!(max > min)) return null;
	const span = max - min;
	// One step per pixel of a roughly 300px track, snapped to something a person
	// would say out loud.
	const step = span > 400 ? 5 : span > 120 ? 2 : 1;
	return {
		min,
		max,
		step,
		minNote: fit.limitedBy?.min === 'wall' ? 'Smallest size its thinnest wall survives' : 'Smallest size this material prints',
		maxNote: fit.limitedBy?.max === 'build_volume' ? 'As large as the print bed allows' : 'Largest size this material prints',
	};
}

/** Snap a height onto a slider's own grid, then hold it inside the ends. */
export function clampHeight(value, bounds) {
	if (!bounds) return value;
	const n = Number(value);
	if (!Number.isFinite(n)) return bounds.min;
	const snapped = bounds.min + Math.round((n - bounds.min) / bounds.step) * bounds.step;
	return Math.min(bounds.max, Math.max(bounds.min, snapped));
}

/**
 * The opening size: the largest catalog preset that fits, because a buyer
 * arriving with no opinion should land on something worth looking at rather
 * than on the smallest thing the machine can make. With no preset in range,
 * the middle of the track.
 */
export function defaultHeight(bounds, presets = []) {
	if (!bounds) return null;
	const inRange = presets
		.map((p) => Number(p.heightMm))
		.filter((h) => Number.isFinite(h) && h >= bounds.min && h <= bounds.max)
		.sort((a, b) => b - a);
	if (inRange.length) return clampHeight(inRange[0], bounds);
	return clampHeight(Math.round((bounds.min + bounds.max) / 2), bounds);
}

/**
 * Choose the everyday object to stand beside the print, and size both for the
 * drawing.
 *
 * A scale drawing only works when both silhouettes are legible: a 35 mm keychain
 * beside a person is a pixel next to a wall. So the reference chosen is the one
 * closest in magnitude to the print, and the taller of the two is drawn at the
 * full available height with the other in true proportion.
 *
 * @param {number} heightMm the ordered size
 * @param {Array<{id:string,name:string,heightMm:number}>} references
 * @param {number} canvasPx the tallest either silhouette may be drawn
 */
export function scaleReference(heightMm, references = [], canvasPx = 220) {
	const h = Number(heightMm);
	if (!(h > 0) || !references.length) return null;
	// Compare in log space: "twice as tall" and "half as tall" are equally
	// readable, and a linear distance would always pick the smallest reference.
	let best = null;
	for (const ref of references) {
		const refH = Number(ref.heightMm);
		if (!(refH > 0)) continue;
		const distance = Math.abs(Math.log(h / refH));
		if (!best || distance < best.distance) best = { ref, distance };
	}
	if (!best) return null;
	const refH = Number(best.ref.heightMm);
	const tallest = Math.max(h, refH);
	return {
		reference: best.ref,
		modelPx: Math.max(6, Math.round((h / tallest) * canvasPx)),
		referencePx: Math.max(6, Math.round((refH / tallest) * canvasPx)),
		ratio: h / refH,
		caption:
			h >= refH
				? `${formatMm(h)} tall, about ${(h / refH).toFixed(1)}x ${best.ref.name.toLowerCase()}`
				: `${formatMm(h)} tall, about ${Math.round((h / refH) * 100)} percent of ${best.ref.name.toLowerCase()}`,
	};
}

/**
 * The itemization as rows, ready to render. Discounts keep their own tone so a
 * buyer can see at a glance what came off, and the estimate flag rides through
 * from the engine rather than being inferred from the material id here.
 */
export function quoteRows(quote) {
	if (!quote?.lines) return [];
	return quote.lines.map((line) => ({
		id: line.id,
		label: line.label,
		detail: line.detail || '',
		amount: line.amount,
		amountText: formatUsdc(line.amount),
		credit: line.amount < 0,
		estimate: Boolean(line.estimate),
	}));
}

// How a score reads at a glance. The bands are deliberately generous at the top:
// a mesh at 80 prints beautifully, and calling that "fair" would push buyers into
// repairs they do not need.
const SCORE_BANDS = [
	{ min: 90, tone: 'great', label: 'Ready to print' },
	{ min: 70, tone: 'good', label: 'Prints well' },
	{ min: 45, tone: 'fair', label: 'Needs a repair pass' },
	{ min: 0, tone: 'poor', label: 'Heavy repair needed' },
];

/**
 * The printability card's whole content: the band, the headline facts a buyer
 * actually asks about, and the deductions as fixable line items.
 */
export function printabilityView(report) {
	if (!report) return null;
	const score = Math.max(0, Math.min(100, Math.round(Number(report.score) || 0)));
	const band = SCORE_BANDS.find((b) => score >= b.min) || SCORE_BANDS[SCORE_BANDS.length - 1];
	const facts = [
		{
			id: 'solid',
			label: 'Solid',
			value: report.manifold ? 'Watertight' : 'Open surface',
			ok: Boolean(report.manifold),
		},
		{
			id: 'shells',
			label: 'Pieces',
			value: report.shells === 1 ? 'One piece' : `${report.shells} loose pieces`,
			ok: report.shells === 1,
		},
		{
			id: 'wall',
			label: 'Thinnest wall',
			value: report.min_wall_mm ? `${(report.min_wall_mm / (report.bbox_mm?.y || 1) * 100).toFixed(2)} percent of height` : 'Not measured',
			ok: Boolean(report.min_wall_mm),
		},
		{
			id: 'colour',
			label: 'Colour',
			value: report.has_textures ? 'Textured, can print in full colour' : 'Single colour',
			ok: true,
		},
	];
	const issues = (report.deductions || []).map((d) => ({
		id: d.id,
		label: d.label || d.id,
		detail: d.detail || d.message || '',
		points: d.points,
		// Repair closes shells, drops slivers and re-winds faces. It cannot invent
		// colour data or decide a mesh is one object, so those are stated as facts
		// rather than offered as a button that would do nothing.
		repairable: REPAIRABLE.has(d.id),
	}));
	return { score, tone: band.tone, label: band.label, facts, issues, repairableCount: issues.filter((i) => i.repairable).length };
}

const REPAIRABLE = new Set([
	'not_manifold',
	'open_edges',
	'open_shell',
	'non_manifold_edges',
	'self_intersections',
	'degenerate_triangles',
	'inconsistent_winding',
	'triangle_budget',
	'thin_walls',
]);

/**
 * The `scale` attribute that makes model-viewer place the object at its real
 * ordered size in AR.
 *
 * model-viewer measures AR in glTF units, where one unit is one metre, and
 * `ar-scale="fixed"` tells it not to let the viewer resize what it placed. The
 * source mesh is at whatever size the generator emitted, so the factor is
 * exactly the quote's own scale: ordered height over native height. Getting this
 * wrong is invisible on a desktop and obvious on a table, which is why it comes
 * from the same number the price was computed from.
 */
export function arScaleAttribute(scale) {
	const s = Number(scale);
	if (!Number.isFinite(s) || s <= 0) return null;
	const value = s.toPrecision(8).replace(/0+$/, '').replace(/\.$/, '');
	return `${value} ${value} ${value}`;
}

/**
 * Turn a rejection from the quote engine into what the panel shows: the reason,
 * the fix, and the buttons that resolve it. Never a bare error.
 */
export function rejectionView(rejection) {
	if (!rejection) return null;
	const failures = rejection.failures?.length ? rejection.failures : [{ code: rejection.code, message: rejection.message, fix: '' }];
	return {
		code: rejection.code,
		headline: failures[0].message,
		fixes: failures.map((f) => ({ code: f.code, message: f.message, fix: f.fix, measured: f.measured, required: f.required })),
		alternatives: rejection.alternatives || [],
		// A wall failure is the one a repair pass can actually resolve; the rest
		// are answered by a different size or a different material.
		offerRepair: failures.some((f) => f.code === 'walls_too_thin'),
	};
}

/** Order timeline steps, in the order they happen, with the ones that branch. */
export const ORDER_STEPS = Object.freeze([
	{ id: 'quoted', label: 'Quoted', blurb: 'Price locked from your model.' },
	{ id: 'paid', label: 'Paid', blurb: 'USDC settled on Solana.' },
	{ id: 'screening', label: 'Screened', blurb: 'Checked against what we can fabricate.' },
	{ id: 'submitted', label: 'Submitted', blurb: 'Handed to the print floor.' },
	{ id: 'printing', label: 'Printing', blurb: 'On the machine.' },
	{ id: 'quality_check', label: 'Checked', blurb: 'Inspected and finished.' },
	{ id: 'shipped', label: 'Shipped', blurb: 'On its way to you.' },
	{ id: 'delivered', label: 'Delivered', blurb: 'In your hands.' },
]);

const BRANCH_STATUSES = new Set(['rejected', 'canceled', 'refunded']);

/**
 * The tracking rail: every step with its state and the real timestamp from the
 * event log. A branch status (rejected, canceled, refunded) stops the rail where
 * it happened rather than pretending the remaining steps are still coming.
 */
export function timelineView(order, events = []) {
	const byStatus = new Map();
	for (const e of events) if (!byStatus.has(e.status)) byStatus.set(e.status, e);
	const branch = BRANCH_STATUSES.has(order?.status) ? order.status : null;
	const reachedIndex = ORDER_STEPS.reduce((acc, step, i) => (byStatus.has(step.id) ? i : acc), -1);
	const currentIndex = branch
		? reachedIndex
		: ORDER_STEPS.findIndex((s) => s.id === order?.status);

	const steps = ORDER_STEPS.map((step, i) => {
		const event = byStatus.get(step.id) || null;
		let state = 'upcoming';
		if (event) state = i === currentIndex && !branch ? 'current' : 'done';
		else if (branch && i > reachedIndex) state = 'stopped';
		else if (i === currentIndex) state = 'current';
		return { ...step, state, at: event?.created_at || null, note: event?.note || null };
	});

	return {
		steps,
		branch: branch
			? {
					status: branch,
					event: byStatus.get(branch) || null,
					label: branch === 'rejected' ? 'Rejected' : branch === 'refunded' ? 'Refunded' : 'Canceled',
				}
			: null,
	};
}

// The countries the shipping form offers, each mapped to the zone the quote
// engine will price it into. Kept short on purpose: this is the list we can
// actually ship to today, and a country that is not here is not a country the
// order should be allowed to reach checkout with.
export const SHIPPING_COUNTRIES = Object.freeze([
	{ code: 'US', name: 'United States' },
	{ code: 'CA', name: 'Canada' },
	{ code: 'GB', name: 'United Kingdom' },
	{ code: 'IE', name: 'Ireland' },
	{ code: 'DE', name: 'Germany' },
	{ code: 'FR', name: 'France' },
	{ code: 'ES', name: 'Spain' },
	{ code: 'IT', name: 'Italy' },
	{ code: 'NL', name: 'Netherlands' },
	{ code: 'BE', name: 'Belgium' },
	{ code: 'AT', name: 'Austria' },
	{ code: 'CH', name: 'Switzerland' },
	{ code: 'PT', name: 'Portugal' },
	{ code: 'DK', name: 'Denmark' },
	{ code: 'SE', name: 'Sweden' },
	{ code: 'NO', name: 'Norway' },
	{ code: 'FI', name: 'Finland' },
	{ code: 'PL', name: 'Poland' },
	{ code: 'CZ', name: 'Czechia' },
	{ code: 'GR', name: 'Greece' },
	{ code: 'CN', name: 'Mainland China' },
	{ code: 'HK', name: 'Hong Kong' },
	{ code: 'SG', name: 'Singapore' },
	{ code: 'JP', name: 'Japan' },
	{ code: 'KR', name: 'South Korea' },
	{ code: 'AU', name: 'Australia' },
	{ code: 'NZ', name: 'New Zealand' },
	{ code: 'AE', name: 'United Arab Emirates' },
	{ code: 'IL', name: 'Israel' },
	{ code: 'BR', name: 'Brazil' },
	{ code: 'MX', name: 'Mexico' },
	{ code: 'IN', name: 'India' },
	{ code: 'ZA', name: 'South Africa' },
]);

/**
 * Inline validation for the shipping form, matching exactly what
 * api/_lib/print-store.js normalizeShipping will accept. Returning the same
 * verdict the server will reach is the point: a form that passes here and fails
 * there is worse than no validation at all.
 */
export function validateShipping(values) {
	const required = { name: 'Full name', line1: 'Street address', city: 'City', postal_code: 'Postal code', country: 'Country' };
	const errors = {};
	for (const [field, label] of Object.entries(required)) {
		const value = String(values?.[field] ?? '').trim();
		if (!value) errors[field] = `${label} is required.`;
		else if (value.length > 120) errors[field] = `${label} must be 120 characters or fewer.`;
	}
	const country = String(values?.country ?? '').trim().toUpperCase();
	if (country && !/^[A-Z]{2}$/.test(country)) errors.country = 'Choose a country from the list.';
	for (const field of ['line2', 'region', 'phone']) {
		const value = String(values?.[field] ?? '').trim();
		if (value.length > 120) errors[field] = 'Must be 120 characters or fewer.';
	}
	return { valid: Object.keys(errors).length === 0, errors };
}
