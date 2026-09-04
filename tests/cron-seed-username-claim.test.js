// The forge seed cron's username claim (api/cron/forge-seed-cron.js) and the
// free-model liveness audit (api/cron/free-model-audit.js).
//
// Both encode the same lesson: a cron that answers 200 OK while doing nothing is
// worse than one that fails, because nothing pages. The seed cron used to read a
// bounded slice of the existing usernames (`limit 100`) and trust it as complete.
// Once a word's numbered slots filled up the slice hid the exhaustion, the claim
// handed back a name that already existed, the insert's `on conflict do nothing`
// returned no row, and the tick skipped. By 2026-07-25 every one of the 171 OG
// words was saturated, so seeding stopped entirely for weeks with a green cron.
// These lock the saturated case in: candidate generation must always yield names
// to try, and must never propose one it was told is taken.
import { test, expect } from 'vitest';
import { seedUsernameCandidates } from '../api/cron/forge-seed-cron.js';
import { diffFreeModels } from '../api/cron/free-model-audit.js';

test('a fresh word claims the bare word first', () => {
	const candidates = seedUsernameCandidates('wolf', new Set());
	expect(candidates[0]).toBe('wolf');
	expect(candidates.slice(1, 3)).toEqual(['wolf2', 'wolf3']);
});

test('a partly used word skips to the free numbered slots', () => {
	const taken = new Set(['wolf', 'wolf2', 'wolf3']);
	const candidates = seedUsernameCandidates('wolf', taken);
	expect(candidates[0]).toBe('wolf4');
	expect(candidates.some((c) => taken.has(c))).toBe(false);
});

// The regression: word + word2..word99 all gone. The old claim returned a taken
// name here and the tick skipped forever.
test('a fully saturated word still yields usable candidates', () => {
	const taken = new Set(['wolf', ...Array.from({ length: 98 }, (_, i) => `wolf${i + 2}`)]);
	const candidates = seedUsernameCandidates('wolf', taken);

	expect(candidates.length).toBeGreaterThan(0);
	expect(candidates.some((c) => taken.has(c))).toBe(false);
	// Every fallback is a random hex slot off the same word, so the display name
	// still reads as the OG word.
	for (const c of candidates) expect(c).toMatch(/^wolf_[0-9a-f]{4}$/);
	// Distinct, so retrying after a conflict actually tries something new.
	expect(new Set(candidates).size).toBe(candidates.length);
});

test('candidates never repeat a name the caller reported as taken', () => {
	const taken = new Set(['ash', 'ash2', 'ash5', 'ash6', 'ash7', 'ash9']);
	const candidates = seedUsernameCandidates('ash', taken);
	for (const c of candidates) expect(taken.has(c)).toBe(false);
});

// free-model-audit: the verdict that pages ops, and the one that must not.
test('a hardcoded id missing from the live list is reported dead', () => {
	const result = diffFreeModels(
		['google/gemma-4-31b-it:free', 'inclusionai/ling-3.0-flash:free'],
		['google/gemma-4-31b-it:free', 'meta-llama/llama-3.3-70b-instruct:free'],
	);
	expect(result.status).toBe('dead_rungs');
	expect(result.dead).toEqual(['inclusionai/ling-3.0-flash:free']);
	expect(result.live).toBe(1);
});

// The failure path that matters: OpenRouter being unreachable returns an empty
// live list, and calling every model dead on our own outage would page ops with
// a false alarm and invite a pointless catalog rewrite.
test('an empty live list is unknown, never a dead verdict', () => {
	const result = diffFreeModels(['google/gemma-4-31b-it:free'], []);
	expect(result.status).toBe('unknown');
	expect(result.dead).toEqual([]);
	expect(result.checked).toBe(1);
});
