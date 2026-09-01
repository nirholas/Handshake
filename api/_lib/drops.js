// Generative 3D drops: the deterministic trait + rarity engine.
//
// A "drop" is a supply-capped collection of 3D characters. The creator supplies
// a base style and a set of trait layers with weighted options; this module
// turns (seed, supply, layers) into the full rolled supply, with no randomness
// that is not reproducible from those three inputs.
//
// Why deterministic matters here: the roll is the product. A holder has to be
// able to prove their token was not re-rolled after the fact, and the platform
// has to be able to regenerate any item's art months later without storing a
// per-item random state. Both fall out of deriving every trait from
// `draw(seed, locus)` in ./genome.js, which keys an independent PRNG stream per
// locus. Independent streams also mean a creator can APPEND a trait layer to a
// draft without perturbing the values already rolled on the existing layers.
//
// Art is deliberately NOT generated here. Rolling the supply is instant and
// free; generating N rigged GLBs is neither. The roll happens at create time,
// the art is forged at reveal time, one item at a time. That is both how real
// drops behave and the only version of this whose economics work at 10k supply.

import { createHash } from 'node:crypto';
import { draw } from './genome.js';

export const DROPS_VERSION = 1;

// Supply ceiling. Above this the rarity pass (which is O(supply * layers)) stops
// being something we are willing to run inside a request, and the reveal backlog
// stops being something a single creator can realistically fund.
export const MAX_SUPPLY = 10000;
export const MIN_SUPPLY = 1;

// A layer with more options than this is almost always a modelling mistake
// (someone pasting a word list), and every extra option dilutes the rarity
// signal that makes a collection legible.
export const MAX_LAYERS = 12;
export const MAX_OPTIONS_PER_LAYER = 64;

// Rarity tiers, sharing the platform's cosmetics vocabulary (src/fits-lib.js)
// so a drop item and a cosmetic read the same way everywhere they meet.
// Cutoffs are percentile-from-the-top of the rarity-score ranking.
export const RARITY_TIERS = [
	{ tier: 'legendary', maxPercentile: 0.01 },
	{ tier: 'epic', maxPercentile: 0.1 },
	{ tier: 'rare', maxPercentile: 0.35 },
	{ tier: 'common', maxPercentile: 1 },
];

/* ────────────────────────────────────────────────────────────────────────── *
 * Layer normalization
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Validate and normalize creator-supplied trait layers.
 *
 * Throws on anything that would make a roll unreproducible or a collection
 * nonsensical (duplicate layer keys, zero-weight layers, empty option sets).
 * Weights are kept as supplied rather than normalized to probabilities, because
 * the provenance hash commits to the exact numbers the creator published.
 *
 * @param {Array<object>} layers
 * @returns {Array<{key:string,name:string,options:Array<{value:string,weight:number,prompt:string}>}>}
 */
export function normalizeLayers(layers) {
	if (!Array.isArray(layers) || layers.length === 0) {
		throw new DropSpecError('at least one trait layer is required');
	}
	if (layers.length > MAX_LAYERS) {
		throw new DropSpecError(`at most ${MAX_LAYERS} trait layers (got ${layers.length})`);
	}

	const seenKeys = new Set();
	const out = [];

	for (const raw of layers) {
		if (!raw || typeof raw !== 'object') {
			throw new DropSpecError('each trait layer must be an object');
		}
		const name = String(raw.name ?? '').trim();
		if (!name) throw new DropSpecError('each trait layer needs a name');
		if (name.length > 40) throw new DropSpecError(`layer name "${name}" is longer than 40 characters`);

		const key = slugify(raw.key ?? name);
		if (!key) throw new DropSpecError(`layer "${name}" has no usable key`);
		if (seenKeys.has(key)) throw new DropSpecError(`duplicate trait layer key "${key}"`);
		seenKeys.add(key);

		const options = normalizeOptions(raw.options, name);
		out.push({ key, name, options });
	}

	return out;
}

function normalizeOptions(options, layerName) {
	if (!Array.isArray(options) || options.length === 0) {
		throw new DropSpecError(`layer "${layerName}" needs at least one option`);
	}
	if (options.length > MAX_OPTIONS_PER_LAYER) {
		throw new DropSpecError(
			`layer "${layerName}" has ${options.length} options (max ${MAX_OPTIONS_PER_LAYER})`,
		);
	}

	const seenValues = new Set();
	const out = [];

	for (const raw of options) {
		const isString = typeof raw === 'string';
		const value = String((isString ? raw : raw?.value) ?? '').trim();
		if (!value) throw new DropSpecError(`layer "${layerName}" has an option with no value`);
		if (value.length > 60) {
			throw new DropSpecError(`option "${value}" in layer "${layerName}" is longer than 60 characters`);
		}
		const lowered = value.toLowerCase();
		if (seenValues.has(lowered)) {
			throw new DropSpecError(`layer "${layerName}" repeats the option "${value}"`);
		}
		seenValues.add(lowered);

		const weight = isString ? 1 : numberOr(raw?.weight, 1);
		if (!(weight > 0) || !Number.isFinite(weight)) {
			throw new DropSpecError(`option "${value}" in layer "${layerName}" needs a weight above zero`);
		}

		// An option may carry its own prompt fragment. When it does not, the
		// value itself is the fragment, which is what makes a bare string list
		// ("Gold", "Obsidian") a usable layer with no extra ceremony.
		const prompt = String((isString ? '' : (raw?.prompt ?? '')) || value).trim().slice(0, 160);

		out.push({ value, weight, prompt });
	}

	return out;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Rolling
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Roll one item's traits. Pure: same (seed, index, layers) always yields the
 * same traits, on this machine and any other.
 *
 * Each layer draws from its own stream, keyed by the layer key rather than by
 * position, so reordering the layer array does not change any result and
 * appending a layer leaves existing layers untouched.
 *
 * @param {{seed:string,index:number,layers:Array<object>}} args
 * @returns {{index:number,traits:Array<{layer:string,layer_name:string,value:string}>}}
 */
export function rollItem({ seed, index, layers }) {
	const traits = [];
	for (const layer of layers) {
		const roll = draw(`${seed}#${index}`, layer.key);
		traits.push({
			layer: layer.key,
			layer_name: layer.name,
			value: pickWeighted(layer.options, roll).value,
		});
	}
	return { index, traits };
}

/**
 * Roll the entire supply and score it.
 *
 * Rarity is computed from the ACTUAL rolled distribution rather than from the
 * declared weights. Those two diverge on every finite supply, and the honest
 * number is the one a holder can recount from the published items.
 *
 * @param {{seed:string,supply:number,layers:Array<object>}} args
 * @returns {Array<{index:number,traits:Array<object>,rarity_score:number,rarity_rank:number,rarity_tier:string}>}
 */
export function rollSupply({ seed, supply, layers }) {
	const size = assertSupply(supply);
	const normalized = Array.isArray(layers) && layers.length && layers[0]?.key
		? layers
		: normalizeLayers(layers);

	const items = [];
	for (let i = 0; i < size; i++) items.push(rollItem({ seed, index: i, layers: normalized }));

	return scoreRarity(items, size);
}

/**
 * Attach statistical rarity to an already-rolled supply.
 *
 * Score is the sum over layers of (supply / occurrences of this item's value on
 * that layer), the standard statistical-rarity formula: a value held by 1 of
 * 1000 contributes 1000, one held by half the supply contributes 2. Summing
 * rather than multiplying keeps a single ultra-rare trait from swamping every
 * other signal in the collection.
 *
 * Ties are broken by index so the ranking is total and reproducible.
 *
 * @param {Array<{index:number,traits:Array<object>}>} items
 * @param {number} [supply]
 */
export function scoreRarity(items, supply = items.length) {
	const counts = new Map();
	for (const item of items) {
		for (const t of item.traits) {
			const k = `${t.layer} ${t.value}`;
			counts.set(k, (counts.get(k) || 0) + 1);
		}
	}

	const scored = items.map((item) => {
		let score = 0;
		for (const t of item.traits) {
			const seen = counts.get(`${t.layer} ${t.value}`) || 1;
			score += supply / seen;
		}
		return { ...item, rarity_score: round4(score) };
	});

	const ordering = [...scored].sort(
		(a, b) => b.rarity_score - a.rarity_score || a.index - b.index,
	);

	const rankByIndex = new Map();
	ordering.forEach((item, i) => rankByIndex.set(item.index, i + 1));

	return scored.map((item) => {
		const rank = rankByIndex.get(item.index);
		return { ...item, rarity_rank: rank, rarity_tier: tierForRank(rank, scored.length) };
	});
}

/**
 * The tier for a 1-based rank within a supply. Exported so the client can label
 * a single item without re-scoring the whole collection.
 */
export function tierForRank(rank, supply) {
	if (!(supply > 0)) return 'common';
	const percentile = rank / supply;
	for (const { tier, maxPercentile } of RARITY_TIERS) {
		if (percentile <= maxPercentile) return tier;
	}
	return 'common';
}

/**
 * Per-layer trait frequency table for the rarity panel on a drop page.
 *
 * @returns {Array<{layer:string,layer_name:string,values:Array<{value:string,count:number,share:number}>}>}
 */
export function traitDistribution(items, layers) {
	const supply = items.length || 1;
	const byLayer = new Map(layers.map((l) => [l.key, { layer: l.key, layer_name: l.name, counts: new Map() }]));

	for (const item of items) {
		for (const t of item.traits) {
			const bucket = byLayer.get(t.layer);
			if (!bucket) continue;
			bucket.counts.set(t.value, (bucket.counts.get(t.value) || 0) + 1);
		}
	}

	return [...byLayer.values()].map((bucket) => ({
		layer: bucket.layer,
		layer_name: bucket.layer_name,
		values: [...bucket.counts.entries()]
			.map(([value, count]) => ({ value, count, share: round4(count / supply) }))
			.sort((a, b) => a.count - b.count || a.value.localeCompare(b.value)),
	}));
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Provenance
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * The commitment a drop publishes before it reveals anything.
 *
 * Anyone holding (seed, supply, layers, style) can re-run rollSupply and check
 * every item against what the drop served them. Publishing the hash at create
 * time and the seed at reveal time is what makes "we did not re-roll the rares
 * into our own wallet" a checkable claim instead of a promise.
 *
 * @param {{seed:string,supply:number,style:string,layers:Array<object>}} spec
 * @returns {string} sha256 hex
 */
export function provenanceHash({ seed, supply, style, layers }) {
	const canonical = canonicalize({
		version: DROPS_VERSION,
		seed: String(seed),
		supply: Number(supply),
		style: String(style || ''),
		layers: layers.map((l) => ({
			key: l.key,
			name: l.name,
			options: l.options.map((o) => ({ value: o.value, weight: o.weight, prompt: o.prompt })),
		})),
	});
	return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Re-derive an item and confirm it matches what was served. Used by the public
 * verify endpoint and by the reveal path, so a corrupted or tampered row can
 * never be handed to a generator as if it were the rolled truth.
 *
 * @returns {{ok:boolean, expected:Array<object>, actual:Array<object>}}
 */
export function verifyItem({ seed, index, layers, traits }) {
	const expected = rollItem({ seed, index, layers }).traits;
    const actual = Array.isArray(traits) ? traits : [];
	const ok =
		expected.length === actual.length &&
		expected.every((e, i) => actual[i]?.layer === e.layer && actual[i]?.value === e.value);
	return { ok, expected, actual };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Prompt composition
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Compose the text-to-3D prompt for one item from the drop's base style and the
 * item's rolled traits.
 *
 * The base style leads so every item in the collection shares a silhouette and
 * finish; the traits follow in layer order so the same trait always lands in the
 * same position of the prompt, which is what keeps a generator's output
 * coherent across a supply instead of drifting item to item.
 *
 * @param {{style:string, traits:Array<{layer:string,value:string}>, layers:Array<object>}} args
 * @returns {string}
 */
export function itemPrompt({ style, traits, layers }) {
	const promptByPair = new Map();
	for (const layer of layers) {
		for (const option of layer.options) {
			promptByPair.set(`${layer.key} ${option.value}`, option.prompt);
		}
	}

	const order = new Map(layers.map((l, i) => [l.key, i]));
	const fragments = [...traits]
		.sort((a, b) => (order.get(a.layer) ?? 0) - (order.get(b.layer) ?? 0))
		.map((t) => promptByPair.get(`${t.layer} ${t.value}`) || t.value)
		.filter(Boolean);

	const base = String(style || '').trim();
	// A single humanoid, full body, T-pose-friendly: the generator hints that make
	// the output riggable by src/glb-canonicalize.js instead of a bust or a scene.
	const suffix = 'full body character, single subject, clean topology, neutral A-pose';
	return [base, ...fragments, suffix].filter(Boolean).join(', ').slice(0, 900);
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Helpers
 * ────────────────────────────────────────────────────────────────────────── */

export class DropSpecError extends Error {
	constructor(message) {
		super(message);
		this.name = 'DropSpecError';
		this.status = 400;
		this.code = 'validation_error';
	}
}

/**
 * Pick an option by cumulative weight from a roll in [0,1).
 * Exported for the tests that pin the weighting behaviour.
 */
export function pickWeighted(options, roll) {
	let total = 0;
	for (const o of options) total += o.weight;
	// Clamp rather than trust: a roll of exactly 1 (impossible from draw, but
	// reachable if a caller passes one in) must not fall off the end.
	let target = Math.min(Math.max(roll, 0), 0.9999999) * total;
	for (const o of options) {
		target -= o.weight;
		if (target < 0) return o;
	}
	return options[options.length - 1];
}

export function assertSupply(supply) {
	const n = Number(supply);
	if (!Number.isInteger(n) || n < MIN_SUPPLY || n > MAX_SUPPLY) {
		throw new DropSpecError(`supply must be a whole number between ${MIN_SUPPLY} and ${MAX_SUPPLY}`);
	}
	return n;
}

export function slugify(value) {
	return String(value ?? '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 48);
}

function numberOr(value, fallback) {
	const n = Number(value);
	return Number.isFinite(n) ? n : fallback;
}

function round4(x) {
	return Math.round(x * 10000) / 10000;
}

// Deterministic JSON with recursively sorted keys, so the provenance hash does
// not depend on the order the creator's client happened to serialize fields in.
function canonicalize(value) {
	if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
	if (value && typeof value === 'object') {
		const keys = Object.keys(value).sort();
		return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
	}
	return JSON.stringify(value);
}
