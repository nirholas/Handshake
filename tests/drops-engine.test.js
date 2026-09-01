/**
 * Generative 3D drops: trait + rarity engine unit tests.
 *
 * The whole product claim of a drop is "this roll was not rigged", so the tests
 * that matter most here are the determinism and independence ones: the same
 * inputs must reproduce identical traits, and appending a layer must not
 * disturb the values already rolled on the layers beside it. Those two
 * properties are what make the published provenance hash worth anything.
 */

import { describe, it, expect } from 'vitest';
import {
	DropSpecError,
	MAX_LAYERS,
	MAX_OPTIONS_PER_LAYER,
	MAX_SUPPLY,
	assertSupply,
	itemPrompt,
	normalizeLayers,
	pickWeighted,
	provenanceHash,
	rollItem,
	rollSupply,
	scoreRarity,
	slugify,
	tierCutoff,
	tierForRank,
	traitDistribution,
	verifyItem,
} from '../api/_lib/drops.js';

const LAYERS = normalizeLayers([
	{
		name: 'Species',
		options: [
			{ value: 'Fox', weight: 60 },
			{ value: 'Wolf', weight: 30 },
			{ value: 'Dragon', weight: 10 },
		],
	},
	{
		name: 'Outfit',
		options: [
			{ value: 'Bomber Jacket', weight: 50, prompt: 'wearing a worn leather bomber jacket' },
			{ value: 'Lab Coat', weight: 50 },
		],
	},
	{ name: 'Aura', options: ['None', 'Ember', 'Frost'] },
]);

describe('normalizeLayers', () => {
	it('derives a slug key from the layer name', () => {
		const [species] = normalizeLayers([{ name: 'Head Wear', options: ['Cap'] }]);
		expect(species.key).toBe('head-wear');
		expect(species.name).toBe('Head Wear');
	});

	it('accepts a bare string option and defaults its weight and prompt', () => {
		const [layer] = normalizeLayers([{ name: 'Aura', options: ['Ember'] }]);
		expect(layer.options[0]).toEqual({ value: 'Ember', weight: 1, prompt: 'Ember' });
	});

	it('keeps an explicit prompt fragment distinct from the trait value', () => {
		const outfit = LAYERS.find((l) => l.key === 'outfit');
		const bomber = outfit.options.find((o) => o.value === 'Bomber Jacket');
		expect(bomber.prompt).toBe('wearing a worn leather bomber jacket');
	});

	it('rejects an empty layer list', () => {
		expect(() => normalizeLayers([])).toThrow(DropSpecError);
	});

	it('rejects duplicate layer keys', () => {
		expect(() =>
			normalizeLayers([
				{ name: 'Aura', options: ['A'] },
				{ name: 'aura', options: ['B'] },
			]),
		).toThrow(/duplicate trait layer key/);
	});

	it('rejects a repeated option value within one layer', () => {
		expect(() => normalizeLayers([{ name: 'Aura', options: ['Ember', 'ember'] }])).toThrow(
			/repeats the option/,
		);
	});

	it('rejects a zero or negative weight', () => {
		expect(() => normalizeLayers([{ name: 'Aura', options: [{ value: 'X', weight: 0 }] }])).toThrow(
			/weight above zero/,
		);
	});

	it('rejects a layer with no options', () => {
		expect(() => normalizeLayers([{ name: 'Aura', options: [] }])).toThrow(/at least one option/);
	});

	it('enforces the layer and option ceilings', () => {
		const tooManyLayers = Array.from({ length: MAX_LAYERS + 1 }, (_, i) => ({
			name: `L${i}`,
			options: ['x'],
		}));
		expect(() => normalizeLayers(tooManyLayers)).toThrow(/at most/);

		const tooManyOptions = Array.from({ length: MAX_OPTIONS_PER_LAYER + 1 }, (_, i) => `opt${i}`);
		expect(() => normalizeLayers([{ name: 'Aura', options: tooManyOptions }])).toThrow(/max/);
	});
});

describe('rollItem determinism', () => {
	it('is reproducible for the same seed and index', () => {
		const a = rollItem({ seed: 'seed-alpha', index: 7, layers: LAYERS });
		const b = rollItem({ seed: 'seed-alpha', index: 7, layers: LAYERS });
		expect(a).toEqual(b);
	});

	it('produces different traits for different indexes', () => {
		const rolls = new Set();
		for (let i = 0; i < 40; i++) {
			rolls.add(JSON.stringify(rollItem({ seed: 'seed-alpha', index: i, layers: LAYERS }).traits));
		}
		expect(rolls.size).toBeGreaterThan(1);
	});

	it('produces different traits for a different seed', () => {
		const a = rollItem({ seed: 'seed-alpha', index: 3, layers: LAYERS });
		const b = rollItem({ seed: 'seed-beta', index: 3, layers: LAYERS });
		expect(a.traits).not.toEqual(b.traits);
	});

	it('emits one trait per layer, in layer order', () => {
		const { traits } = rollItem({ seed: 's', index: 0, layers: LAYERS });
		expect(traits.map((t) => t.layer)).toEqual(['species', 'outfit', 'aura']);
	});

	it('is unaffected by the order the layers are passed in', () => {
		const reordered = [LAYERS[2], LAYERS[0], LAYERS[1]];
		const straight = rollItem({ seed: 's', index: 11, layers: LAYERS }).traits;
		const shuffled = rollItem({ seed: 's', index: 11, layers: reordered }).traits;
		for (const t of straight) {
			expect(shuffled.find((x) => x.layer === t.layer).value).toBe(t.value);
		}
	});

	it('leaves existing layers untouched when a new layer is appended', () => {
		const before = rollItem({ seed: 's', index: 5, layers: LAYERS }).traits;
		const extended = [...LAYERS, ...normalizeLayers([{ name: 'Backdrop', options: ['Void', 'Sun'] }])];
		const after = rollItem({ seed: 's', index: 5, layers: extended }).traits;
		expect(after.slice(0, LAYERS.length)).toEqual(before);
		expect(after).toHaveLength(LAYERS.length + 1);
	});
});

describe('pickWeighted', () => {
	const options = [
		{ value: 'A', weight: 1 },
		{ value: 'B', weight: 3 },
	];

	it('splits the interval by cumulative weight', () => {
		expect(pickWeighted(options, 0).value).toBe('A');
		expect(pickWeighted(options, 0.2).value).toBe('A');
		expect(pickWeighted(options, 0.3).value).toBe('B');
		expect(pickWeighted(options, 0.99).value).toBe('B');
	});

	it('never falls off the end of the option list', () => {
		expect(pickWeighted(options, 1).value).toBe('B');
		expect(pickWeighted(options, 1.5).value).toBe('B');
		expect(pickWeighted(options, -1).value).toBe('A');
	});

	it('honours the declared weights across a large sample', () => {
		let b = 0;
		const n = 4000;
		for (let i = 0; i < n; i++) if (pickWeighted(options, i / n).value === 'B') b++;
		expect(b / n).toBeCloseTo(0.75, 2);
	});
});

describe('rollSupply and rarity', () => {
	const supply = 500;
	const items = rollSupply({ seed: 'provenance-1', supply, layers: LAYERS });

	it('rolls exactly the requested supply, indexed from zero', () => {
		expect(items).toHaveLength(supply);
		expect(items[0].index).toBe(0);
		expect(items[supply - 1].index).toBe(supply - 1);
	});

	it('ranks every item uniquely from 1..supply', () => {
		const ranks = items.map((i) => i.rarity_rank).sort((a, b) => a - b);
		expect(ranks[0]).toBe(1);
		expect(ranks[supply - 1]).toBe(supply);
		expect(new Set(ranks).size).toBe(supply);
	});

	it('scores a rarer trait combination above a common one', () => {
		const dragon = items.find((i) => i.traits.some((t) => t.value === 'Dragon'));
		const fox = items.find((i) => i.traits.some((t) => t.value === 'Fox'));
		expect(dragon.rarity_score).toBeGreaterThan(fox.rarity_score);
	});

	it('assigns tiers by percentile, with legendary the scarcest', () => {
		const tiers = new Set(items.map((i) => i.rarity_tier));
		expect(tiers.has('legendary')).toBe(true);
		expect(tiers.has('common')).toBe(true);
		const legendary = items.filter((i) => i.rarity_tier === 'legendary');
		expect(legendary.length).toBeLessThanOrEqual(Math.ceil(supply * 0.01));
		for (const item of legendary) expect(item.rarity_rank).toBeLessThanOrEqual(supply * 0.01);
	});

	it('respects the declared weights in the rolled distribution', () => {
		const species = items.map((i) => i.traits.find((t) => t.layer === 'species').value);
		const share = (v) => species.filter((s) => s === v).length / supply;
		expect(share('Fox')).toBeCloseTo(0.6, 1);
		expect(share('Dragon')).toBeCloseTo(0.1, 1);
	});

	it('reproduces the identical supply on a second run', () => {
		const again = rollSupply({ seed: 'provenance-1', supply, layers: LAYERS });
		expect(again).toEqual(items);
	});

	it('accepts raw un-normalized layers', () => {
		const raw = rollSupply({
			seed: 's',
			supply: 4,
			layers: [{ name: 'Aura', options: ['Ember', 'Frost'] }],
		});
		expect(raw).toHaveLength(4);
		expect(raw[0].traits[0].layer).toBe('aura');
	});
});

describe('tierForRank', () => {
	it('maps the percentile bands', () => {
		expect(tierForRank(1, 1000)).toBe('legendary');
		expect(tierForRank(10, 1000)).toBe('legendary');
		expect(tierForRank(11, 1000)).toBe('epic');
		expect(tierForRank(100, 1000)).toBe('epic');
		expect(tierForRank(350, 1000)).toBe('rare');
		expect(tierForRank(351, 1000)).toBe('common');
		expect(tierForRank(1000, 1000)).toBe('common');
	});

	it('degrades safely on an empty supply', () => {
		expect(tierForRank(1, 0)).toBe('common');
	});

	// A raw percentile test gives every collection under 100 an empty legendary
	// tier, so the top of a 60-item ranking would read as merely "epic".
	it('always gives the scarcest tier at least one item', () => {
		for (const supply of [1, 7, 60, 99, 100]) {
			expect(tierForRank(1, supply)).toBe('legendary');
		}
	});

	it('keeps the bands ordered as supply shrinks', () => {
		expect(tierForRank(1, 60)).toBe('legendary');
		expect(tierForRank(2, 60)).toBe('epic');
		expect(tierForRank(6, 60)).toBe('epic');
		expect(tierForRank(7, 60)).toBe('rare');
		expect(tierForRank(21, 60)).toBe('rare');
		expect(tierForRank(22, 60)).toBe('common');
		expect(tierForRank(60, 60)).toBe('common');
	});

	it('exposes the cutoff it uses, floored at one item', () => {
		expect(tierCutoff(1000, 0.01)).toBe(10);
		expect(tierCutoff(60, 0.01)).toBe(1);
		expect(tierCutoff(60, 1)).toBe(60);
	});
});

describe('scoreRarity', () => {
	it('breaks ties by index so the ranking is total', () => {
		const flat = [
			{ index: 2, traits: [{ layer: 'a', value: 'x' }] },
			{ index: 0, traits: [{ layer: 'a', value: 'x' }] },
			{ index: 1, traits: [{ layer: 'a', value: 'x' }] },
		];
		const scored = scoreRarity(flat);
		expect(scored.find((i) => i.index === 0).rarity_rank).toBe(1);
		expect(scored.find((i) => i.index === 1).rarity_rank).toBe(2);
		expect(scored.find((i) => i.index === 2).rarity_rank).toBe(3);
	});
});

describe('traitDistribution', () => {
	const items = rollSupply({ seed: 'dist', supply: 200, layers: LAYERS });
	const dist = traitDistribution(items, LAYERS);

	it('reports one bucket per layer', () => {
		expect(dist.map((d) => d.layer)).toEqual(['species', 'outfit', 'aura']);
	});

	it('sums each layer to the full supply', () => {
		for (const layer of dist) {
			expect(layer.values.reduce((n, v) => n + v.count, 0)).toBe(200);
		}
	});

	it('sorts scarcest first', () => {
		const species = dist.find((d) => d.layer === 'species');
		expect(species.values[0].value).toBe('Dragon');
	});

	it('reports share as a fraction of supply', () => {
		const species = dist.find((d) => d.layer === 'species');
		for (const v of species.values) expect(v.share).toBeCloseTo(v.count / 200, 4);
	});
});

describe('provenanceHash', () => {
	const spec = { seed: 'abc', supply: 100, style: 'clay dinosaur', layers: LAYERS };

	it('is stable across calls', () => {
		expect(provenanceHash(spec)).toBe(provenanceHash(spec));
	});

	it('is a sha256 hex digest', () => {
		expect(provenanceHash(spec)).toMatch(/^[0-9a-f]{64}$/);
	});

	it('changes when the seed changes', () => {
		expect(provenanceHash({ ...spec, seed: 'abd' })).not.toBe(provenanceHash(spec));
	});

	it('changes when a weight changes', () => {
		const tweaked = normalizeLayers([{ name: 'Species', options: [{ value: 'Fox', weight: 61 }] }]);
		expect(provenanceHash({ ...spec, layers: tweaked })).not.toBe(provenanceHash(spec));
	});

	it('does not depend on key insertion order', () => {
		const reordered = { layers: LAYERS, style: spec.style, supply: spec.supply, seed: spec.seed };
		expect(provenanceHash(reordered)).toBe(provenanceHash(spec));
	});
});

describe('verifyItem', () => {
	it('confirms an untampered item', () => {
		const item = rollItem({ seed: 'v', index: 9, layers: LAYERS });
		expect(verifyItem({ seed: 'v', index: 9, layers: LAYERS, traits: item.traits }).ok).toBe(true);
	});

	it('catches a dropped trait', () => {
		const item = rollItem({ seed: 'v', index: 9, layers: LAYERS });
		expect(
			verifyItem({ seed: 'v', index: 9, layers: LAYERS, traits: item.traits.slice(1) }).ok,
		).toBe(false);
	});

	it('catches a swapped trait value', () => {
		const item = rollItem({ seed: 'v', index: 9, layers: LAYERS });
		const other = ['Fox', 'Wolf', 'Dragon'].find((v) => v !== item.traits[0].value);
		const tampered = item.traits.map((t, i) => (i === 0 ? { ...t, value: other } : t));
		expect(verifyItem({ seed: 'v', index: 9, layers: LAYERS, traits: tampered }).ok).toBe(false);
	});

	it('treats a missing trait array as a failed verification', () => {
		expect(verifyItem({ seed: 'v', index: 0, layers: LAYERS, traits: null }).ok).toBe(false);
	});
});

describe('itemPrompt', () => {
	const traits = [
		{ layer: 'aura', value: 'Ember' },
		{ layer: 'species', value: 'Fox' },
		{ layer: 'outfit', value: 'Bomber Jacket' },
	];

	it('leads with the base style and follows in layer order', () => {
		const prompt = itemPrompt({ style: 'stylized clay creature', traits, layers: LAYERS });
		expect(prompt.startsWith('stylized clay creature, ')).toBe(true);
		expect(prompt.indexOf('Fox')).toBeLessThan(prompt.indexOf('bomber jacket'));
		expect(prompt.indexOf('bomber jacket')).toBeLessThan(prompt.indexOf('Ember'));
	});

	it('substitutes an option prompt fragment for the raw value', () => {
		const prompt = itemPrompt({ style: 'x', traits, layers: LAYERS });
		expect(prompt).toContain('wearing a worn leather bomber jacket');
		expect(prompt).not.toContain('Bomber Jacket');
	});

	it('appends the riggability hints every item needs', () => {
		const prompt = itemPrompt({ style: 'x', traits, layers: LAYERS });
		expect(prompt).toContain('full body character');
		expect(prompt).toContain('neutral A-pose');
	});

	it('stays within the generator prompt ceiling', () => {
		const long = 'a'.repeat(2000);
		expect(itemPrompt({ style: long, traits, layers: LAYERS }).length).toBeLessThanOrEqual(900);
	});
});

describe('assertSupply', () => {
	it('accepts the boundaries', () => {
		expect(assertSupply(1)).toBe(1);
		expect(assertSupply(MAX_SUPPLY)).toBe(MAX_SUPPLY);
	});

	it('rejects zero, fractions, and anything over the ceiling', () => {
		expect(() => assertSupply(0)).toThrow(DropSpecError);
		expect(() => assertSupply(1.5)).toThrow(DropSpecError);
		expect(() => assertSupply(MAX_SUPPLY + 1)).toThrow(DropSpecError);
		expect(() => assertSupply('many')).toThrow(DropSpecError);
	});
});

describe('slugify', () => {
	it('lowercases, collapses separators, and trims', () => {
		expect(slugify('  Clay Dinos!! 2026 ')).toBe('clay-dinos-2026');
	});

	it('returns an empty string when nothing survives', () => {
		expect(slugify('!!!')).toBe('');
	});
});
