/**
 * api/instant-agent.js turns one sentence into a finished character: a name, a
 * handle, a personality, a body from the shipped avatar library, and a signature
 * move from the shipped clip library. Two halves are covered here.
 *
 * 1. The catalogs are claims about real files. BODIES states how many of the 52
 *    canonical joints each GLB resolves and how many of its meshes carry morph
 *    targets; MOVES names clips in public/animations/manifest.json. Both are
 *    re-measured from the assets on disk, so replacing an avatar or renaming a
 *    clip fails here instead of silently shipping a T-posing agent to the first
 *    screen a new visitor sees.
 * 2. The pure helpers that repair whatever the model returns. Every one of them
 *    must produce a usable value from garbage input, because the page renders
 *    the result directly.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
	BODIES,
	MOVES,
	MOODS,
	RESTING_CLIP,
	safeHandle,
	pickBody,
	pickMove,
	extractJson,
	buildPersona,
} from '../api/instant-agent.js';
import { canonicalizeBoneName, CANONICAL_BONES } from '../src/glb-canonicalize.js';

const root = (p) => resolve(process.cwd(), p);

/** Parse the JSON chunk of a .glb (12-byte header, then the chunk header). */
function glbJson(path) {
	const buf = readFileSync(path);
	expect(buf.subarray(0, 4).toString('ascii')).toBe('glTF');
	const jsonLength = buf.readUInt32LE(12);
	return JSON.parse(buf.subarray(20, 20 + jsonLength).toString('utf8'));
}

/** How many of the 52 canonical joints this file's skins resolve to. */
function canonicalBoneCount(json) {
	const nodes = json.nodes || [];
	const canon = new Set();
	for (const skin of json.skins || []) {
		for (const joint of skin.joints || []) {
			const name = canonicalizeBoneName(nodes[joint]?.name || '');
			if (name && CANONICAL_BONES.includes(name)) canon.add(name);
		}
	}
	return canon.size;
}

/** Meshes with at least one morph-target primitive (the ones that can emote). */
function morphMeshCount(json) {
	return (json.meshes || []).filter((mesh) =>
		(mesh.primitives || []).some((p) => Array.isArray(p.targets) && p.targets.length > 0),
	).length;
}

const clipManifest = JSON.parse(readFileSync(root('public/animations/manifest.json'), 'utf8'));
const clipByName = new Map(clipManifest.map((c) => [c.name, c]));

describe('BODIES is measured against the shipped avatars', () => {
	it.each(BODIES.map((b) => [b.id, b]))('%s ships, is fully rigged, and matches its counts', (_id, body) => {
		const json = glbJson(root(`public${body.glb}`));
		expect(canonicalBoneCount(json)).toBe(body.canonicalBones);
		expect(body.canonicalBones).toBe(CANONICAL_BONES.length);
		expect(morphMeshCount(json)).toBe(body.morphMeshes);
	});

	it('has unique ids and no empty copy', () => {
		expect(new Set(BODIES.map((b) => b.id)).size).toBe(BODIES.length);
		for (const body of BODIES) {
			expect(body.label.length).toBeGreaterThan(0);
			expect(body.blurb.length).toBeGreaterThan(0);
			expect(body.traits.length).toBeGreaterThan(0);
		}
	});
});

describe('MOVES names real clips', () => {
	it.each([...Object.entries(MOVES)])('%s resolves to a manifest clip', (_mood, move) => {
		const clip = clipByName.get(move.clip);
		expect(clip, `${move.clip} is not in public/animations/manifest.json`).toBeTruthy();
		expect(() => readFileSync(root(`public${clip.url}`))).not.toThrow();
	});

	it('the resting clip every body falls back to is real', () => {
		expect(clipByName.has(RESTING_CLIP)).toBe(true);
	});

	it('MOODS is exactly the set the model is told to choose from', () => {
		expect(MOODS).toEqual(Object.keys(MOVES));
	});
});

describe('safeHandle', () => {
	it('slugifies a display name', () => {
		expect(safeHandle('Ada Lovelace')).toBe('ada-lovelace');
		expect(safeHandle('  Café Münz!!  ')).toBe('cafe-munz');
	});

	it('falls back to the name, then to a stable generic', () => {
		expect(safeHandle('', 'Nova Guide')).toBe('nova-guide');
		expect(safeHandle('!!', '???')).toBe('new-agent');
		expect(safeHandle(null, null)).toBe('new-agent');
	});

	it('refuses reserved handles at both levels', () => {
		expect(safeHandle('admin', 'Nova')).toBe('nova');
		expect(safeHandle('admin', 'api')).toBe('new-agent');
	});

	it('never returns something unusable in a URL', () => {
		for (const raw of ['../../etc/passwd', '<script>', '   ', 'a', '🙂🙂🙂']) {
			const handle = safeHandle(raw, 'Fallback Name');
			expect(handle).toMatch(/^[a-z0-9][a-z0-9-]{1,19}$/);
		}
	});
});

describe('pickBody', () => {
	it('honours the model hint over incidental words', () => {
		expect(pickBody('a warm friendly host', 'xbot').id).toBe('xbot');
		expect(pickBody('anything at all', 'michelle').id).toBe('michelle');
	});

	it('matches traits on word boundaries, not substrings', () => {
		expect(pickBody('a robot for tech teams').id).toBe('xbot');
		// "botany" contains "bot" but must not select the robot shell.
		expect(pickBody('a botany tutor for gardeners').id).not.toBe('xbot');
	});

	it('always returns a body, even for an empty idea', () => {
		expect(BODIES).toContain(pickBody('', ''));
		expect(BODIES).toContain(pickBody('     '));
	});
});

describe('pickMove', () => {
	it('resolves a known mood and defaults the rest to warm', () => {
		expect(pickMove('bold')).toBe(MOVES.bold);
		expect(pickMove('nonsense')).toBe(MOVES.warm);
		expect(pickMove(undefined)).toBe(MOVES.warm);
	});
});

describe('extractJson', () => {
	it('reads a bare object', () => {
		expect(extractJson('{"name":"Ada"}')).toEqual({ name: 'Ada' });
	});

	it('reads through a code fence and surrounding prose', () => {
		expect(extractJson('Sure!\n```json\n{"name":"Ada"}\n```\nHope that helps.')).toEqual({
			name: 'Ada',
		});
	});

	it('handles nested objects and braces inside strings', () => {
		expect(extractJson('{"a":{"b":1},"c":"} not the end {"}')).toEqual({
			a: { b: 1 },
			c: '} not the end {',
		});
		expect(extractJson('{"c":"escaped \\" quote {"}')).toEqual({ c: 'escaped " quote {' });
	});

	it('returns null for anything unparseable', () => {
		expect(extractJson('')).toBeNull();
		expect(extractJson(null)).toBeNull();
		expect(extractJson('no json here')).toBeNull();
		expect(extractJson('{"unterminated": ')).toBeNull();
		expect(extractJson('{not: valid}')).toBeNull();
	});
});

describe('buildPersona', () => {
	const idea = 'a patient museum guide who explains renaissance paintings';

	it('passes a complete completion through, trimmed', () => {
		const persona = buildPersona(
			{
				name: '  Lorenzo  ',
				handle: 'Lorenzo!',
				tagline: 'Your guide to the Renaissance',
				personality: 'You are Lorenzo. You explain paintings.',
				greeting: 'Welcome, traveller.',
				starters: ['What is this?', 'Who painted it?', 'Why the light?', 'ignored fourth'],
				mood: 'precise',
				body: 'studio',
			},
			idea,
		);
		expect(persona.name).toBe('Lorenzo');
		expect(persona.handle).toBe('lorenzo');
		expect(persona.starters).toHaveLength(3);
		expect(persona.mood).toBe('precise');
		expect(persona.bodyHint).toBe('studio');
	});

	it('renders no holes when the model returns nothing usable', () => {
		for (const parsed of [null, {}, 'not an object', []]) {
			const persona = buildPersona(parsed, idea);
			expect(persona.name.length).toBeGreaterThan(0);
			expect(persona.tagline.length).toBeGreaterThan(0);
			expect(persona.personality.length).toBeGreaterThan(0);
			expect(persona.greeting.length).toBeGreaterThan(0);
			expect(persona.starters).toHaveLength(3);
			expect(persona.starters.every((s) => s.length > 0)).toBe(true);
			expect(MOODS).toContain(persona.mood);
			expect(persona.handle).toMatch(/^[a-z0-9][a-z0-9-]{1,19}$/);
		}
	});

	it('clamps every field to its contract length', () => {
		const long = 'x'.repeat(2000);
		const persona = buildPersona(
			{ name: long, tagline: long, personality: long, greeting: long, starters: [long] },
			idea,
		);
		expect(persona.name.length).toBeLessThanOrEqual(24);
		expect(persona.tagline.length).toBeLessThanOrEqual(70);
		expect(persona.personality.length).toBeLessThanOrEqual(900);
		expect(persona.greeting.length).toBeLessThanOrEqual(140);
		for (const starter of persona.starters) expect(starter.length).toBeLessThanOrEqual(60);
	});

	it('falls back to warm for a mood outside the ladder', () => {
		expect(buildPersona({ mood: 'furious' }, idea).mood).toBe('warm');
	});
});
